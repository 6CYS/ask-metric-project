"""隔离数据库验证目录身份与事实编码的转换，不写入业务库。"""

from contextlib import contextmanager
from datetime import date
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from ask_metric.api import dependencies
from ask_metric.application.commands import ExecuteQueryCommand
from ask_metric.application.ports import NoopPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import QueryExecutionPlan, QueryPlanner, QueryTemplateId
from ask_metric.infrastructure.db.models import OrgTerm, QueryRun


@pytest.fixture
def source_runtime(monkeypatch):
    engine = create_engine("sqlite://")
    OrgTerm.__table__.create(engine)
    sessions = sessionmaker(engine)
    with sessions.begin() as session:
        session.add_all([
            OrgTerm(org_code="directory-a", org_name="甲行", hierarchy_level="3"),
            OrgTerm(org_code="same-b", org_name="乙行", hierarchy_level="3"),
        ])
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE source_organizations (org_no TEXT, "
                                "org_chn_nm TEXT, org_hier_code TEXT, "
                                "headbnk_org_no TEXT, etl_date TEXT)"))
        connection.execute(text("INSERT INTO source_organizations VALUES "
                                "('directory-a','甲行','3','old-a','2026-07-01'),"
                                "('directory-a','甲行','3','fact-a','2026-08-27'),"
                                "('same-b','乙行','3','same-b','2026-08-27')"))
        connection.execute(text("CREATE TABLE source_values (org_no TEXT, metric_value INTEGER)"))
        connection.execute(text("INSERT INTO source_values VALUES "
                                "('fact-a',-240),('same-b',15),('outside',900)"))
    settings = Settings(_env_file=None, query_database_dialect="inceptor",
                        sit_org_table="source_organizations", sit_org_corporation_code_max="134",
                        sit_org_excluded_corporation_code="086",
                        sit_org_head_office_corporation_code="000",
                        sit_org_legal_entity_hier_code="3", sit_org_head_office_hier_code="1",
                        sit_org_expected_count=2)
    monkeypatch.setattr(dependencies, "get_query_engine", lambda: engine)
    monkeypatch.setattr(dependencies, "get_org_catalog_engine", lambda: engine, raising=False)
    monkeypatch.setattr(dependencies, "get_app_session_factory", lambda: sessions)
    monkeypatch.setattr(dependencies, "get_model_service", lambda _: None)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=settings)))
    yield engine, lambda: dependencies.get_query_execution_service(request).data_source
    engine.dispose()


VALUE_SQL = "SELECT org_no AS org_code, metric_value FROM source_values WHERE org_no IN :org_codes"


def test_source_codes_retrieve_facts_and_restore_catalog_identity(source_runtime):
    _, create = source_runtime
    source = create()
    parameters = {"org_codes": ["directory-a"], "filter_orgs": True}
    result = source.execute_readonly(sql=VALUE_SQL, parameters=parameters)
    assert result.rows == [{"org_code": "directory-a", "metric_value": -240}]
    assert parameters["org_codes"] == ["directory-a"]
    assert result.source_parameters["org_codes"] == ["fact-a"]
    assert result.organization_mapping == {
        "snapshot_date": "2026-08-27", "codes": {"directory-a": "fact-a"},
    }


def test_rank_subject_and_population_share_mapping_and_request_cache(source_runtime):
    engine, create = source_runtime
    reads = []
    event.listen(engine, "before_cursor_execute", lambda conn, cursor, sql, *args:
                 reads.append(sql) if "FROM source_organizations" in sql else None)
    source = create()
    sql = "SELECT * FROM (SELECT org_no AS org_code, metric_value, " \
          "ROW_NUMBER() OVER (ORDER BY metric_value,org_no) AS rank " \
          "FROM source_values WHERE org_no IN :org_codes) r " \
          "WHERE org_code IN :rank_subject_codes"
    params = {"org_codes": ["directory-a", "same-b"], "rank_subject_codes": ["directory-a"]}
    assert source.execute_readonly(sql=sql, parameters=params).rows == [
        {"org_code": "directory-a", "metric_value": -240, "rank": 1},
    ]
    assert source.execute_readonly(sql=VALUE_SQL, parameters={"org_codes": ["same-b"]}).rows == [
        {"org_code": "same-b", "metric_value": 15},
    ]
    assert len(reads) == 1


def test_availability_without_row_identity_uses_same_source_scope(source_runtime):
    _, create = source_runtime
    result = create().execute_readonly(
        sql="SELECT COUNT(*) AS count FROM source_values WHERE org_no IN :org_codes",
        parameters={"org_codes": ["directory-a", "same-b"]},
    )
    assert result.rows == [{"count": 2}]


