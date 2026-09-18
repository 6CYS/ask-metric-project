from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import load_only

from ask_metric.api.dependencies import require_actor
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import Settings
from ask_metric.infrastructure.db.models import (
    ChatConversation,
    Dataset,
    MetricSynonym,
    MetricTerm,
    OrgTerm,
    QueryRun,
    QueryTask,
)
from ask_metric.infrastructure.db.organization_scope import SqlAlchemyOrganizationScopeProvider
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

router = APIRouter(
    prefix="/api/v1/catalog", tags=["catalog"], dependencies=[Depends(require_actor)]
)


class MetricCatalogResponse(BaseModel):
    items: list[dict[str, object]] = Field(default_factory=list)


class MetricPayload(BaseModel):
    metric_code: str = Field(min_length=1, max_length=150)
    metric_name: str = Field(min_length=1, max_length=300)
    metric_explanation: str = ""
    description: str = ""
    unit: str | None = Field(default=None, max_length=64)
    synonyms: list[str] = Field(default_factory=list)
    enabled: bool = True


class OrganizationPayload(BaseModel):
    org_code: str = Field(min_length=1, max_length=128)
    org_name: str = Field(min_length=1, max_length=300)
    aliases: list[str] = Field(default_factory=list)
    enabled: bool = True


class DatasetPayload(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    datasource_type: str = Field(default="mysql", min_length=1, max_length=64)
    schema_name: str = Field(default="business_metrics", min_length=1, max_length=128)
    table_name: str = Field(min_length=1, max_length=128)
    dialect: str = Field(default="mysql", min_length=1, max_length=64)
    enabled: bool = True


def get_uow() -> SqlAlchemyUnitOfWork:
    return SqlAlchemyUnitOfWork()


def get_overview_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_overview_permissions(
    settings: Annotated[Settings, Depends(get_overview_settings)],
) -> ScopedOrganizationPermissionService:
    return ScopedOrganizationPermissionService(
        organization_scope_provider=SqlAlchemyOrganizationScopeProvider(),
        all_organization_org_codes=set(settings.all_organization_org_codes),
    )


@router.get("/overview")
def catalog_overview(
    catalog: Literal["metrics", "organizations"],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
    settings: Annotated[Settings, Depends(get_overview_settings)],
    limit: int = Query(default=8, ge=1, le=20),
) -> dict[str, object]:
    """只返回有限目录摘要；机构先经过与查询相同的授权，再计数和取样。"""
    with uow:
        if catalog == "metrics":
            total = uow.session.scalar(
                select(func.count()).select_from(MetricTerm).where(MetricTerm.enabled.is_(True))
            ) or 0
            codes = list(dict.fromkeys(settings.catalog_overview_metric_codes))
            terms = uow.session.scalars(select(MetricTerm).where(
                MetricTerm.enabled.is_(True), MetricTerm.metric_code.in_(codes)
            )).all() if codes else []
            by_code = {term.metric_code: term for term in terms}
            examples = [
                {"name": by_code[code].metric_name, "unit": by_code[code].unit}
                for code in codes if code in by_code
            ][:limit]
        else:
            codes = list(uow.session.scalars(
                select(OrgTerm.org_code).where(OrgTerm.enabled.is_(True))
            ))
            try:
                authorized = permissions.authorize_logical_dsl(actor=actor, logical_dsl={
                    "orgs": codes, "options": {"organization_scope": "synchronized_catalog"},
                })
            except PermissionDeniedError as error:
                raise HTTPException(
                    status_code=403, detail="无法确认当前账号的机构查询范围"
                ) from error
            allowed = set(authorized.get("orgs", [])) & set(codes)
            total = len(allowed)
            terms = uow.session.scalars(select(OrgTerm).where(
                OrgTerm.enabled.is_(True), OrgTerm.org_code.in_(allowed)
            ).order_by(OrgTerm.org_code).limit(limit)).all()
            examples = [{"name": term.org_name} for term in terms]
    return {
        "catalog": catalog, "total": total, "examples": examples, "examples_only": True,
        "data_availability": "目录存在不代表指定机构和日期有数据，需查询确认。",
    }


@router.get("/metrics", response_model=MetricCatalogResponse)
def list_metrics(
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
) -> MetricCatalogResponse:
    with uow:
        terms = list(
            uow.session.execute(
                select(MetricTerm).order_by(MetricTerm.metric_code)
            ).scalars()
        )
        synonym_rows = list(
            uow.session.execute(
                select(MetricSynonym)
                .where(MetricSynonym.enabled.is_(True))
                .order_by(MetricSynonym.metric_code, MetricSynonym.weight.desc())
            ).scalars()
        )
    aliases: dict[str, list[str]] = {}
    for row in synonym_rows:
        aliases.setdefault(row.metric_code, []).append(row.synonym)
    return MetricCatalogResponse(
        items=[
            {
                "metric_code": item.metric_code,
                "metric_name": item.metric_name,
                "metric_explanation": item.metric_explanation,
                "description": item.description,
                "unit": item.unit,
                "synonyms": aliases.get(item.metric_code, []),
                "enabled": item.enabled,
            }
            for item in terms
        ]
    )


def _require_system_admin(actor: ActorContext) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise HTTPException(status_code=403, detail="系统管理员权限是必需的")


def _normalized_synonyms(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))


