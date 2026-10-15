"""计算契约回归：精确原值、范围、权限、完整性与重放（隔离内存桩）。"""

from contextlib import nullcontext
from copy import deepcopy
from types import SimpleNamespace

import pytest

from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.calculation import (
    CalculationError,
    CalculationExpression,
    CalculationRequest,
    evaluate_expression,
    quantity,
)


def calculation_fixture():
    facts = [
        dict(
            fact_id=f"fact:t:{i}:metric_value",
            task_id="t",
            field="metric_value",
            value=value,
            unit="元",
            org_code="O",
            org_name="测试机构",
            metric_code=f"M{i}",
            metric_name=f"指标{i}",
            date="2026-03-31",
        )
        for i, value in enumerate(["9007199254740993.123456", "9007199254740992.000001"])
    ]
    state = {
        "channel_context": {
            "calculation_context": {"scope_id": "scope", "user_question": "指标甲减指标乙"}
        },
        "result_artifact": {"logical_dsl": {"orgs": ["O"]}, "result": {"facts": facts}},
    }
    task = SimpleNamespace(
        id="t", conversation_id="c", status="SUCCEEDED", expires_at=None, state_json=state
    )
    messages = []
    uow = SimpleNamespace(
        conversations=SimpleNamespace(get_owned_for_update=lambda *args: SimpleNamespace(id="c")),
        tasks=SimpleNamespace(get_owned_for_update=lambda *args: task),
        messages=SimpleNamespace(
            add=messages.append,
            get=lambda message_id, conversation_id: next((
                message for message in messages
                if message.id == message_id and message.conversation_id == conversation_id
            ), None),
        ),
        commit=lambda: None,
    )
    execution = SimpleNamespace(
        uow_factory=lambda: nullcontext(uow),
        _authorize_query=lambda **kwargs: (
            SimpleNamespace(orgs=["O"]),
            [SimpleNamespace(code=f"M{i}", unit="元") for i in range(2)],
            None,
        ),
    )
    request = CalculationRequest(
        conversation_id="c",
        scope_id="scope",
        bindings={"a": {"fact_id": facts[0]["fact_id"]}, "b": {"fact_id": facts[1]["fact_id"]}},
        expressions=[
            {"name": "difference", "label": "甲减乙", "expression": "a-b", "decimal_places": 6}
        ],
    )
    return CalculationApplicationService(execution), request, task, execution, messages


def test_precise_difference_persisted_and_replayed_after_permission_check():
    service, request, task, execution, messages = calculation_fixture()
    actor = SimpleNamespace(user_id="u")
    result = service.calculate(request, actor, "key")
    assert result["results"][0]["value"] == "1.123455"
    assert result["public_answer"] == "计算结果「甲减乙」（a-b）：1.123455元。"
    assert service.calculate(request, actor, "key") == result
    assert len(messages) == len(task.state_json["calculations"]) == 1

    def revoked(**kwargs):
        raise PermissionDeniedError("revoked")

    execution._authorize_query = revoked
    with pytest.raises(ApplicationError) as error:
        service.calculate(request, actor, "key")
    assert error.value.code == "CALCULATION_FORBIDDEN"


@pytest.mark.parametrize(
    "change",
    [
        "scope",
        "conversation",
        "truncated",
        "missing",
        "foreign_fact",
        "unit",
        "date",
        "org",
        "status",
        "null",
    ],
)
def test_invalid_sources_fail_closed(change):
    service, request, task, _, messages = calculation_fixture()
    result = task.state_json["result_artifact"]["result"]
    if change == "scope":
        request.scope_id = "other"
    if change == "conversation":
        task.conversation_id = "other"
    if change == "truncated":
        result["truncated"] = True
    if change == "missing":
        result["evidence"] = {"missing_metric_notice": "缺少指标"}
    if change == "foreign_fact":
        request.bindings["b"].fact_id = "fact:t:99:metric_value"
    if change == "unit":
        result["facts"][1]["unit"] = "户"
    if change == "date":
        result["facts"][1]["date"] = "2026-04-30"
    if change == "org":
        result["facts"][1]["org_code"] = "OTHER"
    if change == "status":
        task.status = "FAILED"
    if change == "null":
        result["facts"][1]["value"] = None
    with pytest.raises(ApplicationError):
        service.calculate(request, SimpleNamespace(user_id="u"), "key")
    assert not messages


def test_explicit_cross_date_allowed_and_changed_replay_rejected():
    service, request, task, _, _ = calculation_fixture()
    task.state_json["result_artifact"]["result"]["facts"][1]["date"] = "2026-04-30"
    request.scope_policy = "cross_date"
    service.calculate(request, SimpleNamespace(user_id="u"), "key")
    changed = deepcopy(request)
    changed.expressions[0].expression = "b-a"
    with pytest.raises(ApplicationError) as error:
        service.calculate(changed, SimpleNamespace(user_id="u"), "key")
    assert error.value.code == "CALCULATION_CONFLICT"


