"""排名 SQL 行为合同：真实 builder，合成 SQLite 数据，双方言转换后执行。"""

import re

import pytest
import sqlglot
from sqlalchemy import bindparam, create_engine, event, text

from ask_metric.domain.query_execution import QueryExecutionPlan, QueryTemplateId
from ask_metric.infrastructure.query.sql_builder import SqlBuilder

VARIABLES = {"fact_table": "synthetic_facts"}
DIALECTS = ["mysql", "inceptor"]


def execute_ranking(rows, dialect, *, mode="exact", direction="desc", limit=3,
                    organizations=("A", "B", "C", "D", "E"), stat_date="2026-04-30"):
    template = QueryTemplateId(f"metric_ranking_{mode}_{direction}")
    parameters = {
        "metric_codes": ["M", "N"], "org_codes": list(organizations), "filter_orgs": True,
        "limit": limit, "stat_date": stat_date, "start_date": "2026-04-01",
        "end_date": "2026-04-30",
    }
    plan = QueryExecutionPlan(
        shape="metric_ranking", template=template, dialect=dialect, dsl={}, parameters=parameters,
    )
    source_sql = SqlBuilder(dialect, VARIABLES).build(plan)
    sqlite_sql = sqlglot.transpile(
        source_sql, read="mysql" if dialect == "mysql" else "hive", write="sqlite",
    )[0]
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def register_regexp(connection, record):
        connection.create_function(
            "REGEXP_LIKE", 2, lambda value, pattern: bool(re.search(pattern, value or "")),
        )

    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE metric_values (metric_code TEXT, metric_name TEXT, org_code TEXT, "
                "org_name TEXT, metric_value NUMERIC, stat_date TEXT)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE metric_terms (metric_code TEXT, metric_name TEXT, unit TEXT)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE synthetic_facts (indcr_no TEXT, org_no TEXT, data_dt TEXT, "
                "indcvl TEXT, indcvl_incrrng TEXT, etl_date TEXT, btch_seq_no INTEGER)"
            )
            connection.exec_driver_sql("INSERT INTO metric_terms VALUES ('M','合成指标','户')")
            for index, row in enumerate(rows):
                metric, org, day, value, *batch = row
                # 名称顺序故意与编码相反，排名不得由可变名称决定。
                connection.exec_driver_sql(
                    "INSERT INTO metric_values VALUES (?, '合成指标', ?, ?, ?, ?)",
                    (metric, org, f"名称{100-index}", value, day),
                )
                connection.exec_driver_sql(
                    "INSERT INTO synthetic_facts VALUES (?, ?, ?, ?, '0', '2026-05-01', ?)",
                    (metric, org, day, None if value is None else str(value),
                     batch[0] if batch else 1),
                )
            statement = text(sqlite_sql).bindparams(
                bindparam("metric_codes", expanding=True), bindparam("org_codes", expanding=True),
            )
            return [dict(row) for row in connection.execute(statement, parameters).mappings()]
    finally:
        engine.dispose()


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("mode", ["exact", "in_range", "as_of", "latest"])
@pytest.mark.parametrize("direction,expected", [
    ("desc", ["A", "B", "C"]), ("asc", ["D", "C", "A"]),
])
def test_ties_null_zero_population_and_top_n(dialect, mode, direction, expected):
    rows = execute_ranking([
        ("M", "B", "2026-04-30", 20), ("M", "A", "2026-04-30", 20),
        ("M", "C", "2026-04-30", 10), ("M", "D", "2026-04-30", 0),
        ("M", "E", "2026-04-30", None), ("M", "X", "2026-04-30", 999),
    ], dialect, mode=mode, direction=direction)
    assert [row["org_code"] for row in rows] == expected
    assert [row["rank"] for row in rows] == [1, 2, 3]
    assert {row["rank_population"] for row in rows} == {4}
    assert all(row.get("rank_data_conflict", 0) == 0 for row in rows)


@pytest.mark.parametrize("dialect", DIALECTS)
def test_fewer_than_three_and_exact_date_never_falls_back(dialect):
    facts = [("M", "A", "2026-04-30", 2), ("M", "B", "2026-04-29", 100)]
    rows = execute_ranking(facts, dialect)
    assert [(row["org_code"], row["rank_population"]) for row in rows] == [("A", 1)]
    assert execute_ranking(facts, dialect, stat_date="2026-04-28") == []


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("mode", ["in_range", "as_of", "latest"])
def test_latest_date_is_per_metric_visible_valid_date_not_per_organization(dialect, mode):
    rows = execute_ranking([
        ("M", "A", "2026-04-30", None), ("M", "A", "2026-04-29", 2),
        ("M", "B", "2026-04-28", 100), ("M", "X", "2026-04-30", 999),
        ("N", "B", "2026-04-27", 7), ("N", "A", "2026-04-28", None),
    ], dialect, mode=mode)
    assert [(row["metric_code"], row["org_code"], row["stat_date"], row["rank_population"])
            for row in rows] == [("M", "A", "2026-04-29", 1), ("N", "B", "2026-04-27", 1)]


@pytest.mark.parametrize("dialect", DIALECTS)
def test_range_bounds_and_authorization_apply_before_target_date(dialect):
    rows = execute_ranking([
        ("M", "A", "2026-03-31", 999), ("M", "A", "2026-05-01", 999),
        ("M", "A", "2026-04-29", 20), ("M", "B", "2026-04-30", 100),
    ], dialect, mode="in_range", organizations=("A",))
    assert [(row["org_code"], row["stat_date"]) for row in rows] == [("A", "2026-04-29")]


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("duplicate_value", [1, 2])
def test_duplicate_fact_outside_top_n_flags_entire_ranking(dialect, duplicate_value):
    rows = execute_ranking([
        ("M", "A", "2026-04-30", 40), ("M", "B", "2026-04-30", 30),
        ("M", "C", "2026-04-30", 20), ("M", "D", "2026-04-30", 1),
        ("M", "D", "2026-04-30", duplicate_value),
    ], dialect)
    assert [row["org_code"] for row in rows] == ["A", "B", "C"]
    assert all(row["rank_data_conflict"] == 1 for row in rows)


def test_inceptor_keeps_latest_batch_dedup_and_invalid_latest_does_not_revive_old():
    rows = execute_ranking([
        ("M", "A", "2026-04-30", 999, 1), ("M", "A", "2026-04-30", 2, 2),
        ("M", "B", "2026-04-30", 10, 1), ("M", "B", "2026-04-30", -999.999, 2),
        ("M", "C", "2026-04-30", 5, 1),
    ], "inceptor")
    assert [(row["org_code"], row["metric_value"], row["rank_population"]) for row in rows] == [
        ("C", 5, 2), ("A", 2, 2),
    ]
