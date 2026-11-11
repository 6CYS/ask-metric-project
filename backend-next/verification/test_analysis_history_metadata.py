"""历史展示编码修复；查询快照与目录为隔离样本，不代表真实业务验收。"""

import base64
import json
from copy import deepcopy
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.application.verified_findings import attach_analysis_findings
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem


def history_service():
    actor = SimpleNamespace(user_id="test-user", subject="test-user")
    catalog = [
        MetricCatalogItem(code="rate", name="测试增幅", unit="%"),
        MetricCatalogItem(code="balance", name="测试余额", unit="元"),
    ]
    before = MetricSemantics(catalog, secret="test", actor_id=actor.user_id, topics={})
    before.topic_attributes["rate"] = {"source": "隔离编码配置", "value_encoding": None}
    current = MetricSemantics(catalog, secret="test", actor_id=actor.user_id, topics={})
    current.topic_attributes["rate"] = {"source": "隔离编码配置", "value_encoding": "ratio"}
    descriptors = []
    for code in ("balance", "rate"):
        descriptor = before.descriptor(code)
        descriptors.append(before.resolve(before.binding(descriptor, "测试")))
    bindings = {item["binding_ref"]: item for item in descriptors}
    request = AnalysisRequest.model_validate(
        {
            "conversation_id": "conversation",
            "execution_mode": "inquiry",
            "org_codes": ["O1"],
            "date_selection": "exact",
            "start": "2026-09-30",
            "end": "2026-09-30",
            "calculation_context": {"scope_id": "old-turn", "user_question": "测试余额和增幅"},
            "plan": {
                "objective": "测试余额和增幅",
                "scope_notice": "甲行",
                "requirements": [{"id": "q1", "question": "测试余额和增幅"}],
                "steps": [
                    {
                        "id": "s1",
                        "method": "observe",
                        "metric_refs": list(bindings),
                        "answers": ["q1"],
                        "rationale": "读取正式指标",
                    }
                ],
            },
        }
    )
    facts = [
        {
            "fact_id": f"fact:task:{index}:metric_value",
            "task_id": "task",
            "metric_code": metric["code"],
            "metric_name": metric["name"],
            "value": value,
            "unit": metric["unit"],
            "org_code": "O1",
            "org_name": "甲行",
            "date": "2026-09-30",
        }
        for index, (metric, value) in enumerate(
            zip(descriptors, ["120.001", "0.0892825203"], strict=True)
        )
    ]
    step_facts = [
        {**fact, "role": "current", "binding_ref": metric["binding_ref"]}
        for fact, metric in zip(facts, descriptors, strict=True)
    ]
    state = {
        "status": "completed",
        "request": request.model_dump(mode="json"),
        "coverage": {},
        "query_results": {},
        "query_count": 1,
        "org_codes": ["O1"],
        "completed_steps": {
            "s1": {
                "step_id": "s1",
                "method": "observe",
                "answers": ["q1"],
                "facts": step_facts,
                "calculations": [],
                "observations": [
                    {
                        "type": "value",
                        "metric": "rate",
                        "fact_refs": [facts[1]["fact_id"]],
                        "text": "旧显示：0.0892825203（数值编码待确认）",
                    }
                ],
                "tasks": [
                    {
                        "task_id": "task",
                        "status": "succeeded",
                        "truncated": False,
                        "request": {"metric_codes": ["balance", "rate"]},
                    }
                ],
                "gaps": [],
            }
        },
    }
    tasks = SimpleNamespace(
        get_task=Mock(),
        get_task_result=Mock(
            return_value=SimpleNamespace(facts=deepcopy(facts), status="succeeded", truncated=False)
        ),
    )
    service = GeneralAnalysisService(tasks, None, None, secret="test")
    evidence = service._finish(
        {
            "state": state,
            "payload": request,
            "run_id": "analysis:old",
            "org_codes": ["O1"],
            "org_names": {"O1": "甲行"},
            "bindings": bindings,
            "semantics": before,
            "today": date(2026, 11, 11),
        }
    )
    attach_analysis_findings(evidence)
    state["result"] = evidence
    service._read_run = Mock(side_effect=lambda *_: deepcopy(state))
    service.semantics = Mock(return_value=current)
    return service, actor, state, before, current