@pytest.mark.parametrize(
    "expression", ["a/0", "a.__class__", "a**2", "a+999", "sum()", "__import__('os')"]
)
def test_unsafe_or_invalid_expression_rejected(expression):
    with pytest.raises(CalculationError):
        evaluate_expression(
            CalculationExpression(name="x", label="测试", expression=expression),
            {"a": quantity("10", "元")},
        )


def test_legacy_rows_resolve_only_unique_formal_org_code():
    from ask_metric.application.calculation_service import build_calculation_facts

    rows = [
        {
            "metric_code": "M",
            "metric_value": "1.123456",
            "org_name": "甲行",
            "stat_date": "2026-03-31",
        }
    ]
    catalog = {
        "metrics": [{"code": "M", "name": "指标", "unit": "元"}],
        "organizations": [{"code": "O1", "name": "甲行"}],
    }
    assert build_calculation_facts("t", rows, catalog)[0]["org_code"] == "O1"
    catalog["organizations"].append({"code": "O2", "name": "甲行"})
    assert build_calculation_facts("t", rows, catalog) == []


def test_unreferenced_declared_names_rejected():
    # 常数合法（"3" 是用户问题里的独立数值 token）但未被表达式引用，必须拒绝
    from ask_metric.domain.calculation import FactBinding, UserConstant

    service, request, task, _, messages = calculation_fixture()
    context = task.state_json["channel_context"]["calculation_context"]
    context["user_question"] = "指标甲减指标乙的3倍"
    request.constants["c"] = UserConstant(value="3", source_text="3")
    with pytest.raises(ApplicationError) as error:
        service.calculate(request, SimpleNamespace(user_id="u"), "key-unused-constant")
    assert error.value.code == "CALCULATION_INVALID"
    assert "未被任何表达式引用" in error.value.message
    assert not messages

    # 绑定同理：声明了数据变量却不被任何表达式使用，同样拒绝
    service, request, task, _, messages = calculation_fixture()
    request.bindings["c"] = FactBinding(fact_id="fact:t:0:metric_value")
    with pytest.raises(ApplicationError) as error:
        service.calculate(request, SimpleNamespace(user_id="u"), "key-unused-binding")
    assert error.value.code == "CALCULATION_INVALID"
    assert "未被任何表达式引用" in error.value.message
    assert not messages


def snapshot_request(request):
    return request.model_copy(update={
        "source_policy": "conversation_snapshots",
        "scope_id": "new-calculation-turn",
        "user_question": "用之前的两个原值计算甲减乙",
    }, deep=True)


@pytest.mark.parametrize("historical", [False, True])
def test_same_request_key_cannot_change_source_task(historical):
    service, request, first, _, messages = calculation_fixture()
    second = deepcopy(first)
    second.id = "second"
    for fact in second.state_json["result_artifact"]["result"]["facts"]:
        fact["task_id"] = second.id
        fact["fact_id"] = fact["fact_id"].replace("fact:t:", "fact:second:")
    tasks = {first.id: first, second.id: second}
    service.uow_factory().__enter__().tasks.get_owned_for_update = (
        lambda task_id, _user: tasks.get(task_id)
    )
    if historical:
        request = snapshot_request(request)
    actor = SimpleNamespace(user_id="u")
    result = service.calculate(request, actor, "same-key")
    changed = request.model_copy(deep=True)
    for binding in changed.bindings.values():
        binding.fact_id = binding.fact_id.replace("fact:t:", "fact:second:")
    with pytest.raises(ApplicationError) as error:
        service.calculate(changed, actor, "same-key")
    assert error.value.code == "CALCULATION_CONFLICT"
    assert error.value.status_code == 409
    assert len(messages) == 1
    assert "calculations" not in second.state_json
    assert service.calculate(request, actor, "same-key") == result
    # 独立请求仍可选取其他来源，不把同会话的合法新计算当成重复。
    another = service.calculate(changed, actor, "another-key")
    assert another["calculation_id"] != result["calculation_id"]
    assert len(messages) == 2


def test_historical_snapshot_difference_preserves_input_and_source_identity():
    service, original, task, _, messages = calculation_fixture()
    before = deepcopy(task.state_json["result_artifact"])
    request = snapshot_request(original)
    result = service.calculate(request, SimpleNamespace(user_id="u"), "snapshot-key")
    assert result["results"][0]["value"] == "1.123455"
    assert result["scope_id"] == "new-calculation-turn"
    assert result["sources"] == [{"task_id": "t", "result_id": "result:t",
                                   "source_scope_id": "scope", "historical": True}]
    assert task.state_json["result_artifact"] == before
    assert result["inputs"]["a"]["value"] == before["result"]["facts"][0]["value"]
    assert service.calculate(request, SimpleNamespace(user_id="u"), "snapshot-key") == result
    assert len(messages) == 1


