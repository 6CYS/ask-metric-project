"""管理员维护指标关系，普通问数仍从现有语义配置读取。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from ask_metric.api.dependencies import require_actor
from ask_metric.application.metric_relationships import (
    CONFIG_DIR,
    MetricRelationshipStore,
    Revision,
)
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import PROJECT_DIR
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.metric_relationships import MetricRelationFields
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.model.configuration import resolve_config_path


def require_relationship_admin(actor: Annotated[ActorContext, Depends(require_actor)]) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise ApplicationError(
            "METRIC_RELATION_FORBIDDEN", "需要系统管理员权限。", status_code=403,
        )


router = APIRouter(
    prefix="/api/v1/catalog/metric-relationships", tags=["metric-relationships"],
    dependencies=[Depends(require_relationship_admin)],
)


class RelationshipWrite(MetricRelationFields):
    revision: Revision


def relationship_store(request: Request) -> MetricRelationshipStore:
    return MetricRelationshipStore(
        resolve_config_path(PROJECT_DIR, request.app.state.settings.analysis_semantics_path),
        CONFIG_DIR / "business-topics.json",
    )


def relationship_catalog() -> list[MetricCatalogItem]:
    with SqlAlchemyUnitOfWork() as uow:
        return uow.metric_catalog.list_enabled(refresh=True)


Store = Annotated[MetricRelationshipStore, Depends(relationship_store)]
Catalog = Annotated[list[MetricCatalogItem], Depends(relationship_catalog)]


@router.get("")
def list_relationships(store: Store, catalog: Catalog) -> dict:
    return store.read(catalog)


@router.post("", status_code=201)
def create_relationship(payload: RelationshipWrite, store: Store, catalog: Catalog) -> dict:
    fields = MetricRelationFields.model_validate(payload.model_dump(exclude={"revision"}))
    return store.create(fields, payload.revision, catalog)


@router.put("/{relation_id}")
def update_relationship(
    relation_id: str, payload: RelationshipWrite, store: Store, catalog: Catalog,
) -> dict:
    fields = MetricRelationFields.model_validate(payload.model_dump(exclude={"revision"}))
    return store.update(relation_id, fields, payload.revision, catalog)


@router.delete("/{relation_id}")
def delete_relationship(
    relation_id: str, store: Store, catalog: Catalog,
    revision: Annotated[str, Query(pattern=r"^[a-f0-9]{64}$")],
) -> dict:
    return store.delete(relation_id, revision, catalog)
