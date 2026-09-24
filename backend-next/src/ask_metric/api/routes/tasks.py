"""问数 HTTP 入口：接收并校验请求，交给应用服务，再序列化返回结果。

仅保留新链路所需接口：基础查询、Agent 会话关联、计算、任务与结果读取。
幂等键用于识别同一次操作的重试。
"""

from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from ask_metric.api.dependencies import (
    get_query_execution_service,
    get_query_task_service,
    require_actor,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.commands import ExecuteQueryCommand, SubmitQuestionCommand
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import (
    QUESTION_MAX_LENGTH,
    ActorContext,
    IncomingRequest,
)
from ask_metric.application.task_results import TaskCommandResult, TaskResultPage
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.calculation import CalculationRequest, CalculationScope
from ask_metric.domain.query_execution import QueryExecutionResult
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.db.models import ChatConversation

router = APIRouter(prefix="/api/v1", tags=["query-tasks"])


class BasicQueryRequest(BasicQuerySpec):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=128)
    calculation_context: CalculationScope | None = None
    source_question: str | None = Field(default=None, min_length=1, max_length=QUESTION_MAX_LENGTH)


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
    # 身份只来自认证依赖；请求仅接受结构化查询契约，不接收 SQL 或任意 DSL。
    spec = BasicQuerySpec.model_validate(payload.model_dump(
        exclude={"conversation_id", "calculation_context", "source_question"}))
    if payload.source_question:
        with task_service.uow_factory() as uow:
            catalog = uow.metric_catalog.list_enabled()
        _verify_metric_coverage(payload.source_question, spec.metric_codes, catalog)
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


def _verify_metric_coverage(
    question: str, requested: list[str], catalog: list[MetricCatalogItem]
) -> None:
    """宿主原句的所有目录目标必须进入独立新任务；无法确定时不部分取数。"""
    mentions = metric_candidate_index(catalog).mentions(question)
    if not mentions or any(item["resolution"]["status"] != "resolved" for item in mentions):
        raise ApplicationError(
            "METRIC_TARGETS_UNRESOLVED", "本轮指标目标未全部确定，请核对指标名称。",
            status_code=409,
        )
    expected = {code for item in mentions for code in item["resolution"]["value"]["codes"]}
    if expected != set(requested):
        raise ApplicationError(
            "METRIC_TARGETS_INCOMPLETE", "本轮指标未全部进入查询，请重新解析原问题。",
            status_code=409,
        )


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


def _xlsx_response(filename: str, content: bytes) -> Response:
    safe_name = filename.replace('"', "").replace("\r", "").replace("\n", "")[:80]
    disposition = f"attachment; filename=export.xlsx; filename*=UTF-8''{quote(safe_name)}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": disposition},
    )


@router.get("/query-tasks/{task_id}/result-export")
def export_task_result(
    task_id: str,
    service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> Response:
    title, content = service.export_task_result(task_id, actor)
    return _xlsx_response(title, content)
