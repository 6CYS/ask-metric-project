from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Engine, select
from sqlalchemy.exc import SQLAlchemyError
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
    issues: list[dict[str, str]] = field(default_factory=list)
    preserved_existing_codes: list[str] = field(default_factory=list)

    @property
    def bad_codes(self) -> set[str]:
        return {issue["code"] for issue in self.issues}

    @property
    def status(self) -> str:
        return "FAILED" if not self.selected_rows else "PARTIAL" if self.issues else "PASS"

    def quarantine(self, code: str, reason: str) -> None:
        issue = {"code": code, "reason": reason}
        if issue not in self.issues:
            self.issues.append(issue)
        self.errors = len(self.bad_codes)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result.pop("selected_codes", None)
        result["status"] = self.status
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
        super().__init__("机构来源范围不一致")


class CatalogSyncError(ValueError):
    def __init__(self, message: str, summary: SyncSummary):
        self.summary = summary
        super().__init__(message)


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
        summary = SyncSummary(source_rows=len(fact_rows), skipped=skipped, dry_run=dry_run)
        # 相同生效版本冲突不能任选第一行；只隔离依赖该来源编码的正式指标。
        conflicts = _latest_conflicts(config_rows, "indcr_no", columns, ("indcr_nm",))
        selected, catalog_skipped, _ = _build_metric_catalog(
            fact_rows, {code: row for code, row in configs.items() if code not in conflicts},
            summary=summary,
        )
        summary.skipped += catalog_skipped
        with self.app_sessions() as session:
            existing = {
                row.metric_code: row for row in session.execute(select(MetricTerm)).scalars()
            }
            selected = _eligible_selection(selected, existing, summary)
            for code, row in selected.items():
                term = existing.get(code)
                created = term is None
                if term is None:
                    term = MetricTerm(
                        metric_code=code, metric_name=row["metric_name"], description="",
                        metric_explanation="", unit=None, enabled=True,
                    )
                    session.add(term)
                before = _metric_state(term)
                term.metric_name = row["metric_name"]
                term.source_metric_code = row["source_metric_code"]
                term.base_name = row["base_name"]
                term.value_basis = row["value_basis"]
                # 已有单位、启停、别名、解释和关系不属于源端主数据更新。
                _count_change(summary, created, before != _metric_state(term))
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
        corporation_code_max: str,
        excluded_corporation_code: str,
        head_office_corporation_code: str,
        legal_entity_hier_code: str,
        head_office_hier_code: str,
        expected_count: int = 0,
        snapshot_date: date | None = None,
        aliases_by_code: dict[str, list[str]] | None = None,
        strict_scope: bool = False,
        confirm_org_additions: bool = False,
        include_branch_level: bool = False,
        branch_hier_code: str = "2",
        parent_field: str = "",
    ) -> SyncSummary:
        if not all((corporation_code_max, excluded_corporation_code,
                    head_office_corporation_code, legal_entity_hier_code, head_office_hier_code)):
            raise ValueError("机构正式来源范围和层级参数必须明确配置；未执行同步")
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
        summary = SyncSummary(source_rows=len(rows), dry_run=dry_run)
        selected, skipped = _select_latest(rows, "org_no", ["source_load_date"])
        summary.skipped = skipped
        conflicts = _latest_conflicts(
            rows, "org_no", ["source_load_date"], ("org_chn_nm", "org_hier_code", "parent_org_no"),
        )
        for row in rows:
            code = _source_text(row.get("org_no"))
            name = _source_text(row.get("org_chn_nm"))
            level = _source_text(row.get("org_hier_code"))
            parent = _source_text(row.get("parent_org_no"))
            if not code or len(code) > 128 or not name or len(name) > 255:
                summary.quarantine(code, "机构编码或名称为空/超长")
            elif code in conflicts:
                summary.quarantine(code, "同一快照的名称或层级冲突")
            elif not level or len(level) > 8 or len(parent) > 128:
                summary.quarantine(code, "机构层级字段为空/超长")
        selected = {code: row for code, row in selected.items() if code not in summary.bad_codes}
        with self.app_sessions() as session:
            existing = {row.org_code: row for row in session.execute(select(OrgTerm)).scalars()}
            selected = _eligible_selection(selected, existing, summary)
            hierarchy = _safe_hierarchy(
                selected, existing, summary, head_office_hier_code,
                legal_entity_hier_code, include_branch_level,
            )
            selected = {code: row for code, row in selected.items() if code in hierarchy}
            _finalize_selection(selected, existing, summary)
            for code, row in selected.items():
                term = existing.get(code)
                created = term is None
                if term is None:
                    term = OrgTerm(
                        org_code=code, org_name=row["org_chn_nm"], aliases=[], enabled=True,
                    )
                    session.add(term)
                before = _org_state(term)
                term.org_name = str(row["org_chn_nm"]).strip()
                # 别名属于独立维护能力；主数据同步不推导或覆盖它。
                node = hierarchy[code]
                term.parent_org_code = node.parent_code
                term.hierarchy_level = node.hierarchy_level
                _count_change(summary, created, before != _org_state(term))
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
    try:
        return InceptorDataSourceAdapter(engine).execute_readonly(
            sql=sql, parameters=parameters or {}
        ).rows
    except RuntimeError as exc:
        if not isinstance(exc.__cause__, SQLAlchemyError):
            raise
        summary = SyncSummary()
        summary.quarantine("", "源表读取失败；请核对连接、授权、物理表及必需列")
        raise CatalogSyncError("源表读取失败，未执行目录写入", summary) from exc


def _validate_table_name(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}", value):
        raise ValueError("Catalog source table must be a qualified SQL identifier")


