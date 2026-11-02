"""普通问数默认日期的隔离回归；合成样本仅用于测试，不代表真实业务验收。"""

import re
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from sqlalchemy import bindparam, create_engine, text
from sqlglot import parse_one

from ask_metric.application.commands import ExecuteQueryCommand
from ask_metric.application.field_resolution import resolve_date_field
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.query_execution import QueryExecutionPlan, QueryPlanner, QueryTemplateId
from ask_metric.domain.semantics import LogicalDSL, MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.query.sql_builder import SqlBuilder

BUSINESS_DATE = date(2026, 10, 23)


def latest_spec(**changes):
    return BasicQuerySpec.model_validate({
        "metric_codes": ["m1"], "org_codes": ["o1"],
        "time": {"preset": "latest"}, "selection": "latest", **changes,
    })


def latest_dsl():
    return LogicalDSL.model_validate({
        "task": "metric_query", "metrics": ["m1", "m2"], "orgs": ["o1", "o2"],
        "time": {"preset": "latest"},
    })


def value_plan(*, dialect="mysql", exact=False):
    return QueryExecutionPlan(
        shape="metric_value", dialect=dialect,
        template=(QueryTemplateId.METRIC_VALUE_EXACT if exact
                  else QueryTemplateId.METRIC_VALUE_AS_OF),
        dsl=(latest_dsl().model_dump(mode="json") if not exact else {
            "task": "metric_query", "metrics": ["m1", "m2"], "orgs": ["o1", "o2"],
            "time": {"start": "2026-10-22", "end": "2026-10-22"},
        }),
        parameters={"metric_codes": ["m1", "m2"], "org_codes": ["o1", "o2"],
                    "filter_orgs": True, "limit": 1001, "end_date": BUSINESS_DATE,
                    "stat_date": date(2026, 10, 22)},
        catalog={
            "metrics": [{"code": "m1", "name": "测试余额", "unit": "元"},
                        {"code": "m2", "name": "测试客户数", "unit": "户"}],
            "organizations": [{"code": "o1", "name": "甲机构"},
                              {"code": "o2", "name": "乙机构"}],
        },
        display_metric_names=["测试余额", "测试客户数"],
        display_org_names=["甲机构", "乙机构"],
    )


def execute_fixture_sql(plan, statements):
    """在内存数据库执行生成 SQL；仅转换方言语法，查询逻辑仍来自正式 builder。"""
    builder = SqlBuilder(plan.dialect, {"fact_table": "metric_source"})
    sql = parse_one(builder.build(plan), read=builder.output_dialect).sql(dialect="sqlite")
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.connection.create_function(
                "regexp", 2, lambda pattern, value: bool(re.search(pattern, value or "")),
            )
            for statement, values in statements:
                connection.exec_driver_sql(statement, values)
            query = text(sql).bindparams(bindparam("metric_codes", expanding=True),
                                        bindparam("org_codes", expanding=True))
            return [dict(row) for row in connection.execute(query, plan.parameters).mappings()]
    finally:
        engine.dispose()


def test_latest_contract_reaches_value_dsl_without_fabricated_calendar():
    spec = latest_spec()
    assert spec.query_shape == "metric_value"
    assert spec.to_logical_dsl().time.model_dump(exclude_none=True) == {"preset": "latest"}
    assert BasicQuerySpec.model_validate(spec.model_dump(mode="json")) == spec


def test_calendar_serialization_preserves_existing_idempotency_payload():
    spec = BasicQuerySpec(metric_codes=["m1"], org_codes=["o1"], selection="exact",
                          time={"start": "2026-10-22", "end": "2026-10-22"})
    assert spec.model_dump(mode="json")["time"] == {
        "start": "2026-10-22", "end": "2026-10-22", "dates": None,
    }
    assert latest_spec().model_dump(mode="json")["time"] == {"preset": "latest"}


@pytest.mark.parametrize("changes", [
    {"time": {"preset": "latest", "start": "2026-10-22", "end": "2026-10-22"}},
    {"time": {"preset": "latest", "dates": ["2026-10-21", "2026-10-22"]}},
    {"selection": "exact"}, {"selection": "latest_in_range"},
    {"time": {"start": "2026-10-22", "end": "2026-10-22"}},
    {"time_alternative": {"label": "历史", "start": "2025-01-01", "end": "2025-12-31"}},
    {"operation": {"kind": "ranking", "position": "top", "top_n": 1}},
    {"operation": {"kind": "rank_position"}, "comparison_scope": {"org_codes": ["o1"]}},
])
def test_latest_rejects_calendar_or_operation_conflicts(changes):
    with pytest.raises(ValidationError):
        latest_spec(**changes)