def test_history_read_rebuilds_encoding_from_raw_snapshot_without_rewriting_history():
    service, actor, state, _, current = history_service()
    original = deepcopy(state)
    result = service.authorized_evidence(actor, "analysis:old")
    rate = next(item for item in result["metric_descriptors"] if item["code"] == "rate")
    fact = next(item for item in result["evidence_items"] if item.get("metric_code") == "rate")
    assert rate["value_encoding"] == "ratio"
    assert current.resolve(rate["binding_ref"])["metadata_version"] == fact["metadata_version"]
    assert fact["value"] == "0.0892825203"
    assert fact["display"] == "8.93%"
    assert result["rows"][1]["metric_value"] == "8.93%"
    assert "8.93%" in result["observations"][0]["text"]
    assert result["evidence_items"][1]["ref"] == original["result"]["evidence_items"][1]["ref"]
    assert state == original


def test_unselected_old_rate_does_not_block_balance_only_history_report():
    service, actor, state, _, _ = history_service()
    ref = state["result"]["evidence_items"][0]["ref"]
    result = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest.model_validate(
            {
                "run_refs": ["analysis:old"],
                "context_run_refs": ["analysis:old"],
                "focus_refs": [ref],
                "summary": f"甲行测试余额为{{{{{ref}}}}}。",
                "preview": True,
            }
        ),
    )
    assert "120.00元" in result["preview_text"]
    assert "8.93" not in result["preview_text"]


@pytest.mark.parametrize(
    "change", ["unit", "description", "explanation", "source_metric_code", "relation"]
)
def test_real_definition_changes_require_targeted_requery(change):
    service, actor, _, _, current = history_service()
    if change == "relation":
        current.extensions["relations"].append(
            {
                "id": "changed",
                "status": "approved",
                "parent": "rate",
                "children": ["balance"],
            }
        )
    else:
        current.items["rate"] = current.items["rate"].model_copy(update={change: "已变更"})
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"
    assert "重新查询" in caught.value.message
    assert set(caught.value.details["metric_codes"]) <= {"balance", "rate"}


@pytest.mark.parametrize("change", ["signature", "actor", "descriptor"])
def test_stale_binding_cannot_bypass_identity_or_authenticated_version(change):
    service, actor, state, _, current = history_service()
    metric = state["result"]["metric_descriptors"][1]
    if change == "signature":
        metric["binding_ref"] = metric["binding_ref"][:-1] + "x"
    elif change == "actor":
        current.actor_id = "different-user"
    else:
        metric["description"] = "篡改旧目录以伪装兼容"
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code in {"ANALYSIS_BINDING_INVALID", "ANALYSIS_METADATA_CHANGED"}


@pytest.mark.parametrize(
    "field,value", [("value", "0.9"), ("unit", "元"), ("org_code", "O2"), ("date", "2026-08-31")]
)
def test_encoding_refresh_rejects_conflicting_original_fact(field, value):
    service, actor, _, _, _ = history_service()
    service.tasks.get_task_result.return_value.facts[1][field] = value
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"


def test_current_history_does_not_re_read_query_snapshots():
    service, actor, state, before, _ = history_service()
    service.semantics.return_value = before
    service.tasks.get_task_result.side_effect = AssertionError("未变更口径不得重新读数")
    assert service.authorized_evidence(actor, "analysis:old") == state["result"]


def test_snapshot_permission_failure_is_preserved():
    service, actor, _, _, _ = history_service()
    service.tasks.get_task_result.side_effect = ApplicationError(
        "RESULT_FORBIDDEN", "当前无权读取原始查询", status_code=403
    )
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.status_code == 403


def test_changed_encoding_does_not_silently_drop_previous_calculations():
    service, actor, state, _, _ = history_service()
    state["completed_steps"]["s1"]["calculations"].append(
        {
            "metric_descriptor": state["result"]["metric_descriptors"][1],
            "inputs": {},
        }
    )
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"
    assert "重新查询" in caught.value.message


def test_execution_resolve_remains_strict_for_old_binding():
    _, _, state, _, current = history_service()
    with pytest.raises(ApplicationError) as caught:
        current.resolve(state["result"]["metric_descriptors"][1]["binding_ref"])
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"


