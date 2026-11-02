"""空结果兜底必须读取真实原始零行快照；合成回执仅用于隔离测试。"""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_analysis_report_availability import setup_report
from test_analysis_report_claims import evidence

from ask_metric.application.analysis_report import compose_analysis_report
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError


def empty_delivery():
    source, service, request = setup_report("", start=None, end=None)
    source.update(execution_mode="inquiry", tasks=[{"task_id": "task-1", "status": "succeeded"}])
    source["metric_descriptors"] = source["metric_descriptors"][:1]
    source["plan"]["steps"][0]["metric_refs"] = ["total"]
    source["gaps"] = ["查询范围未取得有效值。", "本次请求1家机构，取得有效值0家。"]
    request.fallback = True
    snapshot = SimpleNamespace(
        status="succeeded", row_count=0, rows=[], facts=[], truncated=False,
        calculation_scope_id="scope-1", evidence={"logical_dsl": {
            "metrics": ["total"], "orgs": ["O1"],
            "time": {"start": "2026-04-30", "end": "2026-04-30"},
        }})
    service.tasks.get_task_result = Mock(return_value=snapshot)
    return source, service, request, snapshot


def test_inquiry_empty_delivery_uses_authorized_zero_rows_and_verified_available_date():
    _, service, request, _ = empty_delivery()
    actor = object()
    result = compose_analysis_report(service, actor, request)
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert result["analysis_date"] is None
    assert "2026-04-30" in result["public_answer"]
    assert "各项存款余额当日数" in result["report"]["summary"]
    assert "没有查到记录" in result["report"]["summary"]
    assert "2026-08-27" in result["report"]["summary"]
    assert "不能代替" in result["report"]["summary"]
    assert "取得有效值0家" not in result["public_answer"]
    assert "已取得的数据" not in result["public_answer"]
    service.tasks.get_task_result.assert_called_once_with("task-1", actor, limit=1)


@pytest.mark.parametrize("change", ["filtered_rows", "truncated", "failed", "unexecuted",
                                    "snapshot_failed"])
def test_inquiry_empty_delivery_rejects_unproven_empty_results(change):
    source, service, request, snapshot = empty_delivery()
    if change == "filtered_rows":
        snapshot.row_count, snapshot.rows = 1, [{"metric_value": "123", "unit": None}]
    elif change == "truncated":
        snapshot.truncated = True
    elif change == "failed":
        source["tasks"][0]["status"] = "failed"
    elif change == "unexecuted":
        source["tasks"] = []
    else:
        snapshot.status = "failed"
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_EMPTY_UNCONFIRMED"


def test_inquiry_empty_delivery_describes_only_the_executed_metric_and_period():
    source, service, request, snapshot = empty_delivery()
    metric = {**source["metric_descriptors"][0], "code": "other", "binding_ref": "other",
              "name": "未执行指标"}
    source["metric_descriptors"].append(metric)
    source["plan"]["steps"][0]["metric_refs"].append("other")
    snapshot.evidence["logical_dsl"]["time"] = {"start": "2026-03-31", "end": "2026-03-31"}
    request.availability_requests = []
    result = compose_analysis_report(service, object(), request)
    summary = result["report"]["summary"]
    assert "2026-03-31" in summary
    assert "2026-04-30" not in summary
    assert "未执行指标" not in summary


def test_inquiry_partial_success_with_a_verified_fact_cannot_be_called_empty():
    source, service, request, snapshot = empty_delivery()
    fact = {**evidence()["evidence_items"][0], "ref": "base", "date": "2026-04-30",
            "value": "123", "display": "123元", "unit": "元"}
    row = {"metric_name": fact["metric_name"], "org_name": fact["org_name"],
           "stat_date": fact["date"], "metric_value": fact["display"], "value_role": "分析时点"}
    source.update(evidence_items=[fact], actual_dates=[fact["date"]],
                  analysis_date=fact["date"], rows=[row], row_count=1,
                  gaps=["比较基期暂无数据。"])
    snapshot.row_count, snapshot.rows, snapshot.facts = 1, [row], [fact]
    result = compose_analysis_report(service, object(), request)
    assert result["narrative_repaired"] is True
    assert "123元" in result["report"]["summary"]
    assert "没有查到记录" not in result["report"]["summary"]
    assert {ref for item in result["report"]["body_evidence"]
            for ref in item["evidence_refs"]} == {"base"}
    service.tasks.get_task_result.assert_not_called()


def test_inquiry_empty_delivery_rechecks_snapshot_permission():
    _, service, request, _ = empty_delivery()
    service.tasks.get_task_result.side_effect = PermissionDeniedError()
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.status_code == 403


def test_inquiry_empty_delivery_discards_failed_draft_and_does_not_expand_coverage():
    _, service, request, _ = empty_delivery()
    request.summary = "已经增加999亿元。"
    request.availability_requests = []
    result = compose_analysis_report(service, object(), deepcopy(request))
    assert "999" not in result["public_answer"]
    assert "2026-08-27" not in result["public_answer"]
    assert "没有查到记录" in result["report"]["summary"]
