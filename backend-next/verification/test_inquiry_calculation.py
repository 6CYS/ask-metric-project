"""隔离查询与存储边界，验证结果比较、原始计算回执及报告引用的衔接。"""

from copy import deepcopy
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_analysis_comparison_calculation import comparison_fixture

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.analysis import get_analysis_service, router
from ask_metric.application.analysis_calculation import (
    AnalysisCalculationRequest,
    CalculationReference,
    attach_calculation_sources,
    calculate_analysis_results,
)
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def setup_comparison(*, unit="%", encoding="ratio", current="0.035", base="0.01"):
    service, context, metric, facts, saved = comparison_fixture(current, base, unit=unit, encoding=encoding)
    context["state"]["completed_steps"]["s1"] = {
        "step_id": "s1", "answers": ["q1"], "facts": facts, "calculations": [],
        "observations": [], "tasks": [{"task_id": "test-task"}], "gaps": [],
    }
    source = service._finish(context)
    service.tasks = SimpleNamespace(uow_factory=service.execution.uow_factory)
    service.authorized_evidence = lambda actor, ref: deepcopy(source)
    service.semantics = lambda actor: SimpleNamespace(
        resolve=lambda ref: metric, items={metric["code"]: SimpleNamespace(name=metric["name"])},
    )
    request = AnalysisCalculationRequest(
        conversation_id="test-conversation", run_refs=[source["run_ref"]],
        current_ref=source["evidence_items"][0]["ref"], base_ref=source["evidence_items"][1]["ref"],
        calculation_context={"scope_id": "new-turn", "user_question": "这两个时点差多少"},
    )
    return service, context["actor"], request, source, saved


def test_reuses_historical_facts_and_returns_reportable_comparison_without_querying():
    service, actor, request, source, saved = setup_comparison()
    result = calculate_analysis_results(service, actor, request, "compare-key")
    assert result["kind"] == "metric_calculate"
    assert result["status"] == "succeeded"
    assert result["evidence_items"][0]["display"] == "2.50个百分点"
    assert Decimal(result["evidence_items"][0]["value"]) == Decimal("0.025")
    assert result["evidence_items"][0]["input_refs"] == [request.current_ref, request.base_ref]
    receipt = next(iter(saved.values())).payload["result"]
    assert receipt["source_policy"] == "conversation_snapshots"
    assert receipt["scope_id"] == "new-turn"
    assert source["evidence_items"][0]["value"] == "0.035"
    original = deepcopy(source)
    attached = attach_calculation_sources(service, actor, [source], [CalculationReference(**result["calculation_ref"])])
    assert attached[0]["evidence_items"][-1] == result["evidence_items"][0]
    assert source == original


@pytest.mark.parametrize("unit,encoding,current,base,expected", [
    ("元", None, "120", "100", "20.00元"),
    ("%", "ratio", "0.035", "0.01", "2.50个百分点"),
])
def test_historical_comparison_across_runs_retains_both_parents_in_focused_report(
    unit, encoding, current, base, expected,
):
    service, actor, request, source, _ = setup_comparison(
        unit=unit, encoding=encoding, current=current, base=base,
    )
    sources = []
    for index, fact in enumerate(source["evidence_items"][:2]):
        item = deepcopy(source)
        item["run_ref"] = f"analysis:source-{index}"
        item["evidence_items"] = [{**fact, "ref": f"{item['run_ref']}.f1"}]
        item["rows"] = [row for row in item["rows"] if row["stat_date"] == fact["date"]]
        item["actual_dates"] = [fact["date"]]
        item["analysis_date"] = fact["date"]
        sources.append(item)
    original = deepcopy(sources)
    service.authorized_evidence = lambda _actor, ref: deepcopy(next(item for item in sources if item["run_ref"] == ref))
    request.run_refs = [item["run_ref"] for item in sources]
    request.current_ref, request.base_ref = [item["evidence_items"][0]["ref"] for item in sources]
    calculated = calculate_analysis_results(service, actor, request, "split-runs")
    atom = calculated["evidence_items"][0]
    result = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=request.run_refs, context_run_refs=request.run_refs, focus_refs=[atom["ref"]],
        calculation_refs=[CalculationReference(**calculated["calculation_ref"])],
        summary="两期差额为{{" + atom["ref"] + "}}。",
    ))
    assert result["status"] == "succeeded"
    assert result["report"]["summary"] == f"两期差额为{expected}。"
    assert {request.current_ref, request.base_ref, atom["ref"]} <= {
        item["ref"] for item in result["evidence_items"]
    }
    assert sources == original