def test_old_binding_cannot_authenticate_a_replaced_descriptor_version():
    service, actor, state, _, current = history_service()
    metric = state["result"]["metric_descriptors"][1]
    metric["value_encoding"] = "percent"
    content = {
        key: value
        for key, value in metric.items()
        if key not in {"binding_ref", "metadata_version", "discovery_keyword"}
    }
    metric["metadata_version"] = current._metadata_version(content)
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_BINDING_INVALID"


@pytest.mark.parametrize("failure", ["missing_fact", "truncated", "ranking"])
def test_unverifiable_snapshot_requires_requery(failure):
    service, actor, state, _, _ = history_service()
    if failure == "missing_fact":
        service.tasks.get_task_result.return_value.facts = []
    elif failure == "truncated":
        service.tasks.get_task_result.return_value.truncated = True
    else:
        state["completed_steps"]["s1"]["observations"][0]["type"] = "ranking"
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"
    assert caught.value.details["metric_codes"] == ["rate"]


def test_history_recovery_keeps_conversation_boundary():
    from ask_metric.api.routes.analysis import read_analysis_evidence

    service, actor, _, _, _ = history_service()
    with pytest.raises(ApplicationError) as caught:
        read_analysis_evidence("analysis:old", "other-conversation", actor, service)
    assert caught.value.code == "ANALYSIS_RUN_NOT_FOUND"


def test_missing_query_snapshot_returns_targeted_requery_instead_of_reusing_old_facts():
    service, actor, _, _, _ = history_service()
    service.tasks.get_task_result.side_effect = ApplicationError(
        "RESULT_SNAPSHOT_MISSING", "原始快照缺失", status_code=409
    )
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"
    assert caught.value.details["metric_codes"] == ["rate"]


def save_history_evidence(service, state, semantics, bindings=None):
    request = AnalysisRequest.model_validate(state["request"])
    if bindings is None:
        bindings = {
            ref: semantics.resolve(ref) for step in request.plan.steps for ref in step.metric_refs
        }
    state["result"] = service._finish(
        {
            "state": state,
            "payload": request,
            "run_id": "analysis:old",
            "org_codes": ["O1"],
            "org_names": {"O1": "甲行"},
            "bindings": bindings,
            "semantics": semantics,
            "today": date(2026, 11, 11),
        }
    )
    attach_analysis_findings(state["result"])


def unordered_history_service():
    service, actor, state, before, current = history_service()
    original = state["completed_steps"]["s1"]
    steps = {}
    plan_steps = []
    for step_id, code in (("s2", "balance"), ("s1", "rate")):
        fact = deepcopy(next(fact for fact in original["facts"] if fact["metric_code"] == code))
        steps[step_id] = {
            **deepcopy(original),
            "step_id": step_id,
            "facts": [fact],
            "observations": [
                {
                    "type": "value",
                    "metric": code,
                    "fact_refs": [fact["fact_id"]],
                    "text": f"旧{code}数值",
                }
            ],
            "gaps": [f"{code}的补充期间未取得数据。"],
        }
        plan_steps.append(
            {
                **state["request"]["plan"]["steps"][0],
                "id": step_id,
                "metric_refs": [fact["binding_ref"]],
            }
        )
    state["completed_steps"] = steps
    state["request"]["plan"]["steps"] = plan_steps
    save_history_evidence(service, state, before)
    # 模拟 MySQL JSON 重新排列对象键；保留已经发布的 result 引用作为事实身份基准。
    state["completed_steps"] = dict(reversed(list(steps.items())))
    return service, actor, state, before, current


