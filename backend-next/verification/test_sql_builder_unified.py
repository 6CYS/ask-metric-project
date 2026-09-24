"""统一 SQL 入口的真实生成与执行回归；仅使用隔离的 SQLite 合成事实。"""

from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import sqlglot
from sqlalchemy import bindparam, create_engine, text

from ask_metric.application.data_availability import AvailabilityRequest, execute_availability
from ask_metric.core.config import Settings
from ask_metric.domain.query_execution import QueryExecutionPlan, QueryPlanError, QueryTemplateId
from ask_metric.infrastructure.query.sql_builder import SqlBuilder, sql_builder_from_settings


@pytest.fixture(params=["mysql", "inceptor"])
def coverage(request):
    dialect = request.param
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE metric_values (metric_code TEXT, org_code TEXT, stat_date TEXT, "
            "metric_value TEXT)"
        )
        connection.exec_driver_sql(
            "INSERT INTO metric_values VALUES "
            "('M1', 'O1', '2026-04-01', NULL), ('M1', 'O1', '2026-04-01', NULL), "
            "('M1', 'O1', '2026-04-02', '4'), ('M2', 'O1', '2026-04-02', '-999.999'), "
            "('M1', 'O2', '2026-04-02', '5'), ('M2', 'O2', '2026-04-02', 'invalid'), "
            "('M1', 'O1', '2026-04-03', '6'), ('M1', 'X', '2026-05-01', '100'), "
            "('M3', 'O1', NULL, '100'), ('M9', 'O1', '2026-04-02', '100')"
        )
        connection.exec_driver_sql(
            "CREATE VIEW synthetic_facts AS SELECT metric_code AS indcr_no, "
            "org_code AS org_no, stat_date AS data_dt, metric_value AS indcvl FROM metric_values"
        )

    def query(*, sql, parameters):
        sqlite_sql = sqlglot.transpile(
            sql, read="mysql" if dialect == "mysql" else "hive", write="sqlite",
        )[0]
        statement = text(sqlite_sql).bindparams(
            bindparam("metric_codes", expanding=True), bindparam("org_codes", expanding=True),
        )
        parameters = {
            key: value.isoformat() if isinstance(value, date) else value
            for key, value in parameters.items()
        }
        with engine.connect() as connection:
            return SimpleNamespace(rows=[
                dict(row) for row in connection.execute(statement, parameters).mappings()
            ])

    execution = SimpleNamespace(
        sql_builder=SqlBuilder(dialect, {"fact_table": "synthetic_facts"}),
        permission_service=Mock(),
        data_source=SimpleNamespace(execute_readonly=Mock(side_effect=query)),
    )
    execution.permission_service.authorize_logical_dsl.return_value = {"orgs": ["O1", "O2"]}

    def run(**kwargs):
        return execute_availability(
            AvailabilityRequest(**kwargs), object(), execution, dialect,
            {"M1": "合成指标一", "M2": "合成指标二", "M3": "无业务日期指标"},
            {"O1": "合成甲行", "O2": "合成乙行", "X": "不可见行"},
        )

    yield run, execution
    engine.dispose()


def test_metric_discovery_preserves_record_existence_pagination_and_enabled_catalog(coverage):
    run, execution = coverage
    first = run(dimension="metrics", page_size=1)
    second = run(dimension="metrics", page_size=1, page=2)
    empty_page = run(dimension="metrics", page_size=1, page=3)
    assert first["items"] == [{"metric_code": "M1", "metric_name": "合成指标一"}]
    assert second["items"] == [{"metric_code": "M2", "metric_name": "合成指标二"}]
    assert first["metric_count"] == second["metric_count"] == empty_page["metric_count"] == 2
    assert first["has_more"] and not second["has_more"]
    assert empty_page["items"] == []
    assert all(call.kwargs["parameters"]["org_codes"] == ["O1", "O2"]
               for call in execution.data_source.execute_readonly.call_args_list)
    # NULL 值仍然是一条记录；只有无业务日期的记录不参与发现。
    result = run(dimension="metrics", start="2026-04-01", end="2026-04-01")
    assert [item["metric_code"] for item in result["items"]] == ["M1"]


