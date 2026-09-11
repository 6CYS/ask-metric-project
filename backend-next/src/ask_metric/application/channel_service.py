from __future__ import annotations

from collections.abc import Callable
from uuid import NAMESPACE_URL, uuid5

from ask_metric.application.commands import SubmitClarificationCommand
from ask_metric.application.continuation_tokens import (
    ContinuationTarget,
    ContinuationTokenCodec,
    InvalidContinuationToken,
)
from ask_metric.application.requests import ActorContext, IncomingClarificationRequest
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import QueryTask
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

UnitOfWorkFactory = Callable[[], SqlAlchemyUnitOfWork]


class ClarificationCorrelationError(ApplicationError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 409,
        details: dict | None = None,
    ) -> None:
        super().__init__(code, message, status_code=status_code, details=details)


class ChannelClarificationService:
    """Resolves channel-specific correlation before entering the core task command."""

    def __init__(
        self,
        token_codec: ContinuationTokenCodec,
        uow_factory: UnitOfWorkFactory | None = None,
    ) -> None:
        self.token_codec = token_codec
        self.uow_factory = uow_factory or SqlAlchemyUnitOfWork

    def build_command(
        self, request: IncomingClarificationRequest, actor: ActorContext
    ) -> SubmitClarificationCommand:
        target = self._resolve_target(request)
        return SubmitClarificationCommand(
            task_id=target.task_id,
            expected_version=target.expected_version,
            clarification_id=target.clarification_id,
            answers=request.answers,
            actor=actor,
            channel=request.channel,
            channel_context={**target.channel_context, **request.channel_context},
            request_id=(
                request.idempotency_key
                or request.external_message_id
                or request.request_id
            ),
        )

    def _resolve_target(self, request: IncomingClarificationRequest) -> ContinuationTarget:
        direct_values = (request.task_id, request.expected_version)
        if any(value is not None for value in direct_values):
            if (
                not all(value is not None for value in direct_values)
                or not request.clarification_id
            ):
                raise ClarificationCorrelationError(
                    "INCOMPLETE_TASK_REFERENCE",
                    "task_id, expected_version and clarification_id must be provided together",
                    status_code=400,
                )
            with self.uow_factory() as uow:
                task = uow.tasks.get(request.task_id or "")
                if task is None:
                    raise ClarificationCorrelationError(
                        "CLARIFICATION_TARGET_NOT_FOUND",
                        "The referenced task was not found",
                        status_code=404,
                    )
                if request.channel != "web" and not _matches_channel_scope(task, request):
                    raise ClarificationCorrelationError(
                        "CLARIFICATION_SCOPE_MISMATCH",
                        "The referenced task does not belong to this channel session",
                    )
                active = _target_from_task(task, request.channel, request.channel_context)
            if (
                active.expected_version != request.expected_version
                or active.clarification_id != request.clarification_id
            ):
                raise ClarificationCorrelationError(
                    "STALE_CLARIFICATION_REFERENCE",
                    "The task version or clarification identifier is stale",
                    details={
                        "task_id": active.task_id,
                        "actual_version": active.expected_version,
                        "actual_clarification_id": active.clarification_id,
                    },
                )
            return active

        if request.continuation_token:
            try:
                target = self.token_codec.decode(request.continuation_token)
            except InvalidContinuationToken as exc:
                raise ClarificationCorrelationError(
                    "INVALID_CONTINUATION_TOKEN", str(exc), status_code=409
                ) from exc
            if target.channel != request.channel:
                raise ClarificationCorrelationError(
                    "CONTINUATION_CHANNEL_MISMATCH",
                    "The continuation token belongs to a different channel",
                )
            return target

        with self.uow_factory() as uow:
            if request.reply_to_external_message_id:
                message = uow.messages.find_by_external_message_id(
                    request.channel, request.reply_to_external_message_id
                )
                if message is not None and message.task_id:
                    task = uow.tasks.get(message.task_id)
                    if task is not None and _matches_channel_scope(task, request):
                        return _target_from_task(task, request.channel, request.channel_context)

            conversation_id = _conversation_id_for_fallback(request)
            if conversation_id is None:
                raise ClarificationCorrelationError(
                    "CLARIFICATION_TARGET_NOT_FOUND",
                    "No task reference, continuation token, reply mapping or session was provided",
                    status_code=404,
                )
            candidates = [
                task
                for task in uow.tasks.list_waiting_for_conversation(conversation_id)
                if _matches_channel_scope(task, request)
                and (
                    request.clarification_id is None
                    or (
                        QueryTaskState.model_validate(task.state_json or {}).clarification
                        or {}
                    ).get("id")
                    == request.clarification_id
                )
            ]
            if request.idempotency_key:
                for task in uow.tasks.list_for_conversation(conversation_id):
                    state = QueryTaskState.model_validate(task.state_json or {})
                    processed = state.processed_requests.get(request.idempotency_key)
                    if (
                        processed
                        and processed.get("kind") == "submit_clarification"
                        and _matches_channel_scope(task, request)
                    ):
                        return ContinuationTarget(
                            task_id=task.id,
                            expected_version=task.version,
                            clarification_id=request.clarification_id or "",
                            channel=request.channel,
                            channel_context=request.channel_context,
                        )
            if len(candidates) == 1:
                return _target_from_task(
                    candidates[0], request.channel, request.channel_context
                )
            if len(candidates) > 1:
                raise ClarificationCorrelationError(
                    "CLARIFICATION_TARGET_AMBIGUOUS",
                    "Multiple tasks are waiting for clarification in this channel session",
                    details={"candidate_count": len(candidates)},
                )
            raise ClarificationCorrelationError(
                "CLARIFICATION_TARGET_NOT_FOUND",
                "No task is waiting for clarification in this channel session",
                status_code=404,
            )


def _target_from_task(
    task: QueryTask, channel: str, channel_context: dict
) -> ContinuationTarget:
    state = QueryTaskState.model_validate(task.state_json or {})
    clarification = state.clarification or {}
    clarification_id = clarification.get("id")
    if (
        task.status != "WAITING_USER"
        or task.current_stage != "CLARIFICATION"
        or not clarification_id
    ):
        raise ClarificationCorrelationError(
            "STALE_CLARIFICATION_REFERENCE",
            "The referenced task no longer has an active clarification",
        )
    return ContinuationTarget(
        task_id=task.id,
        expected_version=task.version,
        clarification_id=str(clarification_id),
        channel=channel,
        channel_context=channel_context,
    )


def _conversation_id_for_fallback(request: IncomingClarificationRequest) -> str | None:
    if request.conversation_id:
        return request.conversation_id
    if not request.external_session_id:
        return None
    return str(
        uuid5(
            NAMESPACE_URL,
            f"ask-metric:conversation:{request.channel}:{request.external_session_id}",
        )
    )


def _matches_channel_scope(task: QueryTask, request: IncomingClarificationRequest) -> bool:
    state = QueryTaskState.model_validate(task.state_json or {})
    context = state.channel_context
    if context.get("channel") != request.channel:
        return False
    if request.external_user_id:
        stored_user_id = context.get("external_user_id")
        if stored_user_id is None or stored_user_id != request.external_user_id:
            return False
    if request.external_session_id:
        stored_session_id = context.get("external_session_id")
        if stored_session_id is None or stored_session_id != request.external_session_id:
            return False
    if not request.external_user_id and not request.external_session_id:
        return False
    return True
