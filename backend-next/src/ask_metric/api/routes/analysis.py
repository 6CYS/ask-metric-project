"""通用分析接口：目录发现、计划校验、现有查询原语执行及证据报告。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ask_metric.api.dependencies import (
    get_query_execution_service,
    get_query_task_service,
    require_actor,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import METHODS, AnalysisPlan

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
