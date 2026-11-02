"""隔离存储与查询边界，运行真实分析取值比较、Decimal 计算和证据生成。"""

from contextlib import nullcontext
from datetime import date
from decimal import Decimal, localcontext
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_analysis_report_claims import report

from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.calculation import CalculationRequest
from ask_metric.domain.semantics import MetricCatalogItem


def comparison_fixture(current_value, base_value, *, unit="%", encoding="ratio"):
    actor = SimpleNamespace(user_id="test-owner", subject="test-owner")
    catalog = MetricCatalogItem(code="M1", name="隔离测试指标", unit=unit)
    metric = {**catalog.model_dump(), "binding_ref": "test-binding", "value_encoding": encoding,
              "metadata_version": "test-version", "limitations": []}
    facts = [{"fact_id": f"fact:test-task:{index}:metric_value", "task_id": "test-task",
              "field": "metric_value", "value": value, "unit": unit, "metric_code": "M1",
              "metric_name": catalog.name, "org_code": "A", "org_name": "甲行",
              "date": day, "role": role, "binding_ref": "test-binding"}
             for index, (value, day, role) in enumerate([
                 (current_value, "2026-08-31", "current"), (base_value, "2026-07-31", "base")])]
    task = SimpleNamespace(id="test-task", conversation_id="test-conversation", status="SUCCEEDED",
                           expires_at=None, state_json={
        "channel_context": {"calculation_context": {"scope_id": "test-turn", "user_question": "比较变化"}},
        "result_artifact": {"logical_dsl": {"orgs": ["A"]}, "result": {
            "status": "succeeded", "facts": facts, "truncated": False}},
    })
    saved = {}
    uow = SimpleNamespace(
        conversations=SimpleNamespace(get_owned_for_update=lambda *_: SimpleNamespace(id=task.conversation_id)),
        tasks=SimpleNamespace(get_owned_for_update=lambda *_: task),
        messages=SimpleNamespace(get=lambda key, _: saved.get(key), add=lambda message: saved.update({message.id: message})),
        commit=Mock(),
    )
    execution = SimpleNamespace(uow_factory=lambda: nullcontext(uow),
                                _authorize_query=lambda **_: (SimpleNamespace(orgs=["A"]), [catalog], []))
    calculator = CalculationApplicationService(execution)
    service = GeneralAnalysisService(None, execution, calculator, secret="isolated")
    payload = AnalysisRequest.model_validate({
        "conversation_id": task.conversation_id, "execution_mode": "inquiry", "org_codes": ["A"],
        "calculation_context": {"scope_id": "test-turn", "user_question": "比较变化"},
        "plan": {"objective": "比较变化", "scope_notice": "甲行",
                 "requirements": [{"id": "q1", "question": "比较变化"}],
                 "steps": [{"id": "s1", "method": "compare", "metric_refs": ["test-binding"],
                            "answers": ["q1"], "comparisons": ["mom"], "rationale": "核对取值差额"}]},
    })
    context = {"payload": payload, "actor": actor, "run_id": "analysis:test-run",
               "bindings": {"test-binding": metric}, "org_codes": ["A"], "org_names": {"A": "甲行"},
               "today": date(2026, 10, 26), "semantics": SimpleNamespace(comparison_candidates=lambda _: []),
               "state": {"query_count": 1, "completed_steps": {}}}
    return service, context, metric, facts, saved


@pytest.mark.parametrize("encoding,current,base,expected,display", [
    ("ratio", "0.035", "0.01", "0.025", "2.50个百分点"),
    ("percent", "3.5", "1", "2.5", "2.50个百分点"),
    ("ratio", "-0.01", "0.01", "-0.02", "-2.00个百分点"),
    ("percent", "0", "0", "0", "0.00个百分点"),
    ("ratio", "0.1234567890123456789012345678901234567890", "0.1",
     "0.0234567890123456789012345678901234567890", "2.35个百分点"),
])
def test_percentage_difference_uses_real_calculator_and_keeps_catalog_precision(
    encoding, current, base, expected, display,
):
    service, context, metric, facts, saved = comparison_fixture(current, base, encoding=encoding)
    result = service._calculate(context, metric, facts[0], facts[1], "mom")
    context["state"]["completed_steps"]["s1"] = {
        "step_id": "s1", "answers": ["q1"], "facts": facts, "calculations": [result],
        "observations": [], "tasks": [{"task_id": "test-task"}], "gaps": [],
    }
    evidence = service._finish(context)
    atom = next(item for item in evidence["evidence_items"] if item["type"] == "calculation")
    assert Decimal(atom["value"]) == Decimal(expected)
    assert atom["display"] == display
    assert atom["unit"] == "%"
    assert atom["input_fact_refs"] == [fact["fact_id"] for fact in facts]
    receipt = next(iter(saved.values())).payload["result"]
    assert receipt["results"][0]["expression"] == "current-base"
    # 计算回执保留计算器归一值，证据展示按目录的原单位还原，不能修改存储的原始事实。
    with localcontext() as precision:
        precision.prec = 60
        assert Decimal(receipt["results"][0]["value"]) * 100 == Decimal(expected)
    assert receipt["inputs"]["current"]["value"] == current
    answer = report("两期取值差额为{{" + atom["ref"] + "}}。", source=evidence)
    assert answer["status"] == "succeeded"
    assert answer["report"]["summary"] == f"两期取值差额为{display}。"


