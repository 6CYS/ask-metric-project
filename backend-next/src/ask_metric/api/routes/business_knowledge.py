"""管理员维护业务知识；运行读取仍沿业务主题入口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy import select

from ask_metric.api.configuration import shared_configuration
from ask_metric.api.dependencies import require_actor
from ask_metric.application.business_knowledge import (
    BusinessKnowledgeStore,
    KnowledgeFields,
)
from ask_metric.application.database_business_knowledge import DatabaseBusinessKnowledgeStore
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import PROJECT_DIR
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.models import MetricTerm
from ask_metric.infrastructure.db.session import app_read_session
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


def knowledge_store(request: Request, actor: ActorContext | None = None) -> BusinessKnowledgeStore:
    if getattr(request.app.state.settings, "business_configuration_storage", "file") == "database":
        return DatabaseBusinessKnowledgeStore(
            shared_configuration(request),
            actor=(actor.user_id or actor.subject) if actor else "system",
        )
    return BusinessKnowledgeStore(resolve_config_path(
        PROJECT_DIR, request.app.state.settings.business_knowledge_path,
    ))


@router.get("")
def list_knowledge(
    request: Request,
    metric_code: Annotated[str | None, Query(min_length=1, max_length=150)] = None,
) -> dict:
    return knowledge_store(request).read(metric_code=metric_code)


def validate_metric_links(fields: KnowledgeFields) -> None:
    metric_codes = list(fields.metric_codes)
    if fields.report_layout is not None:
        metric_codes.extend(code for section in fields.report_layout.sections
                            for code in section.metric_codes)
    metric_codes = list(dict.fromkeys(metric_codes))
    if not metric_codes:
        return
    with app_read_session() as session:
        existing = set(session.scalars(select(MetricTerm.metric_code).where(
            MetricTerm.metric_code.in_(metric_codes),
        )))
    missing = [code for code in metric_codes if code not in existing]
    if missing:
        raise ApplicationError(
            "BUSINESS_KNOWLEDGE_METRIC_NOT_FOUND",
            "关联指标不存在，请刷新指标目录后重新选择。", status_code=422,
        )


@router.post("", status_code=201)
def create_knowledge(
    payload: KnowledgeWrite, request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict:
    fields = KnowledgeFields.model_validate(
        payload.model_dump(exclude={"revision"}, exclude_unset=True),
    )
    validate_metric_links(fields)
    return knowledge_store(request, actor).create(fields, payload.revision)


@router.put("/{entry_id}")
def update_knowledge(
    entry_id: str, payload: KnowledgeWrite, request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict:
    fields = KnowledgeFields.model_validate(
        payload.model_dump(exclude={"revision"}, exclude_unset=True),
    )
    validate_metric_links(fields)
    return knowledge_store(request, actor).update(entry_id, fields, payload.revision)


@router.patch("/{entry_id}/enabled")
def enable_knowledge(
    entry_id: str, payload: KnowledgeToggle, request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict:
    return knowledge_store(request, actor).set_enabled(entry_id, payload.enabled, payload.revision)
