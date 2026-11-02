"""无日期覆盖与未执行必须区分；使用隔离数据源走执行器到报告的完整空结果路径。"""

from copy import deepcopy
from datetime import date
from unittest.mock import Mock

import pytest
from test_inquiry_empty_delivery import empty_delivery

from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.analysis_report import compose_analysis_report
from ask_metric.core.errors import ApplicationError


def empty_period(selection="latest_in_range", *, deadline=float("inf")):
    source, reporting, request, _ = empty_delivery()
    reporting.execution.data_source.execute_readonly.return_value.rows = []
    executor = GeneralAnalysisService(reporting.tasks, reporting.execution, None, secret="test")
    executor._save = Mock()
    semantics = reporting.semantics(None)
    semantics.comparison_candidates = lambda _metrics: []
    metric = {**source["metric_descriptors"][0], "limitations": []}
    payload = AnalysisRequest.model_validate({
        "execution_mode": "inquiry", "conversation_id": source["conversation_id"],
        "org_codes": source["org_codes"], "date_selection": selection,
        "start": "2026-07-01", "end": "2026-09-30",
        "calculation_context": {"scope_id": source["scope_id"], "user_question": "今年三季度如何"},
        "plan": {"objective": "观察指定季度", "scope_notice": "测试机构",
                 "requirements": [{"id": "q1", "question": "今年三季度如何"}],
                 "steps": [{"id": "s1", "method": "observe", "metric_refs": ["total"],
                            "answers": ["q1"], "rationale": "核对实际期间"}]},
    })
    context = {"payload": payload, "actor": object(), "run_id": "analysis:empty-quarter",
               "lease": "test-lease", "deadline": deadline, "today": date(2026, 10, 26),
               "org_codes": source["org_codes"], "org_names": {"O1": "测试机构"},
               "bindings": {"total": metric}, "semantics": semantics,
               "state": {"coverage": {}, "query_results": {}, "query_count": 0,
                         "completed_steps": {}}}
    step = executor._execute_step(context, payload.plan.steps[0])
    context["state"]["completed_steps"]["s1"] = step
    source.clear()
    source.update(executor._finish(context))
    request.run_refs = [source["run_ref"]]
    request.availability_requests = []
    return source, reporting, request


@pytest.mark.parametrize("selection", ["latest_in_range", "all_in_range"])
def test_verified_empty_quarter_without_value_task_can_deliver(selection):
    source, service, request = empty_period(selection)
    assert source["tasks"] == []
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert "2026-07-01至2026-09-30" in result["report"]["summary"]
    assert "没有查到记录" in result["report"]["summary"]
    assert service.execution.data_source.execute_readonly.call_count == 1
    service.tasks.get_task_result.assert_not_called()


def test_unexecuted_period_does_not_gain_empty_result_proof():
    source, service, request = empty_period(deadline=0)
    assert not source.get("empty_coverages")
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_EMPTY_UNCONFIRMED"
    service.execution.data_source.execute_readonly.assert_not_called()


def test_empty_period_uses_the_existing_authorized_source_read():
    _, service, request = empty_period()
    service.authorized_evidence = Mock(side_effect=ApplicationError(
        "ANALYSIS_FORBIDDEN", "无权读取分析范围。", status_code=403))
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.status_code == 403
    assert service.execution.data_source.execute_readonly.call_count == 1


def test_empty_snapshot_does_not_requery_or_replace_itself_with_later_records():
    _, service, request = empty_period()
    service.execution.data_source.execute_readonly.return_value.rows = [{
        "scope": "any", "org_code": "", "metric_code": "", "date_count": 1,
        "earliest": "2026-08-27", "latest": "2026-08-27", "stat_date": "2026-08-27",
    }]
    result = compose_analysis_report(service, object(), request)
    assert "没有查到记录" in result["report"]["summary"]
    assert service.execution.data_source.execute_readonly.call_count == 1


def test_coverage_proof_cannot_expand_source_scope():
    source, service, request = empty_period()
    proof = deepcopy(source["empty_coverages"])
    proof[0]["request"]["org_codes"] = ["O2"]
    source["empty_coverages"] = proof
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_EMPTY_UNCONFIRMED"
    assert service.execution.data_source.execute_readonly.call_count == 1