def test_date_coverage_deduplicates_pairs_preserves_any_and_all_semantics(coverage):
    run, _ = coverage
    overview = run(page_size=2)["groups"][0]
    assert overview["date_count"] == 3
    assert overview["dates"] == ["2026-04-03", "2026-04-02"]
    assert overview["earliest"] == "2026-04-01" and overview["latest"] == "2026-04-03"
    assert overview["has_more"] is True
    assert run(page=2, page_size=2)["groups"][0]["dates"] == ["2026-04-01"]
    common = run(match="all", metric_codes=["M1", "M2"], org_codes=["O1", "O2"])["groups"][0]
    assert common["scope"] == "common" and common["dates"] == ["2026-04-02"]
    assert common["date_count"] == 1
    empty = run(start="2026-04-04")["groups"][0]
    assert empty["dates"] == [] and empty["date_count"] == 0 and empty["latest"] is None


def test_empty_authorized_scope_short_circuits_sql(coverage):
    run, execution = coverage
    execution.permission_service.authorize_logical_dsl.return_value = {"orgs": []}
    assert run(dimension="metrics")["items"] == []
    assert run()["groups"][0]["date_count"] == 0
    execution.data_source.execute_readonly.assert_not_called()


def all_parameters():
    return {
        "metric_codes": ["M1"], "org_codes": ["O1"], "filter_orgs": True, "limit": 11,
        "filter_metrics": True, "filter_dates": True, "grain": "month", "selection": "all",
        "start_date": "2026-04-01", "end_date": "2026-04-30", "stat_date": "2026-04-30",
        "stat_dates": ["2026-04-01", "2026-04-30"],
        "period_starts": ["2026-04-01"], "period_ends": ["2026-04-30"], "period_count": 1,
        "current_date": "2026-04-30", "base_date": "2026-04-01",
        "require_all": True, "combination_count": 1, "offset": 0, "page_end": 10,
        **{f"period_{bound}_{index}": "2026-04-01"
           for bound in ("start", "end") for index in range(12)},
    }


@pytest.mark.parametrize("dialect", ["mysql", "inceptor"])
@pytest.mark.parametrize("scenario", list(QueryTemplateId))
def test_every_registered_scenario_builds_without_external_files(dialect, scenario):
    plan = QueryExecutionPlan(
        shape="metric_value", template=scenario, dialect=dialect, dsl={},
        parameters=all_parameters(),
    )
    builder = SqlBuilder(dialect)
    sql = builder.build(plan)
    assert sqlglot.parse_one(sql, read=builder.read_dialect)
    assert "M1" not in sql and "O1" not in sql and "2026-04-01" not in sql
    plan.parameters = {}
    with pytest.raises(QueryPlanError, match="misses parameters"):
        builder.build(plan)


@pytest.mark.parametrize("identifiers", [
    {"fact_table": "facts; DELETE FROM facts"},
    {"fact_data_date_field": "day OR 1=1"},
    {"batch_order": "f.etl_date DESC, f.btch_seq_no DESC; DROP TABLE facts"},
])
def test_unsafe_identifiers_are_rejected_before_building(identifiers):
    with pytest.raises(ValueError):
        SqlBuilder("inceptor", identifiers)


def test_runtime_factory_uses_configured_fact_identifiers():
    settings = Settings.model_construct(
        query_database_dialect="inceptor", sit_fact_table="synthetic.custom_facts",
        sit_fact_metric_code_field="custom_metric", sit_fact_org_code_field="custom_org",
        sit_fact_data_date_field="business_day", sit_batch_order="load_day DESC, batch_no ASC",
    )
    builder = sql_builder_from_settings(settings)
    sql = builder.build(QueryExecutionPlan(
        shape="metric_value", template=QueryTemplateId.METRIC_VALUE_LATEST,
        dialect="inceptor", dsl={}, parameters=all_parameters(),
    ))
    assert "synthetic.custom_facts" in sql and "f.business_day" in sql
    assert "f.custom_metric" in sql and "f.custom_org" in sql
    assert "f.load_day DESC, f.batch_no ASC" in sql
