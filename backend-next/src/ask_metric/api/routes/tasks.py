"""问数 HTTP 入口：接收并校验请求，交给应用服务，再序列化返回结果。

提交、语义解析和执行是分开的接口；expected_version 防止旧页面覆盖新状态，
幂等键用于识别同一次操作的重试。二者不能互相替代。
"""

from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ask_metric.api.dependencies import (
    get_actor_provider,
    get_channel_clarification_service,
    get_query_execution_service,
    get_query_task_service,
    get_semantic_task_service,
    require_actor,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.actor_provider import ActorProvider
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.channel_service import ChannelClarificationService
from ask_metric.application.commands import (
    AnalyzeSemanticCommand,
    CancelClarificationCommand,
    CancelTaskCommand,
    ExecuteQueryCommand,
    QueryReference,
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
    TaskResultPage,
)
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.calculation import CalculationRequest, CalculationScope
from ask_metric.domain.query_execution import QueryExecutionResult
from ask_metric.infrastructure.db.models import ChatConversation

router = APIRouter(prefix="/api/v1", tags=["query-tasks"])


class QueryReferencePayload(BaseModel):
    """单来源组合追问引用；后端校验归属、版本、状态与权限。"""

    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=0)
    change_field: Literal["orgs", "time", "compose"] = "compose"


class SubmitQuestionRequest(BaseModel):
    conversation_id: str | None = None
    message: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)
    external_user_id: str | None = None
    external_session_id: str | None = None
    external_message_id: str | None = None
    reply_to_external_message_id: str | None = None
    reply_to_task_id: str | None = Field(default=None, min_length=1, max_length=128)
    # 可选单来源追问引用；缺省为空时旧请求语义不变
    query_reference: QueryReferencePayload | None = None
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


class ExecuteQueryRequest(BaseModel):
    expected_version: int = Field(ge=0)


class BasicQueryRequest(BasicQuerySpec):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=128)
    calculation_context: CalculationScope | None = None


class BasicQueryResponse(BaseModel):
    query: BasicQuerySpec
    result: QueryExecutionResult


@router.post(
    "/basic-queries", response_model=BasicQueryResponse,
    dependencies=[Depends(require_actor), Depends(require_query_ready)],
)
def execute_basic_query(
    payload: BasicQueryRequest,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    task_service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    execution_service: Annotated[
        QueryExecutionApplicationService, Depends(get_query_execution_service)
    ],
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=1, max_length=128)
    ],
) -> BasicQueryResponse:
    # 身份只来自认证依赖；请求不接收 SQL、操作、身份声明或任意 DSL。
    spec = BasicQuerySpec.model_validate(payload.model_dump(
        exclude={"conversation_id", "calculation_context"}))
    created = task_service.submit_question(SubmitQuestionCommand(
        request=IncomingRequest(
            request_id=request.state.request_id,
            channel="basic_query",
            conversation_id=payload.conversation_id,
            channel_context={"calculation_context": (
                payload.calculation_context.model_dump() if payload.calculation_context else {}
            )},
            text=f"基础查询：{spec.time.start}至{spec.time.end}，"
                 f"{len(spec.metric_codes)}个指标、{len(spec.org_codes)}个机构",
        ),
        actor=actor,
        idempotency_key=idempotency_key,
        basic_query=spec,
    ))
    result = execution_service.execute(ExecuteQueryCommand(
        task_id=created.task_id,
        expected_version=created.version,
        request_id=f"basic:{idempotency_key}",
        actor=actor,
    ))
    return BasicQueryResponse(query=spec, result=result)


class AgentQueryContextRequest(BaseModel):
    session_id: UUID


@router.post("/agent-query-contexts")
def create_agent_query_context(
    payload: AgentQueryContextRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
) -> dict[str, str]:
    """显式创建 Agent 会话关联；后续查询不允许重建已删除的关联会话。"""
    conversation_id = f"agent:{payload.session_id}"
    with service.uow_factory() as uow:
        existing = uow.conversations.get(conversation_id)
        if existing is not None:
            if existing.owner_user_id != actor.user_id:
                raise ApplicationError("CONVERSATION_NOT_FOUND", "会话不存在。", status_code=404)
        else:
            if (uow.conversations.count_owned(actor.user_id or "")
                    >= service.max_conversations_per_user):
                raise ApplicationError("CONVERSATION_LIMIT", "会话数量已达上限，请清理历史会话。",
                                       status_code=409)
            uow.conversations.add(ChatConversation(
                id=conversation_id, owner_user_id=actor.user_id, title="智能助手",
                preview="", created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
            ))
            uow.commit()
    return {"conversation_id": conversation_id}


