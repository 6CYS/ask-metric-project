"""通用分析接口：目录发现、计划校验、现有查询原语执行及证据报告。"""

import logging
import threading
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
from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.analysis_workflows import (
    load_workflows,
    profitability_plan,
    retrieve_workflow,
    validate_workflow_admission,
)
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.config import PROJECT_DIR
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import METHODS, AnalysisPlan
from ask_metric.infrastructure.model.configuration import ModelConfigRepository, resolve_config_path
from ask_metric.infrastructure.model.provider import InvalidModelResponse, ModelServiceUnavailable
from ask_metric.infrastructure.model.workflow_vectors import (
    MilvusWorkflowIndex,
    WorkflowRetrievalUnavailable,
)

router = APIRouter(prefix="/api/v1/analysis", tags=["general-analysis"])
_workflow_lock = threading.Lock()
logger = logging.getLogger(__name__)


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
        workflow_catalog=lambda: load_workflows(resolve_config_path(
            PROJECT_DIR, request.app.state.settings.workflow_catalog_path
        )),
    )


class WorkflowRouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=8000)


@router.post("/workflows/route")
def route_analysis_workflow(
    payload: WorkflowRouteRequest,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    settings = request.app.state.settings
    if not settings.workflow_routing_enabled:
        return {"status": "fallback", "reason": "disabled"}
    try:
        catalog = load_workflows(resolve_config_path(PROJECT_DIR, settings.workflow_catalog_path))
        model = get_model_service(request)
        # 专用角色不改动通用目录 Embedding 开关，也不替换当前 Chat 模型。
        model.model_configs = ModelConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.workflow_model_config_path),
            store=settings._config_center,
        )
        with _workflow_lock:
            if not hasattr(request.app.state, "workflow_index"):
                request.app.state.workflow_index = MilvusWorkflowIndex(
                    uri=settings.workflow_milvus_uri, token=settings.workflow_milvus_token,
                    collection=settings.workflow_milvus_collection,
                    client=request.app.state.model_http_client,
                )
        route = retrieve_workflow(
            payload.question, index=request.app.state.workflow_index, model=model, catalog=catalog,
            min_score=settings.workflow_rerank_min_score, margin=settings.workflow_rerank_margin,
        )
    except (WorkflowRetrievalUnavailable, ModelServiceUnavailable, InvalidModelResponse,
            OSError, ValueError, KeyError, TypeError):
        logger.warning("analysis_workflow_route_fallback reason=retrieval_unavailable")
        return {"status": "fallback", "reason": "retrieval_unavailable"}
    if route["status"] != "matched":
        return route
    models = model.model_configs.load().models
    route["retrieval"].update(
        embedding_model=models.embedding.model, reranker_model=models.reranker.model,
    )
    if "expected_org_count" in route["admission"]:
        with service.tasks.uow_factory() as uow:
            organizations = uow.organization_catalog.list_enabled()
        admission = validate_workflow_admission(
            route["admission"], actor=actor, organizations=organizations,
            permissions=service.execution.permission_service,
            hierarchy=(service.execution.organization_scope_provider
                       if hasattr(service.execution.organization_scope_provider, "strict_snapshot")
                       else service.execution.org_hierarchy_provider),
        )
        if admission is None:
            return {"status": "fallback", "reason": "ambiguous_numbered_scope"}
        route["admission"] = admission
    prepared = profitability_plan(
        payload.question, semantics=service.semantics(actor), catalog=catalog,
        parameters=route["parameters"],
    )
    if prepared is None:
        return {"status": "fallback", "reason": "metric_binding_unavailable"}
    return {**route, **prepared}


@router.get("/catalog")
def discover_metrics(
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
    keyword: str = Query(min_length=1, max_length=200),
    page: int = Query(default=1, ge=1, le=1000),
    page_size: int = Query(default=12, ge=1, le=30),
):
    return service.semantics(actor).search(keyword, page=page, page_size=page_size)


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
    payload: AnalysisReportRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    return compose_analysis_report(service, actor, payload)


@router.get("/runs/{key}")
def read_analysis_run(
    key: str,
    conversation_id: str,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[GeneralAnalysisService, Depends(get_analysis_service)],
):
    return service.run_status(actor, key, conversation_id)
