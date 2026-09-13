from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime
from time import perf_counter
from typing import Any, Literal
from uuid import uuid4

from ask_metric.application.commands import AnalyzeSemanticCommand
from ask_metric.application.context_diagnostics import log_context_failure
from ask_metric.application.continuation_tokens import (
    ContinuationTarget,
    ContinuationTokenCodec,
)
from ask_metric.application.conversation_context_service import (
    ConversationShadowService,
    MultiturnGrayExecutionPolicy,
    MultiturnShadowEvaluator,
)
from ask_metric.application.legacy_analysis import require_query_task
from ask_metric.application.ports import PermissionService, ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import _add_result_message
from ask_metric.application.result_action_service import prepare_result_action
from ask_metric.application.semantic_workflow import SemanticAdvance, advance_slot_frame
from ask_metric.application.task_results import TaskCommandResult
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.conversation_context import (
    CandidateDslValidationResult,
    ContextMergeResult,
    MultiturnGrayExecutionState,
)
from ask_metric.domain.intent_routing import (
    IntentClassification,
    InvalidIntentClassification,
    RoutedIntent,
    parse_intent_classification,
)
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantic_engine import InvalidSlotFrameError, SemanticEngine
from ask_metric.domain.task import (
    QueryTaskStage,
    QueryTaskState,
    QueryTaskStatus,
    append_task_trace,
    is_pending_context_clarification,
)
from ask_metric.infrastructure.db.models import ChatMessage, QueryRun, QueryTask
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.model.provider import (
    InvalidModelResponse,
    ModelServiceUnavailable,
)
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

UnitOfWorkFactory = Callable[[], SqlAlchemyUnitOfWork]
logger = logging.getLogger(__name__)


class SemanticTaskNotFoundError(ApplicationError):
    def __init__(self, task_id: str) -> None:
        super().__init__("TASK_NOT_FOUND", f"QueryTask {task_id} was not found", status_code=404)


class SemanticTaskConflictError(ApplicationError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any]) -> None:
        super().__init__(code, message, status_code=409, details=details)


class SemanticModelServiceError(ApplicationError):
    def __init__(self, message: str) -> None:
        super().__init__("MODEL_SERVICE_UNAVAILABLE", message, status_code=503)


class SemanticModelResponseError(ApplicationError):
    def __init__(self, message: str, *, details: Any | None = None) -> None:
        super().__init__(
            "MODEL_RESPONSE_INVALID",
            message,
            status_code=502,
            details=details,
        )


