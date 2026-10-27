"""管理员维护业务知识；运行读取仍沿业务主题入口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from ask_metric.api.dependencies import require_actor
from ask_metric.application.business_knowledge import (
    BusinessKnowledgeStore,
    KnowledgeFields,
)
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import PROJECT_DIR
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.model.configuration import resolve_config_path


def require_knowledge_admin(actor: Annotated[ActorContext, Depends(require_actor)]) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise ApplicationError(
            "BUSINESS_KNOWLEDGE_FORBIDDEN", "需要系统管理员权限。", status_code=403,
        )


router = APIRouter(prefix="/api/v1/catalog/business-knowledge", tags=["business-knowledge"],
                   dependencies=[Depends(require_knowledge_admin)])


class KnowledgeWrite(KnowledgeFields):
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class KnowledgeToggle(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    enabled: StrictBool
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")


def knowledge_store(request: Request) -> BusinessKnowledgeStore:
    return BusinessKnowledgeStore(resolve_config_path(
        PROJECT_DIR, request.app.state.settings.business_knowledge_path,
    ))


@router.get("")
def list_knowledge(request: Request) -> dict:
    return knowledge_store(request).read()


@router.post("", status_code=201)
def create_knowledge(payload: KnowledgeWrite, request: Request) -> dict:
    fields = KnowledgeFields.model_validate(
        payload.model_dump(exclude={"revision"}, exclude_unset=True),
    )
    return knowledge_store(request).create(fields, payload.revision)


@router.put("/{entry_id}")
def update_knowledge(entry_id: str, payload: KnowledgeWrite, request: Request) -> dict:
    fields = KnowledgeFields.model_validate(
        payload.model_dump(exclude={"revision"}, exclude_unset=True),
    )
    return knowledge_store(request).update(entry_id, fields, payload.revision)


@router.patch("/{entry_id}/enabled")
def enable_knowledge(entry_id: str, payload: KnowledgeToggle, request: Request) -> dict:
    return knowledge_store(request).set_enabled(entry_id, payload.enabled, payload.revision)
