from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel

from ask_metric.application.channel_service import ChannelClarificationService
from ask_metric.application.commands import (
    AnalyzeSemanticCommand,
    ExecuteQueryCommand,
    SubmitQuestionCommand,
)
from ask_metric.application.ports import ModelService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import (
    ActorContext,
    IncomingClarificationRequest,
    IncomingRequest,
)
from ask_metric.application.semantic_task_service import SemanticTaskApplicationService
from ask_metric.application.task_results import TaskCommandResult
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.domain.query_execution import QueryExecutionResult


class IntegrationError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class IntegrationAskResult(BaseModel):
    request_id: str
    message_id: str | None = None
    conversation_id: str
    task_id: str
    status: Literal["succeeded", "waiting_user", "processing", "failed", "unsupported"]
    type: Literal["answer", "clarification", "processing", "error"]
    answer: str | None = None
    data: dict[str, Any] | None = None
    clarification: dict[str, Any] | None = None
    error: IntegrationError | None = None
    idempotent_replay: bool = False


class IntegrationAskApplicationService:
    """Aggregate the internal task state machine behind one channel-neutral API."""

    def __init__(
        self,
        *,
        task_service: QueryTaskApplicationService,
        semantic_service: SemanticTaskApplicationService,
        execution_service: QueryExecutionApplicationService,
        clarification_service: ChannelClarificationService,
        model_service: ModelService | None = None,
    ) -> None:
        self.task_service = task_service
        self.semantic_service = semantic_service
        self.execution_service = execution_service
        self.clarification_service = clarification_service
        self.model_service = model_service

    def ask(
        self,
        *,
        request_id: str,
        source_system: str,
        message_id: str | None,
        external_conversation_id: str,
        user_input: str,
        actor: ActorContext,
        external_user_id: str,
        clarification_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        user_context: dict[str, Any] | None = None,
    ) -> IntegrationAskResult:
        internal_conversation_id = _internal_conversation_id(
            source_system, external_user_id, external_conversation_id
        )
        idempotency_key = message_id or request_id
        channel_context = {
            "source_system": source_system,
            "external_conversation_id": external_conversation_id,
            "history": history or [],
            "user": user_context or {},
        }
        if clarification_id:
            incoming = IncomingClarificationRequest(
                request_id=request_id,
                idempotency_key=idempotency_key,
                channel=source_system,
                answers=user_input,
                clarification_id=clarification_id,
                external_user_id=external_user_id,
                external_session_id=external_conversation_id,
                external_message_id=message_id,
                conversation_id=internal_conversation_id,
                channel_context=channel_context,
            )
            command = self.clarification_service.build_command(incoming, actor)
            current = self.task_service.submit_clarification(command)
        else:
            resolved_input = self._resolve_question(user_input, history or [])
            incoming = IncomingRequest(
                request_id=request_id,
                idempotency_key=idempotency_key,
                channel=source_system,
                external_user_id=external_user_id,
                external_session_id=external_conversation_id,
                external_message_id=message_id,
                conversation_id=internal_conversation_id,
                text=resolved_input,
                channel_context=channel_context,
                metadata={
                    "history": history or [],
                    "original_user_input": user_input,
                    "resolved_user_input": resolved_input,
                },
            )
            current = self.task_service.submit_question(
                SubmitQuestionCommand(
                    request=incoming,
                    actor=actor,
                    idempotency_key=idempotency_key,
                )
            )

        if current.status == "RUNNING" and current.current_stage in {
            "INTENT_ROUTING", "SLOT_EXTRACTION",
        }:
            current = self.semantic_service.analyze(
                AnalyzeSemanticCommand(
                    task_id=current.task_id,
                    expected_version=current.version,
                    actor=actor,
                    channel=source_system,
                )
            )

        if current.status == "WAITING_USER":
            return _clarification_result(
                current,
                request_id=request_id,
                message_id=message_id,
                external_conversation_id=external_conversation_id,
            )

        if current.result is not None and (
            current.status == "SUCCEEDED" or current.result.get("analysis")
        ):
            return _execution_result(
                QueryExecutionResult.model_validate(current.result),
                request_id=request_id, message_id=message_id,
                external_conversation_id=external_conversation_id,
                replay=current.idempotent_replay,
            )

        if current.logical_dsl is not None and current.status in {"RUNNING", "SUCCEEDED", "FAILED"}:
            execution = self.execution_service.execute(
                ExecuteQueryCommand(
                    task_id=current.task_id,
                    expected_version=current.version,
                    request_id=f"integration-execute:{idempotency_key}",
                    actor=actor,
                )
            )
            return _execution_result(
                execution,
                request_id=request_id,
                message_id=message_id,
                external_conversation_id=external_conversation_id,
                replay=current.idempotent_replay,
            )

        return _task_terminal_result(
            current,
            request_id=request_id,
            message_id=message_id,
            external_conversation_id=external_conversation_id,
        )

    def _resolve_question(self, user_input: str, history: list[dict[str, str]]) -> str:
        if not history or self.model_service is None:
            return user_input
        try:
            response = self.model_service.analyze(
                prompt="conversation_contextualization",
                context={
                    "history_json": _json(history[-12:]),
                    "user_input": user_input,
                },
            )
        except Exception:
            return user_input
        standalone = response.get("standalone_question")
        if not isinstance(standalone, str) or not standalone.strip():
            return user_input
        return standalone.strip()[:1000]