def test_snapshots_from_multiple_turns_recheck_every_task_and_permission_on_replay():
    service, request, task, execution, messages = calculation_fixture()
    second = deepcopy(task)
    second.id = "second"
    second.state_json["channel_context"]["calculation_context"] = {
        "scope_id": "another-query-turn", "user_question": "查询另一个指标",
    }
    fact = second.state_json["result_artifact"]["result"]["facts"][1]
    fact.update(task_id="second", fact_id="fact:second:1:metric_value")
    tasks = {"t": task, "second": second}
    read_ids = []
    uow = service.uow_factory().__enter__()

    def get_task(task_id, _user):
        read_ids.append(task_id)
        return tasks.get(task_id)

    uow.tasks.get_owned_for_update = get_task
    request = snapshot_request(request)
    request.bindings["b"].fact_id = fact["fact_id"]
    result = service.calculate(request, SimpleNamespace(user_id="u"), "multi-key")
    assert result["results"][0]["value"] == "1.123455"
    assert {s["source_scope_id"] for s in result["sources"]} == {"scope", "another-query-turn"}
    assert set(read_ids) == {"t", "second"}

    def revoked(**kwargs):
        raise PermissionDeniedError("revoked")

    execution._authorize_query = revoked
    with pytest.raises(ApplicationError, match="当前无权") as error:
        service.calculate(request, SimpleNamespace(user_id="u"), "multi-key")
    assert error.value.code == "CALCULATION_FORBIDDEN"
    assert len(messages) == 1


@pytest.mark.parametrize("change,code", [
    ("expired", "CALCULATION_SOURCE_EXPIRED"),
    ("foreign", "CALCULATION_SOURCE_UNAVAILABLE"),
    ("missing_task", "CALCULATION_SOURCE_UNAVAILABLE"),
    ("truncated", "CALCULATION_SOURCE_INCOMPLETE"),
    ("missing_metric", "CALCULATION_SOURCE_INCOMPLETE"),
    ("fact", "CALCULATION_FACT_UNAVAILABLE"),
    ("failed", "CALCULATION_SOURCE_NOT_READY"),
    ("unit", "CALCULATION_INVALID"),
    ("date", "CALCULATION_INVALID"),
    ("org", "CALCULATION_INVALID"),
    ("no_question", "CALCULATION_QUESTION_REQUIRED"),
])
def test_snapshot_policy_keeps_source_and_math_guards(change, code):
    from datetime import UTC, datetime, timedelta

    service, request, task, _, messages = calculation_fixture()
    request = snapshot_request(request)
    result = task.state_json["result_artifact"]["result"]
    if change == "expired":
        task.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    elif change == "foreign":
        task.conversation_id = "another-conversation"
    elif change == "missing_task":
        service.uow_factory().__enter__().tasks.get_owned_for_update = lambda *_: None
    elif change == "truncated":
        result["truncated"] = True
    elif change == "missing_metric":
        result["evidence"] = {"missing_metric_notice": "合成缺失"}
    elif change == "fact":
        request.bindings["b"].fact_id = "fact:t:999:metric_value"
    elif change == "failed":
        task.status = "FAILED"
    elif change == "unit":
        result["facts"][1]["unit"] = "户"
    elif change == "date":
        result["facts"][1]["date"] = "2026-04-30"
    elif change == "org":
        result["facts"][1]["org_code"] = "OTHER"
    elif change == "no_question":
        request.user_question = None
    with pytest.raises(ApplicationError) as error:
        service.calculate(request, SimpleNamespace(user_id="u"), "invalid-snapshot")
    assert error.value.code == code
    assert not messages
    assert "calculations" not in task.state_json


def test_cross_org_historical_difference_and_changed_replay():
    service, request, task, execution, _ = calculation_fixture()
    request = snapshot_request(request)
    facts = task.state_json["result_artifact"]["result"]["facts"]
    facts[0].update(value="12000.1234", org_code="A")
    facts[1].update(value="3000.0100", org_code="B")
    task.state_json["result_artifact"]["logical_dsl"]["orgs"] = ["A", "B"]
    execution._authorize_query = lambda **kwargs: (
        SimpleNamespace(orgs=["A", "B"]),
        [SimpleNamespace(code=f"M{i}", unit="元") for i in range(2)], None,
    )
    request.scope_policy = "cross_org"
    result = service.calculate(request, SimpleNamespace(user_id="u"), "cross-org")
    assert result["results"][0]["value"] == "9000.1134"
    assert result["results"][0]["reply_value"] == "0.90"
    request.expressions[0].expression = "b-a"
    with pytest.raises(ApplicationError) as error:
        service.calculate(request, SimpleNamespace(user_id="u"), "cross-org")
    assert error.value.code == "CALCULATION_CONFLICT"