def test_history_refresh_preserves_published_refs_when_completed_steps_are_reordered():
    service, actor, state, _, _ = unordered_history_service()
    original = deepcopy(state)
    prior_atoms = {atom["ref"]: atom for atom in state["result"]["evidence_items"]}
    prior_observations = {item["ref"]: item for item in state["result"]["observations"]}

    result = service.authorized_evidence(actor, "analysis:old")

    atoms = {atom["ref"]: atom for atom in result["evidence_items"]}
    observations = {item["ref"]: item for item in result["observations"]}
    assert result["run_ref"] == "analysis:old"
    assert atoms.keys() == prior_atoms.keys()
    assert observations.keys() == prior_observations.keys()
    for ref, old in prior_atoms.items():
        assert atoms[ref]["type"] == old["type"]
        assert atoms[ref].get("fact_id") == old.get("fact_id")
        assert atoms[ref].get("metric_code") == old.get("metric_code")
        assert atoms[ref].get("step_ids") == old.get("step_ids")
        if old["type"] == "gap":
            assert atoms[ref]["display"] == old["display"]
    for ref, old in prior_observations.items():
        assert observations[ref]["metric"] == old["metric"]
        assert observations[ref]["fact_refs"] == old["fact_refs"]
    assert atoms["old.f1"]["metric_code"] == "balance"
    assert state == original


def test_old_balance_body_reference_stays_balance_after_step_order_changes():
    service, actor, _, _, _ = unordered_history_service()
    result = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest.model_validate(
            {
                "run_refs": ["analysis:old"],
                "context_run_refs": ["analysis:old"],
                "focus_refs": ["old.f1"],
                "summary": "甲行测试余额为{{old.f1}}。",
                "preview": True,
            }
        ),
    )
    assert "测试余额为120.00元" in result["preview_text"]
    assert "8.93%" not in result["preview_text"]


@pytest.mark.parametrize("corruption", ["missing", "duplicate", "replaced_fact"])
def test_history_refresh_rejects_unmappable_published_references(corruption):
    service, actor, state, _, _ = unordered_history_service()
    if corruption == "missing":
        state["result"]["evidence_items"].pop(0)
    elif corruption == "duplicate":
        duplicate = deepcopy(state["result"]["evidence_items"][0])
        duplicate["ref"] = "old.other-fact"
        state["result"]["evidence_items"].append(duplicate)
    else:
        state["result"]["evidence_items"][0]["fact_id"] = "fact:task:9:metric_value"
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"


def legacy_reference(semantics, code, keyword):
    body = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "c": code,
                    "v": semantics.descriptor(code)["metadata_version"],
                    "q": keyword,
                }
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"{body}.{semantics._signature(body)}"


def legacy_alias_history_service():
    service, actor, state, before, current = history_service()
    original = state["completed_steps"]["s1"]
    rate = original["facts"][1]
    refs = [legacy_reference(before, "rate", word) for word in ("增幅", "增长率")]
    steps, plan_steps = {}, []
    for index, reference in enumerate(refs, 1):
        step_id = f"s{index}"
        steps[step_id] = {
            **deepcopy(original),
            "step_id": step_id,
            "facts": [{**rate, "binding_ref": reference}],
        }
        plan_steps.append(
            {**state["request"]["plan"]["steps"][0], "id": step_id, "metric_refs": [reference]}
        )
    state["completed_steps"] = steps
    state["request"]["plan"]["steps"] = plan_steps
    save_history_evidence(service, state, before)
    return service, actor, state, before, current


def test_history_refresh_accepts_multiple_signed_legacy_keywords_for_same_metric():
    service, actor, state, _, current = legacy_alias_history_service()
    original = deepcopy(state)
    assert len(state["result"]["metric_descriptors"]) == 1

    result = service.authorized_evidence(actor, "analysis:old")

    metric = result["metric_descriptors"][0]
    assert metric["value_encoding"] == "ratio"
    assert current.resolve(metric["binding_ref"])["code"] == "rate"
    assert {ref for step in result["plan"]["steps"] for ref in step["metric_refs"]} == {
        metric["binding_ref"]
    }
    facts = [atom for atom in result["evidence_items"] if atom["type"] == "fact"]
    assert len(facts) == 1
    assert facts[0]["ref"] == "old.f1"
    assert facts[0]["value"] == "0.0892825203"
    assert facts[0]["display"] == "8.93%"
    assert len(result["observations"]) == 2
    assert state == original


