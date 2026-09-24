from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
)
from ask_metric.infrastructure.db.models import (
    AppUser,
    MetricSynonym,
    MetricTerm,
    MetricValue,
    OrgTerm,
)
from ask_metric.infrastructure.query.inceptor import InceptorDataSourceAdapter


@dataclass
class SyncSummary:
    source_rows: int = 0
    selected_rows: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    errors: int = 0
    disabled: int = 0
    dry_run: bool = False
    selected_codes: set[str] = field(default_factory=set, repr=False)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result.pop("selected_codes", None)
        return result


@dataclass
class CatalogCleanupSummary:
    metric_values_deleted: int = 0
    metric_terms_deleted: int = 0
    metric_synonyms_deleted: int = 0
    org_terms_deleted: int = 0
    users_reassigned: int = 0
    retained_metric_terms: int = 0
    retained_org_terms: int = 0
    fallback_org_code: str = ""
    dry_run: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class OrganizationScopeError(ValueError):
    def __init__(self, codes: list[str]):
        self.codes = codes
        super().__init__("应用库存在本次61家范围外的启用机构，须先核对编码及引用")


class SitCatalogSyncService:
    def __init__(self, app_sessions: sessionmaker[Session]) -> None:
        self.app_sessions = app_sessions

    def sync_metrics(
        self,
        *,
        source_engine: Engine,
        config_table: str,
        fact_table: str,
        dry_run: bool = False,
        full: bool = False,
        all_snapshots: bool = False,
        units_by_name: dict[str, str] | None = None,
        infer_units: bool = False,
        active_order: str = "eff_dt,indcr_ver_no,btch_seq_no",
        fact_snapshot_field: str = "etl_date",
        fact_metric_code_field: str = "indcr_no",
        fact_source_metric_code_field: str = "orig_indcr_no",
        fact_value_basis_field: str = "indcr_nm",
        config_code_field: str = "indcr_no",
        config_name_field: str = "indcr_nm",
        config_effective_date_field: str = "eff_dt",
        config_version_field: str = "indcr_ver_no",
        config_batch_field: str = "btch_seq_no",
    ) -> SyncSummary:
        _validate_table_name(config_table)
        _validate_table_name(fact_table)
        _validate_field_name(fact_snapshot_field)
        for source_field in (
            fact_metric_code_field,
            fact_source_metric_code_field,
            fact_value_basis_field,
            config_code_field,
            config_name_field,
            config_effective_date_field,
            config_version_field,
            config_batch_field,
        ):
            _validate_field_name(source_field)
        columns = [part.strip() for part in active_order.split(",") if part.strip()]
        allowed = {"eff_dt", "indcr_ver_no", "btch_seq_no"}
        if not columns or any(item not in allowed for item in columns):
            raise ValueError("SIT_METRIC_ACTIVE_ORDER contains an unsupported field")
        config_rows = _read_rows(
            source_engine,
            f"SELECT {config_code_field} AS indcr_no, "
            f"{config_name_field} AS indcr_nm, "
            f"{config_effective_date_field} AS eff_dt, "
            f"{config_version_field} AS indcr_ver_no, "
            f"{config_batch_field} AS btch_seq_no "
            f"FROM {config_table}",
        )
        configs, skipped = _select_latest(
            config_rows, "indcr_no", columns, effective_field="eff_dt"
        )
        # 部署初始化可以读取全部历史编码；既有调用默认仍使用最新快照。
        snapshot_condition = (
            "" if all_snapshots else
            f" WHERE {fact_snapshot_field} = "
            f"(SELECT MAX({fact_snapshot_field}) FROM {fact_table})"
        )
        fact_rows = _read_rows(
            source_engine,
            f"SELECT DISTINCT {fact_metric_code_field} AS indcr_no, "
            f"{fact_source_metric_code_field} AS orig_indcr_no, "
            f"{fact_value_basis_field} AS indcr_nm "
            f"FROM {fact_table}{snapshot_condition}",
        )
        selected, catalog_skipped, catalog_errors = _build_metric_catalog(fact_rows, configs)
        # 单位必须来自已确认映射；校验完整后再打开应用库写入事务。
        if units_by_name is not None or infer_units:
            from ask_metric.application.metric_units import MetricUnitError, infer_metric_unit

            units_by_name = {} if units_by_name is None else units_by_name.copy()
            if not isinstance(units_by_name, dict):
                raise ValueError("单位映射必须是名称到单位的 JSON 对象")
            selected_names = {row["metric_name"] for row in selected.values()}
            if infer_units:
                for name in selected_names:
                    if not units_by_name.get(name):
                        units_by_name[name] = infer_metric_unit(name)
            missing = {name for name in selected_names if not units_by_name.get(name)}
            if missing:
                raise MetricUnitError(sorted(missing))
            if any(not isinstance(v, str) or not v.strip() or len(v) > 64
                   for v in (units_by_name[name] for name in selected_names)):
                raise ValueError("单位必须为 1 至 64 字符的非空文本")
        if catalog_errors:
            raise ValueError(
                f"指标目录存在 {catalog_errors} 条同编码名称冲突，未写入应用库；"
                "请核对源配置和事实表"
            )
        summary = SyncSummary(
            source_rows=len(fact_rows),
            selected_rows=len(selected),
            skipped=skipped + catalog_skipped,
            errors=catalog_errors,
            dry_run=dry_run,
            selected_codes=set(selected),
        )
        with self.app_sessions() as session:
            existing = {
                row.metric_code: row for row in session.execute(select(MetricTerm)).scalars()
            }
            for code, row in selected.items():
                name = str(row.get("metric_name") or "").strip()
                if not code or not name:
                    summary.skipped += 1
                    continue
                term = existing.get(code)
                created = term is None
                if created:
                    term = MetricTerm(
                        metric_code=code, metric_name=name, description="", metric_explanation=""
                    )
                    session.add(term)
                before = _metric_state(term)
                term.metric_name = name
                # 源字段给出了正式基础指标与取值口径；保留原值供问句省略项核验。
                term.source_metric_code = row["source_metric_code"]
                term.base_name = row["base_name"]
                term.value_basis = row["value_basis"]
                term.enabled = True
                if units_by_name is not None:
                    term.unit = units_by_name[name]
                after = _metric_state(term)
                if created:
                    summary.created += 1
                elif before != after:
                    summary.updated += 1
                else:
                    summary.unchanged += 1
            # Without adding source-marker columns to the existing application
            # schema, a recurring sync cannot safely distinguish lake rows from
            # manually maintained rows.  It is intentionally upsert-only.
            if dry_run:
                session.rollback()
            else:
                session.commit()
        return summary

    def sync_organizations(
        self,
        *,
        source_engine: Engine,
        source_table: str,
        dry_run: bool = False,
        full: bool = False,
        snapshot_field: str = "data_dt",
        org_code_field: str = "org_no",
        org_name_field: str = "org_chn_nm",
        corporation_code_field: str = "corpt_no",
        hierarchy_field: str = "org_hier_code",
        corporation_code_max: str = "134",
        excluded_corporation_code: str = "086",
        head_office_corporation_code: str = "000",
        legal_entity_hier_code: str = "3",
        head_office_hier_code: str = "1",
        expected_count: int = 61,
        snapshot_date: date | None = None,
        aliases_by_code: dict[str, list[str]] | None = None,
        strict_scope: bool = False,
        include_branch_level: bool = False,
        branch_hier_code: str = "2",
        parent_field: str = "",
    ) -> SyncSummary:
        _validate_table_name(source_table)
        _validate_field_name(snapshot_field)
        for source_field in (
            org_code_field,
            org_name_field,
            corporation_code_field,
            hierarchy_field,
        ):
            _validate_field_name(source_field)
        if include_branch_level:
            # 支行层级扩展：上级字段名来自配置（由 verify_org_hierarchy.py 核实），
            # 未配置时拒绝扩展，避免静默写入空层级。
            # 层级编码是绑定参数值，不是 SQL 列名（正式默认值为数字 "2"）。
            if not branch_hier_code.strip() or len(branch_hier_code) > 8:
                raise ValueError("支行层级编码为空或超长")
            if not parent_field:
                raise ValueError("启用支行层级扩展必须配置 SIT_ORG_PARENT_FIELD")
            _validate_field_name(parent_field)
        # 层级元数据始终读取；支行开关只控制目录范围及是否需要源上级字段。
        extra_columns = f", {hierarchy_field} AS org_hier_code"
        if include_branch_level:
            extra_columns += f", {parent_field} AS parent_org_no"
        branch_condition = (
            f" OR {hierarchy_field} = :branch_hier_code" if include_branch_level else ""
        )
        rows = _read_rows(
            source_engine,
            f"SELECT {org_code_field} AS org_no, "
            f"{org_name_field} AS org_chn_nm, "
            f"{snapshot_field} AS source_load_date{extra_columns} FROM {source_table} "
            f"WHERE {snapshot_field} = "
            + (":snapshot_date " if snapshot_date else
               f"(SELECT MAX({snapshot_field}) FROM {source_table}) ")
            +
            f"AND {corporation_code_field} <= :corporation_code_max "
            f"AND {corporation_code_field} <> :excluded_corporation_code "
            f"AND (({hierarchy_field} = :legal_entity_hier_code "
            f"AND {corporation_code_field} <> :head_office_corporation_code) "
            f"OR {hierarchy_field} = :head_office_hier_code{branch_condition})",
            {
                "snapshot_date": snapshot_date.isoformat() if snapshot_date else None,
                "corporation_code_max": corporation_code_max,
                "excluded_corporation_code": excluded_corporation_code,
                "head_office_corporation_code": head_office_corporation_code,
                "legal_entity_hier_code": legal_entity_hier_code,
                "head_office_hier_code": head_office_hier_code,
                "branch_hier_code": branch_hier_code,
            },
        )
        selected, skipped = _select_latest(rows, "org_no", ["source_load_date"])
        # 同一快照必须能唯一确定名称；不截断超过应用字段长度的源名称。
        seen_names: dict[str, str] = {}
        seen_hierarchy: dict[str, tuple[str, str]] = {}
        for row in rows:
            code = str(row.get("org_no") or "").strip()
            name = str(row.get("org_chn_nm") or "").strip()
            if not code or len(code) > 128 or not name or len(name) > 255:
                raise ValueError("机构编码或名称为空/超长，未写入应用库")
            if code in seen_names and seen_names[code] != name:
                raise ValueError("机构同编码出现不同名称，未写入应用库")
            seen_names[code] = name
            level = str(row.get("org_hier_code") or "").strip()
            parent = str(row.get("parent_org_no") or "").strip()
            hierarchy_key = (level, parent)
            if code in seen_hierarchy and seen_hierarchy[code] != hierarchy_key:
                raise ValueError("机构同编码出现冲突层级，未写入应用库")
            if len(parent) > 128 or len(level) > 8:
                raise ValueError("机构层级字段超长，未写入应用库")
            seen_hierarchy[code] = hierarchy_key
        roots = [
            code for code, row in selected.items()
            if str(row.get("org_hier_code") or "").strip() == head_office_hier_code
        ]
        if len(roots) != 1:
            raise ValueError("机构目录必须包含唯一正式省级根机构，未写入应用库")
        root_code = roots[0]
        hierarchy_nodes = []
        for code, row in selected.items():
            level = str(row.get("org_hier_code") or "").strip()
            # 未纳入支行时，源查询仅选正式省级/法人级；唯一省级根是其治理上级。
            # 此关系来自正式层级字段，不根据机构名称或编码形状猜测。
            parent = (
                str(row.get("parent_org_no") or "").strip() or None
                if include_branch_level else None if code == root_code else root_code
            )
            hierarchy_nodes.append(OrganizationHierarchyNode(
                code=code, name=str(row.get("org_chn_nm") or "").strip(),
                parent_code=parent, hierarchy_level=level,
            ))
        snapshot = OrganizationHierarchySnapshot(
            nodes=tuple(hierarchy_nodes), root_level=head_office_hier_code,
            cohort_level=legal_entity_hier_code,
        )
        # 整批先验证再打开写事务；dry-run 执行同样校验，不发布半同步层级。
        snapshot.validated_root()
        hierarchy_by_code = {node.code: node for node in snapshot.nodes}
        additions = aliases_by_code if aliases_by_code is not None else {}
        if not isinstance(additions, dict) or set(additions) - set(selected):
            raise ValueError("机构别名映射含本次范围以外的编码，未写入应用库")
        for aliases in additions.values():
            if not isinstance(aliases, list) or any(
                not isinstance(alias, str) or not alias.strip() or len(alias) > 255
                for alias in aliases
            ):
                raise ValueError("机构别名必须为非空文本列表，每项不超过255字符")
        if include_branch_level:
            # 扩展模式纳入支行，总数随数据湖支行数变化：只要求不少于
            # 现行 1/3 层级范围（expected_count），缺失任一现有机构仍视为异常。
            if len(selected) < expected_count:
                raise RuntimeError(
                    "Organization catalog scope returned "
                    f"{len(selected)} rows; expected at least {expected_count} "
                    "(branch level included). No application catalog data was written."
                )
        elif len(selected) != expected_count:
            raise RuntimeError(
                "Organization catalog scope returned "
                f"{len(selected)} rows; expected {expected_count}. "
                "No application catalog data was written."
            )
        summary = SyncSummary(
            len(rows),
            len(selected),
            skipped=skipped,
            dry_run=dry_run,
            selected_codes=set(selected),
        )
        with self.app_sessions() as session:
            existing = {row.org_code: row for row in session.execute(select(OrgTerm)).scalars()}
            outside = sorted(code for code, term in existing.items()
                             if term.enabled and code not in selected)
            if strict_scope and outside:
                raise OrganizationScopeError(outside)
            for code, row in selected.items():
                name = str(row.get("org_chn_nm") or "").strip()
                if not code or not name:
                    summary.skipped += 1
                    continue
                term = existing.get(code)
                created = term is None
                if created:
                    term = OrgTerm(org_code=code, org_name=name, aliases=[])
                    session.add(term)
                before = _org_state(term)
                term.org_name = name
                # 按机构码追加导出别名，不覆盖目标库已有人工维护的别名。
                term.aliases = list(dict.fromkeys([
                    *(term.aliases or []), *(alias.strip() for alias in additions.get(code, [])),
                ]))
                term.enabled = True
                node = hierarchy_by_code[code]
                term.parent_org_code = node.parent_code
                term.hierarchy_level = node.hierarchy_level
                after = _org_state(term)
                if created:
                    summary.created += 1
                elif before != after:
                    summary.updated += 1
                else:
                    summary.unchanged += 1
            # See metric sync: recurring synchronization is intentionally
            # upsert-only when no schema extension is used.
            if dry_run:
                session.rollback()
            else:
                session.commit()
        return summary

    def cleanup_simulated_catalogs(
        self,
        *,
        retained_metric_codes: set[str],
        retained_org_codes: set[str],
        fallback_org_code: str,
        dry_run: bool = False,
    ) -> CatalogCleanupSummary:
        """Remove external-test catalogs after authoritative lake catalogs exist.

        Users are retained and moved to one explicitly selected synchronized
        organization. Conversations, tasks, permissions, and audit data are not
        touched. Metric synonyms are retained only when their metric code exists in
        the synchronized catalog.
        """

        fallback_org_code = fallback_org_code.strip()
        if not fallback_org_code:
            raise ValueError("A synchronized fallback organization code is required")
        with self.app_sessions() as session:
            metric_terms = list(session.scalars(select(MetricTerm)))
            org_terms = list(session.scalars(select(OrgTerm)))
            if not retained_metric_codes:
                raise RuntimeError("No synchronized data-lake metrics exist; cleanup refused")
            if not retained_org_codes:
                raise RuntimeError("No synchronized data-lake organizations exist; cleanup refused")
            if fallback_org_code not in retained_org_codes:
                raise RuntimeError(
                    "Fallback organization is not in the synchronized data-lake catalog: "
                    + fallback_org_code
                )

            summary = CatalogCleanupSummary(
                retained_metric_terms=len(retained_metric_codes),
                retained_org_terms=len(retained_org_codes),
                fallback_org_code=fallback_org_code,
                dry_run=dry_run,
            )
            for user in session.scalars(select(AppUser)):
                if user.org_code not in retained_org_codes:
                    user.org_code = fallback_org_code
                    summary.users_reassigned += 1
            for value in session.scalars(select(MetricValue)):
                session.delete(value)
                summary.metric_values_deleted += 1
            for synonym in session.scalars(select(MetricSynonym)):
                if synonym.metric_code not in retained_metric_codes:
                    session.delete(synonym)
                    summary.metric_synonyms_deleted += 1
            for term in metric_terms:
                if term.metric_code not in retained_metric_codes:
                    session.delete(term)
                    summary.metric_terms_deleted += 1
            session.flush()
            for term in org_terms:
                if term.org_code not in retained_org_codes:
                    session.delete(term)
                    summary.org_terms_deleted += 1
            if dry_run:
                session.rollback()
            else:
                session.commit()
            return summary


