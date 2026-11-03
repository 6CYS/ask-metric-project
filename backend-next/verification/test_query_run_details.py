"""SQL 查看接口契约；隔离 SQLite 样本不会进入业务库。"""

from copy import deepcopy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes import catalogs
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError, install_exception_handlers
from ask_metric.infrastructure.db.models import ChatConversation, QueryRun, QueryTask
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

BASE = "/api/v1/catalog/query-runs/task-a/sql"
ACTOR = ActorContext(
    subject="sql-reader",
    user_id="owner-a",
    org_id="org-a",
    role_code="USER",
    authentication_method="test",
    trust_level="authenticated",
)
DSL = {
    "orgs": ["org-a"],
    "metrics": ["metric-a"],
    "time": {"start": "2026-09-30", "end": "2026-09-30", "preset": None},
    "options": {"target_dates": ["2026-06-30", "2026-09-30"], "password": "hidden"},
}
ROWS = [
    {
        "org_code": "org-a",
        "org_name": "历史机构甲",
        "metric_code": "metric-a",
        "metric_name": "历史指标甲",
        "metric_value": "-1234.5600",
        "stat_date": "2026-09-30",
    },
    {
        "org_code": "org-a",
        "org_name": "历史机构甲",
        "metric_code": "metric-a",
        "metric_name": "历史指标甲",
        "metric_value": "0.0000",
        "stat_date": "2026-06-30",
    },
]


def artifact():
    return {
        "result_id": "result:task-a",
        "task_id": "task-a",
        "source_run_id": 10,
        "logical_dsl": deepcopy(DSL),
        "result": {
            "run_id": 10,
            "status": "succeeded",
            "columns": list(ROWS[0]),
            "rows": deepcopy(ROWS),
            "row_count": 2,
            "truncated": True,
            "evidence": {"logical_dsl": deepcopy(DSL)},
        },
    }


@pytest.fixture
def sql_api():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    for model in (ChatConversation, QueryTask, QueryRun):
        model.__table__.create(engine)
    sessions = sessionmaker(engine)
    with sessions.begin() as session:
        session.add_all(
            [
                ChatConversation(id="conversation-a", title="隔离样本", owner_user_id="owner-a"),
                ChatConversation(id="conversation-b", title="隔离样本", owner_user_id="owner-b"),
                QueryTask(
                    id="task-a",
                    conversation_id="conversation-a",
                    original_question="隔离样本",
                    status="SUCCEEDED",
                    state_json={
                        "execution": {"run_id": 11, "status": "failed"},
                        "result_artifact": artifact(),
                    },
                ),
                QueryTask(
                    id="task-b", conversation_id="conversation-b", original_question="隔离样本"
                ),
                QueryRun(
                    id=10,
                    task_id="task-a",
                    conversation_id="conversation-a",
                    user_message="隔离样本",
                    intent="metric_query",
                    status="succeeded",
                    sql_text="SELECT metric_value FROM metric_values WHERE org_code = :org_code",
                    sql_params={"org_code": "org-a", "stat_date": "2026-09-30"},
                    query_plan={
                        "dsl": deepcopy(DSL),
                        "catalog": {
                            "organizations": [{"code": "org-a", "name": "历史机构甲"}],
                            "metrics": [{"code": "metric-a", "name": "历史指标甲", "unit": "万元"}],
                        },
                        "connection": "hidden-connection",
                    },
                    row_count=2,
                    latency_ms=37,
                ),
                QueryRun(
                    id=11,
                    task_id="task-a",
                    conversation_id="conversation-a",
                    user_message="隔离样本",
                    intent="metric_query",
                    status="failed",
                    sql_text="SELECT other_value FROM metric_values WHERE org_code = :org_code",
                    sql_params={"org_code": "org-a"},
                    query_plan={"dsl": deepcopy(DSL)},
                    error_message="hidden password and connection",
                ),
                QueryRun(
                    id=12,
                    task_id="task-b",
                    conversation_id="conversation-b",
                    user_message="隔离样本",
                    intent="metric_query",
                    status="succeeded",
                ),
            ]
        )
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(catalogs.router)
    app.dependency_overrides[catalogs.get_uow] = lambda: SqlAlchemyUnitOfWork(sessions)
    app.dependency_overrides[require_actor] = lambda: ACTOR
    app.dependency_overrides[catalogs.get_overview_permissions] = lambda: (
        ScopedOrganizationPermissionService()
    )
    with TestClient(app) as client:
        yield client, sessions, engine
    engine.dispose()


