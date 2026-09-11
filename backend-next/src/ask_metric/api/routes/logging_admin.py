import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ask_metric.api.dependencies import require_actor
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.core.logging import set_log_level

router = APIRouter(
    prefix="/api/v1/logging",
    tags=["logging"],
    dependencies=[Depends(require_actor)],
)
logger = logging.getLogger(__name__)


class LogLevelUpdate(BaseModel):
    level: Literal["DEBUG", "INFO", "WARN", "WARNING", "ERROR", "CRITICAL"]


class LogLevelResponse(BaseModel):
    level: str


def _require_system_admin(actor: ActorContext) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise ApplicationError(
            "LOG_ADMIN_FORBIDDEN",
            "System administrator permission is required",
            status_code=403,
        )


@router.get("/level", response_model=LogLevelResponse)
def get_log_level(actor: Annotated[ActorContext, Depends(require_actor)]) -> LogLevelResponse:
    _require_system_admin(actor)
    return LogLevelResponse(level=logging.getLevelName(logging.getLogger().level))


@router.put("/level", response_model=LogLevelResponse)
def update_log_level(
    payload: LogLevelUpdate,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> LogLevelResponse:
    _require_system_admin(actor)
    previous = logging.getLevelName(logging.getLogger().level)
    normalized = set_log_level(payload.level)
    request.app.state.settings.log_level = normalized
    logger.info(
        "log_level_changed previous=%s current=%s operator=%s",
        previous,
        normalized,
        actor.subject,
    )
    return LogLevelResponse(level=normalized)
