"""通用分析接口：目录发现、计划校验、现有查询原语执行及证据报告。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ask_metric.api.dependencies import (
    get_model_service,
    get_query_execution_service,
    get_query_task_service,
    require_actor,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.analysis_calculation import (
    AnalysisCalculationRequest,
    calculate_analysis_results,
)
from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.catalog_search import metric_embedding_scores
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.config import PROJECT_DIR
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import METHODS, AnalysisPlan
from ask_metric.infrastructure.model.configuration import resolve_config_path
from ask_metric.infrastructure.model.provider import InvalidModelResponse, ModelServiceUnavailable
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

router = APIRouter(prefix="/api/v1/analysis", tags=["general-analysis"])


def get_analysis_service(
    request: Request,
    tasks: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    execution: Annotated[QueryExecutionApplicationService, Depends(get_query_execution_service)],
):
    return GeneralAnalysisService(
        tasks,
        execution,
        CalculationApplicationService(execution),
        secret=request.app.state.settings.jwt_secret,
    )


@router.get("/catalog")
def discover_metrics(
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
    keyword: str = Query(min_length=1, max_length=200),
    page: int = Query(default=1, ge=1, le=1000),
    page_size: int = Query(default=12, ge=1, le=30),
):
    semantics = service.semantics(actor)
    result = semantics.search(keyword, page=page, page_size=page_size)
    if any(item["match_type"] == "exact" for item in result["items"]):
        return result
    settings = request.app.state.settings
    matching = SemanticConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.semantic_config_path),
        store=settings._config_center,
    ).load().metric_matching
    model = get_model_service(request)
    enabled = model.is_enabled("embedding")
    try:
        scores = metric_embedding_scores(
            keyword, list(semantics.items.values()), model_service=model,
            catalog_vector_cache=request.app.state.catalog_vector_cache,
            is_embedding_enabled=enabled, embedding_top_k=matching.embedding_top_k,
            batch_size=matching.embedding_batch_size,
            wait_seconds=matching.embedding_cache_wait_seconds,
        )
    except (ModelServiceUnavailable, InvalidModelResponse):
        scores = None
    if scores is not None:
        result = semantics.search(keyword, page=page, page_size=page_size,
                                  embedding_scores=scores)
    result["semantic_retrieval"] = {
        "status": "succeeded" if scores is not None else "unavailable" if enabled else "disabled",
        "notice": ("近似推荐须核对完整名称和定义，不能直接作为执行依据。" if scores is not None
                   else "本次仅返回名称和别名检索结果，未完成语义推荐；不能据此断言没有相关指标。"),
    }
    return result


@router.get("/methods")
def analysis_methods(actor: Annotated[ActorContext, Depends(require_actor)]):
    return METHODS


class PlanValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan: AnalysisPlan
    question: str = Field(default="", max_length=8000)


@router.post("/validate")
def validate_plan(
    payload: PlanValidationRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    _, bindings = service.validate_plan(payload.plan, actor, payload.question)
    return {
        "status": "validated",
        "metric_count": len(bindings),
        "method_version": METHODS["version"],
    }


@router.post("/execute", dependencies=[Depends(require_query_ready)])
def execute_analysis(
    payload: AnalysisRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
    key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
):
    try:
        return service.execute(payload, actor, key)
    except PermissionDeniedError as exc:
        raise ApplicationError("ANALYSIS_FORBIDDEN", "无权分析所选机构。", status_code=403) from exc


@router.post("/report")
def present_report(
    request: Request,
    payload: AnalysisReportRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    if payload.availability_requests:
        require_query_ready(request)
    return compose_analysis_report(service, actor, payload)


@router.post("/calculations")
def compare_analysis_results(
    payload: AnalysisCalculationRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
    key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
):
    return calculate_analysis_results(service, actor, payload, key)


@router.get("/runs/{key}")
def read_analysis_run(
    key: str,
    conversation_id: str,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    return service.run_status(actor, key, conversation_id)


@router.get("/evidence/{run_ref}")
def read_analysis_evidence(
    run_ref: str,
    conversation_id: str,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    evidence = service.authorized_evidence(actor, run_ref)
    if evidence.get("conversation_id") != conversation_id:
        raise ApplicationError(
            "ANALYSIS_RUN_NOT_FOUND", "分析运行不存在或无权读取。", status_code=404
        )
    return evidence
