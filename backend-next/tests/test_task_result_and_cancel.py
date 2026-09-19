"""结果读取/只读找回/通用取消的应用服务测试（内存桩，不连数据库）。

覆盖契约：取消与成功竞争由乐观锁+状态机裁决；结果读取只回不可变快照的分页事实；
lookup 未找到时 404 且不创建任务。
"""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from ask_metric.application.commands import CancelTaskCommand
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import ChatConversation, QueryTask

ACTOR = ActorContext(
    subject="user-1", user_id="user-1", authentication_method="test", trust_level="authenticated"
)


def _succeeded_task() -> QueryTask:
    result = {
        "run_id": 7,
        "task_id": "task-1",
        "status": "succeeded",
        "query_shape": "metric_value",
        "columns": ["org_name", "metric_value"],
        "rows": [{"org_name": f"机构{i}", "metric_value": f"{i}.00"} for i in range(5)],
        "comparisons": [],
        "row_count": 5,
        "truncated": False,
        "message": "查询完成，共返回 5 行。",
        "task_version": 3,
        "task_status": "SUCCEEDED",
        "timings_ms": {},
        "evidence": {"coverage_notice": None},
    }
    state = QueryTaskState()
    state.result_artifact = {
        "schema_version": 1,
        "result_id": "result:task-1",
        "task_id": "task-1",
        "conversation_id": "conv-1",
        "owner_user_id": "user-1",
        "source_run_id": 7,
        "operation": "QUERY",
        "created_at": datetime.now(UTC).isoformat(),
        "logical_dsl": {},
        "result": result,
    }
    return QueryTask(
        id="task-1",
        conversation_id="conv-1",
        original_question="查存款余额",
        status="SUCCEEDED",
        current_stage="RESULT_FORMATTING",
        version=3,
        state_json=state.model_dump(mode="json"),
    )


class _FakeTasks:
    def __init__(self, task: QueryTask | None) -> None:
        self.task = task

    def get_owned(self, task_id: str, user_id: str) -> QueryTask | None:
        if self.task is None or self.task.id != task_id or user_id != "user-1":
            return None
        return self.task

    def find_by_idempotency_key(self, conversation_id: str, key: str) -> QueryTask | None:
        if self.task is None or conversation_id != "conv-1":
            return None
        return self.task if key == "sub-1" else None

    def update_optimistically(self, *, task_id: str, expected_version: int, **values: Any):
        assert self.task is not None and self.task.id == task_id
        if self.task.version != expected_version:
            return None
        for key, value in values.items():
            setattr(self.task, key, value)
        self.task.version += 1
        return self.task


class _FakeConversations:
    def __init__(self, conversation: ChatConversation | None) -> None:
        self.conversation = conversation

    def get_owned(self, conversation_id: str, user_id: str):
        if self.conversation is None or self.conversation.id != conversation_id:
            return None
        return self.conversation if user_id == "user-1" else None


class _FakeUow:
    def __init__(
        self, task: QueryTask | None, conversation: ChatConversation | None = None
    ) -> None:
        self.tasks = _FakeTasks(task)
        self.conversations = _FakeConversations(conversation)

    def __enter__(self) -> "_FakeUow":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def commit(self) -> None:
        return None


def _service(task: QueryTask | None, conversation: ChatConversation | None = None):
    uow = _FakeUow(task, conversation)
    return QueryTaskApplicationService(uow_factory=lambda: uow)


def _cancel(task_id: str, version: int, request_id: str = "req-cancel-1") -> CancelTaskCommand:
    return CancelTaskCommand(
        task_id=task_id, expected_version=version, actor=ACTOR, request_id=request_id
    )


