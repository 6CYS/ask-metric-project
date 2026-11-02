"""直接查询只放宽每批取证完整性，签名、范围与历史归属仍由服务端核验。"""

from contextlib import nullcontext
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from ask_metric.api.routes import analysis
from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem


def setup_service():
    actor = ActorContext(subject="u1", user_id="u1", org_id="A", role_code="USER",
                         authentication_method="test", trust_level="authenticated")
    metrics = [MetricCatalogItem(code="m1", name="测试余额"),
               MetricCatalogItem(code="m2", name="测试利润")]
    semantics = MetricSemantics(metrics, secret="test", actor_id="u1")
    uow = SimpleNamespace(organization_catalog=SimpleNamespace(
        list_enabled=lambda: [SimpleNamespace(code="A", name="甲行"),
                              SimpleNamespace(code="B", name="乙行")]))
    permissions = Mock()
    permissions.authorize_logical_dsl.side_effect = lambda **kwargs: {
        "orgs": [code for code in kwargs["logical_dsl"]["orgs"] if code == "A"]}
    service = GeneralAnalysisService(SimpleNamespace(uow_factory=lambda: nullcontext(uow)),
        SimpleNamespace(permission_service=permissions, today_provider=lambda: date(2026, 10, 26)),
        None, secret="test")
    service.semantics = Mock(return_value=semantics)
    service._claim = Mock(return_value=("run-1", None, {}))
    service.authorized_evidence = Mock(return_value={"kind": "analysis_evidence"})
    return service, semantics, actor


def request(semantics, code="m1", **overrides):
    reference = semantics.search(code)["items"][0]["binding_ref"]
    return AnalysisRequest.model_validate({
        "execution_mode": "inquiry", "conversation_id": "c1", "org_codes": ["A"],
        "calculation_context": {"scope_id": "turn", "user_question": "测试余额和测试利润各是多少"},
        "plan": {"objective": "读取本批指标", "scope_notice": "甲行",
                 "requirements": [{"id": "q1", "question": "测试余额和测试利润各是多少"}],
                 "steps": [{"id": "s1", "method": "observe", "metric_refs": [reference],
                            "answers": ["q1"], "rationale": "分别取证"}]}, **overrides})


def test_inquiry_can_execute_two_batches_without_rewriting_the_original_question():
    service, semantics, actor = setup_service()
    for code in ("m1", "m2"):
        payload = request(semantics, code)
        assert service.execute(payload, actor, code) == {"kind": "analysis_evidence"}
        assert payload.calculation_context.user_question == "测试余额和测试利润各是多少"
    assert service._claim.call_count == 2


def test_planned_default_still_requires_all_explicit_metrics():
    service, semantics, actor = setup_service()
    payload = request(semantics).model_dump()
    del payload["execution_mode"]
    with pytest.raises(ApplicationError) as error:
        service.execute(AnalysisRequest.model_validate(payload), actor, "one")
    assert error.value.code == "ANALYSIS_EXPLICIT_METRIC_MISSING"
    service._claim.assert_not_called()


@pytest.mark.parametrize("change", ["unknown", "different_actor", "organization"])
def test_inquiry_cannot_bypass_metric_identity_or_organization_permission(change):
    service, semantics, actor = setup_service()
    payload = request(semantics)
    if change == "unknown":
        payload.plan.steps[0].metric_refs = ["made-up"]
    elif change == "different_actor":
        other = MetricSemantics(list(semantics.items.values()), secret="test", actor_id="other")
        payload.plan.steps[0].metric_refs = [other.search("m1")["items"][0]["binding_ref"]]
    else:
        payload.org_codes = ["B"]
    with pytest.raises(ApplicationError) as error:
        service.execute(payload, actor, "one")
    assert error.value.code == ("ANALYSIS_FORBIDDEN" if change == "organization"
                                else "ANALYSIS_BINDING_INVALID")
    service._claim.assert_not_called()


def test_evidence_read_requires_current_authorization_and_conversation_ownership():
    service = SimpleNamespace(authorized_evidence=Mock(return_value={
        "run_ref": "run-1", "conversation_id": "c1"}))
    actor = object()
    assert analysis.read_analysis_evidence("run-1", "c1", actor, service)["run_ref"] == "run-1"
    service.authorized_evidence.assert_called_with(actor, "run-1")
    with pytest.raises(ApplicationError) as error:
        analysis.read_analysis_evidence("run-1", "other-conversation", actor, service)
    assert error.value.code == "ANALYSIS_RUN_NOT_FOUND"
    service.authorized_evidence.side_effect = ApplicationError(
        "ANALYSIS_FORBIDDEN", "无权", status_code=403)
    with pytest.raises(ApplicationError, match="无权"):
        analysis.read_analysis_evidence("run-1", "c1", actor, service)


@pytest.mark.parametrize("days, expected_period", [
    ([date(2026, 7, 31)], "2026-07-31"),
    ([date(2026, 8, 27), date(2026, 7, 31), date(2026, 7, 31)], "2026-07-31、2026-08-27"),
])
def test_empty_exact_query_formats_actual_date_objects_and_reuses_result(days, expected_period):
    service, semantics, actor = setup_service()
    service.tasks.submit_question = Mock(return_value=SimpleNamespace(task_id="task-1", version=1))
    service.execution.execute = Mock(return_value=SimpleNamespace(
        status="succeeded", truncated=False, facts=[], task_id="task-1"))
    service._save = Mock()
    context = {"org_codes": ["A"], "state": {"query_results": {}, "query_count": 0},
               "run_id": "run-1", "lease": "lease-1", "deadline": float("inf"),
               "payload": request(semantics), "actor": actor}
    metric = {"code": "m1", "name": "测试余额"}

    result = service._query(context, metric, days)

    assert result == {"facts": [], "tasks": [{"task_id": "task-1", "status": "succeeded"}],
                      "gaps": [f"测试余额在{expected_period}没有可用数据。"]}
    assert service._query(context, metric, days) == result
    service.execution.execute.assert_called_once()
