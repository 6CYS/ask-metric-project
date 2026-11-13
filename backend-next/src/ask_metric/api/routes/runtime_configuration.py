"""仅暴露Agent实际需要的已知资源；不是按任意配置键读取的通用接口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel

from ask_metric.api.configuration import shared_configuration
from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.model_config import _require_config_write
from ask_metric.application.agent_runtime_configuration import (
    AGENT_RUNTIME_RESOURCE,
    AgentRuntimeDocument,
)
from ask_metric.application.database_runtime_configuration import INQUIRY_TOPICS_RESOURCE
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.configuration_repository import serialize_document

router = APIRouter(
    prefix="/api/v1/runtime-config", tags=["runtime-config"], dependencies=[Depends(require_actor)]
)


@router.get("/inquiry-topics")
@router.get("/inquiry-topics/{version_id}")
def inquiry_topics(request: Request, response: Response, version_id: str | None = None) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if request.app.state.settings.business_configuration_storage != "database":
        raise ApplicationError(
            "CONFIG_DATABASE_DISABLED", "配置数据库来源尚未启用", status_code=503
        )
    repository = shared_configuration(request)
    snapshot = (
        repository.version(INQUIRY_TOPICS_RESOURCE, version_id)
        if version_id
        else repository.read(INQUIRY_TOPICS_RESOURCE)
    )
    return {"version_id": snapshot.id, "document": snapshot.document()}


@router.get("/agent-runtime")
@router.get("/agent-runtime/{version_id}")
def agent_runtime(request: Request, response: Response, version_id: str | None = None) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if request.app.state.settings.business_configuration_storage != "database":
        raise ApplicationError(
            "CONFIG_DATABASE_DISABLED", "配置数据库来源尚未启用", status_code=503
        )
    repository = shared_configuration(request)
    snapshot = (
        repository.version(AGENT_RUNTIME_RESOURCE, version_id)
        if version_id
        else repository.read(AGENT_RUNTIME_RESOURCE)
    )
    try:
        document = AgentRuntimeDocument.model_validate(snapshot.document())
    except ValueError as error:
        raise ApplicationError(
            "AGENT_RUNTIME_INVALID", "数据库Agent运行配置无效", status_code=503
        ) from error
    return {
        "version_id": snapshot.id,
        "revision": snapshot.revision,
        "document": document.model_dump(mode="json"),
    }


class AgentRuntimeWrite(BaseModel):
    revision: str
    document: AgentRuntimeDocument


@router.put("/agent-runtime")
def update_agent_runtime(
    body: AgentRuntimeWrite,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> dict:
    _require_config_write(request.app.state.settings, actor, admin_token)
    if request.app.state.settings.business_configuration_storage != "database":
        raise ApplicationError(
            "CONFIG_DATABASE_DISABLED", "配置数据库来源尚未启用", status_code=503
        )
    snapshot = shared_configuration(request).publish(
        AGENT_RUNTIME_RESOURCE,
        serialize_document(body.document.model_dump(mode="json")),
        expected_revision=body.revision,
        actor=actor.user_id or actor.subject,
    )
    return {
        "version_id": snapshot.id,
        "revision": snapshot.revision,
        "document": snapshot.document(),
    }
