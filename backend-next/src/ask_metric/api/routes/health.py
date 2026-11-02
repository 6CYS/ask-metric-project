from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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
    query_ready = request.app.state.query_initialization.snapshot()["status"] == "ready"
    if not query_ready or not checker.is_ready():
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=HealthResponse(status="unavailable").model_dump(),
        )
    return HealthResponse(status="ready")