class SemanticTaskApplicationService:
    def __init__(
        self,
        *,
        semantic_engine: SemanticEngine,
        config_repository: SemanticConfigRepository,
        uow_factory: UnitOfWorkFactory | None = None,
        continuation_token_codec: ContinuationTokenCodec | None = None,
        today_provider: Callable[[], date] = date.today,
        multiturn_shadow_evaluation_enabled: bool = False,
        multiturn_shadow_evaluator: MultiturnShadowEvaluator | None = None,
        multiturn_routed_execution_enabled: bool = False,
        multiturn_gray_execution_enabled: bool = False,
        multiturn_gray_user_ids: list[str] | None = None,
        multiturn_gray_policy: MultiturnGrayExecutionPolicy | None = None,
        result_permission_service: PermissionService | None = None,
        result_query_planner: QueryPlanner | None = None,
    ) -> None:
        self.semantic_engine = semantic_engine
        self.model_service = semantic_engine.model_service
        self.config_repository = config_repository
        self.uow_factory = uow_factory or SqlAlchemyUnitOfWork
        self.continuation_token_codec = continuation_token_codec
        self.today_provider = today_provider
        self.multiturn_shadow_evaluation_enabled = multiturn_shadow_evaluation_enabled
        self.multiturn_shadow_evaluator = (
            multiturn_shadow_evaluator or MultiturnShadowEvaluator()
        )
        self.multiturn_routed_execution_enabled = multiturn_routed_execution_enabled
        self.multiturn_gray_execution_enabled = multiturn_gray_execution_enabled
        self.multiturn_gray_user_ids = list(multiturn_gray_user_ids or [])
        self.multiturn_gray_policy = multiturn_gray_policy or MultiturnGrayExecutionPolicy()
        self.result_permission_service = (
            result_permission_service or ScopedOrganizationPermissionService()
        )
        self.result_query_planner = result_query_planner or QueryPlanner(dialect="mysql")

    def analyze(self, command: AnalyzeSemanticCommand) -> TaskCommandResult:
        analyze_started = perf_counter()
        with self.uow_factory() as uow:
            task = (
                uow.tasks.get_owned(command.task_id, command.actor.user_id or "")
                if command.actor is not None
                else uow.tasks.get(command.task_id)
            )
            if task is None:
                raise SemanticTaskNotFoundError(command.task_id)
            raw_state = task.state_json or {}
            shadow = raw_state.get("debug", {}).get("multiturn_shadow", {})
            require_query_task(raw_state, task.query_shape)
            _require_version(task, command.expected_version)
            _require_analyzable(task)
            original_question = task.original_question

        if shadow.get("task_goal") == "attribution_analysis":
            return self._finish_intent_boundary(
                command, original_question,
                intent=IntentClassification(intent=RoutedIntent.ATTRIBUTION_ANALYSIS, confidence=1),
                intent_raw=None, intent_model_ms=0, analyze_started=analyze_started,
            )

        if self.multiturn_routed_execution_enabled:
            try:
                routed = self._route_validated_multiturn_follow_up(
                    command,
                    analyze_started=analyze_started,
                )
            except ApplicationError:
                # Ownership, permissions and version conflicts retain their API semantics.
                raise
            except Exception as exc:
                return self._finish_analysis_failure(
                    command,
                    original_question,
                    code="MULTITURN_CONTEXT_ERROR",
                    user_message="追问条件处理失败，请重新发起查询。",
                    stage=QueryTaskStage.VALIDATION,
                    error=exc,
                    retryable=False,
                    analyze_started=analyze_started,
                )
            if routed == "UNSUPPORTED_ATTRIBUTION":
                return self._finish_intent_boundary(
                    command, original_question,
                    intent=IntentClassification(intent=RoutedIntent.ATTRIBUTION_ANALYSIS,
                                                confidence=1),
                    intent_raw=None, intent_model_ms=0, analyze_started=analyze_started,
                )
            if routed is not None:
                return routed

        intent_started = perf_counter()
        intent_raw: dict[str, Any] | None = None
        try:
            intent_raw = self.model_service.analyze(
                prompt="intent_routing",
                context={
                    "question": original_question,
                    "allowed_intents_json": json.dumps(
                        [item.value for item in RoutedIntent],
                        ensure_ascii=False,
                    ),
                },
            )
            intent = parse_intent_classification(intent_raw)
        except ModelServiceUnavailable as exc:
            intent_model_ms = _elapsed_ms(intent_started)
            return self._finish_analysis_failure(
                command,
                original_question,
                code=_model_service_error_code(exc),
                user_message=_model_service_user_message(exc),
                stage=QueryTaskStage.INTENT_ROUTING,
                error=exc,
                retryable=True,
                analyze_started=analyze_started,
                intent_model_ms=intent_model_ms,
                intent_raw=intent_raw,
            )
        except (InvalidModelResponse, InvalidIntentClassification) as exc:
            intent_model_ms = _elapsed_ms(intent_started)
            return self._finish_analysis_failure(
                command,
                original_question,
                code="INTENT_ROUTING_INVALID",
                user_message="问题意图识别结果无效，请重新提问或稍后重试。",
                stage=QueryTaskStage.INTENT_ROUTING,
                error=exc,
                retryable=True,
                analyze_started=analyze_started,
                intent_model_ms=intent_model_ms,
                intent_raw=intent_raw,
            )
        intent_model_ms = _elapsed_ms(intent_started)

        if intent.intent is not RoutedIntent.METRIC_QUERY:
            return self._finish_intent_boundary(
                command,
                original_question,
                intent=intent,
                intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
                analyze_started=analyze_started,
            )
        # 不按原句关键词猜查询能力：先保护目录名称并提取操作，再由 QueryPlanner
        # 在执行前统一校验。名称里的“明细”等词不能直接让正式指标失去查询资格。
        config = self.config_repository.load()
        with self.uow_factory() as uow:
            metrics = uow.metric_catalog.list_enabled()
            organizations = uow.organization_catalog.list_enabled()
        current_date = self.today_provider()
        try:
            analysis = self.semantic_engine.analyze(
                original_question,
                metrics=metrics,
                organizations=organizations,
                config=config,
                current_date=current_date,
            )
        except ModelServiceUnavailable as exc:
            return self._finish_analysis_failure(
                command,
                original_question,
                code=_model_service_error_code(exc),
                user_message=_model_service_user_message(exc),
                stage=_model_failure_stage(exc),
                error=exc,
                retryable=True,
                analyze_started=analyze_started,
                intent=intent,
                intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
            )
        except InvalidSlotFrameError as exc:
            return self._finish_analysis_failure(
                command,
                original_question,
                code="SLOT_FRAME_VALIDATION_FAILED",
                user_message="大模型返回的语义格式无法解析，请重新提问或稍后重试。",
                stage=QueryTaskStage.SLOT_EXTRACTION,
                error=exc,
                retryable=True,
                analyze_started=analyze_started,
                intent=intent,
                intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
            )
        except InvalidModelResponse as exc:
            return self._finish_analysis_failure(
                command,
                original_question,
                code="MODEL_RESPONSE_INVALID",
                user_message="大模型返回格式异常，系统无法继续解析，请稍后重试。",
                stage=_model_failure_stage(exc),
                error=exc,
                retryable=True,
                analyze_started=analyze_started,
                intent=intent,
                intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
            )
        except ValueError as exc:
            return self._finish_analysis_failure(
                command,
                original_question,
                code="SEMANTIC_NORMALIZATION_FAILED",
                user_message="问题语义格式解析失败，请检查日期、指标或机构表达后重试。",
                stage=QueryTaskStage.VALIDATION,
                error=exc,
                retryable=False,
                analyze_started=analyze_started,
                intent=intent,
                intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
            )

        with self.uow_factory() as uow:
            task = (
                uow.tasks.get_owned_for_update(command.task_id, command.actor.user_id or "")
                if command.actor is not None
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise SemanticTaskNotFoundError(command.task_id)
            _require_version(task, command.expected_version)
            _require_analyzable(task)
            state = QueryTaskState.model_validate(task.state_json or {})
            state.timings_ms.update(analysis.timings_ms)
            _record_intent_routing(
                state,
                intent=intent,
                raw_output=intent_raw,
                duration_ms=intent_model_ms,
            )
            state.debug.update({
                "question": original_question,
                "semantic": analysis.debug,
            })
            advance = advance_slot_frame(
                analysis.slot_frame,
                metrics=metrics,
                organizations=organizations,
                config=config,
                today=current_date,
                metric_candidates=analysis.metric_candidates,
            )
            state.metric_matches = [
                item.model_dump(mode="json") for item in analysis.metric_matches
            ]
            state.candidates["metrics"] = [
                item.model_dump(mode="json") for item in analysis.metric_candidates
            ]
            state.config_version = config.version
            shadow_evaluation = None
            gray_decision = None
            gray_execution = None
            if self.multiturn_shadow_evaluation_enabled:
                evaluation_started = perf_counter()
                shadow = state.debug.get("multiturn_shadow")
                if isinstance(shadow, dict):
                    try:
                        shadow_evaluation = self.multiturn_shadow_evaluator.evaluate(
                            shadow_payload=shadow,
                            v1_dsl=advance.logical_dsl,
                            missing_slots=advance.slot_frame.missing,
                        )
                        if shadow_evaluation is not None:
                            shadow["evaluation"] = shadow_evaluation.model_dump(mode="json")
                            gray_decision, gray_execution = (
                                self.multiturn_gray_policy.decide(
                                    enabled=self.multiturn_gray_execution_enabled,
                                    allowlisted_user_ids=self.multiturn_gray_user_ids,
                                    actor=command.actor,
                                    shadow_payload=shadow,
                                    v1_dsl=advance.logical_dsl,
                                    v1_query_shape=advance.query_shape,
                                )
                            )
                            if self.multiturn_gray_execution_enabled:
                                shadow["gray_execution"] = gray_decision.model_dump(
                                    mode="json"
                                )
                            if gray_execution is not None:
                                state.multiturn_execution = gray_execution
                    except Exception as exc:  # pragma: no cover - shadow isolation
                        shadow["evaluation_error"] = {"type": type(exc).__name__}
                state.timings_ms["multiturn_shadow_evaluation_ms"] = max(
                    0, round((perf_counter() - evaluation_started) * 1000)
                )
            message_id, continuation_token = self._apply_advance(
                uow=uow,
                task=task,
                state=state,
                advance=advance,
                channel=command.channel,
                expected_version=command.expected_version,
                promoted_execution=gray_execution,
            )
            shadow = state.debug.get("multiturn_shadow")
            conversation_act = (
                shadow.get("conversation_act") if isinstance(shadow, dict) else None
            )
            state.debug["execution_route"] = {
                "conversation_act": conversation_act or "NEW_QUERY",
                "selected_pipeline": (
                    "LEGACY_GRAY_MULTITURN_OVERRIDE"
                    if gray_execution is not None
                    else "SINGLE_TURN_QUERY"
                    if conversation_act in {None, "NEW_QUERY"}
                    else "SINGLE_TURN_FALLBACK"
                ),
                "single_turn_semantic_executed": True,
                "dsl_source": (
                    "multiturn_shadow.candidate_dsl_validation.candidate_dsl"
                    if gray_execution is not None
                    else "single_turn_semantic.logical_dsl"
                ),
                "reason": (
                    "LEGACY_SHADOW_GRAY_PROMOTION"
                    if gray_execution is not None
                    else "NEW_QUERY_USES_SINGLE_TURN"
                    if conversation_act in {None, "NEW_QUERY"}
                    else "MULTITURN_ROUTE_NOT_EXECUTABLE"
                ),
            }
            executable_dsl_ready = (
                gray_execution is not None or advance.logical_dsl is not None
            )
            next_status = (
                QueryTaskStatus.RUNNING
                if executable_dsl_ready
                else QueryTaskStatus.WAITING_USER
            )
            next_stage = (
                QueryTaskStage.LOGICAL_DSL
                if executable_dsl_ready
                else QueryTaskStage.CLARIFICATION
            )
            effective_query_shape = (
                gray_execution.candidate_query_shape
                if gray_execution is not None
                else advance.query_shape
            )
            state.timings_ms["analyze_total_ms"] = max(
                0, round((perf_counter() - analyze_started) * 1000)
            )
            state.debug["slot_frame"] = state.slots
            state.debug["clarification"] = _debug_clarification(state.clarification)
            state.debug["logical_dsl"] = state.logical_dsl
            append_task_trace(
                state,
                stage=QueryTaskStage.SLOT_EXTRACTION.value,
                status="completed",
                node="slot_frame_adapted",
                detail={
                    "field_validation_error_count": len(
                        analysis.debug.get("chat_model", {}).get(
                            "field_validation_errors", []
                        )
                    ),
                    "missing": list(advance.slot_frame.missing),
                },
            )
            append_task_trace(
                state,
                stage=next_stage.value,
                status=next_status.value,
                node=(
                    "clarification_requested"
                    if advance.logical_dsl is None
                    else "logical_dsl_ready"
                ),
                detail={"query_shape": effective_query_shape},
            )
            if shadow_evaluation is not None:
                append_task_trace(
                    state,
                    stage=next_stage.value,
                    status=next_status.value,
                    node="multiturn_shadow_compared_with_v1",
                    detail={
                        "comparison": shadow_evaluation.comparison,
                        "admission": shadow_evaluation.admission.decision,
                    },
                )
            if gray_execution is not None:
                append_task_trace(
                    state,
                    stage=QueryTaskStage.LOGICAL_DSL.value,
                    status=QueryTaskStatus.RUNNING.value,
                    node="multiturn_gray_candidate_promoted",
                    detail={
                        "source_task_id": gray_execution.source_task_id,
                        "query_shape": gray_execution.candidate_query_shape,
                    },
                )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=next_status.value,
                current_stage=next_stage.value,
                state_json=state.model_dump(mode="json"),
                intent=advance.slot_frame.task.value,
                query_shape=effective_query_shape,
                error_code=None,
                error_message=None,
            )
            if updated is None:
                raise _version_conflict(task.id, command.expected_version)
            uow.commit()
            return _result(
                updated,
                message_id=message_id,
                continuation_token=continuation_token,
            )

    def _finish_analysis_failure(
        self,
        command: AnalyzeSemanticCommand,
        original_question: str,
        *,
        code: str,
        user_message: str,
        stage: QueryTaskStage,
        error: Exception,
        retryable: bool,
        analyze_started: float,
        intent: IntentClassification | None = None,
        intent_raw: dict[str, Any] | None = None,
        intent_model_ms: int | None = None,
    ) -> TaskCommandResult:
        error_reference = uuid4().hex
        error_debug = {
            "code": code,
            "stage": stage.value,
            "node": "semantic_analysis",
            "user_message": user_message,
            "retryable": retryable,
            "error_reference": error_reference,
            "occurred_at": datetime.now(UTC).isoformat(),
        }
        logger.error(
            "semantic_task_failed task_id=%s stage=%s code=%s error_reference=%s",
            command.task_id,
            stage.value,
            code,
            error_reference,
            extra={"trans_api": "semantic_analysis", "exception_type": code},
        )
        with self.uow_factory() as uow:
            task = (
                uow.tasks.get_owned_for_update(command.task_id, command.actor.user_id or "")
                if command.actor is not None
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise SemanticTaskNotFoundError(command.task_id)
            _require_version(task, command.expected_version)
            _require_analyzable(task)
            state = QueryTaskState.model_validate(task.state_json or {})
            if intent is not None and intent_model_ms is not None:
                _record_intent_routing(
                    state,
                    intent=intent,
                    raw_output=intent_raw,
                    duration_ms=intent_model_ms,
                )
            elif intent_model_ms is not None:
                state.timings_ms["intent_model_ms"] = intent_model_ms
                state.debug["intent_routing"] = {
                    "prompt": "intent_routing",
                    "enable_thinking": False,
                    "duration_ms": intent_model_ms,
                    "valid": False,
                }
            state.timings_ms["analyze_total_ms"] = max(
                0, round((perf_counter() - analyze_started) * 1000)
            )
            state.timings_ms["total_ms"] = _terminal_total_ms(state.timings_ms)
            state.debug.update(
                {
                    "question": original_question,
                    "error": error_debug,
                }
            )
            append_task_trace(
                state,
                stage=stage.value,
                status=QueryTaskStatus.FAILED.value,
                node="semantic_analysis_failed",
                detail={"error_code": code, "error_reference": error_reference},
            )
            run = QueryRun(
                task_id=task.id,
                conversation_id=task.conversation_id,
                user_message=original_question,
                intent=(
                    intent.intent.value
                    if intent is not None
                    else task.intent or "unknown"
                ),
                query_shape=task.query_shape,
                query_plan={"error": error_debug},
                status="failed",
                failed_node=stage.value,
                error_type=code,
                error_message=user_message,
            )
            runs = getattr(uow, "runs", None)
            if runs is not None:
                runs.add(run)
            message_id = str(uuid4())
            uow.messages.add(
                ChatMessage(
                    id=message_id,
                    conversation_id=task.conversation_id,
                    task_id=task.id,
                    role="assistant",
                    content=user_message,
                    created_at=datetime.now(UTC),
                    payload={"kind": "task_error", "error": error_debug},
                )
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=QueryTaskStatus.FAILED.value,
                current_stage=stage.value,
                state_json=state.model_dump(mode="json"),
                intent=intent.intent.value if intent is not None else task.intent,
                query_shape=task.query_shape,
                error_code=code,
                error_message=user_message,
                completed_at=datetime.now(UTC),
            )
            if updated is None:
                raise _version_conflict(task.id, command.expected_version)
            uow.commit()
            return _result(updated, message_id=message_id, continuation_token=None)

    def _finish_intent_boundary(
        self,
        command: AnalyzeSemanticCommand,
        original_question: str,
        *,
        intent: IntentClassification,
        intent_raw: dict[str, Any] | None,
        intent_model_ms: int,
        analyze_started: float,
    ) -> TaskCommandResult:
        message, error_code = _intent_boundary_message(intent.intent)
        with self.uow_factory() as uow:
            task = (
                uow.tasks.get_owned_for_update(command.task_id, command.actor.user_id or "")
                if command.actor is not None
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise SemanticTaskNotFoundError(command.task_id)
            _require_version(task, command.expected_version)
            state = QueryTaskState.model_validate(task.state_json or {})
            _record_intent_routing(
                state,
                intent=intent,
                raw_output=intent_raw,
                duration_ms=intent_model_ms,
            )
            state.timings_ms["analyze_total_ms"] = _elapsed_ms(analyze_started)
            state.timings_ms["total_ms"] = _terminal_total_ms(state.timings_ms)
            state.debug.update({"question": original_question, "intent_boundary": message})
            append_task_trace(
                state,
                stage=QueryTaskStage.RESULT_FORMATTING.value,
                status=QueryTaskStatus.SUCCEEDED.value,
                node=(
                    "non_metric_chat"
                    if intent.intent
                    in {RoutedIntent.NON_METRIC_CHAT, RoutedIntent.OTHER}
                    else "intent_not_available"
                ),
                detail={"intent": intent.intent.value, "error_code": error_code},
            )
            _add_terminal_run(
                uow,
                task=task,
                intent=intent.intent.value,
                query_shape=intent.intent.value,
                status=(
                    "success"
                    if intent.intent
                    in {RoutedIntent.NON_METRIC_CHAT, RoutedIntent.OTHER}
                    else "unsupported"
                ),
                failed_node=None,
                error_type=None,
                error_message=None,
                state=state,
            )
            message_id = str(uuid4())
            uow.messages.add(
                ChatMessage(
                    id=message_id,
                    conversation_id=task.conversation_id,
                    task_id=task.id,
                    role="assistant",
                    content=message,
                    created_at=datetime.now(UTC),
                    payload={
                        "kind": "intent_boundary",
                        "intent": intent.intent.value,
                        "message": message,
                    },
                )
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=QueryTaskStatus.SUCCEEDED.value,
                current_stage=QueryTaskStage.RESULT_FORMATTING.value,
                state_json=state.model_dump(mode="json"),
                intent=intent.intent.value,
                query_shape=intent.intent.value,
                error_code=error_code,
                error_message=message,
                completed_at=datetime.now(UTC),
            )
            if updated is None:
                raise _version_conflict(task.id, command.expected_version)
            uow.commit()
            return _result(updated, message_id=message_id, continuation_token=None)

    def _resume_context_clarification(
        self, *, uow: SqlAlchemyUnitOfWork, task: QueryTask, state: QueryTaskState,
        command: AnalyzeSemanticCommand,
    ) -> None:
        """Re-understand the pending request and corrections against its original history."""
        if command.actor and command.actor.tenant_id != state.actor_context.get("tenant_id"):
            raise SemanticTaskNotFoundError(task.id)
        previous = state.debug.get("multiturn_shadow") or {}
        history = [t for t in uow.tasks.list_for_conversation(task.conversation_id)
                   if t.id != task.id
                   and t.created_at.replace(tzinfo=UTC) <= task.created_at.replace(tzinfo=UTC)
                   and ((t.state_json or {}).get("actor_context") or {}).get("tenant_id")
                   == state.actor_context.get("tenant_id")]
        service = ConversationShadowService(model_service=self.model_service)
        metrics = uow.metric_catalog.list_enabled()
        organizations = uow.organization_catalog.list_enabled()
        answers = [entry["answers"] for entry in state.clarification_answers]
        context = {
            "original_question": task.original_question,
            "user_inputs": [task.original_question, *answers],
            "previous_understanding": previous.get("understanding"),
            "clarification_prompt": state.debug.get("context_clarification_prompt"),
        }
        latest = answers[-1]
        message = latest if isinstance(latest, str) else json.dumps(latest, ensure_ascii=False)
        state.debug.setdefault("context_clarification_attempts", []).append({
            "previous_shadow": previous,
            "answer_request_id": state.clarification_answers[-1].get("request_id"),
        })
        state.debug["context_clarification_pending"] = False
        try:
            resolution, patch, ambiguities, inherited = service.understand(
                message=message,
                reply_to_task_id=(previous.get("anchor") or {}).get("selected_task_id"),
                tasks=history, metrics=metrics, organizations=organizations,
                today=self.today_provider(), clarification_context=context,
            )
            shadow = resolution.model_dump(mode="json")
            shadow["understanding"] = {
                "source": "model", "patch": patch.model_dump(mode="json") if patch else None,
                "ambiguities": ambiguities, "inherit": inherited,
            }
            if resolution.conversation_act.value == "FOLLOW_UP" and not ambiguities:
                merged = service.build_context_candidate(
                    resolution=resolution, message=message, tasks=history, metrics=metrics,
                    organizations=organizations, today=self.today_provider(), patch=patch,
                )
                if merged is not None:
                    validated = service.validate_context_candidate(
                        context_merge=merged, actor=command.actor, metrics=metrics,
                        organizations=organizations,
                        permission_service=self.result_permission_service,
                        planner=self.result_query_planner,
                    )
                    shadow["context_merge"] = merged.model_dump(mode="json")
                    shadow["candidate_dsl_validation"] = validated.model_dump(mode="json")
            state.debug["multiturn_shadow"] = shadow
            state.debug.pop("multiturn_shadow_error", None)
        except (ValueError, TypeError, ModelServiceUnavailable, InvalidModelResponse) as exc:
            state.debug["multiturn_shadow_error"] = log_context_failure(
                exc, stage="resume_understanding", task_id=task.id,
                conversation_id=task.conversation_id,
            )

    def _route_validated_multiturn_follow_up(
        self,
        command: AnalyzeSemanticCommand,
        *,
        analyze_started: float,
    ) -> TaskCommandResult | Literal["UNSUPPORTED_ATTRIBUTION"] | None:
        """Route a validated follow-up directly, without running the V1 semantic path."""

        with self.uow_factory() as uow:
            task = (
                uow.tasks.get_owned_for_update(command.task_id, command.actor.user_id or "")
                if command.actor is not None
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise SemanticTaskNotFoundError(command.task_id)
            _require_version(task, command.expected_version)
            _require_analyzable(task)
            state = QueryTaskState.model_validate(task.state_json or {})
            if is_pending_context_clarification(task.state_json or {}):
                self._resume_context_clarification(uow=uow, task=task, state=state, command=command)
            shadow = state.debug.get("multiturn_shadow")
            if isinstance(shadow, dict) and shadow.get("task_goal") == "attribution_analysis":
                # A clarified unsupported goal must not become an executable query.
                task.state_json = state.model_dump(mode="json")
                uow.commit()
                return "UNSUPPORTED_ATTRIBUTION"
            if state.debug.get("multiturn_shadow_error"):
                return self._hold_multiturn_follow_up(
                    uow=uow, task=task, state=state, command=command,
                    analyze_started=analyze_started, reason="CONVERSATION_UNDERSTANDING_FAILED",
                )
            if isinstance(shadow, dict) and shadow.get("conversation_act") == "REFERENCE_ACTION":
                try:
                    outcome = prepare_result_action(
                        uow=uow, task=task, state=state, actor=command.actor,
                        permission_service=self.result_permission_service,
                        planner=self.result_query_planner,
                    )
                except (ValueError, TypeError) as exc:
                    state.debug["result_reference_error"] = str(exc)
                    return self._hold_multiturn_follow_up(
                        uow=uow, task=task, state=state, command=command,
                        analyze_started=analyze_started, reason="RESULT_REFERENCE_UNAVAILABLE",
                    )
                if isinstance(outcome, list):
                    state.debug["result_candidates"] = outcome
                    return self._hold_multiturn_follow_up(
                        uow=uow, task=task, state=state, command=command,
                        analyze_started=analyze_started, reason="RESULT_REFERENCE_AMBIGUOUS",
                    )
                if outcome is not None:
                    state.timings_ms["analyze_total_ms"] = _elapsed_ms(analyze_started)
                    outcome.task_version = command.expected_version + 1
                    outcome.task_status = "SUCCEEDED"
                    state.execution = {"status": "succeeded", "run_id": None,
                                       "result": outcome.model_dump(mode="json")}
                    _add_result_message(uow, task, outcome)
                    append_task_trace(state, stage="RESULT_FORMATTING", status="SUCCEEDED",
                                      node="historical_result_returned",
                                      detail=state.debug["result_reference"])
                    updated = uow.tasks.update_optimistically(
                        task_id=task.id, expected_version=command.expected_version,
                        status="SUCCEEDED", current_stage="RESULT_FORMATTING",
                        state_json=state.model_dump(mode="json"), intent="metric_query",
                        query_shape=outcome.query_shape, completed_at=datetime.now(UTC),
                    )
                    if updated is None:
                        raise _version_conflict(task.id, command.expected_version)
                    uow.commit()
                    return _result(updated, message_id=None, continuation_token=None)
            if not isinstance(shadow, dict) or shadow.get("conversation_act") != "FOLLOW_UP":
                return None
            understanding = shadow.get("understanding")
            if not isinstance(understanding, dict) or understanding.get("ambiguities"):
                return self._hold_multiturn_follow_up(
                    uow=uow,
                    task=task,
                    state=state,
                    command=command,
                    analyze_started=analyze_started,
                    reason="SEMANTIC_AMBIGUITY",
                )
            try:
                validation = CandidateDslValidationResult.model_validate(
                    shadow.get("candidate_dsl_validation")
                )
                context_merge = ContextMergeResult.model_validate(
                    shadow.get("context_merge")
                )
            except (TypeError, ValueError):
                return self._hold_multiturn_follow_up(
                    uow=uow,
                    task=task,
                    state=state,
                    command=command,
                    analyze_started=analyze_started,
                    reason="INVALID_MULTITURN_CONTEXT",
                )
            if (
                validation.status != "VALID"
                or validation.candidate_dsl is None
                or not validation.query_shape
                or context_merge.status not in {"MERGED", "NO_CHANGE"}
            ):
                return self._hold_multiturn_follow_up(
                    uow=uow,
                    task=task,
                    state=state,
                    command=command,
                    analyze_started=analyze_started,
                    reason="MULTITURN_CONTEXT_NOT_EXECUTABLE",
                )

            now = datetime.now(UTC)
            execution = MultiturnGrayExecutionState(
                status="PROMOTED",
                source_task_id=context_merge.base_task_id,
                candidate_dsl=validation.candidate_dsl,
                candidate_query_shape=validation.query_shape,
                v1_dsl=None,
                v1_query_shape=None,
                dsl_equivalent=False,
                promoted_at=now,
            )
            state.multiturn_execution = execution
            state.logical_dsl = validation.candidate_dsl.model_dump(mode="json")
            state.slots = _effective_slot_frame(context_merge)
            state.missing_slots = []
            state.clarification = None
            state.resolved_question = context_merge.merged_snapshot.summary
            state.timings_ms["analyze_total_ms"] = _elapsed_ms(analyze_started)
            route_debug = {
                "conversation_act": "FOLLOW_UP",
                "selected_pipeline": "MULTITURN_CONTEXT",
                "single_turn_semantic_executed": False,
                "dsl_source": "multiturn_shadow.candidate_dsl_validation.candidate_dsl",
                "reason": "VALIDATED_FOLLOW_UP_CONTEXT",
                "source_task_id": context_merge.base_task_id,
            }
            state.debug["execution_route"] = route_debug
            state.debug["effective_context"] = (
                context_merge.merged_snapshot.model_dump(mode="json")
            )
            state.debug["logical_dsl"] = state.logical_dsl
            shadow["mode"] = "routed"
            shadow["route_decision"] = route_debug
            append_task_trace(
                state,
                stage=QueryTaskStage.INTENT_ROUTING.value,
                status="completed",
                node="conversation_route_selected",
                detail={
                    "conversation_act": "FOLLOW_UP",
                    "selected_pipeline": "MULTITURN_CONTEXT",
                },
            )
            append_task_trace(
                state,
                stage=QueryTaskStage.LOGICAL_DSL.value,
                status=QueryTaskStatus.RUNNING.value,
                node="multiturn_context_dsl_selected",
                detail={
                    "source_task_id": context_merge.base_task_id,
                    "query_shape": validation.query_shape,
                },
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=QueryTaskStatus.RUNNING.value,
                current_stage=QueryTaskStage.LOGICAL_DSL.value,
                state_json=state.model_dump(mode="json"),
                intent=validation.candidate_dsl.task.value,
                query_shape=validation.query_shape,
                error_code=None,
                error_message=None,
            )
            if updated is None:
                raise _version_conflict(task.id, command.expected_version)
            uow.commit()
            return _result(updated, message_id=None, continuation_token=None)

    def _hold_multiturn_follow_up(
        self,
        *,
        uow: SqlAlchemyUnitOfWork,
        task: QueryTask,
        state: QueryTaskState,
        command: AnalyzeSemanticCommand,
        analyze_started: float,
        reason: str,
    ) -> TaskCommandResult:
        prompt = (
            "我识别到这是对历史查询的追问，但暂时无法安全确定需要修改的查询条件。"
            "请补充或明确本次要查询的指标、机构或时间。"
        )
        ambiguities = ((state.debug.get("multiturn_shadow") or {}).get("understanding")
                       or {}).get("ambiguities", [])
        if reason == "SEMANTIC_AMBIGUITY" and any(
            item.startswith("semantic:time:") for item in ambiguities
        ):
            prompt = (
                "本次追问的日期需要确认，请提供有效日期或明确月末。"
                "已识别的机构和指标会继续保留。"
            )
        if reason == "CONVERSATION_UNDERSTANDING_FAILED":
            prompt = "本次上下文解析暂时失败，请重试；也可以补充完整的指标、机构和时间后重新提问。"
        elif reason == "RESULT_REFERENCE_NOT_SUPPORTED":
            prompt = "当前暂不支持直接加工历史结果，请说明需要重新查询的指标、机构和时间。"
        elif reason == "RESULT_REFERENCE_UNAVAILABLE":
            prompt = state.debug.get("result_reference_error") or "历史结果不可用，请重新查询。"
        elif reason == "RESULT_REFERENCE_AMBIGUOUS":
            prompt = "前面有多条符合描述的结果，请选择要使用的那一条。"
        message_id = str(uuid4())
        state.logical_dsl = None
        state.missing_slots = ["multiturn_context"]
        state.clarification = {
            "id": str(uuid4()),
            "type": "multiturn_context",
            "prompt": prompt,
            "options": [],
            "fields": [],
            "understood": {},
            "reply_examples": ["请明确本次要修改的指标、机构或时间"],
            "missing": ["multiturn_context"],
            "created_for_version": command.expected_version,
            "task_version": command.expected_version + 1,
            "continuation_token": None,
        }
        if reason == "RESULT_REFERENCE_AMBIGUOUS":
            options = [
                {"code": s["result_id"], "name": (
                    f"第{s['turn_index']}轮 · {s['summary']} · {s['row_count']}行"
                    + ("（裁剪结果）" if s["kind"] == "DERIVED" else "（原始结果）")
                ), "kind": "result", "patch": {"set": {"result_id": s["result_id"]}}}
                for s in state.debug["result_candidates"]
            ]
            state.clarification.update(
                type="result_reference", options=options, missing=["result_id"],
                fields=[{"field": "result_id", "type": "result", "label": "历史结果",
                         "selection_mode": "single", "options": options}],
                candidate_result_ids=[s["code"] for s in options],
            )
        state.timings_ms["analyze_total_ms"] = _elapsed_ms(analyze_started)
        route_debug = {
            "conversation_act": "FOLLOW_UP",
            "selected_pipeline": "MULTITURN_CLARIFICATION",
            "single_turn_semantic_executed": False,
            "dsl_source": None,
            "reason": reason,
        }
        state.debug["execution_route"] = route_debug
        state.debug["logical_dsl"] = None
        shadow = state.debug.get("multiturn_shadow")
        if isinstance(shadow, dict):
            shadow["mode"] = "routed"
            shadow["route_decision"] = route_debug
        append_task_trace(
            state,
            stage=QueryTaskStage.CLARIFICATION.value,
            status=QueryTaskStatus.WAITING_USER.value,
            node="multiturn_context_clarification_requested",
            detail={"reason": reason},
        )
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
                    "channel": command.channel,
                    "task_version": command.expected_version + 1,
                    "clarification_id": state.clarification["id"],
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
            intent="metric_query",
            query_shape=None,
            error_code=None,
            error_message=None,
        )
        if updated is None:
            raise _version_conflict(task.id, command.expected_version)
        uow.commit()
        return _result(updated, message_id=message_id, continuation_token=None)

    def _apply_advance(
        self,
        *,
        uow: SqlAlchemyUnitOfWork,
        task: QueryTask,
        state: QueryTaskState,
        advance: SemanticAdvance,
        channel: str,
        expected_version: int,
        promoted_execution: MultiturnGrayExecutionState | None = None,
    ) -> tuple[str | None, str | None]:
        state.slots = advance.slot_frame.model_dump(mode="json")
        state.missing_slots = (
            [] if promoted_execution is not None else list(advance.slot_frame.missing)
        )
        state.logical_dsl = (
            promoted_execution.candidate_dsl.model_dump(mode="json")
            if promoted_execution is not None
            else advance.logical_dsl.model_dump(mode="json")
            if advance.logical_dsl is not None
            else None
        )
        if promoted_execution is not None or advance.clarification_id is None:
            state.clarification = None
            return None, None
        if advance.clarification_prompt is None:
            raise RuntimeError("Semantic clarification prompt is missing")

        token = self._continuation_token(
            task=task,
            clarification_id=advance.clarification_id,
            expected_version=expected_version,
            channel=channel,
        )
        state.clarification = {
            "id": advance.clarification_id,
            "type": "semantic_slots",
            "prompt": advance.clarification_prompt,
            "options": advance.clarification_options,
            "fields": advance.clarification_fields,
            "understood": advance.clarification_understood,
            "reply_examples": advance.clarification_reply_examples,
            "missing": state.missing_slots,
            "created_for_version": expected_version,
            "task_version": expected_version + 1,
            "continuation_token": token,
        }
        message = ChatMessage(
            id=str(uuid4()),
            conversation_id=task.conversation_id,
            task_id=task.id,
            role="assistant",
            content=advance.clarification_prompt,
            created_at=datetime.now(UTC),
            payload={
                "kind": "clarification",
                "channel": channel,
                "task_version": expected_version + 1,
                "clarification_id": advance.clarification_id,
                "continuation_token": token,
                "clarification": state.clarification,
            },
        )
        uow.messages.add(message)
        return message.id, token

    def _continuation_token(
        self,
        *,
        task: QueryTask,
        clarification_id: str,
        expected_version: int,
        channel: str,
    ) -> str | None:
        if self.continuation_token_codec is None:
            return None
        return self.continuation_token_codec.encode(
            ContinuationTarget(
                task_id=task.id,
                expected_version=expected_version + 1,
                clarification_id=clarification_id,
                channel=channel,
                channel_context={},
            )
        )


def _require_version(task: QueryTask, expected_version: int) -> None:
    if task.version != expected_version:
        raise _version_conflict(task.id, expected_version, actual_version=task.version)


def _require_analyzable(task: QueryTask) -> None:
    allowed_stages = {
        QueryTaskStage.INTENT_ROUTING.value,
        QueryTaskStage.SLOT_EXTRACTION.value,
    }
    if is_pending_context_clarification(task.state_json or {}):
        allowed_stages.add(QueryTaskStage.VALIDATION.value)
    if task.status != QueryTaskStatus.RUNNING.value or task.current_stage not in allowed_stages:
        raise SemanticTaskConflictError(
            "INVALID_TASK_TRANSITION",
            "Semantic analysis can only run once before clarification or Logical DSL",
            details={
                "task_id": task.id,
                "status": task.status,
                "current_stage": task.current_stage,
            },
        )


def _version_conflict(
    task_id: str, expected_version: int, *, actual_version: int | None = None
) -> SemanticTaskConflictError:
    return SemanticTaskConflictError(
        "TASK_VERSION_CONFLICT",
        "The QueryTask was updated by another request",
        details={
            "task_id": task_id,
            "expected_version": expected_version,
            "actual_version": actual_version,
        },
    )


def _debug_clarification(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {key: item for key, item in value.items() if key != "continuation_token"}


def _effective_slot_frame(context_merge: ContextMergeResult) -> dict[str, Any]:
    """Expose the merged follow-up context without pretending V1 extracted it."""

    snapshot = context_merge.merged_snapshot
    if snapshot.time.preset == "latest":
        time_value = "latest"
    else:
        time_value = snapshot.time.start.isoformat()
        if snapshot.time.end != snapshot.time.start:
            time_value = f"{snapshot.time.start.isoformat()}至{snapshot.time.end.isoformat()}"
    return {
        "task": snapshot.intent,
        "metrics": [item.model_dump(mode="json") for item in snapshot.metrics],
        "time": time_value,
        "orgs": [item.name for item in snapshot.orgs],
        "dimensions": list(snapshot.dimensions),
        "filters": [item.model_dump(mode="json") for item in snapshot.filters],
        "ops": [item.model_dump(mode="json") for item in snapshot.ops],
        "options": dict(snapshot.options),
        "missing": [],
        "source": "multiturn_context_merge",
    }


def _add_terminal_run(
    uow: SqlAlchemyUnitOfWork,
    *,
    task: QueryTask,
    intent: str,
    query_shape: str,
    status: str,
    failed_node: str | None,
    error_type: str | None,
    error_message: str | None,
    state: QueryTaskState,
) -> None:
    runs = getattr(uow, "runs", None)
    if runs is None:
        return
    runs.add(
        QueryRun(
            task_id=task.id,
            conversation_id=task.conversation_id,
            user_message=task.original_question,
            intent=intent,
            query_shape=query_shape,
            query_plan={"trace": state.debug.get("trace", [])},
            status=status,
            failed_node=failed_node,
            error_type=error_type,
            error_message=error_message,
        )
    )


def _model_failure_stage(error: Exception) -> QueryTaskStage:
    endpoint = getattr(error, "endpoint", None)
    if isinstance(endpoint, str) and endpoint.rstrip("/").rsplit("/", 1)[-1] in {
        "embeddings", "rerank",
    }:
        return QueryTaskStage.ENTITY_RESOLUTION
    return QueryTaskStage.SLOT_EXTRACTION


def _model_service_error_code(error: ModelServiceUnavailable) -> str:
    return {
        "timeout": "MODEL_REQUEST_TIMEOUT",
        "connection": "MODEL_CONNECTION_FAILED",
        "http_status": "MODEL_HTTP_ERROR",
        "configuration": "MODEL_CONFIGURATION_MISSING",
        "concurrency": "MODEL_CONCURRENCY_LIMIT",
    }.get(error.category, "MODEL_SERVICE_UNAVAILABLE")


def _model_service_user_message(error: ModelServiceUnavailable) -> str:
    return {
        "timeout": "大模型响应超时，请稍后重试。",
        "connection": "暂时无法连接大模型服务，请稍后重试。",
        "http_status": "大模型服务返回异常状态，请稍后重试。",
        "configuration": "大模型服务尚未正确配置，请联系管理员。",
        "concurrency": "当前问数请求较多，请稍后重试。",
    }.get(error.category, "大模型服务暂时不可用，请稍后重试。")


def _record_intent_routing(
    state: QueryTaskState,
    *,
    intent: IntentClassification,
    raw_output: dict[str, Any] | None,
    duration_ms: int,
) -> None:
    state.timings_ms["intent_model_ms"] = duration_ms
    state.debug["intent_routing"] = {
        "prompt": "intent_routing",
        "source": "llm",
        "enable_thinking": False,
        "duration_ms": duration_ms,
        "output": raw_output,
        "intent": intent.intent.value,
        "confidence": intent.confidence,
        "valid": True,
    }
    append_task_trace(
        state,
        stage=QueryTaskStage.INTENT_ROUTING.value,
        status="completed",
        node="intent_classified",
        detail={
            "intent": intent.intent.value,
            "confidence": intent.confidence,
            "source": "llm",
            "enable_thinking": False,
            "duration_ms": duration_ms,
        },
    )


def _intent_boundary_message(intent: RoutedIntent) -> tuple[str, str]:
    if intent in {RoutedIntent.NON_METRIC_CHAT, RoutedIntent.OTHER}:
        return (
            "这不属于问数问题。当前系统仅支持经营指标问数，暂不支持闲聊或其他类型的问题。",
            "NON_METRIC_QUERY_UNSUPPORTED",
        )
    labels = {
        RoutedIntent.ATTRIBUTION_ANALYSIS: "归因分析",
        RoutedIntent.ANOMALY_DETECTION: "异常检测",
        RoutedIntent.TREND_FORECAST: "趋势预测",
        RoutedIntent.METRIC_EXPLANATION: "指标解释",
        RoutedIntent.DATA_LINEAGE: "数据血缘",
        RoutedIntent.INSIGHT_REPORT: "洞察报告",
    }
    label = labels.get(intent, intent.value)
    return (
        f"已识别为{label}。当前版本暂不支持该能力，仅支持指标查询、多轮条件修改和历史结果操作。",
        "INTENT_NOT_AVAILABLE",
    )


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def _terminal_total_ms(timings_ms: dict[str, int]) -> int:
    return sum(timings_ms.get(key, 0) for key in ("task_creation_ms", "analyze_total_ms"))


def _result(
    task: QueryTask,
    *,
    message_id: str | None,
    continuation_token: str | None,
) -> TaskCommandResult:
    state = QueryTaskState.model_validate(task.state_json or {})
    return TaskCommandResult(
        task_id=task.id,
        conversation_id=task.conversation_id,
        version=task.version,
        status=task.status,
        current_stage=task.current_stage,
        message_id=message_id,
        clarification=state.clarification,
        continuation_token=continuation_token,
        slot_frame=state.slots,
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