def edit_state(sessions, update):
    with sessions.begin() as session:
        task = session.get(QueryTask, "task-a")
        state = deepcopy(task.state_json)
        update(state)
        task.state_json = state


def test_saved_source_wins_over_latest_and_exposes_actual_sql_and_bound_result(sql_api):
    client, _, engine = sql_api
    statements = []
    event.listen(
        engine, "before_cursor_execute", lambda c, cu, s, p, ctx, many: statements.append(s)
    )
    response = client.get(BASE, params={"limit": 1})
    assert response.status_code == 200
    data = response.json()
    assert data["run_id"] == 10
    assert data["result_id"] == "result:task-a"
    assert data["status"] == "succeeded"
    assert data["sql_availability"] == "available"
    assert data["sql_text"].endswith("org_code = :org_code")
    assert data["sql_params"] == {"org_code": "org-a", "stat_date": "2026-09-30"}
    assert (data["row_count"], data["latency_ms"]) == (2, 37)
    assert data["conditions"]["orgs"] == [{"code": "org-a", "name": "历史机构甲"}]
    assert data["conditions"]["metrics"] == [
        {"code": "metric-a", "name": "历史指标甲", "unit": "万元"},
    ]
    assert data["conditions"]["time"]["target_dates"] == ["2026-06-30", "2026-09-30"]
    assert data["result"]["rows"] == [ROWS[0]]
    assert data["result"]["row_count"] == 2
    assert data["result"]["truncated"] is True
    assert data["result"]["has_more"] is True
    assert data["result"]["next_offset"] == 1
    assert data["result_unavailable_reason"] is None
    assert "hidden" not in response.text
    assert all(statement.lstrip().upper().startswith("SELECT") for statement in statements)


def test_pagination_reads_only_snapshot_rows(sql_api):
    client, _, _ = sql_api
    data = client.get(BASE, params={"offset": 1, "limit": 1}).json()
    assert data["result"]["rows"] == [ROWS[1]]
    assert data["result"]["has_more"] is False
    assert data["result"]["next_offset"] is None


def test_explicit_other_run_does_not_borrow_saved_result(sql_api):
    client, _, _ = sql_api
    response = client.get(BASE, params={"run_id": 11})
    assert response.status_code == 200
    data = response.json()
    assert data["run_id"] == 11
    assert data["status"] == "failed"
    assert "other_value" in data["sql_text"]
    assert data["result"] is None
    assert data["result_id"] is None
    assert data["result_unavailable_reason"] == "different_run"
    assert "hidden" not in response.text


@pytest.mark.parametrize("role", ["USER", "SYSTEM_ADMIN"])
def test_other_owner_task_and_foreign_run_are_not_found(sql_api, role):
    client, _, _ = sql_api
    client.app.dependency_overrides[require_actor] = lambda: ACTOR.model_copy(
        update={"role_code": role},
    )
    assert client.get(BASE.replace("task-a", "task-b")).status_code == 404
    assert client.get(BASE, params={"run_id": 12}).status_code == 404
    assert client.get(BASE, params={"run_id": 999}).status_code == 404


def test_missing_login_is_rejected(sql_api):
    client, _, _ = sql_api
    del client.app.dependency_overrides[require_actor]
    assert client.get(BASE).status_code == 401


@pytest.mark.parametrize("place", ["plan", "snapshot", "rows", "narrowed"])
def test_current_permission_covers_plan_snapshot_and_actual_result_orgs(sql_api, place):
    client, sessions, _ = sql_api
    if place == "plan":
        with sessions.begin() as session:
            run = session.get(QueryRun, 10)
            run.query_plan = {**run.query_plan, "dsl": {**DSL, "orgs": ["org-b"]}}
    else:

        def update(state):
            saved = state["result_artifact"]
            if place == "rows":
                saved["result"]["rows"][1]["org_code"] = "org-b"
            else:
                saved["logical_dsl"]["orgs"] = ["org-a", "org-b"]
                if place == "narrowed":
                    saved["logical_dsl"]["options"]["organization_scope"] = "synchronized_catalog"

        edit_state(sessions, update)
    response = client.get(BASE, params={"limit": 1})
    assert response.status_code == 403
    assert response.json()["code"] == "ORG_SCOPE_FORBIDDEN"


def test_execution_pointer_is_used_only_when_artifact_has_no_source(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state.pop("result_artifact"))
    data = client.get(BASE).json()
    assert data["run_id"] == 11
    assert data["result"] is None
    assert data["result_unavailable_reason"] == "not_saved"


def test_dangling_saved_source_never_falls_back_to_latest(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state["result_artifact"].update(source_run_id=999))
    assert client.get(BASE).status_code == 404


