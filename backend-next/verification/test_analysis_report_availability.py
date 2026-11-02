"""覆盖查询只授权日期说明，不替代原始查询的业务事实；数据为隔离测试桩。"""

from contextlib import nullcontext
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_analysis_report_empty import empty_ranking

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError


def setup_report(body, *, availability=True, **coverage_changes):
    source = empty_ranking("2026-04-30")
    semantics = SimpleNamespace(resolve=lambda _ref: None, items={
        item["code"]: SimpleNamespace(name=item["name"])
        for item in source["metric_descriptors"]
    })
    execution = SimpleNamespace(
        permission_service=SimpleNamespace(authorize_logical_dsl=Mock(
            side_effect=lambda *, actor, logical_dsl: logical_dsl)),
        planner=SimpleNamespace(dialect="mysql"),
        sql_builder=SimpleNamespace(build=Mock(return_value="isolated coverage query")),
        data_source=SimpleNamespace(execute_readonly=Mock(return_value=SimpleNamespace(rows=[{
            "scope": "any", "org_code": "", "metric_code": "", "date_count": 2,
            "earliest": "2026-07-31", "latest": "2026-08-27", "stat_date": "2026-08-27",
        }]))),
    )
    organizations = [SimpleNamespace(code="O1", name="测试机构")]
    uow = SimpleNamespace(organization_catalog=SimpleNamespace(list_enabled=lambda: organizations))
    service = SimpleNamespace(
        authorized_evidence=lambda _actor, _ref: deepcopy(source),
        semantics=lambda _actor: semantics,
        execution=execution,
        tasks=SimpleNamespace(uow_factory=lambda: nullcontext(uow)),
    )
    coverage = dict(dimension="dates", metric_codes=["total"], org_codes=["O1"],
                    start="2026-01-01", end="2026-10-26", page_size=1)
    coverage.update(coverage_changes)
    request = AnalysisReportRequest(run_refs=[source["run_ref"]], summary=body,
                                    availability_requests=[coverage] if availability else [])
    return source, service, request


def test_verified_coverage_dates_explain_empty_target_without_changing_the_target():
    source, service, request = setup_report(
        "2026年4月末没有可用数据。该指标有记录的日期最早为2026-07-31，"
        "最新为2026年8月27日，不能代替4月末排名。")
    actor = object()
    result = compose_analysis_report(service, actor, request)
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert result["analysis_date"] is None
    assert "查询期间：2026-04-30至2026-04-30" in result["report"]["presentation"]["scope"]
    assert "实际数据日期：暂无数据" in result["report"]["presentation"]["scope"]
    assert result["evidence_items"] == []
    assert source["requested_start"] == source["requested_end"] == "2026-04-30"
    assert "2026年8月27日" in result["public_answer"]
    parameters = service.execution.data_source.execute_readonly.call_args.kwargs["parameters"]
    assert parameters["metric_codes"] == ["total"]
    assert parameters["org_codes"] == ["O1"]
    authorization = service.execution.permission_service.authorize_logical_dsl.call_args.kwargs
    assert authorization["actor"] is actor


def test_unbounded_coverage_reports_existing_dates_without_guessing_a_period():
    _, service, request = setup_report(
        "2026年4月末没有可用数据。该指标有记录的最新日期为2026-08-27。",
        start=None, end=None)
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["analysis_date"] is None
    assert "查询期间：2026-04-30至2026-04-30" in result["report"]["presentation"]["scope"]
    parameters = service.execution.data_source.execute_readonly.call_args.kwargs["parameters"]
    assert parameters["metric_codes"] == ["total"]
    assert parameters["org_codes"] == ["O1"]
    assert parameters["start_date"] is None
    assert parameters["end_date"] is None


@pytest.mark.parametrize("body", [
    "| 日期 | 余额 |\n|---|---|\n| 2026-08-27 | 123元 |",
    "| 日期 | 客户数量 |\n|---|---|\n| 2026-08-27 | 123户 |",
    "| 机构 | 排名 |\n|---|---|\n| 测试机构 | 1 |",
])
def test_coverage_does_not_authorize_business_values_or_actual_ranks(body):
    _, service, request = setup_report(body)
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_date_clarification_does_not_execute_or_invent_a_coverage_request():
    _, service, request = setup_report("是否继续查询2026-08-27？", availability=False)
    result = compose_analysis_report(service, object(), request)
    assert result["analysis_date"] is None
    assert result["evidence_items"] == []
    assert "查询期间：2026-04-30至2026-04-30" in result["report"]["presentation"]["scope"]
    service.execution.data_source.execute_readonly.assert_not_called()


@pytest.mark.parametrize("change", [
    {"metric_codes": ["unknown"]}, {"org_codes": ["O2"]},
    {"metric_codes": []}, {"org_codes": []},
    {"dimension": "metrics"}, {"start": None}, {"end": None},
])
def test_coverage_requires_current_source_scope_and_paired_date_bounds(change):
    _, service, request = setup_report("目标日期没有数据。", **change)
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_SCOPE"
    service.execution.data_source.execute_readonly.assert_not_called()


def test_coverage_permission_revocation_stops_report_and_database_read():
    _, service, request = setup_report("该指标的最新记录为2026-08-27。")
    service.execution.permission_service.authorize_logical_dsl.side_effect = PermissionDeniedError()
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.status_code == 403
    service.execution.data_source.execute_readonly.assert_not_called()


def test_coverage_permission_filter_cannot_silently_shrink_the_scope():
    _, service, request = setup_report("目标日期没有数据。")
    service.execution.permission_service.authorize_logical_dsl.side_effect = None
    service.execution.permission_service.authorize_logical_dsl.return_value = {"orgs": []}
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.status_code == 403


def test_disabled_organization_cannot_be_requeried_using_historical_names():
    _, service, request = setup_report("目标日期没有数据。")
    service.tasks.uow_factory = lambda: nullcontext(SimpleNamespace(
        organization_catalog=SimpleNamespace(list_enabled=lambda: [])))
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_SCOPE"
    service.execution.data_source.execute_readonly.assert_not_called()