def _internal_conversation_id(source_system: str, user_id: str, conversation_id: str) -> str:
    return str(
        uuid5(
            NAMESPACE_URL,
            f"ask-metric:integration:{source_system}:{user_id}:{conversation_id}",
        )
    )


def _json(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _clarification_result(
    result: TaskCommandResult,
    *,
    request_id: str,
    message_id: str | None,
    external_conversation_id: str,
) -> IntegrationAskResult:
    clarification = dict(result.clarification or {})
    clarification.pop("continuation_token", None)
    return IntegrationAskResult(
        request_id=request_id,
        message_id=message_id,
        conversation_id=external_conversation_id,
        task_id=result.task_id,
        status="waiting_user",
        type="clarification",
        answer=clarification.get("prompt") or clarification.get("question"),
        clarification=clarification,
        idempotent_replay=result.idempotent_replay,
    )


def _execution_result(
    result: QueryExecutionResult,
    *,
    request_id: str,
    message_id: str | None,
    external_conversation_id: str,
    replay: bool,
) -> IntegrationAskResult:
    status = result.status
    failed = status in {"failed", "unsupported"}
    return IntegrationAskResult(
        request_id=request_id,
        message_id=message_id,
        conversation_id=external_conversation_id,
        task_id=result.task_id,
        status=status,
        type="error" if failed else "answer",
        answer=result.message,
        data=(
            {
                "columns": result.columns,
                "rows": result.rows,
                "comparisons": result.comparisons,
                "row_count": result.row_count,
                "truncated": result.truncated,
                "latency_ms": result.latency_ms,
                **({"analysis": result.analysis} if result.analysis else {}),
            }
            if not failed
            else None
        ),
        error=(
            IntegrationError(
                code=result.error_code or "QUERY_EXECUTION_FAILED",
                message=result.error_message or result.message or "问数执行失败",
                retryable=status == "failed",
            )
            if failed
            else None
        ),
        idempotent_replay=replay or result.idempotent_replay,
    )


def _task_terminal_result(
    result: TaskCommandResult,
    *,
    request_id: str,
    message_id: str | None,
    external_conversation_id: str,
) -> IntegrationAskResult:
    if result.status == "SUCCEEDED":
        return IntegrationAskResult(
            request_id=request_id,
            message_id=message_id,
            conversation_id=external_conversation_id,
            task_id=result.task_id,
            status="succeeded",
            type="answer",
            answer=result.error_message,
            idempotent_replay=result.idempotent_replay,
        )
    if result.status == "FAILED":
        return IntegrationAskResult(
            request_id=request_id,
            message_id=message_id,
            conversation_id=external_conversation_id,
            task_id=result.task_id,
            status="failed",
            type="error",
            error=IntegrationError(
                code=result.error_code or "INTEGRATION_ASK_FAILED",
                message=result.error_message or "问数处理失败",
            ),
            idempotent_replay=result.idempotent_replay,
        )
    return IntegrationAskResult(
        request_id=request_id,
        message_id=message_id,
        conversation_id=external_conversation_id,
        task_id=result.task_id,
        status="processing",
        type="processing",
        idempotent_replay=result.idempotent_replay,
    )
