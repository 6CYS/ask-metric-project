"""业务字段事实接口：复用启用目录与权限，禁止调用自然语言模型或执行指标 SQL。"""

from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.catalogs import get_overview_permissions, get_overview_settings, get_uow
from ask_metric.application.field_resolution import resolve_catalog_field, resolve_date_field
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.organization_scope import (
    AuthorizedCohortScope,
    ChildrenOfScope,
    OrganizationScopeError,
    is_authorized_cohort_source,
)
from ask_metric.infrastructure.db.org_hierarchy import SqlAlchemyOrgHierarchyProvider
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


class ResolveCohortRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["authorized_cohort"]
    cohort: Literal["rural_commercial_banks"]
    source_text: RawName


class ResolveChildrenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["children_of"]
    parent_name: RawName
    source_text: RawName


ResolveScopeRequest = Annotated[
    ResolveCohortRequest | ResolveChildrenRequest, Field(discriminator="kind")
]


def get_scope_hierarchy(
    settings: Annotated[Settings, Depends(get_overview_settings)],
) -> SqlAlchemyOrgHierarchyProvider:
    return SqlAlchemyOrgHierarchyProvider(
        root_level=settings.sit_org_head_office_hier_code,
        cohort_level=settings.sit_org_legal_entity_hier_code,
    )


@router.post("/resolve-scope")
def resolve_scope(
    payload: ResolveScopeRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
    hierarchy: Annotated[SqlAlchemyOrgHierarchyProvider, Depends(get_scope_hierarchy)],
) -> dict:
    """机构集合意图由 Agent 绑定原文，服务端独立解析正式目录和当前账号权限。"""
    if payload.kind == "authorized_cohort" and not is_authorized_cohort_source(
        payload.cohort, payload.source_text,
    ):
        raise ApplicationError(
            "SCOPE_SOURCE_INVALID",
            "原文未明确表达机构集合，不能将具体机构或未知名称扩大为全部可见农商行",
            status_code=422,
        )
    with uow:
        organizations = uow.organization_catalog.list_enabled()
    try:
        if payload.kind == "authorized_cohort":
            scope = AuthorizedCohortScope(kind=payload.kind, cohort=payload.cohort)
        else:
            snapshot = hierarchy.strict_snapshot()
            allowed = permissions.authorized_org_codes(
                actor=actor, available_org_codes={node.code for node in snapshot.nodes},
                hierarchy_snapshot=snapshot,
            )
            parent = resolve_catalog_field(
                "organization", [payload.parent_name],
                [item for item in organizations if item.code in allowed],
            )
            if parent["status"] != "resolved":
                return parent
            scope = ChildrenOfScope(kind=payload.kind, parent_code=parent["value"]["codes"][0])
        return {"status": "resolved", "value": resolve_query_scope(
            scope=scope, actor=actor, organizations=organizations,
            permissions=permissions, hierarchy=hierarchy,
        )}
    except PermissionDeniedError as error:
        raise OrganizationScopeError("PERMISSION_DENIED", "无法确认当前账号的机构权限") from error


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
