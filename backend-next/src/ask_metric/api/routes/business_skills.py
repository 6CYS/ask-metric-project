"""Agent 透传当前用户鉴权；配置写入仍在后端独立校验。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, ConfigDict

from ask_metric.api.configuration import shared_configuration
from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.model_config import _require_config_write
from ask_metric.application.business_skills import DatabaseBusinessSkills
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError

router = APIRouter(
    prefix="/api/v1/business-skills",
    tags=["business-skills"],
    dependencies=[Depends(require_actor)],
)


class SkillWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = ""
    content: str | None = None


def store(request: Request) -> DatabaseBusinessSkills:
    if request.app.state.settings.business_configuration_storage != "database":
        raise ApplicationError(
            "SKILL_DATABASE_DISABLED", "Skill 数据库来源尚未启用", status_code=503
        )
    return DatabaseBusinessSkills(shared_configuration(request))


@router.get("/runtime")
@router.get("/runtime/{version_id}")
def runtime(request: Request, version_id: str | None = None) -> dict:
    return store(request).runtime(version_id)


@router.get("")
def listing(request: Request, actor: Annotated[ActorContext, Depends(require_actor)]) -> dict:
    if actor.role_code != "SYSTEM_ADMIN":
        raise ApplicationError("CONFIG_ADMIN_REQUIRED", "需要系统管理员权限", status_code=403)
    return {"items": store(request).list()}


def change(
    request: Request,
    name: str,
    body: SkillWrite,
    actor: ActorContext,
    admin_token: str | None,
    *,
    restore: bool = False,
) -> dict:
    _require_config_write(request.app.state.settings, actor, admin_token)
    return store(request).change(
        name, body.revision, content=body.content, actor=actor.subject, restore=restore
    )


@router.put("/{name}")
def save(
    request: Request,
    name: str,
    body: SkillWrite,
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> dict:
    return change(request, name, body, actor, admin_token)


@router.post("/{name}/restore")
def restore(
    request: Request,
    name: str,
    body: SkillWrite,
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> dict:
    return change(request, name, body, actor, admin_token, restore=True)