def test_multiple_runs_without_source_are_ambiguous(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state.clear())
    response = client.get(BASE)
    assert response.status_code == 409
    assert response.json()["code"] == "QUERY_RUN_SOURCE_UNAVAILABLE"


def test_single_legacy_run_without_sql_reports_missing_without_reconstruction(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state.clear())
    with sessions.begin() as session:
        session.delete(session.get(QueryRun, 11))
        run = session.get(QueryRun, 10)
        run.sql_text = None
        run.sql_params = None
    response = client.get(BASE)
    assert response.status_code == 200
    data = response.json()
    assert data["run_id"] == 10
    assert data["sql_text"] is None
    assert data["sql_params"] is None
    assert data["sql_availability"] == "not_recorded"
    assert data["notice"]
    assert data["result"] is None
    assert data["result_unavailable_reason"] == "not_saved"


def test_zero_rows_is_a_saved_empty_result(sql_api):
    client, sessions, _ = sql_api
    edit_state(
        sessions,
        lambda state: state["result_artifact"]["result"].update(
            rows=[],
            columns=[],
            row_count=0,
            truncated=False,
        ),
    )
    data = client.get(BASE).json()
    assert data["result"] is not None
    assert data["result"]["rows"] == []
    assert data["result"]["row_count"] == 0
    assert data["result_unavailable_reason"] is None


def test_missing_trusted_scope_is_rejected(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state.clear())
    with sessions.begin() as session:
        run = session.get(QueryRun, 11)
        run.query_plan = {}
    response = client.get(BASE, params={"run_id": 11})
    assert response.status_code == 409
    assert response.json()["code"] == "RESULT_SCOPE_UNAVAILABLE"


@pytest.mark.parametrize(
    "params",
    [
        {"run_id": 0},
        {"run_id": "oops"},
        {"offset": -1},
        {"limit": 0},
        {"limit": 101},
    ],
)
def test_invalid_read_parameters_are_rejected(sql_api, params):
    client, _, _ = sql_api
    assert client.get(BASE, params=params).status_code == 422


@pytest.mark.parametrize(
    "orgs,options,code",
    [
        ([], {}, "RESULT_SCOPE_UNAVAILABLE"),
        (["org-b"], {}, "ORG_SCOPE_FORBIDDEN"),
        (["org-a", "org-b"], {"organization_scope": "synchronized_catalog"}, "ORG_SCOPE_FORBIDDEN"),
    ],
)
def test_existing_saved_result_permission_contract_is_preserved(orgs, options, code):
    service = QueryTaskApplicationService(permission_service=ScopedOrganizationPermissionService())
    with pytest.raises(ApplicationError) as error:
        service._authorize_saved_result(ACTOR, {"orgs": orgs, "options": options})
    assert error.value.code == code
    service._authorize_saved_result(ACTOR, {"orgs": ["org-a"]})


def test_old_plan_without_orgs_uses_trusted_same_run_snapshot_scope(sql_api):
    client, sessions, _ = sql_api
    with sessions.begin() as session:
        run = session.get(QueryRun, 10)
        run.query_plan = {"dsl": {"metrics": ["metric-a"]}}
    response = client.get(BASE)
    assert response.status_code == 200
    assert response.json()["conditions"]["orgs"] == [{"code": "org-a", "name": "历史机构甲"}]


def test_empty_snapshot_object_is_not_presented_as_a_zero_row_query(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state["result_artifact"].update(result={}))
    response = client.get(BASE)
    assert response.status_code == 200
    assert response.json()["result"] is None
    assert response.json()["result_unavailable_reason"] == "not_saved"


def test_snapshot_with_conflicting_run_identity_is_not_paired_with_sql(sql_api):
    client, sessions, _ = sql_api
    edit_state(sessions, lambda state: state["result_artifact"]["result"].update(run_id=11))
    response = client.get(BASE)
    assert response.status_code == 409
    assert response.json()["code"] == "RESULT_SOURCE_MISMATCH"


def test_old_task_read_still_checks_all_rows_under_current_permissions(sql_api):
    _, sessions, _ = sql_api
    service = QueryTaskApplicationService(
        uow_factory=lambda: SqlAlchemyUnitOfWork(sessions),
        permission_service=ScopedOrganizationPermissionService(),
    )
    assert service.get_task("task-a", ACTOR).result["source_run_id"] == 10
    edit_state(
        sessions,
        lambda state: state["result_artifact"]["result"]["rows"][1].update(
            org_code="org-b",
        ),
    )
    with pytest.raises(ApplicationError) as error:
        service.get_task("task-a", ACTOR)
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"
