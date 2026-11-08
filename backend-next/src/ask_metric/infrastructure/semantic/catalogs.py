from __future__ import annotations

from collections import defaultdict
from collections.abc import Collection
from threading import Lock
from typing import Protocol, TypedDict

from sqlalchemy import func, inspect, or_, select
from sqlalchemy.orm import Session, undefer_group
from sqlalchemy.sql.elements import ColumnElement

from ask_metric.application.org_aliases import derive_org_aliases
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.db.models import (
    MetricSynonym,
    MetricTerm,
    OrgTerm,
)


class _MetricSourceFields(TypedDict):
    source_metric_code: str | None
    base_name: str | None
    value_basis: str | None


class MetricCatalogRepository(Protocol):
    def list_enabled(self, *, refresh: bool = False) -> list[MetricCatalogItem]: ...
    def list_enabled_matching(
        self, *, codes: Collection[str], names: Collection[str],
    ) -> list[MetricCatalogItem]: ...
    def list_disabled(self) -> list[MetricCatalogItem]: ...


class OrganizationCatalogRepository(Protocol):
    def list_enabled(self) -> list[OrganizationCatalogItem]: ...


class SqlAlchemyMetricCatalogRepository:
    _cache_lock = Lock()
    _cache_key: tuple | None = None
    _cache_value: list[MetricCatalogItem] = []
    # 已确认具备来源字段的库；迁移只增不减，确认后不再每次请求查询 information_schema。
    _source_structure_binds: set[str] = set()

    def __init__(self, session: Session) -> None:
        self.session = session

    def _has_source_structure(self) -> bool:
        bind_key = str(self.session.get_bind().url)
        with self._cache_lock:
            if bind_key in self._source_structure_binds:
                return True
        # 走当前 Session 的连接：inspect(engine) 会另从连接池取连接，执行链持有任务行锁时
        # 并发请求可能互相等待连接直到超时。
        inspector = inspect(self.session.connection())
        columns = {
            column["name"] for column in inspector.get_columns("metric_terms")
        }
        available = {"source_metric_code", "base_name", "value_basis"} <= columns
        if available:
            with self._cache_lock:
                self._source_structure_binds.add(bind_key)
        return available

    def _table_version(self, model: type) -> tuple[object, int]:
        # 计数与最新更新时间一起作为版本：硬删除不会推进 updated_at。
        return tuple(self.session.execute(
            select(func.max(model.updated_at), func.count()).select_from(model)
        ).one())

    @staticmethod
    def _source_fields(term: MetricTerm, available: bool) -> _MetricSourceFields:
        if not available:
            return {"source_metric_code": None, "base_name": None, "value_basis": None}
        return {"source_metric_code": term.source_metric_code,
                "base_name": term.base_name, "value_basis": term.value_basis}

    def list_disabled(self) -> list[MetricCatalogItem]:
        source_available = self._has_source_structure()
        query = select(MetricTerm).where(MetricTerm.enabled.is_(False))
        if source_available:
            query = query.options(undefer_group("metric_source"))
        return [MetricCatalogItem(code=term.metric_code, name=term.metric_name, unit=None,
                                  value_policy="source_raw_v1",
                                  **self._source_fields(term, source_available))
                for term in self.session.execute(query).scalars()]

    def list_enabled(self, *, refresh: bool = False) -> list[MetricCatalogItem]:
        source_available = self._has_source_structure()
        cache_key = (
            str(self.session.get_bind().url), self._table_version(MetricTerm),
            self._table_version(MetricSynonym), source_available,
        )
        with self._cache_lock:
            if not refresh and self._cache_key == cache_key:
                return list(self._cache_value)
        result = self._read_enabled(source_available)
        with self._cache_lock:
            self.__class__._cache_key = cache_key
            self.__class__._cache_value = result
        return list(result)

    def list_enabled_matching(
        self, *, codes: Collection[str], names: Collection[str],
    ) -> list[MetricCatalogItem]:
        """实时读取完整匹配候选；同名竞争者留给业务层判定，不复用或改写全量缓存。"""
        codes, names = sorted(set(codes)), sorted(set(names))
        if not codes and not names:
            return []
        matches = []
        if codes:
            matches.append(MetricTerm.metric_code.in_(codes))
        if names:
            matching_aliases = select(MetricSynonym.metric_code).where(
                MetricSynonym.enabled.is_(True), MetricSynonym.synonym.in_(names),
            )
            matches.extend([
                MetricTerm.metric_name.in_(names), MetricTerm.metric_code.in_(matching_aliases),
            ])
        return self._read_enabled(self._has_source_structure(), matching=or_(*matches))

    def _read_enabled(
        self, source_available: bool, *, matching: ColumnElement[bool] | None = None,
    ) -> list[MetricCatalogItem]:
        # 正文预览需要实时复核目录，但无需逐行加载时间戳等管理字段及完整 ORM 实体。
        columns = [
            MetricTerm.metric_code, MetricTerm.metric_name, MetricTerm.description,
            MetricTerm.unit, MetricTerm.metric_explanation,
        ]
        if source_available:
            columns.extend([
                MetricTerm.source_metric_code, MetricTerm.base_name, MetricTerm.value_basis,
            ])
        query = (select(*columns).where(MetricTerm.enabled.is_(True))
                 .order_by(MetricTerm.metric_code))
        if matching is not None:
            query = query.where(matching)
        terms = self.session.execute(query).mappings().all()
        if not terms:
            return []
        synonym_query = select(MetricSynonym.metric_code, MetricSynonym.synonym).where(
            MetricSynonym.enabled.is_(True),
        ).order_by(
            MetricSynonym.metric_code, MetricSynonym.weight.desc(), MetricSynonym.synonym,
        )
        if matching is not None:
            synonym_query = synonym_query.where(
                MetricSynonym.metric_code.in_([term["metric_code"] for term in terms]),
            )
        synonyms = self.session.execute(synonym_query)
        aliases: dict[str, list[str]] = defaultdict(list)
        for synonym in synonyms:
            if synonym.synonym not in aliases[synonym.metric_code]:
                aliases[synonym.metric_code].append(synonym.synonym)
        return [
            MetricCatalogItem(
                code=term["metric_code"],
                name=term["metric_name"],
                source_metric_code=term.get("source_metric_code"),
                base_name=term.get("base_name"),
                value_basis=term.get("value_basis"),
                aliases=aliases[term["metric_code"]],
                description=term["description"],
                unit=None,
                value_policy="source_raw_v1",
                explanation=term["metric_explanation"],
            )
            for term in terms
        ]


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
                # 运行时即时派生：上线后不等重新同步即生效；
                # 库中人工别名在前，派生别名只补充不覆盖。
                aliases=list(dict.fromkeys([
                    *(row.aliases or []), *derive_org_aliases(row.org_name),
                ])),
            )
            for row in rows
        ]
