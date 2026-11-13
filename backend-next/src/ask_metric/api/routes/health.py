from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ask_metric.api.configuration import shared_configuration
from ask_metric.application.database_configuration_readiness import validate_database_configuration
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.readiness import DatabaseReadiness, get_database_readiness

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: str


@router.get("/api/v1/query-readiness")
def query_readiness(request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.query_initialization.snapshot()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/health/ready",
    response_model=HealthResponse,
    responses={503: {"model": HealthResponse}},
)
def readiness(
    request: Request,
    checker: Annotated[DatabaseReadiness, Depends(get_database_readiness)],
) -> HealthResponse | JSONResponse:
    ready = checker.is_ready()
    if ready and request.app.state.settings.business_configuration_storage == "database":
        try:
            validate_database_configuration(shared_configuration(request))
        except (ApplicationError, ValueError, KeyError, TypeError):
            # 健康探针仅报告受控状态，不暴露配置正文或内部连接信息。
            ready = False
    if not ready:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=HealthResponse(status="unavailable").model_dump(),
        )
    return HealthResponse(status="ready")
