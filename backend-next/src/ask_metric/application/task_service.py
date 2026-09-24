from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from time import perf_counter
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from ask_metric.application.commands import SubmitQuestionCommand
from ask_metric.application.ports import PermissionDeniedError, PermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_results import TaskCommandResult, TaskResultPage
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.calculation import CalculationScope
from ask_metric.domain.catalog_references import explicit_catalog_references
from ask_metric.domain.metric_matching import conflicting_metric_references
from ask_metric.domain.query_execution import QueryExecutionResult
from ask_metric.domain.task import (
    QueryTaskStage,
    QueryTaskState,
    QueryTaskStatus,
    append_task_trace,
)
from ask_metric.infrastructure.db.models import ChatConversation, ChatMessage, QueryTask
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.export.xlsx import build_xlsx
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

_RESULT_COLUMN_LABELS = {
    "metric_code": "指标编码",
    "metric_name": "指标名称",
    "unit": "单位",
    "org_name": "机构名称",
    "metric_value": "指标值",
    "stat_date": "统计日期",
    "rank": "排名",
    "period": "期间",
    "current_date": "本期日期",
    "current_value": "本期值",
    "base_date": "基期日期",
    "base_value": "基期值",
    "difference": "差值",
    "change_rate": "变化率",
    "left_org": "左侧机构",
    "left_value": "左侧值",
    "right_org": "右侧机构",
    "right_value": "右侧值",
    "ratio": "比值",
    "higher_org": "较高机构",
    "status": "状态",
    "method": "计算方式",
}


def _result_column_label(column: object) -> str:
    value = str(column)
    return _RESULT_COLUMN_LABELS.get(value, value)

# Callable[[], T] 表示“无参数、返回 T 的函数”；每次调用工厂才创建新的数据库单元。
UnitOfWorkFactory = Callable[[], SqlAlchemyUnitOfWork]
_PROCESSED_REQUEST_LIMIT = 50


class TaskNotFoundError(ApplicationError):
    def __init__(self, task_id: str) -> None:
        super().__init__("TASK_NOT_FOUND", f"QueryTask {task_id} was not found", status_code=404)


class ConversationNotFoundError(ApplicationError):
    def __init__(self, conversation_id: str) -> None:
        super().__init__(
            "CONVERSATION_NOT_FOUND",
            f"Conversation {conversation_id} was not found",
            status_code=404,
        )


class TaskConflictError(ApplicationError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status_code=409, details=details)


class ConversationLimitReachedError(ApplicationError):
    def __init__(self, limit: int) -> None:
        super().__init__(
            "CONVERSATION_LIMIT_REACHED",
            f"会话数量已达到上限（{limit} 个），请先导出或删除部分历史会话。",
            status_code=409,
            details={"limit": limit},
        )