@pytest.mark.parametrize("corruption", ["signature", "version", "unknown_fact_ref"])
def test_history_refresh_rejects_unverified_legacy_aliases(corruption):
    service, actor, state, before, current = legacy_alias_history_service()
    reference = state["request"]["plan"]["steps"][0]["metric_refs"][0]
    if corruption == "signature":
        invalid = reference[:-1] + "x"
    elif corruption == "version":
        invalid = legacy_reference(current, "rate", "新版本不能替代原始版本")
    else:
        invalid = legacy_reference(before, "rate", "未登记计划的引用")
    state["completed_steps"]["s1"]["facts"][0]["binding_ref"] = invalid
    if corruption != "unknown_fact_ref":
        state["request"]["plan"]["steps"][0]["metric_refs"] = [invalid]
    with pytest.raises(ApplicationError) as caught:
        service.authorized_evidence(actor, "analysis:old")
    assert caught.value.code in {"ANALYSIS_METADATA_CHANGED", "ANALYSIS_BINDING_INVALID"}


@pytest.mark.parametrize("kind", ["calculation", "ranking"])
def test_reordered_history_preserves_unaffected_calculation_and_judgment_dependencies(kind):
    from ask_metric.application.analysis_report_view import validated_report_atoms

    service, actor, state, before, _ = unordered_history_service()
    state["completed_steps"] = dict(reversed(list(state["completed_steps"].items())))
    balance = state["completed_steps"]["s2"]
    fact = balance["facts"][0]
    other = {**fact, "fact_id": "fact:task:2:metric_value", "value": "100.001"}
    if kind == "calculation":
        other.update(date="2026-08-31", role="base")
        balance["method"] = "compare"
        balance["calculations"] = [
            {
                "calculation_id": "comparison",
                "metric_descriptor": before.resolve(fact["binding_ref"]),
                "comparison": "mom",
                "org_code": "O1",
                "date": "2026-09-30",
                "difference_value": "20.000",
                "inputs": {"current": fact, "base": other},
                "results": [
                    {
                        "name": "difference",
                        "value": "20.000",
                        "display_value": "20.00",
                        "unit": "元",
                    }
                ],
            }
        ]
        balance["observations"].append(
            {
                "type": "comparison",
                "metric": "balance",
                "calculation_id": "comparison",
                "fact_refs": [fact["fact_id"], other["fact_id"]],
                "direction": "增加",
                "text": "余额较上期增加20.00元。",
            }
        )
        state["request"]["plan"]["steps"][0].update(method="compare", comparisons=["mom"])
    else:
        other.update(org_code="O2", org_name="乙行")
        balance["method"] = "ranking"
        balance["observations"].append(
            {
                "type": "ranking",
                "metric": "balance",
                "fact_refs": [fact["fact_id"]],
                "comparison_fact_refs": [fact["fact_id"], other["fact_id"]],
                "date": "2026-09-30",
                "org_code": "O1",
                "rank": 1,
                "position": "top",
                "text": "甲行余额在两家机构中排名第一。",
            }
        )
        state["request"]["plan"]["steps"][0].update(method="ranking", top_n=1)
        state["request"]["org_codes"] = state["org_codes"] = ["O1", "O2"]
    balance["facts"].append(other)
    bindings = {
        ref: before.resolve(ref)
        for step in state["request"]["plan"]["steps"]
        for ref in step["metric_refs"]
    }
    state["result"] = service._finish(
        {
            "state": state,
            "payload": AnalysisRequest.model_validate(state["request"]),
            "run_id": "analysis:old",
            "org_codes": state["org_codes"],
            "org_names": {"O1": "甲行", "O2": "乙行"},
            "bindings": bindings,
            "semantics": before,
            "today": date(2026, 11, 11),
        }
    )
    attach_analysis_findings(state["result"])
    original = deepcopy(state["result"])
    state["completed_steps"] = dict(reversed(list(state["completed_steps"].items())))

    result = service.authorized_evidence(actor, "analysis:old")

    atoms = validated_report_atoms([result])
    assert set(atoms) == {atom["ref"] for atom in original["evidence_items"]}
    for old in original["evidence_items"]:
        new = atoms[old["ref"]]
        assert new.get("input_refs") == old.get("input_refs")
        assert new.get("input_fact_refs") == old.get("input_fact_refs")
        assert new.get("calculation_id") == old.get("calculation_id")
        if old.get("metric_code") == "balance":
            assert new == old
    assert result["verified_findings"] == original["verified_findings"]
    assert result["verified_findings"]["items"]
    for finding in result["verified_findings"]["items"]:
        assert set(finding["evidence_refs"]) <= atoms.keys()
