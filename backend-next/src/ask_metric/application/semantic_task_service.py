from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime
from time import perf_counter
from typing import Any
from uuid import uuid4

from sqlalchemy.exc import OperationalError

from ask_metric.application.commands import AnalyzeSemanticCommand
from ask_metric.application.continuation_tokens import (
    ContinuationTarget,
    ContinuationTokenCodec,
)
from ask_metric.application.query_scope import require_current_query_scope
from ask_metric.application.semantic_workflow import SemanticAdvance, advance_slot_frame
from ask_metric.application.task_results import TaskCommandResult
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.intent_routing import (
    IntentClassification,
    InvalidIntentClassification,
    RoutedIntent,
    parse_intent_classification,
)
from ask_metric.domain.metric_matching import MetricMatcher
from ask_metric.domain.query_capabilities import capability_error
from ask_metric.domain.semantic_engine import (
    InvalidSlotFrameError,
    SemanticEngine,
    is_direct_catalog_query,
)
from ask_metric.domain.semantic_normalization import query_shape_for
from ask_metric.domain.semantic_reference import (
    ReferenceMergeUnsupported,
    merge_reference_frame,
)
from ask_metric.domain.task import (
    QueryTaskStage,
    QueryTaskState,
    QueryTaskStatus,
    append_task_trace,
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
    """编排问数的独立问题语义解析和当前任务澄清；analyze 指语义解析。"""

    def __init__(
        self,
        *,
        semantic_engine: SemanticEngine,
        config_repository: SemanticConfigRepository,
        uow_factory: UnitOfWorkFactory | None = None,
        continuation_token_codec: ContinuationTokenCodec | None = None,
        today_provider: Callable[[], date] = date.today,
    ) -> None:
        self.semantic_engine = semantic_engine
        self.model_service = semantic_engine.model_service
        self.config_repository = config_repository
        self.uow_factory = uow_factory or SqlAlchemyUnitOfWork
        self.continuation_token_codec = continuation_token_codec
        self.today_provider = today_provider

    def analyze(self, command: AnalyzeSemanticCommand) -> TaskCommandResult:
        # 先验证归属、版本和可执行阶段。读完状态即离开 with，首次意图模型调用
        # 不占用这个数据库工作单元；结果落库时还需再次检查版本，防止覆盖新状态。
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
            require_current_query_scope(raw_state)
            replay = _analysis_replay(task, command)
            if replay is not None:
                return replay
            _require_version(task, command.expected_version)
            _require_analyzable(task)
            original_question = task.original_question
            reference = raw_state.get("query_reference")

        config = self.config_repository.load()
        with self.uow_factory() as uow:
            metrics = uow.metric_catalog.list_enabled()
            disabled = uow.metric_catalog.list_disabled()
            organizations = uow.organization_catalog.list_enabled()

        intent_started = perf_counter()
        intent_raw: dict[str, Any] | None = None
        supplied_reference = reference
        if reference is not None and is_direct_catalog_query(
            original_question,
            metrics=[*metrics, *disabled],
            organizations=organizations,
            organization_aliases=config.organization_aliases,
            require_complete=True,
        ):
            # 原文已独立给齐所有条件时，不让模型误选 followup 把新问题缩成单字段替换。
            # 来源归属已在提交期校验；此处不继承其条件，后续仍走完整目录/权限/DSL 校验。
            reference = None
        direct_catalog_query = reference is None and is_direct_catalog_query(
            original_question,
            metrics=[*metrics, *disabled],
            organizations=organizations,
            organization_aliases=config.organization_aliases,
        )
        if reference is not None or direct_catalog_query:
            intent_raw = {
                "source": "query_reference" if reference else "catalog_exact",
                "intent": "metric_query",
            }
            # 已验证的引用追问：不经过孤立意图路由（"那江阴呢？"离开上下文无法判断），
            # 直接进入受治理指标语义解析；来源冻结条件在提交时已校验。
            intent = IntentClassification(intent=RoutedIntent.METRIC_QUERY, confidence=1.0)
            intent_model_ms = 0
        else:
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
        disabled_codes = {metric.code for metric in disabled}
        requested_disabled = [
            match.name
            for match in MetricMatcher([*metrics, *disabled]).resolve(original_question).matches
            if match.code in disabled_codes
        ]
        if requested_disabled:
            # 长名称优先匹配：停用的短名称不能误伤其仍启用的增幅/排名指标。
            return self._finish_analysis_failure(
                command,
                original_question,
                code="METRIC_DISABLED",
                user_message="以下指标当前未启用："
                + "、".join(dict.fromkeys(requested_disabled))
                + "。本次未执行部分取数，请移除这些指标或联系管理员确认。",
                stage=QueryTaskStage.VALIDATION,
                error=ValueError("requested disabled metrics"),
                retryable=False,
                analyze_started=analyze_started,
                intent=intent,
                intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
            )
        current_date = self.today_provider()
        try:
            analysis = self.semantic_engine.analyze(
                original_question,
                metrics=metrics,
                organizations=organizations,
                config=config,
                current_date=current_date,
                reference_context=reference,
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

        advance_input = analysis.slot_frame
        resolved_time_override = None
        if reference is not None:
            # 引用追问：以冻结来源为底稿做单字段合并；超出范围明确失败，不静默降级
            try:
                merged = merge_reference_frame(reference, analysis.slot_frame)
                advance_input = merged.frame
                resolved_time_override = merged.resolved_time
            except ReferenceMergeUnsupported as exc:
                return self._finish_analysis_failure(
                    command,
                    original_question,
                    code="REFERENCE_MODIFICATION_UNSUPPORTED",
                    user_message=str(exc),
                    stage=QueryTaskStage.VALIDATION,
                    error=exc,
                    retryable=False,
                    analyze_started=analyze_started,
                    intent=intent,
                    intent_raw=intent_raw,
                    intent_model_ms=intent_model_ms,
                )

        unsupported = capability_error(advance_input, query_shape_for(advance_input))
        if unsupported:
            return self._finish_analysis_failure(
                command, original_question, code="QUERY_UNSUPPORTED", user_message=unsupported,
                stage=QueryTaskStage.VALIDATION, error=ValueError(unsupported), retryable=False,
                analyze_started=analyze_started, intent=intent, intent_raw=intent_raw,
                intent_model_ms=intent_model_ms,
            )

        with self.uow_factory() as uow:
            try:
                task = (
                    uow.tasks.get_owned_for_update(command.task_id, command.actor.user_id or "")
                    if command.actor is not None
                    else uow.tasks.get_for_update(command.task_id)
                )
            except OperationalError as exc:
                # 当前事务由 with 退出并回滚；不能再开事务抢同一把锁写失败状态。
                if _is_lock_wait_timeout(exc):
                    raise ApplicationError(
                        "DB_LOCK_TIMEOUT",
                        "数据库正忙，任务状态未改变，请稍后回查。",
                        status_code=503,
                        details={"task_id": command.task_id, "retryable": True},
                    ) from exc
                raise
            if task is None:
                raise SemanticTaskNotFoundError(command.task_id)
            replay = _analysis_replay(task, command)
            if replay is not None:
                return replay
            _require_version(task, command.expected_version)
            _require_analyzable(task)
            state = QueryTaskState.model_validate(task.state_json or {})
            if supplied_reference is not None and reference is None:
                state.query_reference = None
                state.debug["input_routing"] = {
                    "reason": "self_contained_catalog_query",
                    "supplied_reference": supplied_reference,
                }
            state.timings_ms.update(analysis.timings_ms)
            _record_intent_routing(
                state,
                intent=intent,
                raw_output=intent_raw,
                duration_ms=intent_model_ms,
            )
            state.debug.update(
                {
                    "question": original_question,
                    "semantic": analysis.debug,
                }
            )
            if reference is not None:
                state.debug["reference_merge"] = {
                    "source_task_id": reference["source_task_id"],
                    "source_version": reference["source_version"],
                    "changes": advance_input.changes,
                    "inherited_fields": [field for field in
                        ("metrics", "orgs", "time", "ops", "filters", "dimensions")
                        if field not in advance_input.changes],
                }
            advance = advance_slot_frame(
                advance_input,
                metrics=metrics,
                organizations=organizations,
                config=config,
                today=current_date,
                metric_candidates=analysis.metric_candidates,
                resolved_time_override=resolved_time_override,
            )
            state.metric_matches = [
                item.model_dump(mode="json") for item in analysis.metric_matches
            ]
            state.candidates["metrics"] = [
                item.model_dump(mode="json") for item in analysis.metric_candidates
            ]
            state.config_version = config.version
            message_id, continuation_token = self._apply_advance(
                uow=uow,
                task=task,
                state=state,
                advance=advance,
                channel=command.channel,
                expected_version=command.expected_version,
            )
            state.debug["execution_route"] = {
                "selected_pipeline": "SINGLE_TURN_QUERY",
                "dsl_source": "single_turn_semantic.logical_dsl",
                "single_turn_semantic_executed": True,
                "reason": "QUERY_REFERENCE" if reference is not None else "INDEPENDENT_QUESTION",
            }
            executable_dsl_ready = advance.logical_dsl is not None
            next_status = (
                QueryTaskStatus.RUNNING if executable_dsl_ready else QueryTaskStatus.WAITING_USER
            )
            next_stage = (
                QueryTaskStage.LOGICAL_DSL if executable_dsl_ready else QueryTaskStage.CLARIFICATION
            )
            effective_query_shape = advance.query_shape
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
                        analysis.debug.get("chat_model", {}).get("field_validation_errors", [])
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
            _record_analysis(state, command)
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
        if not getattr(error, "_ask_metric_alert_logged", False):
            logger.error(
                "semantic_task_failed task_id=%s stage=%s code=%s error_reference=%s",
                command.task_id,
                stage.value,
                code,
                error_reference,
                exc_info=(type(error), error, error.__traceback__),
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
            replay = _analysis_replay(task, command)
            if replay is not None:
                return replay
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
                intent=(intent.intent.value if intent is not None else task.intent or "unknown"),
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
            _record_analysis(state, command)
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
            replay = _analysis_replay(task, command)
            if replay is not None:
                return replay
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
                    if intent.intent in {RoutedIntent.NON_METRIC_CHAT, RoutedIntent.OTHER}
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
                    if intent.intent in {RoutedIntent.NON_METRIC_CHAT, RoutedIntent.OTHER}
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
            _record_analysis(state, command)
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

    def _apply_advance(
        self,
        *,
        uow: SqlAlchemyUnitOfWork,
        task: QueryTask,
        state: QueryTaskState,
        advance: SemanticAdvance,
        channel: str,
        expected_version: int,
    ) -> tuple[str | None, str | None]:
        state.slots = advance.slot_frame.model_dump(mode="json")
        state.missing_slots = list(advance.slot_frame.missing)
        state.logical_dsl = (
            advance.logical_dsl.model_dump(mode="json") if advance.logical_dsl is not None else None
        )
        if advance.clarification_id is None:
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
        "embeddings",
        "rerank",
    }:
        return QueryTaskStage.ENTITY_RESOLUTION
    return QueryTaskStage.SLOT_EXTRACTION


def _model_service_error_code(error: ModelServiceUnavailable) -> str:
    if error.status_code == 429:
        return "MODEL_RATE_LIMITED"
    return {
        "timeout": "MODEL_REQUEST_TIMEOUT",
        "connection": "MODEL_CONNECTION_FAILED",
        "http_status": "MODEL_HTTP_ERROR",
        "configuration": "MODEL_CONFIGURATION_MISSING",
        "concurrency": "MODEL_CONCURRENCY_LIMIT",
    }.get(error.category, "MODEL_SERVICE_UNAVAILABLE")


def _model_service_user_message(error: ModelServiceUnavailable) -> str:
    if error.status_code == 429:
        return "模型服务请求频率已达上限，请稍后重试。"
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
    source = (raw_output or {}).get("source", "llm")
    state.debug["intent_routing"] = {
        "prompt": "intent_routing",
        "source": source,
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
            "source": source,
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
    if intent is RoutedIntent.ATTRIBUTION_ANALYSIS:
        return (
            "已识别为归因分析。当前版本暂不支持机构贡献度归因，也不支持解读涨跌的"
            "业务动因；可改用指标取值、两期对比或机构排名查询。",
            "INTENT_NOT_AVAILABLE",
        )
    labels = {
        RoutedIntent.ANOMALY_DETECTION: "异常检测",
        RoutedIntent.TREND_FORECAST: "趋势预测",
        RoutedIntent.METRIC_EXPLANATION: "指标解释",
        RoutedIntent.DATA_LINEAGE: "数据血缘",
        RoutedIntent.INSIGHT_REPORT: "洞察报告",
    }
    label = labels.get(intent, intent.value)
    return (
        f"已识别为{label}。当前版本暂不支持该能力，"
        "仅支持单次指标查询、当前任务澄清和历史结果查看/导出。",
        "INTENT_NOT_AVAILABLE",
    )


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def _is_lock_wait_timeout(exc: OperationalError) -> bool:
    """只识别 MySQL 行锁等待超时（errno 1205），其他数据库错误照常抛出。"""
    orig = getattr(exc, "orig", None)
    args = getattr(orig, "args", ())
    return bool(args) and args[0] == 1205


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


def _analysis_replay(task: QueryTask, command: AnalyzeSemanticCommand) -> TaskCommandResult | None:
    if not command.request_id:
        return None
    record = (task.state_json or {}).get("processed_requests", {}).get(command.request_id)
    if record is None:
        return None
    if (
        record.get("kind") != "analyze"
        or record.get("expected_version") != command.expected_version
    ):
        raise SemanticTaskConflictError(
            "IDEMPOTENCY_KEY_REUSED",
            "同一分析请求标识不能用于不同版本",
            details={"task_id": task.id},
        )
    return _result(task, message_id=None, continuation_token=None).model_copy(
        update={"idempotent_replay": True}
    )


def _record_analysis(state: QueryTaskState, command: AnalyzeSemanticCommand) -> None:
    if command.request_id:
        state.processed_requests[command.request_id] = {
            "kind": "analyze",
            "expected_version": command.expected_version,
        }
        while len(state.processed_requests) > 100:
            state.processed_requests.pop(next(iter(state.processed_requests)))