def verify_data_lake_readonly(engine: Engine) -> dict[str, Any]:
    execution = InceptorDataSourceAdapter(engine).execute_readonly(
        sql="SELECT 1 AS ok", parameters={}
    )
    return {
        "connected": bool(execution.rows),
        "readonly_guard": True,
        "latency_ms": execution.latency_ms,
    }


def _read_rows(
    engine: Engine, sql: str, parameters: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    return InceptorDataSourceAdapter(engine).execute_readonly(
        sql=sql, parameters=parameters or {}
    ).rows


def _validate_table_name(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}", value):
        raise ValueError("Catalog source table must be a qualified SQL identifier")


def _validate_field_name(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError("Catalog snapshot field must be a SQL identifier")


def _build_metric_catalog(
    fact_rows: list[dict[str, Any]], configs: dict[str, dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], int, int]:
    selected: dict[str, dict[str, Any]] = {}
    skipped = 0
    errors = 0
    for fact in fact_rows:
        metric_code = str(fact.get("indcr_no") or "").strip()
        source_metric_code = str(fact.get("orig_indcr_no") or "").strip()
        value_basis = str(fact.get("indcr_nm") or "").strip()
        config = configs.get(source_metric_code)
        if not metric_code or not source_metric_code or config is None:
            skipped += 1
            continue
        base_name = _strip_metric_prefix(config.get("indcr_nm"))
        metric_name = _compose_metric_name(base_name, value_basis)
        if not metric_name:
            skipped += 1
            continue
        candidate = {
            "metric_name": metric_name,
            "source_metric_code": source_metric_code,
            "base_name": base_name,
            "value_basis": value_basis,
            "config": config,
        }
        current = selected.get(metric_code)
        if current is not None and any(current[key] != candidate[key] for key in (
            "metric_name", "source_metric_code", "base_name", "value_basis"
        )):
            errors += 1
            continue
        selected[metric_code] = candidate
    return selected, skipped, errors


def _strip_metric_prefix(value: Any) -> str:
    return re.sub(r"^机构", "", str(value or "").strip(), count=1).strip()


def _compose_metric_name(base_name: str, value_basis: str) -> str:
    if not base_name:
        return ""
    qualifier = value_basis.strip()
    # 按源字段直接拼接，不猜测重复口径或改写正式指标名称。
    return f"{base_name}{qualifier}"


def _select_latest(
    rows: list[dict[str, Any]],
    key: str,
    order: list[str],
    *,
    effective_field: str | None = None,
) -> tuple[dict[str, dict[str, Any]], int]:
    selected: dict[str, dict[str, Any]] = {}
    skipped = 0
    for row in rows:
        if effective_field:
            effective_date = _as_date(row.get(effective_field))
            if effective_date is not None and effective_date > date.today():
                skipped += 1
                continue
        code = str(row.get(key) or "").strip()
        if not code:
            skipped += 1
            continue
        current = selected.get(code)
        if current is None or _sort_key(row, order) > _sort_key(current, order):
            selected[code] = row
    return selected, skipped


def _sort_key(row: dict[str, Any], order: list[str]) -> tuple[tuple[int, Any], ...]:
    return tuple(_sortable(row.get(field)) for field in order)


def _sortable(value: Any) -> tuple[int, Any]:
    if value is None or str(value).strip() == "":
        return (0, "")
    try:
        return (2, Decimal(str(value)))
    except InvalidOperation:
        return (1, str(value))


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _metric_state(term: MetricTerm) -> tuple[Any, ...]:
    return (term.metric_name, term.enabled, term.unit, term.source_metric_code,
            term.base_name, term.value_basis)


def _org_state(term: OrgTerm) -> tuple[Any, ...]:
    return (
        term.org_name,
        tuple(term.aliases or []),
        term.enabled,
        term.parent_org_code,
        term.hierarchy_level,
    )