def test_unapproved_percentage_encoding_still_has_no_computable_result():
    service, context, metric, facts, saved = comparison_fixture("0.035", "0.01", encoding=None)
    assert service._calculate(context, metric, facts[0], facts[1], "mom") is None
    assert not saved


def test_model_cannot_inline_conversion_or_business_constants():
    service, context, _, facts, _ = comparison_fixture("3.5", "1", encoding="percent")
    request = CalculationRequest(
        conversation_id=context["payload"].conversation_id, scope_id="test-turn", scope_policy="cross_date",
        expressions=[{"name": "forged", "label": "未绑定常量", "expression": "(current-base)*100"}],
        bindings={"current": {"fact_id": facts[0]["fact_id"]}, "base": {"fact_id": facts[1]["fact_id"]}},
    )
    with pytest.raises(ApplicationError) as error:
        service.calculation.calculate(request, context["actor"], "untrusted")
    assert error.value.code == "CALCULATION_INVALID"
    assert "业务数值须使用数据引用" in error.value.message


@pytest.mark.parametrize("current,base,difference,rate", [
    ("120", "100", "20", "0.2"), ("80", "100", "-20", "-0.2"),
    ("0", "0", "0", None), ("10", "-10", "20", None),
])
def test_money_comparison_retains_difference_and_positive_base_rate(current, base, difference, rate):
    service, context, metric, facts, _ = comparison_fixture(current, base, unit="元", encoding=None)
    result = service._calculate(context, metric, facts[0], facts[1], "mom")
    assert Decimal(result["difference_value"]) == Decimal(difference)
    rates = [item for item in result["results"] if item["name"] == "change_rate"]
    if rate is None:
        assert not rates
    else:
        assert len(rates) == 1
        assert Decimal(rates[0]["value"]) == Decimal(rate)


def test_saved_calculation_replay_keeps_original_receipt_and_precision():
    service, context, metric, facts, saved = comparison_fixture("0.035", "0.01")
    first = service._calculate(context, metric, facts[0], facts[1], "mom")
    second = service._calculate(context, metric, facts[0], facts[1], "mom")
    assert first == second
    assert len(saved) == 1


def test_compare_step_and_report_atoms_use_the_same_percentage_difference():
    service, context, _, facts, _ = comparison_fixture("0.035", "0.01")
    context["deadline"] = float("inf")
    context["payload"].date_selection = "exact"
    context["payload"].start = context["payload"].end = date(2026, 8, 31)
    service.execution.planner = SimpleNamespace(max_limit=100)
    service._query = Mock(return_value={"facts": facts, "tasks": [{"task_id": "test-task"}], "gaps": []})
    step = service._execute_step(context, context["payload"].plan.steps[0])
    observation = next(item for item in step["observations"] if item["type"] == "comparison")
    assert observation["direction"] == "增加"
    assert "差额2.50个百分点" in observation["text"]
    assert not step["gaps"]
    assert service._query.call_count == 1
    context["state"]["completed_steps"]["s1"] = step
    evidence = service._finish(context)
    atom = next(item for item in evidence["evidence_items"] if item["type"] == "calculation")
    assert atom["display"] == "2.50个百分点"


def test_structure_share_does_not_apply_difference_conversion():
    service, context, metric, facts, _ = comparison_fixture("25", "100", unit="元", encoding=None)
    facts[1]["date"] = facts[0]["date"]
    result = service._calculate(context, metric, facts[0], facts[1], "结构", share=True)
    assert result["difference_value"] is None
    assert result["results"][0]["name"] == "share"
    assert Decimal(result["results"][0]["value"]) == Decimal("0.25")
    assert result["results"][0]["display_value"] == "25.00"