def _validate_field_name(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError("Catalog snapshot field must be a SQL identifier")


def _build_metric_catalog(
    fact_rows: list[dict[str, Any]], configs: dict[str, dict[str, Any]],
    *, summary: SyncSummary | None = None,
) -> tuple[dict[str, dict[str, Any]], int, int]:
    report = summary if summary is not None else SyncSummary()
    selected: dict[str, dict[str, Any]] = {}
    for fact in fact_rows:
        code = _source_text(fact.get("indcr_no"))
        source = _source_text(fact.get("orig_indcr_no"))
        basis = _source_text(fact.get("indcr_nm"))
        config = configs.get(source)
        base = _strip_metric_prefix(config.get("indcr_nm")) if config else ""
        name = _compose_metric_name(base, basis)
        if (not code or len(code) > 128 or not source or len(source) > 128
                or not base or len(base) > 255 or not basis or len(basis) > 255
                or not name or len(name) > 255):
            report.quarantine(code, "正式编码、来源编码、基础名称或取值口径缺失/冲突/超长")
            continue
        candidate = dict(metric_name=name, source_metric_code=source,
                         base_name=base, value_basis=basis, config=config)
        current = selected.get(code)
        if current is not None and current != candidate:
            report.quarantine(code, "同一正式指标编码存在多个名称、来源或口径")
        selected[code] = candidate
    return ({code: row for code, row in selected.items() if code not in report.bad_codes},
            0, report.errors)


def _latest_conflicts(
    rows: list[dict[str, Any]], key: str, order: list[str], fields: tuple[str, ...],
) -> set[str]:
    latest, _ = _select_latest(rows, key, order,
                              effective_field="eff_dt" if "eff_dt" in order else None)
    conflicts = set()
    for row in rows:
        code = _source_text(row.get(key))
        current = latest.get(code)
        if current is not None and _sort_key(row, order) == _sort_key(current, order):
            if any(_source_text(row.get(name)) != _source_text(current.get(name))
                   for name in fields):
                conflicts.add(code)
    return conflicts


def _count_change(summary: SyncSummary, created: bool, changed: bool) -> None:
    if created:
        summary.created += 1
    elif changed:
        summary.updated += 1
    else:
        summary.unchanged += 1


def _eligible_selection(selected: dict, existing: dict, summary: SyncSummary) -> dict:
    eligible = {}
    for code, row in selected.items():
        if code in existing and not existing[code].enabled:
            summary.quarantine(code, "保留人工停用状态，本次不更新")
        else:
            eligible[code] = row
    _finalize_selection(eligible, existing, summary)
    return eligible


def _finalize_selection(selected: dict, existing: dict, summary: SyncSummary) -> None:
    summary.selected_codes = set(selected)
    summary.selected_rows = len(selected)
    summary.preserved_existing_codes = sorted(set(existing) - set(selected))
    if not selected:
        raise CatalogSyncError("没有可安全同步的合格记录；应用目录保持原样", summary)


def _safe_hierarchy(
    selected: dict, existing: dict, summary: SyncSummary,
    root_level: str, cohort_level: str, include_branch: bool,
) -> dict[str, OrganizationHierarchyNode]:
    # 优先使用应用库可信根；来源未返回的旧节点仍参与最终权限结构校验。
    retained = {
        code: OrganizationHierarchyNode(code, term.org_name, term.parent_org_code,
                                        term.hierarchy_level)
        for code, term in existing.items() if term.enabled
    }
    roots = [node.code for node in retained.values()
             if not node.parent_code and node.hierarchy_level == root_level]
    source_roots = [code for code, row in selected.items()
                    if _source_text(row.get("org_hier_code")) == root_level]
    candidates = roots or source_roots
    if len(candidates) != 1:
        for code in selected:
            summary.quarantine(code, "无法确定唯一可信省级根")
        _finalize_selection({}, existing, summary)
    root = candidates[0]
    updates = {}
    for code, row in selected.items():
        level = _source_text(row.get("org_hier_code"))
        parent = ((_source_text(row.get("parent_org_no")) or None) if include_branch
                  else None if level == root_level else root)
        updates[code] = OrganizationHierarchyNode(
            code, str(row["org_chn_nm"]).strip(), parent, level,
        )
    # 移除坏更新并恢复该编码旧节点，再迭代验证依赖子树，直到有效目录稳定。
    while True:
        effective = retained | updates
        bad = set()
        for code, node in effective.items():
            if code == root:
                invalid = bool(node.parent_code) or node.hierarchy_level != root_level
            else:
                invalid = (not node.hierarchy_level or node.hierarchy_level == root_level
                           or node.parent_code not in effective
                           or ((node.parent_code == root)
                               != (node.hierarchy_level == cohort_level)))
            seen = set()
            cursor = code
            while not invalid and cursor != root:
                if cursor in seen or cursor not in effective:
                    invalid = True
                    break
                seen.add(cursor)
                cursor = effective[cursor].parent_code or ""
            if invalid:
                bad.add(code)
        rejected = bad & updates.keys()
        if not rejected:
            if bad:
                for code in selected:
                    summary.quarantine(code, "保留节点的既有层级无效，需要先修正目录")
                _finalize_selection({}, existing, summary)
            break
        for code in rejected:
            summary.quarantine(code, "父机构缺失、环路或层级/根冲突；保留旧节点")
            updates.pop(code)
    OrganizationHierarchySnapshot(
        tuple((retained | updates).values()), root_level, cohort_level,
    ).validated_root()
    return updates


def _source_text(value: Any) -> str:
    # 空值与数值零不同；文本编码原样保留前导零，不猜测补齐。
    return "" if value is None else str(value).strip()


def _strip_metric_prefix(value: Any) -> str:
    return re.sub(r"^机构", "", _source_text(value), count=1).strip()


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
        code = _source_text(row.get(key))
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
