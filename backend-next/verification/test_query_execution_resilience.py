"""查询执行链健壮性回归：数量上限、幂等竞争、RUNNING 收敛、查询超时与应用库连接占用。

使用单连接 SQLite 应用库与桩数据源，不连接真实数据库或模型。连接池只有 1 个连接，
执行链任何嵌套取连接都会在 0.5 秒内超时暴露。
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock

import pymysql
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

import ask_metric.infrastructure.db.organization_scope as organization_scope_module
import ask_metric.infrastructure.db.session as session_module
from ask_metric.application import query_execution_service as execution_module
from ask_metric.application.commands import ExecuteQueryCommand, SubmitQuestionCommand
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import (
    QueryExecutionApplicationService,
    QueryExecutionConflictError,
)
from ask_metric.application.requests import ActorContext, IncomingRequest
from ask_metric.application.task_service import (
    QueryTaskApplicationService,
    _is_recoverable_idempotency_race,
)
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.query_execution import QueryPlanError, QueryPlanner
from ask_metric.infrastructure.db.base import Base
from ask_metric.infrastructure.db.models import MetricTerm, OrgTerm, QueryRun, QueryTask
from ask_metric.infrastructure.db.org_hierarchy import SqlAlchemyOrgHierarchyProvider
from ask_metric.infrastructure.db.organization_scope import SqlAlchemyOrganizationScopeProvider
from ask_metric.infrastructure.db.session import query_socket_timeouts
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

ORG_COUNT = 150
DAY = {"start": "2026-04-30", "end": "2026-04-30"}


def _actor(*, org_id="O0000", role="USER"):
    return ActorContext(
        subject="synthetic", user_id="u1", org_id=org_id, role_code=role,
        authentication_method="test", trust_level="authenticated",
    )


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'app.db'}", poolclass=QueuePool,
        pool_size=1, max_overflow=0, pool_timeout=0.5,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as session:
        session.add(MetricTerm(metric_code="M1", metric_name="合成存款余额", unit="元"))
        session.add_all([
            OrgTerm(org_code=f"O{index:04d}", org_name=f"合成机构{index}")
            for index in range(ORG_COUNT)
        ])
        session.commit()
    # 默认应用库入口指向本测试库，保证不会读到本机配置的真实应用库。
    monkeypatch.setattr(session_module, "get_app_session_factory", lambda: factory)
    monkeypatch.setattr(
        organization_scope_module, "get_app_session_factory", lambda: factory, raising=False,
    )
    yield factory
    engine.dispose()


def _services(sessions, rows=None, **options):
    def uow_factory():
        return SqlAlchemyUnitOfWork(sessions)

    data_source = Mock()
    data_source.execute_readonly.return_value = SimpleNamespace(latency_ms=1, rows=rows or [{
        "metric_code": "M1", "metric_name": "合成存款余额", "org_code": "O0000",
        "org_name": "合成机构0", "stat_date": "2026-04-30", "metric_value": Decimal("12.5"),
        "unit": "元",
    }])
    execution = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql"), data_source=data_source,
        permission_service=ScopedOrganizationPermissionService(
            organization_scope_provider=SqlAlchemyOrganizationScopeProvider(),
        ),
        org_hierarchy_provider=SqlAlchemyOrgHierarchyProvider(),
        uow_factory=uow_factory, **options,
    )
    return QueryTaskApplicationService(uow_factory), execution


def _submit(tasks, spec, *, actor=None, key="k1"):
    created = tasks.submit_question(SubmitQuestionCommand(
        request=IncomingRequest(request_id=f"req-{key}", channel="basic_query", text="基础查询"),
        actor=actor or _actor(), idempotency_key=key, basic_query=spec,
    ))
    return ExecuteQueryCommand(
        task_id=created.task_id, expected_version=created.version,
        request_id=f"basic:{key}", actor=actor or _actor(),
    )


def _spec(**overrides):
    return BasicQuerySpec.model_validate(
        {"metric_codes": ["M1"], "org_codes": ["O0000"], "time": DAY, "selection": "exact",
         **overrides}
    )


def _task(sessions, task_id):
    with sessions() as session:
        return session.get(QueryTask, task_id)


# ---- 1. 契约与规划层上限一致，超限不可重试 ----

def test_basic_query_contract_rejects_more_than_31_discrete_dates():
    dates = [f"2026-01-{day:02d}" for day in range(1, 32)] + ["2026-02-01"]
    with pytest.raises(ValidationError):
        _spec(time={"start": dates[0], "end": dates[-1], "dates": dates},
              selection="latest_in_range")
    accepted = _spec(time={"start": dates[0], "end": dates[-2], "dates": dates[:-1]},
                     selection="latest_in_range")
    assert len(accepted.time.dates) == 31


def test_basic_query_contract_rejects_more_than_1000_orgs():
    with pytest.raises(ValidationError):
        _spec(org_codes=[f"X{index}" for index in range(1001)])


def test_org_codes_within_contract_reach_sql_instead_of_planning_failure(sessions):
    tasks, execution = _services(sessions)
    codes = [f"O{index:04d}" for index in range(ORG_COUNT)]
    command = _submit(tasks, _spec(org_codes=codes), actor=_actor(role="SYSTEM_ADMIN"))

    result = execution.execute(command)

    assert result.status == "succeeded", result.error_code
    sent = execution.data_source.execute_readonly.call_args.kwargs["parameters"]
    assert len(sent["org_codes"]) == ORG_COUNT


def test_deterministic_plan_error_is_not_reported_as_retryable(sessions, monkeypatch):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())

    def reject(*args, **kwargs):
        raise QueryPlanError("org_names exceeds the maximum item count")

    monkeypatch.setattr(execution.planner, "build", reject)
    result = execution.execute(command)

    assert (result.status, result.error_code) == ("failed", "QUERY_PLAN_INVALID")
    assert result.debug["error"]["retryable"] is False
    assert "稍后重试" not in result.error_message
    execution.data_source.execute_readonly.assert_not_called()


# ---- 2. GoldenDB/MySQL 幂等竞争识别 ----

def _mysql_duplicate(key: str, code: int = 1062) -> IntegrityError:
    orig = pymysql.err.IntegrityError(code, f"Duplicate entry 'agent:x-k1' for key '{key}'")
    return IntegrityError("INSERT", {}, orig)


@pytest.mark.parametrize("key,recoverable", [
    ("query_tasks.uq_query_tasks_conversation_idempotency", True),
    ("uq_query_tasks_conversation_idempotency", True),
    ("chat_conversations.PRIMARY", True),
    ("PRIMARY", True),
    ("chat_messages.PRIMARY", False),
    ("query_tasks.PRIMARY", False),
    ("metric_terms.metric_terms_metric_code_key", False),
])
def test_mysql_duplicate_entry_is_classified_by_constraint(key, recoverable):
    assert _is_recoverable_idempotency_race(_mysql_duplicate(key)) is recoverable


def test_non_duplicate_mysql_integrity_error_is_not_recovered():
    orig = pymysql.err.IntegrityError(1452, "Cannot add or update a child row")
    assert _is_recoverable_idempotency_race(IntegrityError("INSERT", {}, orig)) is False


def test_concurrent_submit_with_same_key_replays_winner_on_mysql(sessions, monkeypatch):
    tasks, _ = _services(sessions)
    original = tasks._submit_question_once
    calls = []

    def lose_race(command, conversation_id, fingerprint):
        calls.append(conversation_id)
        if len(calls) == 1:
            # 并发请求先提交成功，本请求随后撞上唯一索引。
            original(command, conversation_id, fingerprint)
            raise _mysql_duplicate("query_tasks.uq_query_tasks_conversation_idempotency")
        return original(command, conversation_id, fingerprint)

    monkeypatch.setattr(tasks, "_submit_question_once", lose_race)
    replayed = tasks.submit_question(SubmitQuestionCommand(
        request=IncomingRequest(request_id="req", channel="basic_query", text="基础查询"),
        actor=_actor(), idempotency_key="k1", basic_query=_spec(),
    ))

    assert replayed.idempotent_replay is True
    assert len(calls) == 1


# ---- 3. RUNNING 必须收敛 ----

def test_unexpected_error_after_sql_marks_task_failed_and_replays(sessions, monkeypatch):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())

    def broken_renderer(*args, **kwargs):
        raise RuntimeError("renderer bug")

    monkeypatch.setattr(execution_module, "render_fact_answer", broken_renderer)
    failed = execution.execute(command)

    assert (failed.status, failed.error_code) == ("failed", "QUERY_EXECUTION_FAILED")
    assert _task(sessions, command.task_id).status == "FAILED"
    replay = execution.execute(command)
    assert replay.idempotent_replay is True
    assert replay.status == "failed"
    assert execution.data_source.execute_readonly.call_count == 1


def test_result_persistence_failure_is_recorded_as_failure(sessions, monkeypatch):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())

    def lost_connection(**kwargs):
        raise OperationalError("UPDATE query_tasks", {}, Exception("server has gone away"))

    monkeypatch.setattr(execution, "_finish_success", lost_connection)
    result = execution.execute(command)

    assert result.status == "failed"
    task = _task(sessions, command.task_id)
    assert (task.status, task.error_code) == ("FAILED", "QUERY_EXECUTION_FAILED")


def test_unrecordable_failure_is_raised_not_reported_as_known_result(sessions, monkeypatch):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())

    def unavailable(**kwargs):
        raise OperationalError("UPDATE query_tasks", {}, Exception("server has gone away"))

    monkeypatch.setattr(execution, "_finish_success", unavailable)
    monkeypatch.setattr(execution, "_finish_failure", unavailable)
    with pytest.raises(OperationalError):
        execution.execute(command)
    assert _task(sessions, command.task_id).status == "RUNNING"


def _interrupt_after_prepare(execution, command, sessions, *, started_at):
    """模拟进程在 RUNNING 提交后被杀：只执行准备阶段，再改写开始时间。"""
    prepared = execution._prepare(command)
    with sessions() as session:
        task = session.get(QueryTask, command.task_id)
        state = dict(task.state_json)
        execution_state = dict(state["execution"])
        if started_at is None:
            execution_state.pop("started_at")
        else:
            execution_state["started_at"] = started_at.isoformat()
        state["execution"] = execution_state
        task.state_json = state
        session.commit()
    return prepared


def test_recent_running_execution_still_reports_already_running(sessions):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())
    _interrupt_after_prepare(execution, command, sessions, started_at=datetime.now(UTC))

    with pytest.raises(QueryExecutionConflictError) as error:
        execution.execute(command)
    assert error.value.code == "QUERY_ALREADY_RUNNING"


@pytest.mark.parametrize("started_at", [
    datetime.now(UTC) - timedelta(minutes=30),
    None,  # 升级前登记、没有开始时间的执行
])
def test_stale_running_execution_is_reclaimed_on_retry(sessions, started_at):
    tasks, execution = _services(sessions, running_stale_after=timedelta(minutes=10))
    command = _submit(tasks, _spec())
    _interrupt_after_prepare(execution, command, sessions, started_at=started_at)

    result = execution.execute(command)

    assert result.idempotent_replay is True
    assert (result.status, result.error_code) == ("failed", "QUERY_EXECUTION_INTERRUPTED")
    task = _task(sessions, command.task_id)
    assert (task.status, task.error_code) == ("FAILED", "QUERY_EXECUTION_INTERRUPTED")
    with sessions() as session:
        run = session.get(QueryRun, task.state_json["execution"]["run_id"])
        assert (run.status, run.failed_node) == ("failed", "execution_reclaimed")
    execution.data_source.execute_readonly.assert_not_called()


def test_late_original_execution_cannot_overwrite_reclaimed_task(sessions, monkeypatch):
    tasks, execution = _services(sessions, running_stale_after=timedelta(minutes=10))
    command = _submit(tasks, _spec())
    prepared = _interrupt_after_prepare(
        execution, command, sessions, started_at=datetime.now(UTC) - timedelta(minutes=30),
    )
    execution.execute(command)

    # 原执行进程恢复后继续落库，必须因版本冲突失败。
    monkeypatch.setattr(execution, "_prepare", lambda _: prepared)
    with pytest.raises(QueryExecutionConflictError) as error:
        execution.execute(command)
    assert error.value.code == "TASK_VERSION_CONFLICT"
    assert _task(sessions, command.task_id).error_code == "QUERY_EXECUTION_INTERRUPTED"


# ---- 4. 业务查询连接的客户端超时 ----

@pytest.mark.parametrize("url", [
    "mysql+pymysql://reader@lake.example:3306/default",
    "mysql://reader@goldendb.example:3306/metrics",
])
def test_query_engine_bounds_socket_wait_for_mysql_protocol(url):
    assert query_socket_timeouts(url, 30_000) == {"read_timeout": 35, "write_timeout": 35}
    assert query_socket_timeouts(url, 1_500) == {"read_timeout": 7, "write_timeout": 7}


def test_query_socket_timeouts_skip_unknown_drivers():
    assert query_socket_timeouts("sqlite://", 30_000) == {}


# ---- 5. 执行链不嵌套占用应用库连接 ----

def test_execution_chain_runs_on_single_app_connection(sessions):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())

    result = execution.execute(command)

    assert result.status == "succeeded", (result.error_code, result.error_message)
    assert _task(sessions, command.task_id).status == "SUCCEEDED"


def test_org_scope_and_hierarchy_reuse_active_unit_of_work_session(sessions):
    with sessions() as session:
        session.get(OrgTerm, 1).parent_org_code = None
        for org in session.query(OrgTerm).filter(OrgTerm.org_code != "O0000"):
            org.parent_org_code = "O0000"
            org.hierarchy_level = "3"
        session.get(OrgTerm, 1).hierarchy_level = "1"
        session.commit()
    with SqlAlchemyUnitOfWork(sessions) as uow:
        uow.tasks.get_for_update("missing")  # 占住唯一连接，模拟执行链持有任务行锁
        allowed = SqlAlchemyOrganizationScopeProvider().allowed_org_codes("O0000")
        snapshot = SqlAlchemyOrgHierarchyProvider().strict_snapshot()
        metrics = uow.metric_catalog.list_enabled()
    assert len(allowed) == ORG_COUNT
    assert snapshot.validated_root() == "O0000"
    assert [item.code for item in metrics] == ["M1"]


# ---- 6. 按幂等键只读回查（agent 对账） ----

def _lookup(tasks, key="k1", *, actor=None, conversation_id=None):
    return tasks.find_basic_query(key, actor or _actor(), conversation_id=conversation_id)


def _set_state(sessions, task_id, mutate):
    with sessions() as session:
        task = session.get(QueryTask, task_id)
        state = dict(task.state_json)
        mutate(state)
        task.state_json = state
        session.commit()


def test_lookup_reports_success_with_result_reference(sessions):
    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec())
    execution.execute(command)

    found = _lookup(tasks)

    assert (found.task_id, found.status) == (command.task_id, "succeeded")
    assert found.result_id


def test_lookup_reports_failure_code(sessions, monkeypatch):
    tasks, execution = _services(sessions)
    monkeypatch.setattr(execution.planner, "build", Mock(side_effect=QueryPlanError("x")))
    execution.execute(_submit(tasks, _spec()))

    found = _lookup(tasks)

    assert (found.status, found.error_code) == ("failed", "QUERY_PLAN_INVALID")


def test_lookup_never_received_is_not_found(sessions):
    tasks, _ = _services(sessions)
    with pytest.raises(ApplicationError) as error:
        _lookup(tasks, "never-sent")
    assert (error.value.code, error.value.status_code) == ("BASIC_QUERY_NOT_FOUND", 404)


def test_lookup_hides_other_users_queries(sessions):
    tasks, execution = _services(sessions)
    execution.execute(_submit(tasks, _spec(), key="shared"))
    other = ActorContext(subject="other", user_id="u2", org_id="O0000", role_code="USER",
                         authentication_method="test", trust_level="authenticated")
    with pytest.raises(ApplicationError) as error:
        _lookup(tasks, "shared", actor=other)
    assert error.value.code == "BASIC_QUERY_NOT_FOUND"
    # 显式传入他人的会话同样不可见。
    conversation = _task(sessions, _lookup(tasks, "shared").task_id).conversation_id
    with pytest.raises(ApplicationError):
        _lookup(tasks, "shared", actor=other, conversation_id=conversation)


def test_lookup_reports_running_then_interrupted_without_writing(sessions):
    tasks, execution = _services(sessions, running_stale_after=timedelta(minutes=10))
    command = _submit(tasks, _spec())
    execution._prepare(command)

    assert _lookup(tasks).status == "running"

    def age(state):
        state["execution"] = {**state["execution"],
                              "started_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat()}

    _set_state(sessions, command.task_id, age)
    found = _lookup(tasks)
    assert (found.status, found.error_code) == ("interrupted", "QUERY_EXECUTION_INTERRUPTED")
    # 回查只读：任务仍为 RUNNING，由下一次执行请求负责回收落库。
    assert _task(sessions, command.task_id).status == "RUNNING"


def test_lookup_reports_submitted_but_never_executed_task(sessions):
    tasks, _ = _services(sessions)
    command = _submit(tasks, _spec())
    assert _lookup(tasks).status == "running"

    def age(state):
        debug = dict(state["debug"])
        submitted_at = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        debug["task_create"] = {**debug["task_create"], "submitted_at": submitted_at}
        state["debug"] = debug

    _set_state(sessions, command.task_id, age)
    assert _lookup(tasks).status == "interrupted"


def test_lookup_route_requires_owner_and_returns_status(sessions):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from ask_metric.api.dependencies import get_query_task_service, require_actor
    from ask_metric.api.routes.tasks import router
    from ask_metric.core.errors import install_exception_handlers

    tasks, execution = _services(sessions)
    command = _submit(tasks, _spec(), key="route-key")
    execution.execute(command)
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[require_actor] = _actor
    app.dependency_overrides[get_query_task_service] = lambda: tasks
    client = TestClient(app)

    found = client.get("/api/v1/basic-queries/route-key")
    missing = client.get("/api/v1/basic-queries/unknown-key")

    assert found.status_code == 200
    assert found.json()["status"] == "succeeded"
    assert missing.status_code == 404
    assert missing.json()["code"] == "BASIC_QUERY_NOT_FOUND"
