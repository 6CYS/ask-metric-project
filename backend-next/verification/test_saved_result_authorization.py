"""所有历史结果读取和幂等入口在返回诊断事实前复核权限；仅内存桩。"""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from ask_metric.application.commands import SubmitQuestionCommand
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext, IncomingRequest
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import ChatConversation, QueryTask

ACTOR = ActorContext(
    subject="synthetic", user_id="u", org_id="A", authentication_method="test",
    trust_level="authenticated",
)
DSL = {"task": "metric_query", "metrics": ["M"], "orgs": ["B"],
       "time": {"start": "2026-04-30", "end": "2026-04-30"}}


def fixture(*, dsl=DSL, artifact=True, status="SUCCEEDED", message_dsl=None):
    saved = {
        "task_id": "t", "status": "succeeded", "query_shape": "metric_value",
        "rows": [{"org_code": "B", "metric_value": 123}],
        "row_count": 1, "columns": ["org_code", "metric_value"],
        "evidence": {"logical_dsl": dsl} if dsl else {},
    }
    state = QueryTaskState(logical_dsl=dsl)
    state.debug = {"result": {"answer": {"facts": [{"value": "sensitive"}]}}}
    if artifact:
        state.result_artifact = {
            "result_id": "result:t", "task_id": "t", "logical_dsl": dsl, "result": saved,
        }
    task = QueryTask(
        id="t", conversation_id="c", original_question="合成问题", status=status,
        current_stage="RESULT_FORMATTING", version=3, state_json=state.model_dump(mode="json"),
    )
    conversation = ChatConversation(
        id="c", title="合成会话", owner_user_id="u", preview="", created_at=datetime.now(UTC),
    )
    message_result = {**saved, "evidence": {"logical_dsl": message_dsl}} if message_dsl else saved
    messages = [SimpleNamespace(
        task_id="t", payload={"kind": "query_result", "result": message_result},
    )]

    class Uow:
        tasks = SimpleNamespace(
            get_owned=lambda *args: task, get_owned_for_update=lambda *args: task,
            find_by_idempotency_key=lambda *args: task, list_for_conversation=lambda *args: [task],
        )
        conversations = SimpleNamespace(
            get=lambda *args: conversation, get_owned=lambda *args: conversation,
        )

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    uow = Uow()
    uow.messages = SimpleNamespace(list_for_conversation=lambda *args: messages)
    service = QueryTaskApplicationService(
        permission_service=ScopedOrganizationPermissionService(), uow_factory=lambda: uow,
    )
    command = SubmitQuestionCommand(
        request=IncomingRequest(
            request_id="r", channel="web", conversation_id="c", text="合成问题",
        ),
        actor=ACTOR, idempotency_key="same",
    )
    return service, task, command


def read(service, command, path):
    if path == "submission":
        return service.submit_question(command)
    if path == "concurrent_submission":
        return service._recover_concurrent_question(command, "c", "legacy-fingerprint")
    if path == "get_task":
        return service.get_task("t", ACTOR)
    if path == "get_result":
        return service.get_task_result("t", ACTOR)
    return service.export_task_result("t", ACTOR)


PATHS = ["submission", "concurrent_submission", "get_task", "get_result", "export_task"]


@pytest.mark.parametrize("path", PATHS)
def test_revoked_result_is_blocked_before_payload_debug_or_export(path):
    service, _, command = fixture()
    with pytest.raises(ApplicationError) as error:
        read(service, command, path)
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"


@pytest.mark.parametrize("path", ["get_task", "export_task"])
def test_legacy_result_with_no_trusted_scope_fails_closed(path):
    service, _, command = fixture(dsl=None, artifact=False)
    with pytest.raises(ApplicationError) as error:
        read(service, command, path)
    assert error.value.code == "RESULT_SCOPE_UNAVAILABLE"


def test_valid_legacy_scope_from_state_is_authorized_without_rewriting():
    service, task, _ = fixture(dsl={**DSL, "orgs": ["A"]}, artifact=False)
    messages = service.uow_factory().messages.list_for_conversation("c")
    messages[0].payload["result"]["rows"] = [{"org_code": "A", "metric_value": 123}]
    original = task.state_json.copy()
    result = service.get_task("t", ACTOR)
    assert result.task_id == "t"
    assert task.state_json == original


def test_legacy_message_evidence_does_not_bypass_permissions():
    service, _, command = fixture(dsl=None, artifact=False, message_dsl=DSL)
    with pytest.raises(ApplicationError) as error:
        read(service, command, "export_task")
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"


def test_actual_rows_are_rechecked_when_legacy_dsl_records_only_parent():
    service, task, _ = fixture(dsl={**DSL, "orgs": ["A"]})
    with pytest.raises(ApplicationError) as error:
        service.get_task("t", ACTOR)
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"


@pytest.mark.parametrize("path", ["get_task", "submission"])
def test_legacy_message_rows_are_rechecked_before_returning_task_debug(path):
    service, _, command = fixture(dsl={**DSL, "orgs": ["A"]}, artifact=False)
    with pytest.raises(ApplicationError) as error:
        read(service, command, path)
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"


def test_no_result_task_can_still_be_read_without_query_scope():
    service, task, _ = fixture(dsl=None, artifact=False, status="RUNNING")
    assert service.get_task("t", ACTOR).task_id == task.id


def test_synchronized_catalog_result_is_not_silently_trimmed_after_revocation():
    service, _, _ = fixture(dsl={**DSL, "orgs": ["A", "B"],
                               "options": {"organization_scope": "synchronized_catalog"}})
    with pytest.raises(ApplicationError) as error:
        service.get_task_result("t", ACTOR)
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"
