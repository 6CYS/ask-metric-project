from __future__ import annotations

from collections import defaultdict
from threading import Lock
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.db.models import (
    MetricSynonym,
    MetricTerm,
    OrgTerm,
)


class MetricCatalogRepository(Protocol):
    def list_enabled(self) -> list[MetricCatalogItem]: ...


class OrganizationCatalogRepository(Protocol):
    def list_enabled(self) -> list[OrganizationCatalogItem]: ...


class SqlAlchemyMetricCatalogRepository:
    _cache_lock = Lock()
    _cache_key: tuple[str, object, object] | None = None
    _cache_value: list[MetricCatalogItem] = []

    def __init__(self, session: Session) -> None:
        self.session = session

    def list_enabled(self) -> list[MetricCatalogItem]:
        term_version = self.session.execute(
            select(func.max(MetricTerm.updated_at))
        ).scalar_one_or_none()
        synonym_version = self.session.execute(
            select(func.max(MetricSynonym.updated_at))
        ).scalar_one_or_none()
        cache_key = (str(self.session.get_bind().url), term_version, synonym_version)
        with self._cache_lock:
            if self._cache_key == cache_key:
                return list(self._cache_value)
        terms = list(
            self.session.execute(
                select(MetricTerm)
                .where(MetricTerm.enabled.is_(True))
                .order_by(MetricTerm.metric_code)
            ).scalars()
        )
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