def _normalized_aliases(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))


def _metric_response(term: MetricTerm, synonyms: list[str]) -> dict[str, object]:
    return {
        "metric_code": term.metric_code,
        "metric_name": term.metric_name,
        "metric_explanation": term.metric_explanation,
        "description": term.description,
        "unit": term.unit,
        "synonyms": synonyms,
        "enabled": term.enabled,
    }


@router.post("/metrics", status_code=status.HTTP_201_CREATED)
def create_metric(
    payload: MetricPayload,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_system_admin(actor)
    synonyms = _normalized_synonyms(payload.synonyms)
    with uow:
        if uow.session.execute(
            select(MetricTerm.id).where(MetricTerm.metric_code == payload.metric_code)
        ).scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail="Metric already exists")
        term = MetricTerm(
            metric_code=payload.metric_code,
            metric_name=payload.metric_name,
            metric_explanation=payload.metric_explanation,
            description=payload.description,
            unit=payload.unit,
            enabled=payload.enabled,
        )
        uow.session.add(term)
        for value in synonyms:
            uow.session.add(MetricSynonym(metric_code=payload.metric_code, synonym=value))
        uow.commit()
        uow.session.refresh(term)
        return _metric_response(term, synonyms)


@router.put("/metrics/{metric_code}")
def update_metric(
    metric_code: str,
    payload: MetricPayload,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_system_admin(actor)
    synonyms = _normalized_synonyms(payload.synonyms)
    with uow:
        term = uow.session.execute(
            select(MetricTerm).where(MetricTerm.metric_code == metric_code)
        ).scalar_one_or_none()
        if term is None:
            raise HTTPException(status_code=404, detail="Metric not found")
        term.metric_name = payload.metric_name
        term.metric_explanation = payload.metric_explanation
        term.description = payload.description
        term.unit = payload.unit
        term.enabled = payload.enabled
        uow.session.execute(delete(MetricSynonym).where(MetricSynonym.metric_code == metric_code))
        for value in synonyms:
            uow.session.add(MetricSynonym(metric_code=metric_code, synonym=value))
        uow.commit()
        uow.session.refresh(term)
        return _metric_response(term, synonyms)


@router.delete("/metrics/{metric_code}", status_code=status.HTTP_204_NO_CONTENT)
def delete_metric(
    metric_code: str,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> None:
    _require_system_admin(actor)
    with uow:
        term = uow.session.execute(
            select(MetricTerm).where(MetricTerm.metric_code == metric_code)
        ).scalar_one_or_none()
        if term is None:
            raise HTTPException(status_code=404, detail="Metric not found")
        term.enabled = False
        uow.commit()


@router.get("/organizations", response_model=MetricCatalogResponse)
def list_organizations(
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
) -> MetricCatalogResponse:
    with uow:
        organizations = list(
            uow.session.execute(select(OrgTerm).order_by(OrgTerm.org_code)).scalars()
        )
    return MetricCatalogResponse(
        items=[
            {
                "org_code": item.org_code,
                "org_name": item.org_name,
                "aliases": item.aliases or [],
                "enabled": item.enabled,
                "created_at": item.created_at,
                "updated_at": item.updated_at,
            }
            for item in organizations
        ]
    )


def _organization_response(term: OrgTerm) -> dict[str, object]:
    return {
        "org_code": term.org_code,
        "org_name": term.org_name,
        "aliases": term.aliases or [],
        "enabled": term.enabled,
        "created_at": term.created_at,
        "updated_at": term.updated_at,
    }


@router.post("/organizations", status_code=status.HTTP_201_CREATED)
def create_organization(
    payload: OrganizationPayload,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_system_admin(actor)
    with uow:
        existing = uow.session.execute(
            select(OrgTerm.id).where(OrgTerm.org_code == payload.org_code)
        ).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail="Organization already exists")
        term = OrgTerm(
            org_code=payload.org_code,
            org_name=payload.org_name,
            aliases=_normalized_aliases(payload.aliases),
            enabled=payload.enabled,
        )
        uow.session.add(term)
        uow.commit()
        uow.session.refresh(term)
        return _organization_response(term)


@router.put("/organizations/{org_code}")
def update_organization(
    org_code: str,
    payload: OrganizationPayload,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_system_admin(actor)
    if payload.org_code != org_code:
        raise HTTPException(status_code=400, detail="Organization code cannot be changed")
    with uow:
        term = uow.session.execute(
            select(OrgTerm).where(OrgTerm.org_code == org_code)
        ).scalar_one_or_none()
        if term is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        term.org_name = payload.org_name
        term.aliases = _normalized_aliases(payload.aliases)
        term.enabled = payload.enabled
        uow.commit()
        uow.session.refresh(term)
        return _organization_response(term)


@router.delete("/organizations/{org_code}", status_code=status.HTTP_204_NO_CONTENT)
def delete_organization(
    org_code: str,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> None:
    _require_system_admin(actor)
    with uow:
        term = uow.session.execute(
            select(OrgTerm).where(OrgTerm.org_code == org_code)
        ).scalar_one_or_none()
        if term is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        term.enabled = False
        uow.commit()


@router.get("/datasets", response_model=MetricCatalogResponse)
def list_datasets(
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
) -> MetricCatalogResponse:
    with uow:
        rows = list(uow.session.execute(select(Dataset).order_by(Dataset.id)).scalars())
    return MetricCatalogResponse(
        items=[_dataset_response(item) for item in rows]
    )


def _dataset_response(dataset: Dataset) -> dict[str, object]:
    return {
        "id": dataset.id,
        "name": dataset.name,
        "datasource_type": dataset.datasource_type,
        "schema_name": dataset.schema_name,
        "table_name": dataset.table_name,
        "dialect": dataset.dialect,
        "enabled": dataset.enabled,
    }


@router.post("/datasets", status_code=status.HTTP_201_CREATED)
def create_dataset(
    payload: DatasetPayload,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_system_admin(actor)
    with uow:
        existing = uow.session.execute(
            select(Dataset.id).where(Dataset.name == payload.name)
        ).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail="Dataset already exists")
        dataset = Dataset(**payload.model_dump())
        uow.session.add(dataset)
        uow.commit()
        uow.session.refresh(dataset)
        return _dataset_response(dataset)


@router.put("/datasets/{dataset_id}")
def update_dataset(
    dataset_id: int,
    payload: DatasetPayload,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_system_admin(actor)
    with uow:
        dataset = uow.session.execute(
            select(Dataset).where(Dataset.id == dataset_id)
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="Dataset not found")
        duplicate = uow.session.execute(
            select(Dataset.id).where(
                Dataset.name == payload.name,
                Dataset.id != dataset_id,
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            raise HTTPException(status_code=409, detail="Dataset already exists")
        for field, value in payload.model_dump().items():
            setattr(dataset, field, value)
        uow.commit()
        uow.session.refresh(dataset)
        return _dataset_response(dataset)


@router.delete("/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(
    dataset_id: int,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> None:
    _require_system_admin(actor)
    with uow:
        dataset = uow.session.execute(
            select(Dataset).where(Dataset.id == dataset_id)
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="Dataset not found")
        dataset.enabled = False
        uow.commit()


class QueryRunPageResponse(MetricCatalogResponse):
    total: int
    page: int
    page_size: int


def _visible_log_tasks(actor: ActorContext):
    """列表、总数和详情仅限本人；管理员与同机构账号也不能跨账号读取。"""
    if not actor.user_id:
        raise HTTPException(status_code=403, detail="当前身份缺少账号标识，无法查看问数日志")
    return select(QueryTask.id).join(
        ChatConversation, ChatConversation.id == QueryTask.conversation_id
    ).where(ChatConversation.owner_user_id == actor.user_id)


def _latest_log_run_id(task_id):
    return (
        select(QueryRun.id)
        .where(QueryRun.task_id == task_id)
        .order_by(QueryRun.created_at.desc(), QueryRun.id.desc())
        .limit(1)
    )


@router.get("/query-runs", response_model=QueryRunPageResponse)
def list_query_runs(
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 10,
) -> QueryRunPageResponse:
    visible = _visible_log_tasks(actor)
    with uow:
        total = uow.session.execute(
            select(func.count()).select_from(visible.subquery())
        ).scalar_one()
        page = min(page, max(1, (total + page_size - 1) // page_size))
        # 排序只携带 ID 和时间，避免 JSON 状态及结果进入数据库排序缓冲区。
        ids = list(uow.session.execute(
            visible.order_by(QueryTask.created_at.desc(), QueryTask.id.desc())
            .offset((page - 1) * page_size).limit(page_size)
        ).scalars())
        rows = []
        if ids:
            tasks = list(uow.session.execute(
                select(QueryTask).where(QueryTask.id.in_(ids)).options(load_only(
                    QueryTask.id, QueryTask.conversation_id, QueryTask.original_question,
                    QueryTask.intent, QueryTask.query_shape, QueryTask.status,
                    QueryTask.current_stage, QueryTask.error_code, QueryTask.error_message,
                    QueryTask.created_at, raiseload=True,
                ))
            ).scalars())
            tasks_by_id = {task.id: task for task in tasks}
            # 相关子查询只定位最新 ID；批量读取本页摘要，避免逐条往返数据库。
            latest = _latest_log_run_id(QueryTask.id).correlate(QueryTask).scalar_subquery()
            run_ids = dict(uow.session.execute(
                select(QueryTask.id, latest).select_from(QueryTask).where(QueryTask.id.in_(ids))
            ).all())
            runs = list(uow.session.execute(
                select(QueryRun).where(QueryRun.id.in_(
                    [run_id for run_id in run_ids.values() if run_id is not None]
                )).options(load_only(
                    QueryRun.id, QueryRun.intent, QueryRun.query_shape,
                    QueryRun.raw_org_text, QueryRun.matched_text,
                    QueryRun.matched_org_name, QueryRun.org_match_type,
                    QueryRun.status, QueryRun.failed_node, QueryRun.error_type,
                    QueryRun.error_message, QueryRun.retry_count, raiseload=True,
                ))
            ).scalars())
            runs_by_id = {run.id: run for run in runs}
            rows = [
                (tasks_by_id[task_id], runs_by_id.get(run_ids.get(task_id)))
                for task_id in ids if task_id in tasks_by_id
            ]
    return QueryRunPageResponse(
        total=total, page=page, page_size=page_size,
        items=[
            {
                "id": run.id if run is not None else task.id,
                "task_id": task.id,
                "conversation_id": task.conversation_id,
                "user_message": task.original_question,
                "intent": task.intent or (run.intent if run is not None else "pending"),
                "query_shape": task.query_shape or (run.query_shape if run is not None else None),
                "raw_org_text": run.raw_org_text if run is not None else None,
                "matched_text": run.matched_text if run is not None else None,
                "matched_org_name": run.matched_org_name if run is not None else None,
                "org_match_type": run.org_match_type if run is not None else None,
                "status": _task_log_status(task, run),
                "task_status": task.status,
                "current_stage": task.current_stage,
                "failed_node": run.failed_node if run is not None else None,
                "error_type": run.error_type if run is not None else None,
                "error_message": task.error_message
                or (run.error_message if run is not None else None),
                "error_code": task.error_code,
                "retry_count": run.retry_count if run is not None else 0,
                "created_at": task.created_at,
            }
            for task, run in rows
        ]
    )


@router.get("/query-runs/{task_id}/organizations")
def get_query_run_organizations(
    task_id: str,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    with uow:
        visible_id = uow.session.execute(
            _visible_log_tasks(actor).where(QueryTask.id == task_id)
        ).scalar_one_or_none()
        if visible_id is None:
            raise HTTPException(status_code=404, detail="Query task log was not found")
        state = uow.session.execute(
            select(QueryTask.state_json).where(QueryTask.id == visible_id)
        ).scalar_one() or {}
        run_id = uow.session.execute(_latest_log_run_id(task_id)).scalar_one_or_none()
        run = None
        if run_id is not None:
            run = uow.session.execute(
                select(QueryRun).where(QueryRun.id == run_id).options(load_only(
                    QueryRun.id, QueryRun.query_plan, QueryRun.raw_org_text,
                    QueryRun.matched_text, QueryRun.matched_org_name, raiseload=True,
                ))
            ).scalar_one()
        plan = (run.query_plan or {}) if run is not None else {}
        audit = plan.get("organization_audit") or {}
        orgs = (plan.get("dsl") or state.get("logical_dsl") or {}).get("orgs")
        raw = ",".join(orgs) if isinstance(orgs, list) else (
            run.raw_org_text if run is not None else None
        )
        names = audit.get("matched_names")
        # 旧日志从同次执行的结果证据恢复名称，不查询现今目录猜测历史匹配结果。
        artifact = state.get("result_artifact") or {}
        if names is None and run is not None and artifact.get("source_run_id") == run.id:
            rows = (artifact.get("result") or {}).get("rows", [])
            names = list(dict.fromkeys(
                str(row["org_name"]) for row in rows if row.get("org_name") is not None
            ))
        matched = ",".join(names) if isinstance(names, list) else (
            (run.matched_org_name or run.matched_text) if run is not None else None
        )
        incomplete = any(value and value.endswith("...") for value in (raw, matched))
        return {
            "raw_org_text": raw,
            "matched_org_name": matched,
            "notice": "历史记录仅保留了截断摘要，缺失部分无法恢复。" if incomplete else None,
        }


@router.get("/query-runs/{task_id}")
def get_query_run_detail(
    task_id: str,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    with uow:
        visible_id = uow.session.execute(
            _visible_log_tasks(actor).where(QueryTask.id == task_id)
        ).scalar_one_or_none()
        if visible_id is None:
            raise HTTPException(status_code=404, detail="Query task log was not found")
        # 仅用户打开详情时加载状态 JSON；任务主键查询无需对大字段排序。
        task = uow.session.execute(
            select(QueryTask).where(QueryTask.id == visible_id)
        ).scalar_one()
        run_id = uow.session.execute(_latest_log_run_id(task_id)).scalar_one_or_none()
        run = None
        if run_id is not None:
            run = uow.session.execute(
                select(QueryRun).where(QueryRun.id == run_id).options(
                    load_only(QueryRun.id, QueryRun.status, raiseload=True)
                )
            ).scalar_one()
    return {
        "task_id": task.id,
        "user_message": task.original_question,
        "resolved_question": (task.state_json or {}).get("resolved_question"),
        "clarification_answers": (task.state_json or {}).get("clarification_answers", []),
        "status": _task_log_status(task, run),
        "task_status": task.status,
        "current_stage": task.current_stage,
        "timings_ms": (task.state_json or {}).get("timings_ms", {}),
        "trace": ((task.state_json or {}).get("debug") or {}).get("trace", []),
        "debug": (task.state_json or {}).get("debug", {}),
    }


def _task_log_status(task: QueryTask, run: QueryRun | None) -> str:
    if task.status == "SUCCEEDED":
        return "success"
    if task.status == "WAITING_USER":
        return "waiting_user"
    if task.status == "CANCELLED":
        return "cancelled"
    if task.status == "FAILED":
        return "unsupported" if run is not None and run.status == "unsupported" else "failed"
    return "running"
