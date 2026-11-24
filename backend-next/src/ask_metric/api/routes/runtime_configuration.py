"""仅暴露Agent实际需要的已知资源；不是按任意配置键读取的通用接口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel

from ask_metric.api.configuration import shared_configuration
from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.model_config import _require_config_read, _require_config_write
from ask_metric.application.agent_runtime_configuration import (
    AGENT_RUNTIME_RESOURCE,
    AgentRuntimeDocument,
)
from ask_metric.application.configuration_setup import (
    initialize_management_configuration,
    missing_resources,
)
from ask_metric.application.database_runtime_configuration import INQUIRY_TOPICS_RESOURCE
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.config_center.nacos import (
    AGENT_MODEL_DATA_ID,
    ConfigCenterConflict,
    ConfigCenterError,
    require_config_store,
)
from ask_metric.infrastructure.configuration_repository import serialize_document

router = APIRouter(
    prefix="/api/v1/runtime-config", tags=["runtime-config"], dependencies=[Depends(require_actor)]
)


def _require_database(request: Request) -> None:
    if request.app.state.settings.business_configuration_storage != "database":
        raise ApplicationError(
            "CONFIG_DATABASE_DISABLED", "配置数据库来源尚未启用", status_code=503
        )


@router.get("/status")
def configuration_status(
    request: Request,
    response: Response,
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict:
    _require_config_read(actor)
    _require_database(request)
    response.headers["Cache-Control"] = "no-store"
    settings = request.app.state.settings
    return {
        "missing_resources": missing_resources(
            shared_configuration(request),
            models_in_database=settings.model_configuration_storage != "nacos",
        ),
        "write_enabled": bool(settings.model_admin_write_enabled),
        "write_token_required": bool(settings.model_admin_token_required),
    }


@router.post("/initialize")
def initialize_configuration(
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> dict:
    _require_config_write(request.app.state.settings, actor, admin_token)
    _require_database(request)
    repository = shared_configuration(request)
    models_in_database = request.app.state.settings.model_configuration_storage != "nacos"
    created = initialize_management_configuration(
        repository, actor=actor.user_id or actor.subject, models_in_database=models_in_database
    )
    return {
        "created_resources": created,
        "missing_resources": missing_resources(repository, models_in_database=models_in_database),
    }


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
    _require_database(request)
    settings = request.app.state.settings
    if settings.model_configuration_storage == "nacos":
        try:
            store = require_config_store(settings._config_center)
            raw, revision = store.read_json_with_revision(AGENT_MODEL_DATA_ID)
        except ConfigCenterError:
            raise ApplicationError(
                "AGENT_RUNTIME_UNAVAILABLE", "请核对 Nacos 中的 Agent 模型配置。", status_code=503
            ) from None
        if version_id is not None and version_id != revision:
            raise ApplicationError(
                "CONFIG_VERSION_NOT_FOUND",
                "本轮绑定的 Agent 模型配置已变更，请重新发起本轮或测评。",
                status_code=409,
            )
        try:
            document = AgentRuntimeDocument.model_validate(raw)
        except ValueError:
            raise ApplicationError(
                "AGENT_RUNTIME_INVALID", "Nacos 中的 Agent 模型配置无效。", status_code=503
            ) from None
        return {
            "version_id": revision,
            "revision": revision,
            "document": document.model_dump(mode="json"),
        }
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
    _require_database(request)
    settings = request.app.state.settings
    if settings.model_configuration_storage == "nacos":
        if not body.revision:
            raise ApplicationError(
                "CONFIG_VERSION_REQUIRED", "请刷新后以当前 Nacos 配置版本保存。", status_code=409
            )
        document = body.document.model_dump(mode="json")
        try:
            store = require_config_store(settings._config_center)
            revision = store.publish_json(
                AGENT_MODEL_DATA_ID, document, expected_revision=body.revision
            )
        except ConfigCenterConflict:
            raise ApplicationError(
                "CONFIG_VERSION_CONFLICT", "配置已被更新，请刷新后重新编辑。", status_code=409
            ) from None
        except ConfigCenterError:
            raise ApplicationError(
                "AGENT_RUNTIME_PUBLISH_FAILED", "Nacos Agent 模型配置发布未确认。", status_code=503
            ) from None
        return {"version_id": revision, "revision": revision, "document": document}
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