class TestGetTaskResult:
    @pytest.mark.parametrize(
        "question,conflict",
        [
            ("刚才乙行3月的数据再显示", True),
            ("重看甲行贷款余额", True),
            ("重看甲行存款余额", False),
            ("刚才的数据再显示一下", False),
        ],
    )
    def test_empty_result_read_checks_explicit_catalog_conditions(self, question, conflict):
        task = _succeeded_task()
        state = QueryTaskState.model_validate(task.state_json)
        saved = state.result_artifact["result"]
        saved.update(rows=[], row_count=0, evidence={
            "logical_dsl": {"orgs": ["A"], "metrics": ["M1"]},
        })
        task.state_json = state.model_dump(mode="json")
        original_state = task.state_json.copy()
        uow = _FakeUow(task)
        uow.organization_catalog = SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code="A", name="甲农村商业银行", aliases=["甲行"]),
            OrganizationCatalogItem(code="B", name="乙农村商业银行", aliases=["乙行"]),
        ])
        uow.metric_catalog = SimpleNamespace(list_enabled=lambda: [
            MetricCatalogItem(code="M1", name="存款余额"),
            MetricCatalogItem(code="M2", name="贷款余额"),
        ])
        service = QueryTaskApplicationService(uow_factory=lambda: uow)
        if conflict:
            with pytest.raises(ApplicationError) as error:
                service.get_task_result("task-1", ACTOR, read_question=question)
            assert error.value.code == "RESULT_REFERENCE_CONFLICT"
        else:
            page = service.get_task_result("task-1", ACTOR, read_question=question)
            assert page.row_count == 0
            assert page.result_id == "result:task-1"
        assert task.state_json == original_state
        assert task.version == 3

    def test_paged_rows_from_artifact(self) -> None:
        service = _service(_succeeded_task())
        page = service.get_task_result("task-1", ACTOR, offset=1, limit=2)
        assert page.result_id == "result:task-1"
        assert [row["org_name"] for row in page.rows] == ["机构1", "机构2"]
        assert page.has_more is True
        assert page.next_offset == 3
        assert page.row_count == 5

        tail = service.get_task_result("task-1", ACTOR, offset=4, limit=2)
        assert [row["org_name"] for row in tail.rows] == ["机构4"]
        assert tail.has_more is False
        assert tail.next_offset is None

    def test_not_ready_when_not_succeeded(self) -> None:
        task = _succeeded_task()
        task.status = "RUNNING"
        with pytest.raises(ApplicationError) as excinfo:
            _service(task).get_task_result("task-1", ACTOR)
        assert excinfo.value.code == "RESULT_NOT_READY"

    def test_snapshot_missing_is_explicit_error(self) -> None:
        task = _succeeded_task()
        state = QueryTaskState.model_validate(task.state_json)
        state.result_artifact = None
        task.state_json = state.model_dump(mode="json")
        with pytest.raises(ApplicationError) as excinfo:
            _service(task).get_task_result("task-1", ACTOR)
        assert excinfo.value.code == "RESULT_SNAPSHOT_MISSING"

    def test_other_user_cannot_read(self) -> None:
        other = ActorContext(
            subject="user-2", user_id="user-2",
            authentication_method="test", trust_level="authenticated",
        )
        with pytest.raises(ApplicationError) as excinfo:
            _service(_succeeded_task()).get_task_result("task-1", other)
        assert excinfo.value.code == "TASK_NOT_FOUND"


class TestCancelTask:
    def test_cancel_running_task(self) -> None:
        task = _succeeded_task()
        task.status = "RUNNING"
        task.current_stage = "EXECUTION"
        service = _service(task)
        result = service.cancel_task(_cancel("task-1", 3))
        assert result.status == "CANCELLED"
        assert result.version == 4
        assert task.status == "CANCELLED"

    def test_cancel_replay_is_idempotent(self) -> None:
        task = _succeeded_task()
        task.status = "WAITING_USER"
        task.current_stage = "CLARIFICATION"
        service = _service(task)
        first = service.cancel_task(_cancel("task-1", 3))
        second = service.cancel_task(_cancel("task-1", 3))
        assert first.version == 4
        assert second.idempotent_replay is True
        assert second.version == 4

    def test_cancel_succeeded_task_rejected(self) -> None:
        """成功先提交则保留成功：终态不允许迁移到 CANCELLED。"""
        with pytest.raises(ApplicationError) as excinfo:
            _service(_succeeded_task()).cancel_task(_cancel("task-1", 3))
        assert excinfo.value.code == "INVALID_TASK_TRANSITION"

    def test_cancel_version_conflict(self) -> None:
        task = _succeeded_task()
        task.status = "RUNNING"
        with pytest.raises(ApplicationError) as excinfo:
            _service(task).cancel_task(_cancel("task-1", 99))
        assert excinfo.value.code == "TASK_VERSION_CONFLICT"


class TestLookupTask:
    def test_lookup_found(self) -> None:
        conversation = ChatConversation(id="conv-1", owner_user_id="user-1", title="t", preview="")
        service = _service(_succeeded_task(), conversation)
        result = service.lookup_task("conv-1", "sub-1", ACTOR)
        assert result.task_id == "task-1"

    def test_lookup_missing_is_404_without_creating(self) -> None:
        conversation = ChatConversation(id="conv-1", owner_user_id="user-1", title="t", preview="")
        service = _service(None, conversation)
        with pytest.raises(ApplicationError) as excinfo:
            service.lookup_task("conv-1", "sub-x", ACTOR)
        assert excinfo.value.code == "TASK_NOT_FOUND"
