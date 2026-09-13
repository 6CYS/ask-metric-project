from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator

from ask_metric.api.dependencies import (
    get_actor_provider,
    get_analysis_service,
    get_channel_clarification_service,
    get_query_execution_service,
    get_query_task_service,
    get_semantic_task_service,
    require_actor,
)
from ask_metric.application.actor_provider import ActorProvider
from ask_metric.application.channel_service import ChannelClarificationService
from ask_metric.application.commands import (
    AnalyzeSemanticCommand,
    CancelClarificationCommand,
    ExecuteQueryCommand,
    SubmitClarificationCommand,
    SubmitQuestionCommand,
)
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import (
    QUESTION_MAX_LENGTH,
    ActorContext,
    IncomingClarificationRequest,
    IncomingRequest,
    UntrustedIdentityClaims,
)
from ask_metric.application.semantic_task_service import SemanticTaskApplicationService
from ask_metric.application.task_results import (
    ConversationCleanupResult,
    ConversationListItem,
    ConversationSnapshot,
    TaskCommandResult,
)
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.domain.conversation_context import (
    MultiturnHumanReview,
    MultiturnReviewSample,
    MultiturnRolloutReadiness,
    MultiturnShadowMetrics,
)
from ask_metric.domain.query_execution import QueryExecutionResult

router = APIRouter(prefix="/api/v1", tags=["query-tasks"])


class SubmitQuestionRequest(BaseModel):
    conversation_id: str | None = None
    message: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)
    external_user_id: str | None = None
    external_session_id: str | None = None
    external_message_id: str | None = None
    reply_to_external_message_id: str | None = None
    reply_to_task_id: str | None = Field(default=None, min_length=1, max_length=128)
    identity_claims: UntrustedIdentityClaims | None = None
    business_context: dict[str, Any] = Field(default_factory=dict)
    channel_context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    debug: bool = False


class SubmitClarificationRequest(BaseModel):
    expected_version: int = Field(ge=0)
    clarification_id: str = Field(min_length=1, max_length=128)
    answers: Any
    channel_context: dict[str, Any] = Field(default_factory=dict)


class CancelClarificationRequest(BaseModel):
    expected_version: int = Field(ge=0)
    clarification_id: str = Field(min_length=1, max_length=128)


class AnalyzeSemanticRequest(BaseModel):
    expected_version: int = Field(ge=0)


@router.get("/query-tasks/{task_id}/analysis-progress")
def analysis_progress(
    task_id: str, request: Request, actor: Annotated[ActorContext, Depends(require_actor)]
):
    # Ordinary queries never load the graph, Skill or checkpoint tables while being polled.
    task = get_query_task_service(request).get_task(task_id, actor)
    if not request.app.state.settings.analysis_enabled:
        return {"version": task.version, "events": []}
    from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

    with SqlAlchemyUnitOfWork() as uow:
        raw = uow.tasks.get_owned(task_id, actor.user_id or "").state_json or {}
        if not raw.get("analysis_started"):
            return {"version": task.version, "events": []}
    return get_analysis_service(request).progress(task_id, actor)


@router.post("/query-tasks/{task_id}/analysis-cancel")
def cancel_analysis(
    task_id: str,
    body: AnalyzeSemanticRequest,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
):
    return get_analysis_service(request).cancel(task_id, actor, body.expected_version)


class ExecuteQueryRequest(BaseModel):
    expected_version: int = Field(ge=0)


class SubmitChannelClarificationRequest(BaseModel):
    channel: str = Field(min_length=1, max_length=64)
    answers: Any
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)
    task_id: str | None = None
    expected_version: int | None = Field(default=None, ge=0)
    clarification_id: str | None = None
    continuation_token: str | None = None
    external_user_id: str | None = None
    external_session_id: str | None = None
    external_message_id: str | None = None
    reply_to_external_message_id: str | None = None
    conversation_id: str | None = None
    identity_claims: UntrustedIdentityClaims | None = None
    channel_context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


