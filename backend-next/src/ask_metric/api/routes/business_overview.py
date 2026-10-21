"""经营概览：主题约束规划，复用现有查询、计算与鉴权。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header

from ask_metric.api.dependencies import (
    get_query_execution_service,
    get_query_task_service,
    require_actor,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.business_overview import (
    BusinessOverviewService,
    OverviewRequest,
    read_knowledge,
)
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError

router = APIRouter(prefix="/api/v1", tags=["business-overview"])


def get_overview_service(
    tasks: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    execution: Annotated[QueryExecutionApplicationService, Depends(get_query_execution_service)],
) -> BusinessOverviewService:
    return BusinessOverviewService(tasks, execution, CalculationApplicationService(execution))


@router.get("/business-topics/{topic}")
def describe_topic(
    topic: str,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[BusinessOverviewService, Depends(get_overview_service)],
) -> dict:
    return service.describe(topic)


@router.get("/business-topics/{topic}/knowledge")
def topic_knowledge(topic: str, actor: Annotated[ActorContext, Depends(require_actor)]) -> dict:
    return {
        "topic": topic,
        "entries": read_knowledge(topic),
        "notice": "知识条目提供方法和背景，不能作为当前机构数值或因果证据。",
    }


@router.post("/business-overviews", dependencies=[Depends(require_query_ready)])
def execute_overview(
    payload: OverviewRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[BusinessOverviewService, Depends(get_overview_service)],
    key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
) -> dict:
    try:
        return service.execute(payload, actor, key)
    except PermissionDeniedError as exc:
        raise ApplicationError("ANALYSIS_FORBIDDEN", "无权分析所选机构。", status_code=403) from exc