@pytest.mark.parametrize("change,expected_code", [
    ("conversation", "ANALYSIS_CALCULATION_SOURCE"),
    ("reference", "ANALYSIS_CALCULATION_FACT_REQUIRED"),
    ("derived_fact", "ANALYSIS_CALCULATION_FACT_REQUIRED"),
    ("metric", "ANALYSIS_CALCULATION_METRIC_MISMATCH"),
    ("both_dimensions", "ANALYSIS_CALCULATION_SCOPE_MISMATCH"),
    ("encoding", "ANALYSIS_CALCULATION_UNIT_UNCONFIRMED"),
    ("missing_value", "ANALYSIS_CALCULATION_FACT_REQUIRED"),
])
def test_unrelated_or_incomparable_sources_are_rejected_before_calculation(change, expected_code):
    service, actor, request, source, saved = setup_comparison()
    if change == "conversation":
        request.conversation_id = "another-conversation"
    elif change == "reference":
        request.current_ref = "invented"
    elif change == "derived_fact":
        request.current_ref = "observation-only"
        source["evidence_items"].append({"ref": request.current_ref, "type": "observation"})
    elif change == "metric":
        other_metric = {
            **source["metric_descriptors"][0],
            "code": "another-metric", "name": "另一正式指标", "binding_ref": "another-binding",
        }
        source["metric_descriptors"].append(other_metric)
        source["plan"]["steps"][0]["metric_refs"].append(other_metric["binding_ref"])
        source["evidence_items"][1].update(
            metric_code=other_metric["code"], metric_name=other_metric["name"],
        )
    elif change == "both_dimensions":
        source["org_codes"].append("B")
        source["org_names"].append("乙行")
        source["evidence_items"][1].update(org_code="B", org_name="乙行")
    elif change == "missing_value":
        source["evidence_items"][0]["value"] = None
    else:
        source["metric_descriptors"][0]["value_encoding"] = None
    with pytest.raises(ApplicationError) as error:
        calculate_analysis_results(service, actor, request, "invalid")
    assert error.value.code == expected_code
    assert error.value.status_code == 422
    assert not saved


def test_same_key_same_input_replays_and_changed_input_conflicts():
    service, actor, request, _, saved = setup_comparison(unit="元", encoding=None, current="120", base="100")
    first = calculate_analysis_results(service, actor, request, "idempotent")
    assert calculate_analysis_results(service, actor, request, "idempotent") == first
    request.current_ref, request.base_ref = request.base_ref, request.current_ref
    with pytest.raises(ApplicationError) as error:
        calculate_analysis_results(service, actor, request, "idempotent")
    assert error.value.code == "CALCULATION_CONFLICT"
    assert len(saved) == 1


def test_report_rejects_missing_calculation_or_changed_source_value():
    service, actor, request, source, _ = setup_comparison()
    result = calculate_analysis_results(service, actor, request, "stored")
    reference = CalculationReference(**result["calculation_ref"])
    wrong = reference.model_copy(update={"calculation_id": "missing"})
    with pytest.raises(ApplicationError):
        attach_calculation_sources(service, actor, [source], [wrong])
    source["evidence_items"][0]["value"] = "999"
    with pytest.raises(ApplicationError):
        attach_calculation_sources(service, actor, [source], [reference])


def test_http_calculation_and_historical_report_share_verified_sources():
    service, actor, request, _, _ = setup_comparison(unit="元", encoding=None, current="120", base="100")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_analysis_service] = lambda: service
    app.dependency_overrides[require_actor] = lambda: actor
    with TestClient(app) as client:
        response = client.post("/api/v1/analysis/calculations", json=request.model_dump(mode="json"),
                               headers={"Idempotency-Key": "http-compare"})
        assert response.status_code == 200
        calculation = response.json()
        atom = calculation["evidence_items"][0]
        assert Decimal(atom["value"]) == Decimal("20")
        assert atom["display"] == "20.00元"
        rates = [item for item in calculation["evidence_items"] if item["name"] == "change_rate"]
        assert rates[0]["display"] == "20.00%"
        response = client.post("/api/v1/analysis/report", json={
            "run_refs": request.run_refs, "context_run_refs": request.run_refs,
            "focus_refs": [atom["ref"]], "calculation_refs": [calculation["calculation_ref"]],
            "summary": "两期差额为{{" + atom["ref"] + "}}。",
        })
        assert response.status_code == 200
        result = response.json()
        assert result["status"] == "succeeded"
        assert result["report"]["summary"] == f"两期差额为{atom['display']}。"
        assert atom["ref"] in result["report"]["body_evidence"][0]["evidence_refs"]


def test_same_date_cross_organization_comparison_uses_explicit_scope():
    service, actor, request, source, saved = setup_comparison(unit="元", encoding=None, current="120", base="100")
    source["org_codes"].append("B")
    source["org_names"].append("乙行")
    source["evidence_items"][1].update(org_code="B", org_name="乙行", date="2026-08-31")
    with service.execution.uow_factory() as uow:
        task = uow.tasks.get_owned_for_update("test-task", actor.user_id)
        artifact = task.state_json["result_artifact"]
        artifact["logical_dsl"]["orgs"] = ["A", "B"]
        artifact["result"]["facts"][1].update(org_code="B", org_name="乙行", date="2026-08-31")
    service.execution._authorize_query = lambda **_: (
        SimpleNamespace(orgs=["A", "B"]), [SimpleNamespace(code="M1", unit="元")], [],
    )
    result = calculate_analysis_results(service, actor, request, "peer")
    assert Decimal(result["evidence_items"][0]["value"]) == Decimal("20")
    assert next(iter(saved.values())).payload["result"]["scope_policy"] == "cross_org"


def test_revoked_source_permission_is_propagated_without_calculating():
    service, actor, request, _, saved = setup_comparison()
    def forbidden(*_):
        raise ApplicationError("ANALYSIS_FORBIDDEN", "无权", status_code=403)
    service.authorized_evidence = forbidden
    with pytest.raises(ApplicationError) as error:
        calculate_analysis_results(service, actor, request, "forbidden")
    assert error.value.status_code == 403
    assert not saved