@router.post("/questions", response_model=TaskCommandResult)
def submit_question(
    payload: SubmitQuestionRequest,
    request: Request,
    actor_provider: Annotated[ActorProvider, Depends(get_actor_provider)],
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    idempotency_header: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> TaskCommandResult:
    request_id = request.state.request_id
    incoming = IncomingRequest(
        request_id=request_id,
        idempotency_key=idempotency_header or payload.idempotency_key or request_id,
        channel="web",
        external_user_id=payload.external_user_id,
        external_session_id=payload.external_session_id,
        external_message_id=payload.external_message_id,
        reply_to_external_message_id=payload.reply_to_external_message_id,
        reply_to_task_id=payload.reply_to_task_id,
        conversation_id=payload.conversation_id,
        text=payload.message,
        identity_claims=payload.identity_claims,
        business_context=payload.business_context,
        channel_context=payload.channel_context,
        metadata=payload.metadata,
        debug=payload.debug,
    )
    actor = actor_provider.resolve(incoming)
    return service.submit_question(
        SubmitQuestionCommand(
            request=incoming,
            actor=actor,
            idempotency_key=incoming.idempotency_key or request_id,
        )
    )


@router.post("/query-tasks/{task_id}/analyze", response_model=TaskCommandResult)
def analyze_query_task(
    task_id: str,
    payload: AnalyzeSemanticRequest,
    service: Annotated[SemanticTaskApplicationService, Depends(get_semantic_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> TaskCommandResult:
    return service.analyze(
        AnalyzeSemanticCommand(
            task_id=task_id,
            expected_version=payload.expected_version,
            actor=actor,
        )
    )


@router.post("/query-tasks/{task_id}/execute", response_model=QueryExecutionResult)
def execute_query_task(
    task_id: str,
    payload: ExecuteQueryRequest,
    request: Request,
    actor_provider: Annotated[ActorProvider, Depends(get_actor_provider)],
    service: Annotated[QueryExecutionApplicationService, Depends(get_query_execution_service)],
    idempotency_header: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> QueryExecutionResult:
    incoming = IncomingRequest(
        request_id=request.state.request_id,
        channel="web",
        text="execute-query",
    )
    actor = actor_provider.resolve(incoming)
    return service.execute(
        ExecuteQueryCommand(
            task_id=task_id,
            expected_version=payload.expected_version,
            request_id=idempotency_header or request.state.request_id,
            actor=actor,
        )
    )


@router.post("/query-tasks/{task_id}/clarifications", response_model=TaskCommandResult)
def submit_clarification(
    task_id: str,
    payload: SubmitClarificationRequest,
    request: Request,
    actor_provider: Annotated[ActorProvider, Depends(get_actor_provider)],
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
) -> TaskCommandResult:
    incoming = IncomingRequest(
        request_id=request.state.request_id,
        channel="web",
        conversation_id=None,
        text="clarification-answer",
        channel_context=payload.channel_context,
    )
    actor = actor_provider.resolve(incoming)
    return service.submit_clarification(
        SubmitClarificationCommand(
            task_id=task_id,
            expected_version=payload.expected_version,
            clarification_id=payload.clarification_id,
            answers=payload.answers,
            actor=actor,
            channel="web",
            channel_context=payload.channel_context,
            request_id=request.state.request_id,
        )
    )


@router.post(
    "/query-tasks/{task_id}/clarifications/cancel",
    response_model=TaskCommandResult,
)
def cancel_clarification(
    task_id: str,
    payload: CancelClarificationRequest,
    request: Request,
    actor_provider: Annotated[ActorProvider, Depends(get_actor_provider)],
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
) -> TaskCommandResult:
    incoming = IncomingRequest(
        request_id=request.state.request_id,
        channel="web",
        text="cancel-clarification",
    )
    actor = actor_provider.resolve(incoming)
    return service.cancel_clarification(
        CancelClarificationCommand(
            task_id=task_id,
            expected_version=payload.expected_version,
            clarification_id=payload.clarification_id,
            actor=actor,
            request_id=request.state.request_id,
        )
    )


@router.post("/clarifications", response_model=TaskCommandResult)
def submit_channel_clarification(
    payload: SubmitChannelClarificationRequest,
    request: Request,
    actor_provider: Annotated[ActorProvider, Depends(get_actor_provider)],
    correlation_service: Annotated[
        ChannelClarificationService, Depends(get_channel_clarification_service)
    ],
    task_service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    idempotency_header: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> TaskCommandResult:
    incoming = IncomingClarificationRequest(
        request_id=request.state.request_id,
        idempotency_key=idempotency_header or payload.idempotency_key,
        channel=payload.channel,
        answers=payload.answers,
        task_id=payload.task_id,
        expected_version=payload.expected_version,
        clarification_id=payload.clarification_id,
        continuation_token=payload.continuation_token,
        external_user_id=payload.external_user_id,
        external_session_id=payload.external_session_id,
        external_message_id=payload.external_message_id,
        reply_to_external_message_id=payload.reply_to_external_message_id,
        conversation_id=payload.conversation_id,
        identity_claims=payload.identity_claims,
        channel_context=payload.channel_context,
        metadata=payload.metadata,
    )
    actor = actor_provider.resolve(incoming)
    command = correlation_service.build_command(incoming, actor)
    return task_service.submit_clarification(command)


@router.get("/query-tasks/{task_id}", response_model=TaskCommandResult)
def get_query_task(
    task_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> TaskCommandResult:
    return service.get_task(task_id, actor)


@router.get("/conversations/{conversation_id}", response_model=ConversationSnapshot)
def get_conversation(
    conversation_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> ConversationSnapshot:
    return service.get_conversation(conversation_id, actor)


class ConversationListResponse(BaseModel):
    items: list[ConversationListItem]
    has_more: bool


class RenameConversationRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        title = value.strip()
        if not title:
            raise ValueError("title must not be blank")
        return title


class MultiturnReviewRequest(BaseModel):
    expected_version: int = Field(ge=0)
    decision: Literal["APPROVED", "REJECTED"]
    reason_codes: list[str] = Field(default_factory=list, max_length=20)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("reason_codes")
    @classmethod
    def validate_reason_codes(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value or len(value) > 128 for value in normalized):
            raise ValueError("reason codes must be non-empty and at most 128 characters")
        if len(set(normalized)) != len(normalized):
            raise ValueError("reason codes must not contain duplicates")
        return normalized

    @model_validator(mode="after")
    def require_rejection_reason(self) -> "MultiturnReviewRequest":
        if (
            self.decision == "REJECTED"
            and not self.reason_codes
            and not (self.notes and self.notes.strip())
        ):
            raise ValueError("rejected review requires a reason code or notes")
        return self


class MultiturnReviewSampleListResponse(BaseModel):
    items: list[MultiturnReviewSample]
    has_more: bool


@router.get("/conversations", response_model=ConversationListResponse)
def list_conversations(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    limit: Annotated[int, Query(ge=1, le=50)] = 12,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ConversationListResponse:
    items, has_more = service.list_conversations(actor, limit=limit, offset=offset)
    return ConversationListResponse(items=items, has_more=has_more)


@router.get("/multiturn/metrics", response_model=MultiturnShadowMetrics)
def get_multiturn_metrics(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> MultiturnShadowMetrics:
    return service.get_multiturn_metrics(actor)


@router.get("/multiturn/readiness", response_model=MultiturnRolloutReadiness)
def get_multiturn_readiness(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> MultiturnRolloutReadiness:
    return service.get_multiturn_readiness(actor)


@router.get(
    "/multiturn/review-samples",
    response_model=MultiturnReviewSampleListResponse,
)
def list_multiturn_review_samples(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    reviewed: bool | None = None,
) -> MultiturnReviewSampleListResponse:
    items, has_more = service.list_multiturn_review_samples(
        actor,
        limit=limit,
        offset=offset,
        reviewed=reviewed,
    )
    return MultiturnReviewSampleListResponse(items=items, has_more=has_more)


@router.put(
    "/query-tasks/{task_id}/multiturn-review",
    response_model=MultiturnHumanReview,
)
def review_multiturn_task(
    task_id: str,
    payload: MultiturnReviewRequest,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> MultiturnHumanReview:
    return service.review_multiturn_task(
        task_id=task_id,
        expected_version=payload.expected_version,
        decision=payload.decision,
        reason_codes=payload.reason_codes,
        notes=payload.notes,
        actor=actor,
    )


@router.delete("/conversations", response_model=ConversationCleanupResult)
def cleanup_conversations(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    keep_latest: Annotated[int, Query(ge=10, le=100)] = 50,
) -> ConversationCleanupResult:
    return service.cleanup_conversations(actor, keep_latest=keep_latest)


@router.patch("/conversations/{conversation_id}", response_model=ConversationListItem)
def rename_conversation(
    conversation_id: str,
    payload: RenameConversationRequest,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> ConversationListItem:
    return service.rename_conversation(conversation_id, payload.title, actor)


def _xlsx_response(filename: str, content: bytes) -> Response:
    safe_name = filename.replace('"', "").replace("\r", "").replace("\n", "")[:80]
    disposition = f"attachment; filename=export.xlsx; filename*=UTF-8''{quote(safe_name)}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": disposition},
    )


@router.get("/conversations/{conversation_id}/export")
def export_conversation(
    conversation_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> Response:
    title, content = service.export_conversation(conversation_id, actor)
    return _xlsx_response(title, content)


@router.get("/query-tasks/{task_id}/result-export")
def export_task_result(
    task_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> Response:
    title, content = service.export_task_result(task_id, actor)
    return _xlsx_response(title, content)


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(
    conversation_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> Response:
    service.delete_conversation(conversation_id, actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