def test_historical_constants_must_come_from_current_question():
    from ask_metric.domain.calculation import UserConstant

    service, request, task, _, _ = calculation_fixture()
    task.state_json["channel_context"]["calculation_context"]["user_question"] = "查询3个指标"
    request = snapshot_request(request)
    request.constants["factor"] = UserConstant(value="3", source_text="3")
    request.expressions[0].expression = "a-b*factor"
    with pytest.raises(ApplicationError):
        service.calculate(request, SimpleNamespace(user_id="u"), "old-constant")
    request.user_question = "甲减去乙的3倍"
    result = service.calculate(request, SimpleNamespace(user_id="u"), "new-constant")
    assert result["inputs"]["factor"]["kind"] == "user_constant"
    assert result["sources"][0]["historical"] is True


@pytest.mark.parametrize("historical", [False, True])
def test_persisted_replay_is_scoped_to_conversation_and_rechecks_permissions(historical):
    """实际 ORM/事务和 JSON 往返；仅创建内存 SQLite，不读取本机数据库配置。"""
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker

    from ask_metric.infrastructure.db.base import Base
    from ask_metric.infrastructure.db.models import ChatConversation, ChatMessage, QueryTask
    from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

    _, template, source, execution, _ = calculation_fixture()
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    execution.uow_factory = lambda: SqlAlchemyUnitOfWork(sessions)
    original_artifacts = {}

    def request_for(conversation_id, task_id):
        request = snapshot_request(template) if historical else template.model_copy(deep=True)
        request.conversation_id = conversation_id
        for binding in request.bindings.values():
            binding.fact_id = binding.fact_id.replace("fact:t:", f"fact:{task_id}:")
        return request

    try:
        with sessions() as session:
            session.add_all([
                ChatConversation(id=cid, title="合成会话", owner_user_id="u", preview="")
                for cid in ("c1", "c2")
            ])
            for cid, task_id in (("c1", "t1"), ("c1", "t2"), ("c2", "t3")):
                state = deepcopy(source.state_json)
                for fact in state["result_artifact"]["result"]["facts"]:
                    fact["task_id"] = task_id
                    fact["fact_id"] = fact["fact_id"].replace("fact:t:", f"fact:{task_id}:")
                original_artifacts[task_id] = deepcopy(state["result_artifact"])
                session.add(QueryTask(
                    id=task_id, conversation_id=cid, original_question="合成问题",
                    status="SUCCEEDED", current_stage="RESULT_FORMATTING", state_json=state,
                ))
            session.commit()

        actor = SimpleNamespace(user_id="u")
        request = request_for("c1", "t1")
        first = CalculationApplicationService(execution).calculate(request, actor, "same-key")
        # 新服务实例、新 Session 从落库记录恢复，不依赖先前进程内对象。
        service = CalculationApplicationService(execution)
        assert service.calculate(request, actor, "same-key") == first
        with pytest.raises(ApplicationError) as conflict:
            service.calculate(request_for("c1", "t2"), actor, "same-key")
        assert conflict.value.code == "CALCULATION_CONFLICT"
        other = service.calculate(request_for("c2", "t3"), actor, "same-key")
        assert other["calculation_id"] != first["calculation_id"]
        with pytest.raises(ApplicationError) as forbidden:
            service.calculate(request, SimpleNamespace(user_id="other-user"), "same-key")
        assert forbidden.value.code == "CALCULATION_CONTEXT_NOT_FOUND"

        def revoked(**kwargs):
            raise PermissionDeniedError("synthetic permission revoked")

        execution._authorize_query = revoked
        with pytest.raises(ApplicationError) as revoked_replay:
            service.calculate(request, actor, "same-key")
        assert revoked_replay.value.code == "CALCULATION_FORBIDDEN"
        with sessions() as session:
            messages = list(session.scalars(select(ChatMessage)))
            assert len(messages) == 2
            assert len({message.id for message in messages}) == 2
            assert all(message.payload["request_id"] == "same-key" for message in messages)
            assert "calculations" not in session.get(QueryTask, "t2").state_json
            for task_id, artifact in original_artifacts.items():
                assert session.get(QueryTask, task_id).state_json["result_artifact"] == artifact
        with execution.uow_factory() as uow:
            c1_message = next(message for message in messages if message.conversation_id == "c1")
            assert uow.messages.get(c1_message.id, "c2") is None
    finally:
        engine.dispose()