@pytest.mark.parametrize(("time", "selection", "template"), [
    ({"start": "2026-10-22", "end": "2026-10-22"}, "exact", "metric_value_exact"),
    ({"start": "2026-10-01", "end": "2026-10-22"}, "latest_in_range", "metric_value_in_range"),
    ({"start": "2026-10-01", "end": "2026-10-22"}, "all_in_range", "metric_trend"),
    ({"start": "2026-10-01", "end": "2026-10-22", "dates": ["2026-10-01", "2026-10-22"]},
     "exact", "metric_value_at_dates"),
])
def test_existing_calendar_contract_preserves_selected_dates(time, selection, template):
    spec = BasicQuerySpec(metric_codes=["m1"], org_codes=["o1"], time=time,
                          selection=selection)
    plan = QueryPlanner(dialect="mysql").build(spec.to_logical_dsl(), spec.query_shape)
    assert plan.template.value == template


@pytest.mark.parametrize("expression", ["最新", "最近", "近期", "近来", "这段时间", "这阵子"])
def test_unbounded_recent_resolves_policy_instead_of_guessing_calendar(expression):
    resolved = resolve_date_field(expression, BUSINESS_DATE,
                                  model_value={"start": "2026-10-23", "end": "2026-10-23"})
    assert resolved["status"] == "resolved"
    assert resolved["value"] == {"preset": "latest"}


def test_explicit_calendar_and_invalid_range_do_not_become_latest():
    historical = resolve_date_field("2026年7月31日", BUSINESS_DATE)
    assert historical["value"] == {"start": "2026-07-31", "end": "2026-07-31"}
    assert resolve_date_field("到2026年7月31日", BUSINESS_DATE)["status"] == "invalid"
    assert resolve_date_field("最近三个月", BUSINESS_DATE)["value"].get("preset") is None


def test_latest_planner_uses_server_cutoff_but_keeps_policy_evidence():
    plan = QueryPlanner(dialect="mysql").build(
        latest_dsl(), "metric_value", business_date=BUSINESS_DATE,
    )
    assert plan.template == QueryTemplateId.METRIC_VALUE_AS_OF
    assert plan.parameters["end_date"] == BUSINESS_DATE
    assert plan.dsl["time"]["preset"] == "latest"
    assert plan.dsl["time"]["start"] is None


def test_mysql_latest_ignores_null_and_future_rows_and_keeps_zero():
    rows = execute_fixture_sql(value_plan(), [
        ("CREATE TABLE metric_values (metric_code TEXT, metric_name TEXT, org_code TEXT, "
         "org_name TEXT, metric_value NUMERIC, stat_date TEXT)", ()),
        ("CREATE TABLE metric_terms (metric_code TEXT, metric_name TEXT, unit TEXT)", ()),
        ("INSERT INTO metric_values VALUES (?, ?, ?, ?, ?, ?)", [
            ("m1", "测试余额", "o1", "甲机构", 10, "2026-10-20"),
            ("m1", "测试余额", "o1", "甲机构", None, "2026-10-22"),
            ("m1", "测试余额", "o1", "甲机构", 99, "2026-10-24"),
            ("m1", "测试余额", "o2", "乙机构", 0, "2026-10-21"),
            ("m2", "测试客户数", "o1", "甲机构", 3, "2026-10-23"),
        ]),
    ])
    assert {(row["metric_code"], row["org_code"], row["stat_date"], row["metric_value"])
            for row in rows} == {
        ("m1", "o1", "2026-10-20", 10), ("m1", "o2", "2026-10-21", 0),
        ("m2", "o1", "2026-10-23", 3),
    }


def test_source_latest_keeps_latest_batch_then_skips_invalid_dates():
    rows = execute_fixture_sql(value_plan(dialect="inceptor"), [
        ("CREATE TABLE metric_source (indcr_no TEXT, org_no TEXT, data_dt TEXT, indcvl TEXT, "
         "indcvl_incrrng TEXT, etl_date TEXT, btch_seq_no INTEGER)", ()),
        ("INSERT INTO metric_source VALUES (?, ?, ?, ?, ?, ?, ?)", [
            ("m1", "o1", "2026-10-20", "0", None, "2026-10-20", 1),
            ("m1", "o1", "2026-10-21", "8", None, "2026-10-21", 1),
            ("m1", "o1", "2026-10-21", "-999.999", None, "2026-10-21", 2),
            ("m1", "o1", "2026-10-22", "错误值", None, "2026-10-22", 1),
            ("m1", "o1", "2026-10-23", None, None, "2026-10-23", 1),
            ("m1", "o1", "2026-10-24", "99", None, "2026-10-24", 1),
            ("m1", "o2", "2026-10-22", "2", None, "2026-10-22", 1),
            ("m1", "o2", "2026-10-22", "4", None, "2026-10-22", 2),
        ]),
    ])
    assert {(row["org_code"], row["stat_date"], row["metric_value"]) for row in rows} == {
        ("o1", "2026-10-20", 0), ("o2", "2026-10-22", 4),
    }


