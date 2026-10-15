"""问数 HTTP 入口：接收并校验请求，交给应用服务，再序列化返回结果。

仅保留新链路所需接口：基础查询、Agent 会话关联、计算、任务与结果读取。
幂等键用于识别同一次操作的重试。
"""

from datetime import UTC, datetime
from typing import Annotated, NoReturn
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ask_metric.api.dependencies import (
    get_query_execution_service,
    get_query_task_service,
    require_actor,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.commands import ExecuteQueryCommand, SubmitQuestionCommand
from ask_metric.application.metric_candidates import MetricCandidateIndex, metric_candidate_index
from ask_metric.application.analysis_selection import verify_selection
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import (
    QUESTION_MAX_LENGTH,
    ActorContext,
    IncomingRequest,
)
from ask_metric.application.task_results import (
    BasicQueryStatus,
    TaskCommandResult,
    TaskResultPage,
)
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec, CatalogCode
from ask_metric.domain.calculation import CalculationRequest, CalculationScope
from ask_metric.domain.query_execution import MAX_METRIC_CODES, QueryExecutionResult
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.db.models import ChatConversation

router = APIRouter(prefix="/api/v1", tags=["query-tasks"])


class SourceMetricSpan(BaseModel):
    """宿主保存的完整指标原文片段；位置按 Unicode 码点计数。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    start: int = Field(ge=0)
    end: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)

    @model_validator(mode="after")
    def validate_span(self):
        if self.start >= self.end:
            raise ValueError("指标绑定必须使用非空原文片段")
        return self


class SourceMetricBinding(SourceMetricSpan):
    """宿主保存的原文指标身份，不接受模型补写字段。"""

    codes: list[CatalogCode] = Field(min_length=1, max_length=MAX_METRIC_CODES)

    @model_validator(mode="after")
    def validate_codes(self):
        if len(set(self.codes)) != len(self.codes):
            raise ValueError("指标绑定编码不能重复")
        return self


class BasicQueryRequest(BasicQuerySpec):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=128)
    calculation_context: CalculationScope | None = None
    source_question: str | None = Field(default=None, min_length=1, max_length=QUESTION_MAX_LENGTH)
    source_metric_bindings: list[SourceMetricBinding] | None = Field(default=None, min_length=1)
    source_metric_exclusions: list[SourceMetricSpan] | None = None
    source_semantic_receipt: str | None = Field(default=None, min_length=1, max_length=16000, repr=False)

    @model_validator(mode="after")
    def require_binding_question(self):
        if self.source_metric_bindings is not None and self.source_question is None:
            raise ValueError("指标原文绑定必须同时提供覆盖原句")
        if self.source_metric_exclusions is not None and (
            self.source_question is None or self.source_metric_bindings is None
        ):
            raise ValueError("排除指标原文片段必须同时提供完整原句和保留指标绑定")
        return self


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
        exclude={"conversation_id", "calculation_context", "source_question",
                 "source_metric_bindings", "source_metric_exclusions", "source_semantic_receipt"}))
    if payload.source_semantic_receipt:
        if payload.source_question or payload.organization_scope:
            raise ApplicationError("ANALYSIS_SOURCE_INVALID", "分析选择不能与原句绑定或动态范围混用。", status_code=409)
        with task_service.uow_factory() as uow:
            catalog = uow.metric_catalog.list_enabled()
        verify_selection(payload.source_semantic_receipt, owner=actor.user_id, conversation=payload.conversation_id,
            codes=spec.metric_codes, scope=spec.model_dump(mode="json", exclude_none=True),
            catalog=catalog, secret=request.app.state.settings.jwt_secret)
    if payload.source_question:
        with task_service.uow_factory() as uow:
            catalog = uow.metric_catalog.list_enabled()
        _verify_metric_coverage(
            payload.source_question, spec.metric_codes, catalog, payload.source_metric_bindings,
            payload.source_metric_exclusions,
        )
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


@router.get(
    "/basic-queries/{idempotency_key}", response_model=BasicQueryStatus,
    dependencies=[Depends(require_actor)],
)
def get_basic_query_status(
    idempotency_key: Annotated[str, Path(min_length=1, max_length=128)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    task_service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    conversation_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
) -> BasicQueryStatus:
    """按幂等键只读回查本人基础查询的状态，供请求结果丢失后对账；不执行查询。"""
    return task_service.find_basic_query(
        idempotency_key, actor, conversation_id=conversation_id,
    )


def _verify_metric_coverage(
    question: str, requested: list[str], catalog: list[MetricCatalogItem],
    bindings: list[SourceMetricBinding] | None = None,
    exclusions: list[SourceMetricSpan] | None = None,
) -> None:
    """宿主原句的所有目录目标必须进入独立新任务；无法确定时不部分取数。"""
    index = metric_candidate_index(catalog)
    mentions = index.mentions(question)
    if bindings is None:
        # 兼容旧调用方：没有已确认身份时，仍要求原句自身能唯一确定全部指标。
        if (exclusions is not None or not mentions
                or any(item["resolution"]["status"] != "resolved" for item in mentions)):
            raise ApplicationError(
                "METRIC_TARGETS_UNRESOLVED", "本轮指标目标未全部确定，请核对指标名称。",
                status_code=409,
            )
        expected = {code for item in mentions for code in item["resolution"]["value"]["codes"]}
    else:
        expected = _verify_metric_bindings(question, mentions, bindings, exclusions or [], index)
    if expected != set(requested):
        raise ApplicationError(
            "METRIC_TARGETS_INCOMPLETE", "本轮指标未全部进入查询，请重新解析原问题。",
            status_code=409,
        )


def _verify_metric_bindings(
    question: str, mentions: list[dict], bindings: list[SourceMetricBinding],
    exclusions: list[SourceMetricSpan], index: MetricCandidateIndex,
) -> set[str]:
    """原文完整扫描与逐片段身份双向核对；不能拿 requested 反推歧义选择。"""
    def unresolved() -> NoReturn:
        raise ApplicationError(
            "METRIC_TARGETS_UNRESOLVED", "本轮指标目标未全部确定，请核对指标名称。",
            status_code=409,
        )

    spans: list[SourceMetricSpan] = [*bindings, *exclusions]
    if not mentions or not bindings or len(mentions) != len(spans):
        unresolved()
    by_span: dict[tuple[int, int, str], SourceMetricSpan] = {}
    previous_end = 0
    for span in sorted(spans, key=lambda item: (item.start, item.end)):
        # 保留完整原文再标记放弃项，避免删除共享基础名或拼接出用户未表达的新名称。
        if (span.start < previous_end or span.end > len(question)
                or question[span.start:span.end] != span.text):
            unresolved()
        previous_end = span.end
        by_span[(span.start, span.end, span.text)] = span
    expected: set[str] = set()
    for mention in mentions:
        binding = by_span.pop((mention["start"], mention["end"], mention["text"]), None)
        if binding is None:
            unresolved()
        if not isinstance(binding, SourceMetricBinding):
            # 用户可以明确放弃未决目标；只有精确覆盖扫描所得完整片段才可排除。
            continue
        resolution = mention["resolution"]
        codes = set(binding.codes)
        if not codes.issubset(index.items):
            unresolved()
        if resolution["status"] == "resolved":
            if codes != set(resolution["value"]["codes"]):
                unresolved()
        elif resolution["status"] in {"ambiguous", "needs_confirmation"}:
            candidates = {candidate.get("code") for candidate in resolution.get("candidates", [])}
            # 模糊基础名需要先确认基础、再确认口径；候选自身不带最终编码。
            # 只从当前索引已验证的来源结构扩展可选变体，不从 requested 反推选择。
            for candidate in resolution.get("candidates", []):
                metadata = candidate.get("metadata", {})
                if metadata.get("kind") == "base_only":
                    variants = index.variants.get(metadata.get("source_metric_code"), {})
                    candidates.update(code for variant_codes in variants.values()
                                      for code in variant_codes)
            if len(codes) != 1 or not codes.issubset(candidates):
                unresolved()
        else:
            unresolved()
        expected.update(codes)
    if by_span:
        unresolved()
    return expected


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
            # 会话数量不设上限；资源占用由存储与运维容量管理，不在用户侧截断。
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
