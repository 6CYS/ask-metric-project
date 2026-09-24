from __future__ import annotations

from collections import defaultdict
from threading import Lock
from typing import Protocol

from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session, undefer_group

from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.db.models import (
    MetricSynonym,
    MetricTerm,
    OrgTerm,
)


class MetricCatalogRepository(Protocol):
    def list_enabled(self) -> list[MetricCatalogItem]: ...
    def list_disabled(self) -> list[MetricCatalogItem]: ...


class OrganizationCatalogRepository(Protocol):
    def list_enabled(self) -> list[OrganizationCatalogItem]: ...


class SqlAlchemyMetricCatalogRepository:
    _cache_lock = Lock()
    _cache_key: tuple[str, object, object, bool] | None = None
    _cache_value: list[MetricCatalogItem] = []

    def __init__(self, session: Session) -> None:
        self.session = session

    def _has_source_structure(self) -> bool:
        inspector = inspect(self.session.get_bind())
        columns = {
            column["name"] for column in inspector.get_columns("metric_terms")
        }
        return {"source_metric_code", "base_name", "value_basis"} <= columns

    @staticmethod
    def _source_fields(term: MetricTerm, available: bool) -> dict[str, str | None]:
        if not available:
            return {"source_metric_code": None, "base_name": None, "value_basis": None}
        return {"source_metric_code": term.source_metric_code,
                "base_name": term.base_name, "value_basis": term.value_basis}

    def list_disabled(self) -> list[MetricCatalogItem]:
        source_available = self._has_source_structure()
        query = select(MetricTerm).where(MetricTerm.enabled.is_(False))
        if source_available:
            query = query.options(undefer_group("metric_source"))
        return [MetricCatalogItem(code=term.metric_code, name=term.metric_name, unit=term.unit,
                                  **self._source_fields(term, source_available))
                for term in self.session.execute(query).scalars()]

    def list_enabled(self) -> list[MetricCatalogItem]:
        source_available = self._has_source_structure()
        term_version = self.session.execute(
            select(func.max(MetricTerm.updated_at))
        ).scalar_one_or_none()
        synonym_version = self.session.execute(
            select(func.max(MetricSynonym.updated_at))
        ).scalar_one_or_none()
        cache_key = (
            str(self.session.get_bind().url), term_version, synonym_version, source_available
        )
        with self._cache_lock:
            if self._cache_key == cache_key:
                return list(self._cache_value)
        query = (
            select(MetricTerm).where(MetricTerm.enabled.is_(True))
            .order_by(MetricTerm.metric_code)
        )
        if source_available:
            query = query.options(undefer_group("metric_source"))
        terms = list(self.session.execute(query).scalars())
        synonyms = list(
            self.session.execute(
                select(MetricSynonym)
                .where(MetricSynonym.enabled.is_(True))
                .order_by(
                    MetricSynonym.metric_code,
                    MetricSynonym.weight.desc(),
                    MetricSynonym.synonym,
                )
            ).scalars()
        )
        aliases: dict[str, list[str]] = defaultdict(list)
        for synonym in synonyms:
            if synonym.synonym not in aliases[synonym.metric_code]:
                aliases[synonym.metric_code].append(synonym.synonym)
        result = [
            MetricCatalogItem(
                code=term.metric_code,
                name=term.metric_name,
                **self._source_fields(term, source_available),
                aliases=aliases[term.metric_code],
                description=term.description,
                unit=term.unit,
                explanation=term.metric_explanation,
            )
            for term in terms
        ]
        with self._cache_lock:
            self.__class__._cache_key = cache_key
            self.__class__._cache_value = result
        return list(result)


class SqlAlchemyOrganizationCatalogRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def list_enabled(self) -> list[OrganizationCatalogItem]:
        rows = self.session.execute(
            select(OrgTerm).where(OrgTerm.enabled.is_(True)).order_by(OrgTerm.org_code)
        ).scalars()
        return [
            OrganizationCatalogItem(
                code=row.org_code,
                name=row.org_name,
                aliases=list(dict.fromkeys(row.aliases or [])),
            )
            for row in rows
        ]