def test_explicit_empty_historical_day_does_not_fall_back_to_latest():
    rows = execute_fixture_sql(value_plan(exact=True), [
        ("CREATE TABLE metric_values (metric_code TEXT, metric_name TEXT, org_code TEXT, "
         "org_name TEXT, metric_value NUMERIC, stat_date TEXT)", ()),
        ("CREATE TABLE metric_terms (metric_code TEXT, metric_name TEXT, unit TEXT)", ()),
        ("INSERT INTO metric_values VALUES (?, ?, ?, ?, ?, ?)", [
            ("m1", "测试余额", "o1", "甲机构", 10, "2026-10-20"),
            ("m1", "测试余额", "o1", "甲机构", 20, "2026-10-23"),
        ]),
    ])
    assert rows == []


def run_result(rows, *, max_limit=1000):
    service = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql", max_limit=max_limit),
        data_source=SimpleNamespace(execute_readonly=lambda **_: SimpleNamespace(rows=rows,
                                                                               latency_ms=1)),
        permission_service=ScopedOrganizationPermissionService(),
        today_provider=lambda: BUSINESS_DATE,
    )
    command = ExecuteQueryCommand(task_id="test-task", expected_version=0, request_id="test",
                                  actor=ActorContext(subject="test", authentication_method="test",
                                                     trust_level="authenticated", org_id="o1"))
    # 隔离应用库写入边界；查询结果处理、正文与证据生成保持正式实现。
    with patch.object(service, "_finish_success"), patch.object(service, "_finish_failure"):
        return service._run_prepared(
            command, run_id=1, plan=value_plan(), sql="SELECT 1", execution_version=0,
            timings_ms={}, execution_total_started=perf_counter(),
        )


def result_row(org="o1", day="2026-10-20"):
    return {"metric_code": "m1", "metric_name": "测试余额", "org_code": org,
            "org_name": "甲机构" if org == "o1" else "乙机构", "stat_date": day,
            "metric_value": Decimal("0"), "unit": "元"}


def test_complete_result_dates_cover_all_rows_and_disclose_missing_pairs():
    result = run_result([result_row(), result_row("o2", "2026-10-21")])
    assert result.status == "succeeded"
    assert result.evidence["query_dates"] == {
        "complete": True, "actual_dates": ["2026-10-20", "2026-10-21"], "uniform_date": None,
    }
    assert "甲机构的测试客户数" in result.message
    assert "乙机构的测试客户数" in result.message
    assert "不等" in result.evidence["coverage_notice"]


def test_latest_value_keeps_actual_date_without_repeating_system_coverage_notice():
    result = run_result([result_row()])
    assert result.status == "succeeded"
    assert result.message.count("2026年10月20日") == 1
    assert "当前系统日期" not in result.message
    assert "当前数据源" not in result.message
    assert result.evidence["query_dates"]["uniform_date"] == "2026-10-20"
    assert result.evidence["coverage_notice"] is None
    assert "当前系统日期" not in str(result.answer_blocks)


@pytest.mark.parametrize(("rows", "limit", "complete", "uniform"), [
    ([result_row()], 1000, True, "2026-10-20"),
    ([result_row(), result_row("o2", "2026-10-21")], 1, False, None),
    ([], 1000, True, None),
    ([result_row(day=None)], 1000, False, None),
])
def test_only_complete_single_day_result_can_supply_inherited_date(rows, limit, complete, uniform):
    result = run_result(rows, max_limit=limit)
    assert result.status == "succeeded"
    dates = result.evidence["query_dates"]
    assert dates["complete"] is complete
    assert dates["uniform_date"] == uniform
    if not complete:
        assert result.evidence["missing_metric_notice"] is None


def test_execution_plan_passes_business_date_and_preserves_authorization():
    actor = ActorContext(subject="test", authentication_method="test", trust_level="authenticated",
                         org_id="o1", role_code="SYSTEM_ADMIN")
    catalogs = SimpleNamespace(
        metric_catalog=SimpleNamespace(list_enabled=lambda: [
            MetricCatalogItem(code="m1", name="测试余额", unit="元"),
            MetricCatalogItem(code="m2", name="测试客户数", unit="户"),
        ]),
        organization_catalog=SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code="o1", name="甲机构"),
            OrganizationCatalogItem(code="o2", name="乙机构"),
        ]),
    )

    @contextmanager
    def uow():
        yield catalogs

    service = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql"), data_source=SimpleNamespace(),
        permission_service=ScopedOrganizationPermissionService(), uow_factory=uow,
        today_provider=lambda: BUSINESS_DATE,
    )
    _, plan, _ = service._build_governed_plan(
        uow=catalogs, actor=actor, logical_dsl=latest_dsl().model_dump(mode="json"),
        query_shape="metric_value", strict_codes=True,
    )
    assert plan.parameters["end_date"] == BUSINESS_DATE
    assert plan.parameters["org_codes"] == ["o1", "o2"]
    with pytest.raises(PermissionDeniedError):
        service._build_governed_plan(
            uow=catalogs, actor=actor.model_copy(update={"role_code": "USER"}),
            logical_dsl=latest_dsl().model_dump(mode="json"),
            query_shape="metric_value", strict_codes=True,
        )
