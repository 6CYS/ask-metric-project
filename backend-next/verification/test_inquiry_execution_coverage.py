"""执行回执透传覆盖范围与查询完整性，不把隔离夹具用作业务验收数据。"""

from copy import deepcopy
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_inquiry_analysis import request, setup_service

from ask_metric.domain.query_execution import QueryExecutionResult


def finish_coverage(coverage, tasks=None, gaps=None, orgs=None):
    service, semantics, _ = setup_service()
    orgs = orgs or ["A"]
    payload = request(semantics, date_selection="available_in_range",
                      start="2026-01-01", end="2026-10-26", org_codes=orgs)
    metric = {"code": "m1", "name": "测试余额", "limitations": []}
    state = {"coverage": coverage, "query_count": len(tasks or []), "completed_steps": {
        "s1": {"step_id": "s1", "answers": ["q1"], "facts": [], "calculations": [],
               "observations": [], "tasks": tasks or [], "gaps": gaps or []},
    }}
    before = deepcopy(state)
    result = service._finish({
        "state": state, "payload": payload, "run_id": "analysis:coverage-test",
        "bindings": {"test-binding": metric}, "org_codes": orgs,
        "org_names": {"A": "甲行", "B": "乙行"}, "today": date(2026, 10, 26),
        "semantics": SimpleNamespace(comparison_candidates=lambda _metrics: []),
    })
    assert state == before
    return result


def coverage_check(*, has_more=False, orgs=None):
    return {
        "scope": "any", "date_count": 2 if has_more else 1,
        "earliest": "2026-08-01" if has_more else "2026-08-27", "latest": "2026-08-27",
        "dates": ["2026-08-27"], "has_more": has_more,
        "request": {"dimension": "dates", "metric_codes": ["m1"],
                    "org_codes": orgs or ["A"], "match": "any", "start": "2026-08-01",
                    "end": "2026-08-31", "page": 1, "page_size": 1},
    }


@pytest.mark.parametrize("has_more", [False, True])
def test_nonempty_coverage_retains_single_point_or_unread_dates(has_more):
    check = coverage_check(has_more=has_more)
    result = finish_coverage({"check": {**check, "private_internal": "not-public"}})
    assert result["coverage_checks"] == [check]
    assert result["empty_coverages"] == []
    assert result["date_selection"] == "available_in_range"
    assert (result["requested_start"], result["requested_end"]) == ("2026-01-01", "2026-10-26")


def test_multi_organization_any_coverage_is_not_split_into_individual_proofs():
    check = coverage_check(orgs=["A", "B"])
    assert finish_coverage({"check": check}, orgs=["A", "B"])["coverage_checks"] == [check]


def test_paged_coverage_preserves_collected_dates_and_budget_gap():
    check = coverage_check(has_more=True)
    check.update(date_count=2001, dates=["2026-08-01", "2026-08-27"],
                 gaps=["区间记录的覆盖检查达到分页预算，仅分析已取得的日期。"])
    check["request"].update(page=40, page_size=50)
    assert finish_coverage({"check": check})["coverage_checks"] == [check]


def test_unexecuted_or_old_state_does_not_acquire_coverage_proof():
    assert "coverage_checks" not in finish_coverage({})
    assert "coverage_checks" not in finish_coverage({"unexecuted": {"gaps": ["时间预算已用尽"]}})


@pytest.mark.parametrize("status,truncated,error_code", [
    ("succeeded", False, None),
    ("succeeded", True, None),
    ("failed", False, "QUERY_FAILED"),
])
def test_query_and_final_evidence_keep_original_request_and_execution_state(
    status, truncated, error_code,
):
    service, semantics, actor = setup_service()
    service.tasks.submit_question = Mock(return_value=SimpleNamespace(task_id="task-1", version=1))
    service.execution.execute = Mock(return_value=QueryExecutionResult(
        task_id="task-1", status=status, truncated=truncated, error_code=error_code,
        query_shape="basic_query", facts=[],
    ))
    service._save = Mock()
    context = {"org_codes": ["A"], "state": {"query_results": {}, "query_count": 0},
               "run_id": "run-1", "lease": "lease-1", "deadline": float("inf"),
               "payload": request(semantics), "actor": actor}
    result = service._query(context, {"code": "m1", "name": "测试余额"}, [date(2026, 8, 27)])
    task = result["tasks"][0]
    assert (task["status"], task["truncated"], task["error_code"]) == (
        status, truncated, error_code,
    )
    assert task["request"]["metric_codes"] == ["m1"]
    assert task["request"]["org_codes"] == ["A"]
    assert task["request"]["time"] == {
        "start": "2026-08-27", "end": "2026-08-27", "dates": None,
    }
    assert task["request"]["selection"] == "exact"
    assert finish_coverage({}, result["tasks"], result["gaps"])["tasks"] == [task]
    assert service._query(context, {"code": "m1", "name": "测试余额"},
                          [date(2026, 8, 27)]) == result
    service.execution.execute.assert_called_once()


def test_query_budget_exhaustion_does_not_create_successful_task():
    service, semantics, actor = setup_service()
    service.execution.execute = Mock()
    context = {"org_codes": ["A"], "state": {"query_results": {}, "query_count": 40},
               "payload": request(semantics), "actor": actor, "deadline": float("inf")}
    result = service._query(context, {"code": "m1", "name": "测试余额"}, [date(2026, 8, 27)])
    evidence = finish_coverage({}, result["tasks"], result["gaps"])
    assert evidence["tasks"] == []
    assert "coverage_checks" not in evidence
    assert evidence["complete"] is False
    service.execution.execute.assert_not_called()