@router.post("/calculations")
def calculate_query_facts(
    payload: CalculationRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    execution: Annotated[QueryExecutionApplicationService, Depends(get_query_execution_service)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
) -> dict:
    return CalculationApplicationService(execution).calculate(payload, actor, idempotency_key)


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


@router.post(
    "/questions", response_model=TaskCommandResult,
    # 装饰器登记 URL；依赖在处理请求时执行，认证与就绪检查都通过才进入业务。
    dependencies=[Depends(require_actor), Depends(require_query_ready)],
)
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
    reference = (
        QueryReference(
            task_id=payload.query_reference.task_id,
            version=payload.query_reference.version,
            change_field=payload.query_reference.change_field,
        )
        if payload.query_reference is not None
        else None
    )
    return service.submit_question(
        SubmitQuestionCommand(
            request=incoming,
            actor=actor,
            idempotency_key=incoming.idempotency_key or request_id,
            query_reference=reference,
        )
    )


@router.post(
    "/query-tasks/{task_id}/analyze", response_model=TaskCommandResult,
    dependencies=[Depends(require_actor), Depends(require_query_ready)],
)
def analyze_query_task(
    task_id: str,
    payload: AnalyzeSemanticRequest,
    request: Request,
    service: Annotated[SemanticTaskApplicationService, Depends(get_semantic_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> TaskCommandResult:
    return service.analyze(
        AnalyzeSemanticCommand(
            task_id=task_id,
            expected_version=payload.expected_version,
            actor=actor,
            request_id=request.state.request_id,
        )
    )


@router.post(
    "/query-tasks/{task_id}/execute", response_model=QueryExecutionResult,
    dependencies=[Depends(require_actor), Depends(require_query_ready)],
)
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


@router.post(
    "/query-tasks/{task_id}/clarifications", response_model=TaskCommandResult,
    dependencies=[Depends(require_actor), Depends(require_query_ready)],
)
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


@router.post(
    "/clarifications", response_model=TaskCommandResult,
    dependencies=[Depends(require_actor), Depends(require_query_ready)],
)
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


@router.get("/query-tasks/lookup", response_model=TaskCommandResult)
def lookup_query_task(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    conversation_id: Annotated[str, Query(min_length=1, max_length=128)],
    submission_key: Annotated[str, Query(min_length=1, max_length=128)],
) -> TaskCommandResult:
    """只读找回：提交成功但响应丢失时按会话与提交键定位，未找到不新建任务。"""
    return service.lookup_task(conversation_id, submission_key, actor)


@router.get("/query-tasks/{task_id}", response_model=TaskCommandResult)
def get_query_task(
    task_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> TaskCommandResult:
    return service.get_task(task_id, actor)


@router.get("/query-tasks/{task_id}/result", response_model=TaskResultPage)
def get_query_task_result(
    task_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
) -> TaskResultPage:
    """统一结果读取：校验归属后返回不可变快照的分页事实，未就绪/缺快照明确报错。"""
    return service.get_task_result(task_id, actor, offset=offset, limit=limit)


class ReadTaskResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original_question: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=100)


@router.post("/query-tasks/{task_id}/result", response_model=TaskResultPage)
def read_query_task_result(
    task_id: str,
    payload: ReadTaskResultRequest,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> TaskResultPage:
    """Agent 历史回读：原文仅用于校验引用，不创建任务或执行 SQL。"""
    return service.get_task_result(
        task_id, actor, offset=payload.offset, limit=payload.limit,
        read_question=payload.original_question,
    )


class CancelTaskRequest(BaseModel):
    expected_version: int = Field(ge=0)


@router.post("/query-tasks/{task_id}/cancel", response_model=TaskCommandResult)
def cancel_query_task(
    task_id: str,
    payload: CancelTaskRequest,
    request: Request,
    actor_provider: Annotated[ActorProvider, Depends(get_actor_provider)],
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
) -> TaskCommandResult:
    """通用逻辑取消：复用幂等记录与乐观锁；不承诺数据库驱动即时停止 SQL。"""
    incoming = IncomingRequest(
        request_id=request.state.request_id,
        channel="web",
        text="cancel-task",
    )
    actor = actor_provider.resolve(incoming)
    return service.cancel_task(
        CancelTaskCommand(
            task_id=task_id,
            expected_version=payload.expected_version,
            actor=actor,
            request_id=request.state.request_id,
        )
    )


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


@router.get("/conversations", response_model=ConversationListResponse)
def list_conversations(
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    limit: Annotated[int, Query(ge=1, le=50)] = 12,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ConversationListResponse:
    items, has_more = service.list_conversations(actor, limit=limit, offset=offset)
    return ConversationListResponse(items=items, has_more=has_more)


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
