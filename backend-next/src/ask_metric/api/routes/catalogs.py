from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ask_metric.api.dependencies import get_model_service, require_actor
from ask_metric.application.catalog_search import (
    CatalogSearchHit,
    metric_embedding_scores,
    rank_organizations,
)
from ask_metric.application.catalog_search import (
    search_metrics as rank_metric_catalog,
)
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import PROJECT_DIR
from ask_metric.infrastructure.db.models import (
    AppUser,
    ChatConversation,
    Dataset,
    MetricSynonym,
    MetricTerm,
    OrgTerm,
    QueryRun,
    QueryTask,
)
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.model.configuration import resolve_config_path
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

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


def _metric_hit_payload(hit: CatalogSearchHit) -> dict[str, object]:
    return {
        "metric_code": hit.code,
        "metric_name": hit.name,
        "unit": hit.unit,
        "synonyms": hit.aliases,
        "score": round(hit.score, 6),
        "match_type": hit.match_type,
    }


def _org_hit_payload(hit: CatalogSearchHit) -> dict[str, object]:
    return {
        "org_code": hit.code,
        "org_name": hit.name,
        "aliases": hit.aliases,
        "score": round(hit.score, 6),
        "match_type": hit.match_type,
    }


@router.get("/metrics/search")
def search_metric_catalog(
    request: Request,
    keyword: Annotated[str, Query(min_length=1, max_length=200)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> dict[str, object]:
    """指标目录检索：确定性命中计入 total，embedding top-k 只作语义近似推荐。

    目录与语义链路召回语料同源（启用指标），模型与向量缓存复用进程级装配；
    embedding 未启用时降级为纯词法结果。
    """
    settings = request.app.state.settings
    matching = SemanticConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.semantic_config_path)
    ).load().metric_matching
    with uow:
        items = uow.metric_catalog.list_enabled()
    model_service = get_model_service(request)
    embedding_scores = metric_embedding_scores(
        keyword,
        items,
        model_service=model_service,
        catalog_vector_cache=request.app.state.catalog_vector_cache,
        is_embedding_enabled=model_service.is_enabled("embedding"),
        embedding_top_k=matching.embedding_top_k,
        batch_size=matching.embedding_batch_size,
        wait_seconds=matching.embedding_cache_wait_seconds,
    )
    result = rank_metric_catalog(
        keyword, items, embedding_scores=embedding_scores, limit=limit
    )
    return {
        "total": result.total,
        "items": [_metric_hit_payload(hit) for hit in result.items],
        "semantic_suggestions": [
            _metric_hit_payload(hit) for hit in result.semantic_suggestions
        ],
    }


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


@router.get("/organizations/search")
def search_organization_catalog(
    keyword: Annotated[str, Query(min_length=1, max_length=200)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> dict[str, object]:
    """机构目录检索：只做确定性档位（exact/前缀/包含），不模糊匹配。

    编码确认要求精确性，无确定性命中时返回空，由调用方走语义链路兜底。
    """
    with uow:
        items = uow.organization_catalog.list_enabled()
    result = rank_organizations(keyword, items, limit=limit)
    return {
        "total": result.total,
        "items": [_org_hit_payload(hit) for hit in result.items],
    }


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


@router.get("/query-runs", response_model=MetricCatalogResponse)
def list_query_runs(
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> MetricCatalogResponse:
    latest_run_id = (
        select(QueryRun.id)
        .where(QueryRun.task_id == QueryTask.id)
        .order_by(QueryRun.created_at.desc(), QueryRun.id.desc())
        .limit(1)
        .correlate(QueryTask)
        .scalar_subquery()
    )
    statement = (
        select(QueryTask, QueryRun)
        .join(ChatConversation, ChatConversation.id == QueryTask.conversation_id)
        .outerjoin(QueryRun, QueryRun.id == latest_run_id)
    )
    if actor.role_code != "SYSTEM_ADMIN":
        statement = (
            statement.join(AppUser, AppUser.id == ChatConversation.owner_user_id)
            .where(AppUser.org_code == actor.org_id)
        )
    statement = statement.order_by(QueryTask.created_at.desc()).limit(500)
    with uow:
        rows = list(uow.session.execute(statement).all())
    return MetricCatalogResponse(
        items=[
            {
                "id": run.id if run is not None else task.id,
                "task_id": task.id,
                "conversation_id": task.conversation_id,
                "user_message": task.original_question,
                "resolved_question": (task.state_json or {}).get("resolved_question"),
                "clarification_answers": (task.state_json or {}).get("clarification_answers", []),
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
                "error_code": task.error_code or _run_error_code(run),
                "retry_count": run.retry_count if run is not None else 0,
                "created_at": task.created_at,
                "trace": ((task.state_json or {}).get("debug") or {}).get("trace", []),
                "timings_ms": (task.state_json or {}).get("timings_ms", {}),
            }
            for task, run in rows
        ]
    )


@router.get("/query-runs/{task_id}")
def get_query_run_detail(
    task_id: str,
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    statement = (
        select(QueryTask, QueryRun)
        .join(ChatConversation, ChatConversation.id == QueryTask.conversation_id)
        .outerjoin(QueryRun, QueryRun.task_id == QueryTask.id)
        .where(QueryTask.id == task_id)
        .order_by(QueryRun.created_at.desc(), QueryRun.id.desc())
        .limit(1)
    )
    if actor.role_code != "SYSTEM_ADMIN":
        statement = statement.join(
            AppUser, AppUser.id == ChatConversation.owner_user_id
        ).where(AppUser.org_code == actor.org_id)
    with uow:
        row = uow.session.execute(statement).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Query task log was not found")
    task, run = row
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


def _run_error_code(run: QueryRun | None) -> str | None:
    if run is None:
        return None
    return ((run.query_plan or {}).get("error") or {}).get("code")


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
