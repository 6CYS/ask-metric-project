"""业务字段事实接口：复用启用目录与权限，禁止调用自然语言模型或执行指标 SQL。"""

from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.catalogs import get_overview_permissions, get_uow
from ask_metric.application.field_resolution import resolve_catalog_field, resolve_date_field
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

router = APIRouter(prefix="/api/v1/business-context", tags=["business-context"])
RawName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ResolveFieldRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity: Literal["metric", "organization", "date"]
    raw_values: list[RawName] = Field(min_length=1, max_length=100)
    reference_year: int | None = Field(default=None, ge=1, le=9999)


class MetricMentionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=8000)


@router.post("/metric-mentions")
def metric_mentions(
    payload: MetricMentionsRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
) -> dict:
    """对完整原文匹配启用目录，不调用模型、不执行指标 SQL。取数权限仍在执行层校验。"""
    with uow:
        items = uow.metric_catalog.list_enabled()
    return {"mentions": metric_candidate_index(items).mentions(payload.question)}


@router.post("/resolve-field")
def resolve_field(
    payload: ResolveFieldRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
) -> dict:
    if payload.entity == "date":
        if len(payload.raw_values) != 1:
            return {"status": "invalid"}
        today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        return resolve_date_field(
            payload.raw_values[0], today, reference_year=payload.reference_year
        )
    with uow:
        if payload.entity == "metric":
            items = uow.metric_catalog.list_enabled()
        else:
            items = uow.organization_catalog.list_enabled()
            if items:
                try:
                    authorized = permissions.authorize_logical_dsl(actor=actor, logical_dsl={
                        "orgs": [item.code for item in items],
                        "options": {"organization_scope": "synchronized_catalog"},
                    })
                except PermissionDeniedError as error:
                    raise HTTPException(status_code=403, detail="无权解析机构范围") from error
                allowed = set(authorized.get("orgs", []))
                items = [item for item in items if item.code in allowed]
        return resolve_catalog_field(payload.entity, payload.raw_values, items)
