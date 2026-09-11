from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, date, datetime
from time import perf_counter
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from sqlalchemy.exc import IntegrityError

from ask_metric.application.commands import (
    CancelClarificationCommand,
    RequestClarificationCommand,
    SubmitClarificationCommand,
    SubmitQuestionCommand,
)
from ask_metric.application.context_diagnostics import context_failure, log_context_failure
from ask_metric.application.continuation_tokens import (
    ContinuationTarget,
    ContinuationTokenCodec,
)
from ask_metric.application.conversation_context_service import (
    ConversationShadowService,
    MultiturnRolloutReadinessPolicy,
    MultiturnShadowMetricsAggregator,
)
from ask_metric.application.ports import NoopPermissionService, PermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.application.result_repository import hydrate_legacy_results, result_inventory
from ask_metric.application.semantic_workflow import (
    advance_slot_frame,
    apply_clarification_answers,
    resolved_question,
)
from ask_metric.application.task_results import (
    ConversationCleanupResult,
    ConversationListItem,
    ConversationMessageResult,
    ConversationSnapshot,
    ConversationTaskResult,
    TaskCommandResult,
)
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.conversation_context import (
    MultiturnHumanReview,
    MultiturnReviewSample,
    MultiturnRolloutReadiness,
    MultiturnRolloutThresholds,
    MultiturnShadowMetrics,
)
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.task import (
    QueryTaskStage,
    QueryTaskState,
    QueryTaskStatus,
    append_task_trace,
)
from ask_metric.domain.task_state_machine import InvalidTaskTransition, QueryTaskStateMachine
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
    def __init__(
        self,
        uow_factory: UnitOfWorkFactory | None = None,
        continuation_token_codec: ContinuationTokenCodec | None = None,
        semantic_config_repository: SemanticConfigRepository | None = None,
        today_provider: Callable[[], date] = date.today,
        max_conversations_per_user: int = 500,
        multiturn_shadow_enabled: bool = False,
        conversation_shadow_service: ConversationShadowService | None = None,
        candidate_permission_service: PermissionService | None = None,
        candidate_query_planner: QueryPlanner | None = None,
        multiturn_metrics_aggregator: MultiturnShadowMetricsAggregator | None = None,
        multiturn_rollout_thresholds: MultiturnRolloutThresholds | None = None,
    ) -> None:
        self.uow_factory = uow_factory or SqlAlchemyUnitOfWork
        self.continuation_token_codec = continuation_token_codec
        self.semantic_config_repository = semantic_config_repository
        self.today_provider = today_provider
        self.max_conversations_per_user = max_conversations_per_user
        self.multiturn_shadow_enabled = multiturn_shadow_enabled
        self.conversation_shadow_service = (
            conversation_shadow_service or ConversationShadowService()
        )
        self.candidate_permission_service = (
            candidate_permission_service or NoopPermissionService()
        )
        self.candidate_query_planner = candidate_query_planner or QueryPlanner(
            dialect="mysql"
        )
        self.multiturn_metrics_aggregator = (
            multiturn_metrics_aggregator or MultiturnShadowMetricsAggregator()
        )
        self.multiturn_rollout_policy = MultiturnRolloutReadinessPolicy(
            multiturn_rollout_thresholds
            or MultiturnRolloutThresholds(
                min_reviewed_samples=30,
                min_approval_rate=0.95,
                min_gray_success_rate=0.98,
                max_fallback_rate=0.05,
                max_failure_rate=0.01,
            )
        )

    def submit_question(self, command: SubmitQuestionCommand) -> TaskCommandResult:
        conversation_id = _resolve_conversation_id(command)
        fingerprint = _question_fingerprint(command, conversation_id)

        try:
            return self._submit_question_once(command, conversation_id, fingerprint)
        except IntegrityError as exc:
            if not _is_recoverable_idempotency_race(exc):
                raise
            # A concurrent request may have won the unique idempotency race.
            return self._recover_concurrent_question(command, conversation_id, fingerprint)

    def _submit_question_once(
        self,
        command: SubmitQuestionCommand,
        conversation_id: str,
        fingerprint: str,
    ) -> TaskCommandResult:
        creation_started = perf_counter()
        with self.uow_factory() as uow:
            conversation = uow.conversations.get(conversation_id)
            if conversation is not None and conversation.owner_user_id != command.actor.user_id:
                raise ConversationNotFoundError(conversation_id)
            existing = uow.tasks.find_by_idempotency_key(
                conversation_id, command.idempotency_key
            )
            if existing is not None:
                return _question_replay_result(
                    existing,
                    fingerprint,
                    original_question=command.request.text,
                )

            task_id = str(uuid4())
            shadow_started = perf_counter()
            shadow_resolution = None
            shadow_context_candidate = None
            shadow_dsl_validation = None
            shadow_error: dict[str, Any] | None = None
            shadow_context_error: str | None = None
            shadow_patch = None
            shadow_ambiguities: list[str] = []
            shadow_inherited_fields: list[str] = []
            historical_tasks: list[QueryTask] = []
            if self.multiturn_shadow_enabled:
                try:
                    historical_tasks = (
                        uow.tasks.list_for_conversation(conversation_id)
                        if conversation is not None
                        else []
                    )
                    historical_tasks = [t for t in historical_tasks if
                        not (t.state_json or {}).get("internal_analysis_id") and
                        ((t.state_json or {}).get("actor_context") or {}).get("tenant_id")
                        == command.actor.tenant_id]
                    has_legacy_results = any(
                        t.status == "SUCCEEDED"
                        and not (t.state_json or {}).get("result_artifact")
                        and not (t.state_json or {}).get("conversation_focus")
                        for t in historical_tasks
                    )
                    if has_legacy_results and hasattr(uow.messages, "list_for_conversation"):
                        historical_tasks = hydrate_legacy_results(
                            historical_tasks, uow.messages.list_for_conversation(conversation_id),
                        )
                    metric_catalog = getattr(uow, "metric_catalog", None)
                    organization_catalog = getattr(uow, "organization_catalog", None)
                    metrics = (
                        metric_catalog.list_enabled() if metric_catalog is not None else []
                    )
                    organizations = (
                        organization_catalog.list_enabled()
                        if organization_catalog is not None
                        else []
                    )
                    (
                        shadow_resolution,
                        shadow_patch,
                        shadow_ambiguities,
                        shadow_inherited_fields,
                    ) = self.conversation_shadow_service.understand(
                        message=command.request.text,
                        reply_to_task_id=command.request.reply_to_task_id,
                        tasks=historical_tasks,
                        metrics=metrics,
                        organizations=organizations,
                        today=self.today_provider(),
                    )
                except Exception as exc:  # pragma: no cover - defensive shadow isolation
                    shadow_error = log_context_failure(
                        exc, stage="submit_understanding", task_id=task_id,
                        conversation_id=conversation_id, request_id=command.request.request_id,
                    )
                if (
                    shadow_resolution is not None
                    and shadow_resolution.conversation_act.value == "FOLLOW_UP"
                    and shadow_resolution.anchor.selected_task_id is not None
                    and not shadow_ambiguities
                ):
                    try:
                        shadow_context_candidate = (
                            self.conversation_shadow_service.build_context_candidate(
                                resolution=shadow_resolution,
                                message=command.request.text,
                                tasks=historical_tasks,
                                metrics=metrics,
                                organizations=organizations,
                                today=self.today_provider(),
                                patch=shadow_patch,
                            )
                        )
                        if shadow_context_candidate is not None:
                            shadow_dsl_validation = (
                                self.conversation_shadow_service.validate_context_candidate(
                                    context_merge=shadow_context_candidate,
                                    actor=command.actor,
                                    metrics=metrics,
                                    organizations=organizations,
                                    permission_service=self.candidate_permission_service,
                                    planner=self.candidate_query_planner,
                                )
                            )
                    except Exception as exc:  # pragma: no cover - shadow isolation
                        shadow_context_error = type(exc).__name__
                        log_context_failure(
                            exc, stage="context_candidate", task_id=task_id,
                            conversation_id=conversation_id, request_id=command.request.request_id,
                        )
                        shadow_error = context_failure(exc, stage="context_candidate")

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
                current_stage=QueryTaskStage.INTENT_ROUTING.value,
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
            if self.multiturn_shadow_enabled:
                state.timings_ms["multiturn_shadow_ms"] = max(
                    0, round((perf_counter() - shadow_started) * 1000)
                )
                if shadow_resolution is not None:
                    shadow_payload = shadow_resolution.model_dump(mode="json")
                    if shadow_resolution.conversation_act.value == "REFERENCE_ACTION":
                        summaries, focus_id = result_inventory(historical_tasks)
                        state.result_reference_scope = {
                            "result_ids": [s["result_id"] for s in summaries],
                            "focus_result_id": focus_id,
                        }
                    shadow_payload["understanding"] = {
                        "source": (
                            "model"
                            if self.conversation_shadow_service.model_service is not None
                            else "deterministic_legacy"
                        ),
                        "patch": (
                            shadow_patch.model_dump(mode="json")
                            if shadow_patch is not None
                            else None
                        ),
                        "inherit": shadow_inherited_fields,
                        "ambiguities": shadow_ambiguities,
                    }
                    if shadow_context_candidate is not None:
                        shadow_payload["context_merge"] = (
                            shadow_context_candidate.model_dump(mode="json")
                        )
                    if shadow_dsl_validation is not None:
                        shadow_payload["candidate_dsl_validation"] = (
                            shadow_dsl_validation.model_dump(mode="json")
                        )
                    if shadow_context_error is not None:
                        shadow_payload["context_merge_error"] = {
                            **(shadow_error or {}), "type": shadow_context_error
                        }
                    state.debug["multiturn_shadow"] = shadow_payload
                elif shadow_error is not None:
                    state.debug["multiturn_shadow_error"] = shadow_error
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
                stage=QueryTaskStage.INTENT_ROUTING.value,
                status=QueryTaskStatus.RUNNING.value,
                node="task_created",
                detail={"message_id": message_id},
            )
            if shadow_resolution is not None:
                append_task_trace(
                    state,
                    stage=QueryTaskStage.INTENT_ROUTING.value,
                    status=QueryTaskStatus.RUNNING.value,
                    node="multiturn_shadow_evaluated",
                    detail={
                        "conversation_act": shadow_resolution.conversation_act.value,
                        "anchor_status": shadow_resolution.anchor.status.value,
                        "anchor_selection": shadow_resolution.anchor.selection.value,
                        "context_merge_status": (
                            shadow_context_candidate.status
                            if shadow_context_candidate is not None
                            else "NOT_APPLICABLE"
                        ),
                        "candidate_dsl_status": (
                            shadow_dsl_validation.status
                            if shadow_dsl_validation is not None
                            else "NOT_APPLICABLE"
                        ),
                    },
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
            return _question_replay_result(
                existing,
                fingerprint,
                original_question=command.request.text,
            )

    def request_clarification(
        self, command: RequestClarificationCommand
    ) -> TaskCommandResult:
        request_id = command.request_id or f"clarification:{command.clarification_id}"
        fingerprint = _fingerprint(
            {
                "kind": "request_clarification",
                "task_id": command.task_id,
                "clarification_id": command.clarification_id,
                "prompt": command.prompt,
                "type": command.clarification_type,
                "options": command.options,
            }
        )
        with self.uow_factory() as uow:
            # The public semantic route authenticates ownership before this internal transition.
            task = uow.tasks.get(command.task_id)
            if task is None:
                raise TaskNotFoundError(command.task_id)
            state = _load_state(task)
            replay = _processed_replay(state, request_id, fingerprint, task)
            if replay is not None:
                return replay
            _require_version(task, command.expected_version)
            _require_transition(
                task,
                next_status=QueryTaskStatus.WAITING_USER,
                next_stage=QueryTaskStage.CLARIFICATION,
            )

            message_id = str(uuid4())
            continuation_token = self._create_continuation_token(command)
            state.clarification = {
                "id": command.clarification_id,
                "type": command.clarification_type,
                "prompt": command.prompt,
                "options": command.options,
                "created_for_version": command.expected_version,
                "task_version": command.expected_version + 1,
                "continuation_token": continuation_token,
            }
            _record_processed_request(
                state,
                request_id,
                kind="request_clarification",
                fingerprint=fingerprint,
                message_id=message_id,
            )
            uow.messages.add(
                ChatMessage(
                    id=message_id,
                    conversation_id=task.conversation_id,
                    task_id=task.id,
                    role="assistant",
                    content=command.prompt,
                    created_at=datetime.now(UTC),
                    payload={
                        "kind": "clarification",
                        "channel": command.channel,
                        "external_message_id": command.external_message_id,
                        "task_version": command.expected_version + 1,
                        "clarification_id": command.clarification_id,
                        "channel_context": command.channel_context,
                        "continuation_token": continuation_token,
                        "clarification": state.clarification,
                    },
                )
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=QueryTaskStatus.WAITING_USER.value,
                current_stage=QueryTaskStage.CLARIFICATION.value,
                state_json=state.model_dump(mode="json"),
                intent=task.intent,
                query_shape=task.query_shape,
                error_code=task.error_code,
                error_message=task.error_message,
            )
            if updated is None:
                raise _version_conflict(command.task_id, command.expected_version)
            conversation = uow.conversations.get(task.conversation_id)
            if conversation is not None:
                conversation.preview = _preview(command.prompt)
                conversation.updated_at = datetime.now(UTC)
            uow.commit()
            return _task_result(
                updated,
                message_id=message_id,
                continuation_token=continuation_token,
            )

    def _create_continuation_token(
        self, command: RequestClarificationCommand
    ) -> str | None:
        if self.continuation_token_codec is None:
            return None
        return self.continuation_token_codec.encode(
            ContinuationTarget(
                task_id=command.task_id,
                expected_version=command.expected_version + 1,
                clarification_id=command.clarification_id,
                channel=command.channel,
                channel_context=command.channel_context,
            )
        )

    def submit_clarification(
        self, command: SubmitClarificationCommand
    ) -> TaskCommandResult:
        fingerprint = _fingerprint(
            {
                "kind": "submit_clarification",
                "task_id": command.task_id,
                "clarification_id": command.clarification_id,
                "answers": command.answers,
                "actor": command.actor.subject,
                "channel": command.channel,
            }
        )
        with self.uow_factory() as uow:
            task = _get_owned_task(uow, command.task_id, command.actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(command.task_id)
            state = _load_state(task)
            replay = _processed_replay(state, command.request_id, fingerprint, task)
            if replay is not None:
                return replay

            _require_version(task, command.expected_version)
            clarification = state.clarification or {}
            active_clarification_id = clarification.get("id")
            if active_clarification_id != command.clarification_id:
                raise TaskConflictError(
                    "CLARIFICATION_MISMATCH",
                    "The clarification response is stale or does not belong to this task",
                    details={
                        "task_id": task.id,
                        "expected_clarification_id": active_clarification_id,
                        "received_clarification_id": command.clarification_id,
                    },
                )

            message_id = str(uuid4())
            state.clarification_answers.append(
                {
                    "clarification_id": command.clarification_id,
                    "answers": command.answers,
                    "actor": command.actor.model_dump(mode="json"),
                    "channel": command.channel,
                    "channel_context": command.channel_context,
                    "request_id": command.request_id,
                }
            )
            state.debug["clarification_answers"] = state.clarification_answers
            state.clarification = None
            _record_processed_request(
                state,
                command.request_id,
                kind="submit_clarification",
                fingerprint=fingerprint,
                message_id=message_id,
            )
            answer_text = _answer_text(command.answers)
            uow.messages.add(
                ChatMessage(
                    id=message_id,
                    conversation_id=task.conversation_id,
                    task_id=task.id,
                    role="user",
                    content=answer_text,
                    created_at=datetime.now(UTC),
                    payload={
                        "kind": "clarification_answer",
                        "clarification_id": command.clarification_id,
                        "answers": command.answers,
                        "request_id": command.request_id,
                        "channel": command.channel,
                    },
                )
            )
            next_status = QueryTaskStatus.RUNNING
            next_stage = QueryTaskStage.VALIDATION
            continuation_token = None
            result_message_id = message_id
            next_intent = task.intent
            next_query_shape = task.query_shape
            if clarification.get("type") == "analysis":
                state.analysis_resume = command.answers
                state.missing_slots = []
                next_stage = QueryTaskStage.SLOT_EXTRACTION
            elif clarification.get("type") == "result_reference":
                answers = command.answers
                selected_id = None
                if isinstance(answers, dict):
                    selected_id = (answers.get("set") or {}).get("result_id")
                elif isinstance(answers, str) and self.conversation_shadow_service.model_service:
                    selection = self.conversation_shadow_service.model_service.analyze(
                        prompt="result_reference_selection",
                        context={"user_input": answers, "candidates_json": json.dumps(
                            clarification.get("options", []), ensure_ascii=False,
                        )},
                    )
                    selected_id = selection.get("result_id")
                if selected_id not in clarification.get("candidate_result_ids", []):
                    raise TaskConflictError(
                        "RESULT_SELECTION_REQUIRED", "请从本次澄清候选中明确选择一条历史结果",
                        details={"task_id": task.id},
                    )
                state.selected_result_id = selected_id
                state.missing_slots = []
                next_stage = QueryTaskStage.SLOT_EXTRACTION
            elif clarification.get("type") == "multiturn_context":
                state.debug["context_clarification_pending"] = True
                state.debug["context_clarification_prompt"] = clarification.get("prompt")
                next_stage = QueryTaskStage.SLOT_EXTRACTION
            elif clarification.get("type") == "semantic_slots":
                if self.semantic_config_repository is None:
                    raise RuntimeError("Semantic configuration is not available")
                metrics = uow.metric_catalog.list_enabled()
                organizations = uow.organization_catalog.list_enabled()
                config = self.semantic_config_repository.load()
                raw_frame = state.slots or state.slot_frame or {}
                frame = apply_clarification_answers(
                    raw_frame,
                    command.answers,
                    metrics=metrics,
                    organizations=organizations,
                )
                advance = advance_slot_frame(
                    frame,
                    metrics=metrics,
                    organizations=organizations,
                    config=config,
                    today=self.today_provider(),
                    metric_candidates=[
                        item
                        for item in metrics
                        if item.code
                        in {
                            candidate.get("code")
                            for candidate in state.candidates.get("metrics", [])
                        }
                    ],
                )
                state.slots = advance.slot_frame.model_dump(mode="json")
                state.missing_slots = list(advance.slot_frame.missing)
                state.logical_dsl = (
                    advance.logical_dsl.model_dump(mode="json")
                    if advance.logical_dsl is not None
                    else None
                )
                state.debug["slot_frame"] = state.slots
                state.debug["logical_dsl"] = state.logical_dsl
                next_intent = advance.slot_frame.task.value
                next_query_shape = advance.query_shape
                if advance.logical_dsl is not None:
                    state.resolved_question = resolved_question(advance.slot_frame)
                    state.debug["resolved_question"] = state.resolved_question
                    uow.messages.add(
                        ChatMessage(
                            id=str(uuid4()),
                            conversation_id=task.conversation_id,
                            task_id=task.id,
                            role="user",
                            content=f"已确认问题：{state.resolved_question}",
                            created_at=datetime.now(UTC),
                            payload={
                                "kind": "resolved_question",
                                "original_question": task.original_question,
                                "resolved_question": state.resolved_question,
                                "clarification_answers": state.clarification_answers,
                            },
                        )
                    )
                    next_stage = QueryTaskStage.LOGICAL_DSL
                else:
                    next_status = QueryTaskStatus.WAITING_USER
                    next_stage = QueryTaskStage.CLARIFICATION
                    result_message_id, continuation_token = self._renew_semantic_clarification(
                        uow=uow,
                        task=task,
                        state=state,
                        advance=advance,
                        channel=command.channel,
                        expected_version=command.expected_version,
                    )
            append_task_trace(
                state,
                stage=next_stage.value,
                status=next_status.value,
                node=(
                    "clarification_resolved"
                    if next_stage == QueryTaskStage.LOGICAL_DSL
                    else "clarification_updated"
                ),
                detail={"clarification_id": command.clarification_id},
            )
            _require_transition(
                task,
                next_status=next_status,
                next_stage=next_stage,
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=next_status.value,
                current_stage=next_stage.value,
                state_json=state.model_dump(mode="json"),
                intent=next_intent,
                query_shape=next_query_shape,
                error_code=task.error_code,
                error_message=task.error_message,
            )
            if updated is None:
                raise _version_conflict(command.task_id, command.expected_version)
            conversation = uow.conversations.get(task.conversation_id)
            if conversation is not None:
                conversation.preview = _preview(answer_text)
                conversation.updated_at = datetime.now(UTC)
            uow.commit()
            return _task_result(
                updated,
                message_id=result_message_id,
                continuation_token=continuation_token,
            )

    def cancel_clarification(
        self, command: CancelClarificationCommand
    ) -> TaskCommandResult:
        with self.uow_factory() as uow:
            task = _get_owned_task(uow, command.task_id, command.actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(command.task_id)
            _require_version(task, command.expected_version)
            state = _load_state(task)
            clarification = state.clarification or {}
            if clarification.get("id") != command.clarification_id:
                raise TaskConflictError(
                    "CLARIFICATION_MISMATCH",
                    "The clarification cancellation is stale or does not belong to this task",
                    details={
                        "task_id": task.id,
                        "expected_clarification_id": clarification.get("id"),
                        "received_clarification_id": command.clarification_id,
                    },
                )

            _require_transition(
                task,
                next_status=QueryTaskStatus.CANCELLED,
                next_stage=QueryTaskStage.CLARIFICATION,
            )
            state.clarification = None
            state.debug["clarification_cancelled"] = {
                "clarification_id": command.clarification_id,
                "actor": command.actor.model_dump(mode="json"),
                "request_id": command.request_id,
            }
            append_task_trace(
                state,
                stage=QueryTaskStage.CLARIFICATION.value,
                status=QueryTaskStatus.CANCELLED.value,
                node="clarification_cancelled",
                detail={"clarification_id": command.clarification_id},
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=QueryTaskStatus.CANCELLED.value,
                current_stage=QueryTaskStage.CLARIFICATION.value,
                state_json=state.model_dump(mode="json"),
                intent=task.intent,
                query_shape=task.query_shape,
                error_code=task.error_code,
                error_message=task.error_message,
                completed_at=datetime.now(UTC),
            )
            if updated is None:
                raise _version_conflict(command.task_id, command.expected_version)
            uow.commit()
            return _task_result(updated)

    def _renew_semantic_clarification(
        self,
        *,
        uow: SqlAlchemyUnitOfWork,
        task: QueryTask,
        state: QueryTaskState,
        advance: Any,
        channel: str,
        expected_version: int,
    ) -> tuple[str, str | None]:
        clarification_id = advance.clarification_id
        prompt = advance.clarification_prompt
        if prompt is None:
            raise RuntimeError("Semantic clarification prompt is missing")
        token = None
        if self.continuation_token_codec is not None:
            token = self.continuation_token_codec.encode(
                ContinuationTarget(
                    task_id=task.id,
                    expected_version=expected_version + 1,
                    clarification_id=clarification_id,
                    channel=channel,
                    channel_context={},
                )
            )
        state.clarification = {
            "id": clarification_id,
            "type": "semantic_slots",
            "prompt": prompt,
            "options": advance.clarification_options,
            "fields": advance.clarification_fields,
            "understood": advance.clarification_understood,
            "reply_examples": advance.clarification_reply_examples,
            "missing": state.missing_slots,
            "created_for_version": expected_version,
            "task_version": expected_version + 1,
            "continuation_token": token,
        }
        message_id = str(uuid4())
        uow.messages.add(
            ChatMessage(
                id=message_id,
                conversation_id=task.conversation_id,
                task_id=task.id,
                role="assistant",
                content=prompt,
                created_at=datetime.now(UTC),
                payload={
                    "kind": "clarification",
                    "channel": channel,
                    "task_version": expected_version + 1,
                    "clarification_id": clarification_id,
                    "continuation_token": token,
                    "clarification": state.clarification,
                },
            )
        )
        return message_id, token

    def get_task(self, task_id: str, actor: ActorContext) -> TaskCommandResult:
        from ask_metric.application.analysis_access import authorize_analysis

        with self.uow_factory() as uow:
            task = uow.tasks.get_owned(task_id, actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(task_id)
            authorize_analysis(task.state_json or {}, actor, self.candidate_permission_service)
            return _task_result(task)

    def get_conversation(self, conversation_id: str, actor: ActorContext) -> ConversationSnapshot:
        from ask_metric.application.analysis_access import authorize_analysis

        with self.uow_factory() as uow:
            conversation = uow.conversations.get_owned(conversation_id, actor.user_id or "")
            if conversation is None:
                raise ConversationNotFoundError(conversation_id)
            messages = uow.messages.list_for_conversation(conversation_id)
            tasks = uow.tasks.list_for_conversation(conversation_id)
            for task in tasks:
                authorize_analysis(task.state_json or {}, actor, self.candidate_permission_service)
            return ConversationSnapshot(
                id=conversation.id,
                title=conversation.title,
                preview=conversation.preview,
                messages=[
                    ConversationMessageResult(
                        id=message.id,
                        role=message.role,
                        content=message.content,
                        task_id=message.task_id,
                        payload=message.payload,
                    )
                    for message in messages
                ],
                tasks=[
                    ConversationTaskResult(
                        id=task.id,
                        status=task.status,
                        current_stage=task.current_stage,
                        version=task.version,
                        original_question=task.original_question,
                        query_shape=task.query_shape,
                        error_code=task.error_code,
                        error_message=task.error_message,
                        logical_dsl=_load_state(task).logical_dsl,
                        timings_ms=_load_state(task).timings_ms,
                        debug=_load_state(task).debug,
                    )
                    for task in tasks if not (task.state_json or {}).get("internal_analysis_id")
                ],
            )

    def list_conversations(
        self, actor: ActorContext, *, limit: int = 12, offset: int = 0
    ) -> tuple[list[ConversationListItem], bool]:
        with self.uow_factory() as uow:
            rows = uow.conversations.list_owned(
                actor.user_id or "", limit=limit + 1, offset=offset
            )
            items = [
                ConversationListItem(
                    id=item.id,
                    title=item.title,
                    preview=item.preview,
                    created_at=item.created_at.isoformat() if item.created_at else None,
                    updated_at=item.updated_at.isoformat() if item.updated_at else None,
                )
                for item in rows[:limit]
            ]
            return items, len(rows) > limit

    def get_multiturn_metrics(self, actor: ActorContext) -> MultiturnShadowMetrics:
        with self.uow_factory() as uow:
            tasks = uow.tasks.list_owned(actor.user_id or "")
            return self.multiturn_metrics_aggregator.summarize(tasks)

    def get_multiturn_readiness(self, actor: ActorContext) -> MultiturnRolloutReadiness:
        metrics = self.get_multiturn_metrics(actor)
        return self.multiturn_rollout_policy.evaluate(metrics)

    def list_multiturn_review_samples(
        self,
        actor: ActorContext,
        *,
        limit: int,
        offset: int,
        reviewed: bool | None,
    ) -> tuple[list[MultiturnReviewSample], bool]:
        with self.uow_factory() as uow:
            tasks = reversed(uow.tasks.list_owned(actor.user_id or ""))
            samples: list[MultiturnReviewSample] = []
            for task in tasks:
                state = _load_state(task)
                shadow = state.debug.get("multiturn_shadow")
                if not isinstance(shadow, dict) or not isinstance(
                    shadow.get("evaluation"), dict
                ):
                    continue
                if reviewed is not None and (state.multiturn_review is not None) != reviewed:
                    continue
                evaluation = shadow["evaluation"]
                admission = evaluation.get("admission")
                gray_result = shadow.get("gray_result")
                samples.append(
                    MultiturnReviewSample(
                        task_id=task.id,
                        conversation_id=task.conversation_id,
                        question=task.original_question,
                        task_status=task.status,
                        conversation_act=str(shadow.get("conversation_act") or "UNKNOWN"),
                        comparison=evaluation.get("comparison"),
                        admission=(
                            admission.get("decision")
                            if isinstance(admission, dict)
                            else None
                        ),
                        gray_outcome=(
                            gray_result.get("outcome")
                            if isinstance(gray_result, dict)
                            else None
                        ),
                        review=state.multiturn_review,
                    )
                )
            page = samples[offset : offset + limit + 1]
            return page[:limit], len(page) > limit

    def review_multiturn_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        decision: str,
        reason_codes: list[str],
        notes: str | None,
        actor: ActorContext,
    ) -> MultiturnHumanReview:
        with self.uow_factory() as uow:
            task = uow.tasks.get_owned_for_update(task_id, actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(task_id)
            _require_version(task, expected_version)
            state = _load_state(task)
            shadow = state.debug.get("multiturn_shadow")
            if not isinstance(shadow, dict) or not isinstance(
                shadow.get("evaluation"), dict
            ):
                raise TaskConflictError(
                    "MULTITURN_REVIEW_NOT_APPLICABLE",
                    "The task has no completed multiturn shadow evaluation",
                )
            review = MultiturnHumanReview(
                decision=decision,
                reason_codes=reason_codes,
                notes=notes.strip() if notes and notes.strip() else None,
                reviewer_user_id=actor.user_id or "",
                reviewed_at=datetime.now(UTC),
            )
            state.multiturn_review = review
            append_task_trace(
                state,
                stage=task.current_stage,
                status=task.status,
                node="multiturn_human_review_recorded",
                detail={"decision": review.decision},
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=expected_version,
                status=task.status,
                current_stage=task.current_stage,
                state_json=state.model_dump(mode="json"),
                intent=task.intent,
                query_shape=task.query_shape,
                error_code=task.error_code,
                error_message=task.error_message,
                completed_at=task.completed_at,
            )
            if updated is None:
                raise _version_conflict(task.id, expected_version)
            uow.commit()
            return review

    def rename_conversation(
        self, conversation_id: str, title: str, actor: ActorContext
    ) -> ConversationListItem:
        with self.uow_factory() as uow:
            conversation = uow.conversations.rename_owned(
                conversation_id, actor.user_id or "", title
            )
            if conversation is None:
                raise ConversationNotFoundError(conversation_id)
            uow.commit()
            return ConversationListItem(
                id=conversation.id,
                title=conversation.title,
                preview=conversation.preview,
                created_at=conversation.created_at.isoformat() if conversation.created_at else None,
                updated_at=conversation.updated_at.isoformat() if conversation.updated_at else None,
            )

    def export_conversation(self, conversation_id: str, actor: ActorContext) -> tuple[str, bytes]:
        from ask_metric.application.analysis_access import authorize_analysis

        with self.uow_factory() as uow:
            conversation = uow.conversations.get_owned(conversation_id, actor.user_id or "")
            if conversation is None:
                raise ConversationNotFoundError(conversation_id)
            messages = uow.messages.list_for_conversation(conversation_id)
            tasks = uow.tasks.list_for_conversation(conversation_id)
            for task in tasks:
                authorize_analysis(task.state_json or {}, actor, self.candidate_permission_service)
            workbook = build_xlsx(
                [
                    (
                        "会话消息",
                        ["时间", "角色", "内容", "任务ID", "附加数据"],
                        [
                            [
                                item.created_at.isoformat() if item.created_at else "",
                                item.role,
                                item.content,
                                item.task_id or "",
                                json.dumps(item.payload, ensure_ascii=False, default=str)
                                if item.payload
                                else "",
                            ]
                            for item in messages
                        ],
                    ),
                    (
                        "任务",
                        ["任务ID", "原问题", "状态", "阶段", "查询类型", "错误"],
                        [
                            [
                                item.id,
                                item.original_question,
                                item.status,
                                item.current_stage,
                                item.query_shape or "",
                                item.error_message or "",
                            ]
                            for item in tasks
                        ],
                    ),
                ]
            )
            return conversation.title, workbook

    def export_task_result(self, task_id: str, actor: ActorContext) -> tuple[str, bytes]:
        from ask_metric.application.analysis_access import authorize_analysis

        with self.uow_factory() as uow:
            task = uow.tasks.get_owned(task_id, actor.user_id or "")
            if task is None:
                raise TaskNotFoundError(task_id)
            authorize_analysis(task.state_json or {}, actor, self.candidate_permission_service)
            messages = uow.messages.list_for_conversation(task.conversation_id)
            result_payload = next(
                (
                    message.payload.get("result")
                    for message in reversed(messages)
                    if message.task_id == task_id
                    and message.payload
                    and message.payload.get("kind") == "query_result"
                ),
                None,
            )
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

    def delete_conversation(self, conversation_id: str, actor: ActorContext) -> None:
        with self.uow_factory() as uow:
            if not uow.conversations.delete_owned(conversation_id, actor.user_id or ""):
                raise ConversationNotFoundError(conversation_id)
            uow.commit()

    def cleanup_conversations(
        self, actor: ActorContext, *, keep_latest: int
    ) -> ConversationCleanupResult:
        if not 10 <= keep_latest <= 100:
            raise ValueError("keep_latest must be between 10 and 100")
        user_id = actor.user_id or ""
        with self.uow_factory() as uow:
            before_count = uow.conversations.count_owned(user_id)
            deleted_count = uow.conversations.delete_old_owned(
                user_id, keep_latest=keep_latest
            )
            remaining_count = uow.conversations.count_owned(user_id)
            uow.commit()
            return ConversationCleanupResult(
                keep_latest=keep_latest,
                deleted_count=deleted_count,
                remaining_count=remaining_count,
                protected_active_count=max(
                    0, remaining_count - min(before_count, keep_latest)
                ),
            )


def _resolve_conversation_id(command: SubmitQuestionCommand) -> str:
    if command.request.conversation_id:
        return command.request.conversation_id
    stable_context = command.request.external_session_id or command.request.request_id
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


def _processed_replay(
    state: QueryTaskState,
    request_id: str,
    fingerprint: str,
    task: QueryTask,
) -> TaskCommandResult | None:
    record = state.processed_requests.get(request_id)
    if record is None:
        return None
    if record.get("fingerprint") != fingerprint:
        raise TaskConflictError(
            "IDEMPOTENCY_KEY_REUSED",
            "The same request identifier was reused with different content",
        )
    return _task_result(
        task,
        message_id=record.get("message_id"),
        idempotent_replay=True,
    )


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


def _require_version(task: QueryTask, expected_version: int) -> None:
    if task.version != expected_version:
        raise _version_conflict(task.id, expected_version, actual_version=task.version)


def _version_conflict(
    task_id: str,
    expected_version: int,
    *,
    actual_version: int | None = None,
) -> TaskConflictError:
    return TaskConflictError(
        "TASK_VERSION_CONFLICT",
        "The QueryTask was updated by another request",
        details={
            "task_id": task_id,
            "expected_version": expected_version,
            "actual_version": actual_version,
        },
    )


def _require_transition(
    task: QueryTask,
    *,
    next_status: QueryTaskStatus,
    next_stage: QueryTaskStage,
) -> None:
    try:
        QueryTaskStateMachine.require_transition(
            current_status=task.status,
            current_stage=task.current_stage,
            next_status=next_status,
            next_stage=next_stage,
        )
    except InvalidTaskTransition as exc:
        raise TaskConflictError(
            "INVALID_TASK_TRANSITION",
            str(exc),
            details={
                "task_id": task.id,
                "status": task.status,
                "current_stage": task.current_stage,
            },
        ) from exc


def _task_result(
    task: QueryTask,
    *,
    message_id: str | None = None,
    idempotent_replay: bool = False,
    continuation_token: str | None = None,
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
        continuation_token=continuation_token or (
            state.clarification or {}
        ).get("continuation_token"),
        slot_frame=state.slots or state.slot_frame,
        logical_dsl=state.logical_dsl,
        missing=state.missing_slots,
        query_shape=task.query_shape,
        resolved_question=state.resolved_question,
        error_code=task.error_code,
        error_message=task.error_message,
        timings_ms=state.timings_ms,
        debug=state.debug,
        result=(state.execution or {}).get("result"),
    )


def _answer_text(answers: Any) -> str:
    if isinstance(answers, str):
        return answers
    if isinstance(answers, dict):
        selected = answers.get("set")
        if isinstance(selected, dict):
            labels = []
            for values in selected.values():
                if not isinstance(values, list):
                    continue
                for value in values:
                    if isinstance(value, dict):
                        label = (
                            value.get("name")
                            or value.get("metric_name")
                            or value.get("org_name")
                        )
                    else:
                        label = value
                    if isinstance(label, str) and label.strip():
                        labels.append(label.strip())
            text = answers.get("text")
            if isinstance(text, str) and text.strip():
                labels.append(text.strip())
            if labels:
                return "、".join(labels)
    return json.dumps(answers, ensure_ascii=False, sort_keys=True)


def _conversation_title(text: str) -> str:
    value = text.strip()
    return value[:80] + ("..." if len(value) > 80 else "")


def _preview(text: str) -> str:
    value = text.strip()
    return value[:200] + ("..." if len(value) > 200 else "")