class QueryTaskApplicationService:
    """管理问题提交和历史结果读取；SQL 执行交给 QueryExecutionApplicationService。"""
    def __init__(
        self,
        uow_factory: UnitOfWorkFactory | None = None,
        semantic_config_repository: SemanticConfigRepository | None = None,
        max_conversations_per_user: int = 500,
        permission_service: PermissionService | None = None,
    ) -> None:
        self.uow_factory = uow_factory or SqlAlchemyUnitOfWork
        self.semantic_config_repository = semantic_config_repository
        self.max_conversations_per_user = max_conversations_per_user
        self.permission_service = permission_service

    def submit_question(self, command: SubmitQuestionCommand) -> TaskCommandResult:
        """在会话归属范围内创建任务；相同幂等键及内容的重试复用已有任务。"""
        context = command.request.channel_context.get("calculation_context")
        if context:
            try:
                CalculationScope.model_validate(context)
            except ValidationError as exc:
                raise ApplicationError("CALCULATION_CONTEXT_INVALID", "计算范围格式无效。",
                                       status_code=422) from exc
        conversation_id = _resolve_conversation_id(command)
        fingerprint = _question_fingerprint(command, conversation_id)

        try:
            return self._submit_question_once(command, conversation_id, fingerprint)
        except IntegrityError as exc:
            if not _is_recoverable_idempotency_race(exc):
                raise
            # 两个请求可能同时查到“尚无任务”；数据库唯一约束决定谁先创建成功。
            # 只恢复已识别的幂等竞争，其他完整性错误仍抛出，避免掩盖真实故障。
            return self._recover_concurrent_question(command, conversation_id, fingerprint)

    def _submit_question_once(
        self,
        command: SubmitQuestionCommand,
        conversation_id: str,
        fingerprint: str,
    ) -> TaskCommandResult:
        creation_started = perf_counter()
        with self.uow_factory() as uow:
            conversation = (
                uow.conversations.get_owned_for_update(conversation_id, command.actor.user_id or "")
                if conversation_id.startswith("agent:")
                else uow.conversations.get(conversation_id)
            )
            if conversation is None and conversation_id.startswith("agent:"):
                raise ConversationNotFoundError(conversation_id)
            if conversation is not None and conversation.owner_user_id != command.actor.user_id:
                raise ConversationNotFoundError(conversation_id)
            existing = uow.tasks.find_by_idempotency_key(
                conversation_id, command.idempotency_key
            )
            if existing is not None:
                self._authorize_task_result(command.actor, existing, uow=uow)
                return _question_replay_result(
                    existing,
                    fingerprint,
                    original_question=command.request.text,
                )

            scope = command.request.channel_context.get("calculation_context")
            if command.basic_query is not None and scope:
                conflicts = conflicting_metric_references(
                    CalculationScope.model_validate(scope).user_question,
                    command.basic_query.metric_codes,
                    uow.metric_catalog.list_enabled(),
                )
                if conflicts:
                    names = "；".join(
                        f"所选「{selected.name}」与原文完整指标「{matched.name}」冲突"
                        for selected, matched in conflicts
                    )
                    # 在创建任务和执行 SQL 前拒绝，交由 pi 重新核对；不能静默改查另一指标。
                    raise ApplicationError(
                        "QUERY_METRIC_REFERENCE_CONFLICT",
                        f"{names}。请保留原文完整名称重新核对目录，不能用短别名替代。",
                        status_code=422,
                    )

            task_id = str(uuid4())
            now = datetime.now(UTC)
            if conversation is None:
                if not command.actor.user_id:
                    raise ConversationNotFoundError(conversation_id)
                if (
                    uow.conversations.count_owned(command.actor.user_id)
                    >= self.max_conversations_per_user
                ):
                    raise ConversationLimitReachedError(self.max_conversations_per_user)
                conversation = ChatConversation(
                    id=conversation_id,
                    title=_conversation_title(command.request.text),
                    preview=_preview(command.request.text),
                    owner_user_id=command.actor.user_id,
                    created_at=now,
                    updated_at=now,
                )
                uow.conversations.add(conversation)
            else:
                conversation.preview = _preview(command.request.text)
                conversation.updated_at = now
            uow.flush()

            message_id = str(uuid4())
            state = QueryTaskState(
                initial_message_id=message_id,
                request_fingerprint=fingerprint,
                channel_context={
                    "channel": command.request.channel,
                    "external_user_id": command.request.external_user_id,
                    "external_session_id": command.request.external_session_id,
                    "external_message_id": command.request.external_message_id,
                    "reply_to_external_message_id": command.request.reply_to_external_message_id,
                    "reply_to_task_id": command.request.reply_to_task_id,
                    **command.request.channel_context,
                },
                actor_context=command.actor.model_dump(mode="json"),
            )
            initial_stage = QueryTaskStage.SLOT_EXTRACTION
            if command.basic_query is not None:
                # 结构化调用直接进入同一执行链；不调用模型，也不注入历史条件。
                spec = command.basic_query
                state.logical_dsl = spec.to_logical_dsl().model_dump(mode="json")
                state.debug["basic_query"] = spec.model_dump(mode="json")
                initial_stage = QueryTaskStage.LOGICAL_DSL
            _record_processed_request(
                state,
                command.request.request_id,
                kind="submit_question",
                fingerprint=fingerprint,
                message_id=message_id,
            )
            task = QueryTask(
                id=task_id,
                conversation_id=conversation_id,
                original_question=command.request.text,
                status=QueryTaskStatus.RUNNING.value,
                current_stage=initial_stage.value,
                intent="metric_query" if command.basic_query is not None else None,
                query_shape=(
                    command.basic_query.query_shape if command.basic_query is not None else None
                ),
                state_json=state.model_dump(mode="json"),
                version=0,
                idempotency_key=command.idempotency_key,
                created_at=now,
                updated_at=now,
            )
            uow.tasks.add(task)
            uow.flush()
            uow.messages.add(
                ChatMessage(
                    id=message_id,
                    conversation_id=conversation_id,
                    task_id=task_id,
                    role="user",
                    content=command.request.text,
                    payload={
                        "kind": "question",
                        "request_id": command.request.request_id,
                        "channel": command.request.channel,
                    },
                    created_at=now,
                )
            )
            state.timings_ms["task_creation_ms"] = max(
                0, round((perf_counter() - creation_started) * 1000)
            )
            state.debug["task_create"] = {
                "input": {
                    "question": command.request.text,
                    "conversation_id": conversation_id,
                    "request_id": command.request.request_id,
                    "idempotency_key": command.idempotency_key,
                },
                "output": {
                    "task_id": task_id,
                    "version": task.version,
                    "status": task.status,
                    "current_stage": task.current_stage,
                },
            }
            append_task_trace(
                state,
                stage=initial_stage.value,
                status=QueryTaskStatus.RUNNING.value,
                node="task_created",
                detail={"message_id": message_id},
            )
            task.state_json = state.model_dump(mode="json")
            uow.commit()
            return _task_result(task, message_id=message_id)

    def _recover_concurrent_question(
        self,
        command: SubmitQuestionCommand,
        conversation_id: str,
        fingerprint: str,
    ) -> TaskCommandResult:
        with self.uow_factory() as uow:
            existing = uow.tasks.find_by_idempotency_key(
                conversation_id, command.idempotency_key
            )
            if existing is None:
                # The competing request may only have created the shared conversation.
                # Retry once after that transaction has committed.
                return self._submit_question_once(
                    command,
                    conversation_id,
                    fingerprint,
                )
            self._authorize_task_result(command.actor, existing, uow=uow)
            return _question_replay_result(
                existing,
                fingerprint,
                original_question=command.request.text,
            )

    def get_task_result(
        self, task_id: str, actor: ActorContext, *, offset: int = 0, limit: int = 100,
        read_question: str | None = None,
    ) -> TaskResultPage:
        """统一结果读取：从不可变 ResultArtifact 返回分页事实，不触发 SQL 或重算。"""
        with self.uow_factory() as uow:
            task = _get_owned_task(uow, task_id, actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(task_id)
            state = _load_state(task)
            artifact = getattr(state, "result_artifact", None)
            saved = artifact.get("result") if isinstance(artifact, dict) else None
            if task.status != QueryTaskStatus.SUCCEEDED.value or not isinstance(saved, dict):
                if task.status == QueryTaskStatus.SUCCEEDED.value:
                    raise TaskConflictError(
                        "RESULT_SNAPSHOT_MISSING",
                        "The succeeded query result snapshot is missing",
                        details={"task_id": task.id},
                    )
                raise TaskConflictError(
                    "RESULT_NOT_READY",
                    "The query result is not ready",
                    details={"task_id": task.id, "status": task.status},
                )
            result = QueryExecutionResult.model_validate(saved)
            self._authorize_task_result(actor, task, uow=uow)
            if read_question is not None:
                config = (
                    self.semantic_config_repository.load()
                    if self.semantic_config_repository is not None else None
                )
                requested = explicit_catalog_references(
                    read_question,
                    metrics=uow.metric_catalog.list_enabled(),
                    organizations=uow.organization_catalog.list_enabled(),
                    organization_aliases=config.organization_aliases if config else {},
                )
                # 历史结果即使零行也必须按正式条件核对，不能由模型选中哪个引用就交付哪个。
                dsl = result.evidence.get("logical_dsl") or artifact.get("logical_dsl") or {}
                conflicts = {
                    field: {"requested": sorted(codes), "selected": dsl.get(field, [])}
                    for field, codes in requested.items()
                    if codes and not codes.issubset(set(dsl.get(field, [])))
                }
                if conflicts:
                    raise TaskConflictError(
                        "RESULT_REFERENCE_CONFLICT",
                        "所选历史结果与本轮明确指定的机构或指标不一致，请重新定位已有结果。",
                        details={"task_id": task.id, "conflicts": conflicts},
                    )
            page_rows = result.rows[offset : offset + limit]
            next_offset = offset + len(page_rows)
            page_indices = {str(index) for index in range(offset, next_offset)}
            return TaskResultPage(
                task_id=task.id,
                result_id=artifact["result_id"],
                status=result.status,
                query_shape=result.query_shape,
                columns=result.columns,
                rows=page_rows,
                comparisons=result.comparisons,
                facts=[fact for fact in result.facts
                       if len(fact.get("fact_id", "").split(":")) == 4
                       and fact["fact_id"].split(":")[2] in page_indices],
                calculation_scope_id=(
                    state.channel_context.get("calculation_context", {}).get("scope_id")
                ),
                row_count=result.row_count,
                truncated=result.truncated,
                offset=offset,
                limit=limit,
                next_offset=next_offset if next_offset < len(result.rows) else None,
                has_more=next_offset < len(result.rows),
                message=result.message,
                answer_blocks=result.answer_blocks,
                evidence=result.evidence,
            )

    def get_task(self, task_id: str, actor: ActorContext) -> TaskCommandResult:
        with self.uow_factory() as uow:
            task = uow.tasks.get_owned(task_id, actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(task_id)
            self._authorize_task_result(actor, task, uow=uow)
            return _task_result(task)

    def _authorize_task_result(
        self, actor: ActorContext, task: QueryTask, *, result_payload: dict | None = None,
        uow: SqlAlchemyUnitOfWork | None = None,
    ) -> None:
        """所有含成功结果或诊断事实的入口共用校验；旧记录仅从可信持久化条件恢复。"""
        if self.permission_service is None:
            return
        state = task.state_json or {}
        artifact = state.get("result_artifact") or {}
        saved = artifact.get("result") or result_payload or {}
        if not saved and task.status == QueryTaskStatus.SUCCEEDED.value and uow is not None:
            saved = _message_query_result(
                uow.messages.list_for_conversation(task.conversation_id), task.id,
            ) or {}
        has_result = (
            task.status == QueryTaskStatus.SUCCEEDED.value or bool(saved)
            or (state.get("execution") or {}).get("status") == "succeeded"
        )
        if not has_result:
            return
        sources = (
            artifact.get("logical_dsl"), (saved.get("evidence") or {}).get("logical_dsl"),
            state.get("logical_dsl"),
        )
        dsl = next((
            value for value in sources if isinstance(value, dict) and value.get("orgs")
        ), None)
        if dsl is None:
            raise ApplicationError(
                "RESULT_SCOPE_UNAVAILABLE", "历史结果缺少可信机构范围，无法安全读取，请重新查询。",
                status_code=409,
            )
        self._authorize_saved_result(actor, dsl)
        # 旧排名记录可能保存上级条件，结果里的实际机构仍须逐一复核。
        result_orgs = {row.get("org_code") for row in saved.get("rows", []) if row.get("org_code")}
        if result_orgs:
            self._authorize_saved_result(actor, {**dsl, "orgs": sorted(result_orgs)})

    def _authorize_saved_result(self, actor: ActorContext, dsl: dict | None) -> None:
        """结果引用不是授权票据；任一组成机构失权时拒绝整个快照。"""
        if self.permission_service is None:
            return
        if not dsl or not dsl.get("orgs"):
            raise ApplicationError(
                "RESULT_SCOPE_UNAVAILABLE", "历史结果缺少可信机构范围，无法安全读取，请重新查询。",
                status_code=409,
            )
        try:
            authorized = self.permission_service.authorize_logical_dsl(
                actor=actor, logical_dsl=dsl,
            )
            if set(authorized.get("orgs", [])) != set(dsl.get("orgs", [])):
                raise PermissionDeniedError("结果机构范围已变化")
        except PermissionDeniedError as exc:
            raise ApplicationError("ORG_SCOPE_FORBIDDEN", "无权访问该查询结果。",
                                   status_code=403) from exc

    def export_task_result(self, task_id: str, actor: ActorContext) -> tuple[str, bytes]:
        with self.uow_factory() as uow:
            task = uow.tasks.get_owned(task_id, actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(task_id)
            messages = uow.messages.list_for_conversation(task.conversation_id)
            result_payload = _message_query_result(messages, task_id)
            self._authorize_task_result(actor, task, result_payload=result_payload)
            if not isinstance(result_payload, dict):
                raise ApplicationError(
                    "QUERY_RESULT_NOT_FOUND", "该任务没有可导出的查询结果。", status_code=404
                )
            # Match the UI table: comparisons are derived answer facts, not source rows.
            rows = result_payload.get("rows") or []
            columns = result_payload.get("columns") or (list(rows[0]) if rows else [])
            columns = [column for column in columns if column.strip().lower() != "unit"]
            workbook = build_xlsx(
                [
                    (
                        "查询结果",
                        [_result_column_label(column) for column in columns],
                        [[row.get(column) for column in columns] for row in rows],
                    )
                ]
            )
            return task.original_question, workbook


def _resolve_conversation_id(command: SubmitQuestionCommand) -> str:
    if command.request.conversation_id:
        return command.request.conversation_id
    stable_context = command.request.external_session_id or command.request.request_id
    if command.basic_query is not None:
        # 无会话 ID 的工具重试仍须落在同一幂等范围，且不同用户不能共用会话。
        stable_context = f"{command.actor.user_id}:{command.idempotency_key}"
    return str(
        uuid5(
            NAMESPACE_URL,
            f"ask-metric:conversation:{command.request.channel}:{stable_context}",
        )
    )


def _get_owned_task(uow, task_id: str, user_id: str):
    getter = getattr(uow.tasks, "get_owned", None)
    return getter(task_id, user_id) if getter else uow.tasks.get(task_id)


def _question_fingerprint(command: SubmitQuestionCommand, conversation_id: str) -> str:
    return _fingerprint(
        {
            "kind": "submit_question",
            "conversation_id": conversation_id,
            "text": command.request.text,
            "channel": command.request.channel,
            "external_user_id": command.request.external_user_id,
            "external_session_id": command.request.external_session_id,
            "external_message_id": command.request.external_message_id,
            "reply_to_task_id": command.request.reply_to_task_id,
            "actor": command.actor.subject,
            **({"calculation_context": command.request.channel_context["calculation_context"]}
               if command.request.channel_context.get("calculation_context") else {}),
            **({"basic_query": command.basic_query.model_dump(mode="json")}
               if command.basic_query is not None else {}),
        }
    )


def _fingerprint(value: Any) -> str:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _is_recoverable_idempotency_race(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    diagnostic = getattr(orig, "diag", None)
    constraint_name = getattr(diagnostic, "constraint_name", None)
    return constraint_name in {
        "chat_conversations_pkey",
        "uq_query_tasks_conversation_idempotency",
    }


def _load_state(task: QueryTask) -> QueryTaskState:
    return QueryTaskState.model_validate(task.state_json or {})


def _record_processed_request(
    state: QueryTaskState,
    request_id: str,
    *,
    kind: str,
    fingerprint: str,
    message_id: str | None,
) -> None:
    if not request_id:
        return
    state.processed_requests[request_id] = {
        "kind": kind,
        "fingerprint": fingerprint,
        "message_id": message_id,
    }
    while len(state.processed_requests) > _PROCESSED_REQUEST_LIMIT:
        state.processed_requests.pop(next(iter(state.processed_requests)))


def _question_replay_result(
    task: QueryTask,
    fingerprint: str,
    *,
    original_question: str,
) -> TaskCommandResult:
    state = _load_state(task)
    if state.request_fingerprint and state.request_fingerprint != fingerprint:
        raise TaskConflictError(
            "IDEMPOTENCY_KEY_REUSED",
            "The same idempotency key was reused with a different question",
            details={"task_id": task.id, "conversation_id": task.conversation_id},
        )
    if not state.request_fingerprint and task.original_question != original_question:
        raise TaskConflictError(
            "IDEMPOTENCY_KEY_REUSED",
            "A legacy task reused the idempotency key with a different question",
            details={"task_id": task.id, "conversation_id": task.conversation_id},
        )
    return _task_result(
        task,
        message_id=state.initial_message_id,
        idempotent_replay=True,
    )


def _task_result(
    task: QueryTask,
    *,
    message_id: str | None = None,
    idempotent_replay: bool = False,
) -> TaskCommandResult:
    state = _load_state(task)
    return TaskCommandResult(
        task_id=task.id,
        conversation_id=task.conversation_id,
        version=task.version,
        status=task.status,
        current_stage=task.current_stage,
        message_id=message_id,
        idempotent_replay=idempotent_replay,
        clarification=state.clarification,
        # 历史任务的状态里可能仍留有旧链路澄清令牌，读取时透传，不新生成。
        continuation_token=(state.clarification or {}).get("continuation_token"),
        slot_frame=state.slots or state.slot_frame,
        logical_dsl=state.logical_dsl,
        missing=state.missing_slots,
        query_shape=task.query_shape,
        resolved_question=state.resolved_question,
        error_code=task.error_code,
        error_message=task.error_message,
        timings_ms=state.timings_ms,
        debug=state.debug,
        result=_result_ref(state),
    )


def _result_ref(state: QueryTaskState) -> dict[str, Any] | None:
    """从不可变 ResultArtifact 构造轻量结果引用；不读不存在的 execution.result，
    完整明细经 GET /query-tasks/{id}/result 读取。"""
    artifact = getattr(state, "result_artifact", None)
    if not isinstance(artifact, dict) or not artifact.get("result_id"):
        return None
    saved = artifact.get("result")
    if not isinstance(saved, dict):
        return None
    return {
        "result_id": artifact["result_id"],
        "task_id": artifact.get("task_id"),
        "source_run_id": artifact.get("source_run_id"),
        "status": saved.get("status"),
        "row_count": saved.get("row_count"),
        "truncated": saved.get("truncated", False),
    }


def _conversation_title(text: str) -> str:
    value = text.strip()
    return value[:80] + ("..." if len(value) > 80 else "")


def _preview(text: str) -> str:
    value = text.strip()
    return value[:200] + ("..." if len(value) > 200 else "")


def _message_query_result(messages: list, task_id: str) -> dict | None:
    """兼容仅在历史消息中保存结果的记录，不执行查询或猜测机构范围。"""
    return next((
        message.payload.get("result") for message in reversed(messages)
        if message.task_id == task_id and message.payload
        and message.payload.get("kind") == "query_result"
    ), None)