@pytest.mark.parametrize("change", [
    "DELETE FROM source_organizations WHERE org_no='directory-a' AND etl_date='2026-08-27'",
    "UPDATE source_organizations SET org_chn_nm='其他甲行' WHERE org_no='directory-a'",
    "UPDATE source_organizations SET org_hier_code='2' WHERE org_no='directory-a'",
    "UPDATE source_organizations SET headbnk_org_no='same-b' WHERE org_no='directory-a'",
    "INSERT INTO source_organizations VALUES ('directory-a','甲行','3','other-a','2026-08-27')",
])
def test_untrusted_or_ambiguous_mapping_is_not_used(source_runtime, change):
    engine, create = source_runtime
    with engine.begin() as connection:
        connection.execute(text(change))
    with pytest.raises(ApplicationError, match="机构.*映射") as failure:
        create().execute_readonly(sql=VALUE_SQL, parameters={"org_codes": ["directory-a"]})
    assert failure.value.code == "ORG_SOURCE_MAPPING_INVALID"


def test_unknown_requested_identity_and_outside_result_are_rejected(source_runtime):
    _, create = source_runtime
    source = create()
    with pytest.raises(ApplicationError):
        source.execute_readonly(sql=VALUE_SQL, parameters={"org_codes": ["fact-a"]})
    with pytest.raises(ApplicationError):
        source.execute_readonly(sql="SELECT org_no AS org_code FROM source_values",
                                parameters={"org_codes": ["directory-a"]})


def test_aggregate_cannot_disable_authorized_organization_filter(source_runtime):
    _, create = source_runtime
    with pytest.raises(ApplicationError):
        create().execute_readonly(
            sql="SELECT COUNT(*) AS count FROM source_values "
                "WHERE (:filter_orgs = FALSE OR org_no IN :org_codes)",
            parameters={"org_codes": ["directory-a"], "filter_orgs": False},
        )


@pytest.mark.parametrize("fail_sql", [False, True])
def test_query_audit_retains_actual_binding_even_when_sql_fails(source_runtime, fail_sql):
    engine, create = source_runtime
    QueryRun.__table__.create(engine)
    sessions = sessionmaker(engine)
    with sessions.begin() as session:
        session.add(QueryRun(id=1, task_id="isolated-task", user_message="隔离测试",
                             intent="metric_query", status="running", query_plan={},
                             sql_params={"org_codes": ["directory-a"]}))

    @contextmanager
    def query_uow():
        with sessions() as session:
            yield SimpleNamespace(runs=SimpleNamespace(get=lambda key: session.get(QueryRun, key)),
                                  commit=session.commit)

    service = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="inceptor"), data_source=create(),
        permission_service=NoopPermissionService(), uow_factory=query_uow,
    )
    plan = QueryExecutionPlan(
        shape="metric_value", dialect="inceptor", template=QueryTemplateId.METRIC_VALUE_EXACT,
        dsl={"task": "metric_query", "metrics": ["m1"], "orgs": ["directory-a"],
             "time": {"start": "2026-08-27", "end": "2026-08-27"}},
        parameters={"org_codes": ["directory-a"], "metric_codes": ["m1"],
                    "filter_orgs": True, "stat_date": date(2026, 8, 27)},
        catalog={"metrics": [{"code": "m1", "name": "测试利润", "unit": "元"}],
                 "organizations": [{"code": "directory-a", "name": "甲行"}]},
        display_metric_names=["测试利润"], display_org_names=["甲行"],
    )
    command = ExecuteQueryCommand(
        task_id="isolated-task", expected_version=0, request_id="isolated-request",
        actor=ActorContext(subject="isolated", authentication_method="test",
                           trust_level="authenticated", org_id="directory-a"),
    )
    # 只隔离持久化边界；源查询、映射、事实和对外证据均走正式实现。
    with patch.object(service, "_finish_success"), patch.object(service, "_finish_failure"):
        result = service._run_prepared(
            command, run_id=1, plan=plan, execution_version=0, timings_ms={},
            execution_total_started=perf_counter(),
            sql="SELECT org_no AS org_code, " + ("invalid_column" if fail_sql else "metric_value")
                + " AS metric_value, 'm1' AS metric_code, '元' AS unit, "
                "'测试利润' AS metric_name, '甲行' AS org_name, '2026-08-27' AS stat_date "
                "FROM source_values WHERE org_no IN :org_codes",
        )
    with sessions() as session:
        run = session.get(QueryRun, 1)
        assert run.sql_params["org_codes"] == ["fact-a"]
        assert run.query_plan["organization_mapping"] == {
            "snapshot_date": "2026-08-27", "codes": {"directory-a": "fact-a"},
        }
    if fail_sql:
        assert result.status == "failed"
        return
    assert result.status == "succeeded"
    assert result.facts[0]["org_code"] == "directory-a"
    assert result.evidence["logical_dsl"]["orgs"] == ["directory-a"]
    assert result.evidence["source_parameters"]["org_codes"] == ["fact-a"]
    assert result.evidence["organization_mapping"] == {
        "snapshot_date": "2026-08-27", "codes": {"directory-a": "fact-a"},
    }
