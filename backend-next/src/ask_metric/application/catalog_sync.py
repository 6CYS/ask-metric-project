from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

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
    issues: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    preserved_existing_codes: list[str] = field(default_factory=list)

    def quarantine(self, code: str, reason: str, *, name: str | None = None) -> None:
        issue = {"code": code, "reason": reason}
        if name is not None:
            issue["name"] = name
        if issue not in self.issues:
            self.issues.append(issue)
        self.errors = len(self.issues)

    @property
    def status(self) -> str:
        if not self.selected_rows:
            return "FAILED"
        return "PARTIAL" if self.issues or self.warnings else "PASS"

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
        super().__init__("应用库存在本次范围外的启用机构，须先核对编码及引用")


class CatalogSyncError(ValueError):
    def __init__(self, summary: SyncSummary):
        self.summary = summary.to_dict()
        super().__init__("无合格目录记录；已有数据保留，请查看隔离报告")


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
        # 仅当前生效版本存在歧义时隔离，旧版本改名不影响最新版本。
        latest_names: dict[str, set[str]] = {}
        for row in config_rows:
            code = str(row.get("indcr_no") or "").strip()
            current = configs.get(code)
            if current is not None and _sort_key(row, columns) == _sort_key(current, columns):
                latest_names.setdefault(code, set()).add(str(row.get("indcr_nm") or "").strip())
        conflicting_configs = {code for code, names in latest_names.items() if len(names) > 1}
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
        summary = SyncSummary(
            source_rows=len(fact_rows),
            skipped=skipped,
            dry_run=dry_run,
        )
        selected = _build_metric_catalog(fact_rows, configs, summary, conflicting_configs)
        if units_by_name is not None and not isinstance(units_by_name, dict):
            raise ValueError("单位映射必须是名称到单位的 JSON 对象")
        units = dict(units_by_name or {})
        with self.app_sessions() as session:
            existing = {
                row.metric_code: row for row in session.execute(select(MetricTerm)).scalars()
            }
            # 单位逐指标校验；映射缺项时仅复用同编码、同名称的既有单位。
            # 不把未知单位猜成金额，也不因一个缺失项回滚其他合格记录。
            for code, row in list(selected.items()):
                name = row["metric_name"]
                unit = units.get(name)
                old = existing.get(code)
                old_unit = old.unit if old is not None and old.metric_name == name else None
                if name not in units and old_unit:
                    unit = old_unit
                if unit and old_unit and unit != old_unit:
                    summary.quarantine(code, "conflicting_existing_unit", name=name)
                    del selected[code]
                    continue
                if not unit and infer_units:
                    from ask_metric.application.metric_units import infer_metric_unit

                    unit = infer_metric_unit(name)
                if not isinstance(unit, str) or not unit.strip() or len(unit) > 64:
                    summary.quarantine(code, "missing_or_invalid_unit", name=name)
                    del selected[code]
                else:
                    row["unit"] = unit.strip()
            _finalize_selection(summary, selected, existing)
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
                term.enabled = True
                term.unit = row["unit"]
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
        rows = _read_rows(
            source_engine,
            f"SELECT {org_code_field} AS org_no, "
            f"{org_name_field} AS org_chn_nm, "
            f"{snapshot_field} AS source_load_date FROM {source_table} "
            f"WHERE {snapshot_field} = "
            + (":snapshot_date " if snapshot_date else
               f"(SELECT MAX({snapshot_field}) FROM {source_table}) ")
            +
            f"AND {corporation_code_field} <= :corporation_code_max "
            f"AND {corporation_code_field} <> :excluded_corporation_code "
            f"AND (({hierarchy_field} = :legal_entity_hier_code "
            f"AND {corporation_code_field} <> :head_office_corporation_code) "
            f"OR {hierarchy_field} = :head_office_hier_code)",
            {
                "snapshot_date": snapshot_date.isoformat() if snapshot_date else None,
                "corporation_code_max": corporation_code_max,
                "excluded_corporation_code": excluded_corporation_code,
                "head_office_corporation_code": head_office_corporation_code,
                "legal_entity_hier_code": legal_entity_hier_code,
                "head_office_hier_code": head_office_hier_code,
            },
        )
        selected, skipped = _select_latest(rows, "org_no", ["source_load_date"])
        summary = SyncSummary(source_rows=len(rows), skipped=skipped, dry_run=dry_run)
        # 同一快照必须能唯一确定名称；不截断超过应用字段长度的源名称。
        seen_names: dict[str, str] = {}
        for row in rows:
            code = str(row.get("org_no") or "").strip()
            name = str(row.get("org_chn_nm") or "").strip()
            if not code or len(code) > 128 or not name or len(name) > 255:
                summary.quarantine(code, "missing_or_oversized_code_or_name")
            if code in seen_names and seen_names[code] != name:
                summary.quarantine(code, "conflicting_names")
            seen_names[code] = name
        # 冲突编码的所有候选一起隔离，不依赖数据库返回顺序选择其中一条。
        for issue in summary.issues:
            selected.pop(issue["code"], None)
        additions = aliases_by_code if aliases_by_code is not None else {}
        if not isinstance(additions, dict):
            raise ValueError("机构别名映射必须是编码到列表的 JSON 对象")
        valid_additions: dict[str, list[str]] = {}
        for code, aliases in additions.items():
            if code not in selected or not isinstance(aliases, list) or any(
                not isinstance(alias, str) or not alias.strip() or len(alias) > 255
                for alias in aliases
            ):
                summary.warnings.append({"code": str(code), "reason": "aliases_not_applied"})
                continue
            valid_additions[code] = aliases
        with self.app_sessions() as session:
            existing = {row.org_code: row for row in session.execute(select(OrgTerm)).scalars()}
            outside = sorted(code for code, term in existing.items()
                             if term.enabled and code not in selected)
            if strict_scope and outside:
                raise OrganizationScopeError(outside)
            if outside:
                summary.warnings.append({"reason": "existing_organizations_preserved",
                                         "codes": outside})
            _finalize_selection(summary, selected, existing)
            if summary.selected_rows != expected_count:
                summary.warnings.append({"reason": "unexpected_organization_count",
                                         "expected": expected_count,
                                         "actual": summary.selected_rows})
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
                    *(term.aliases or []),
                    *(alias.strip() for alias in valid_additions.get(code, [])),
                ]))
                term.enabled = True
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


def _finalize_selection(
    summary: SyncSummary, selected: dict[str, Any], existing: dict[str, Any]
) -> None:
    # 人工停用属于运维决策，例行同步不能重新启用。
    for code in list(selected):
        if code in existing and not existing[code].enabled:
            summary.quarantine(code, "existing_record_disabled")
            del selected[code]
    summary.selected_rows = len(selected)
    summary.selected_codes = set(selected)
    summary.preserved_existing_codes = sorted(set(existing) - set(selected))
    summary.skipped += len({item["code"] for item in summary.issues})
    if not selected:
        raise CatalogSyncError(summary)


def _build_metric_catalog(
    fact_rows: list[dict[str, Any]], configs: dict[str, dict[str, Any]],
    summary: SyncSummary, conflicting_configs: set[str],
) -> dict[str, dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for fact in fact_rows:
        metric_code = str(fact.get("indcr_no") or "").strip()
        source_metric_code = str(fact.get("orig_indcr_no") or "").strip()
        value_basis = str(fact.get("indcr_nm") or "").strip()
        config = configs.get(source_metric_code)
        if not metric_code or len(metric_code) > 128 or not source_metric_code or config is None:
            summary.quarantine(metric_code, "missing_or_invalid_code_or_config")
            continue
        if source_metric_code in conflicting_configs:
            summary.quarantine(metric_code, "conflicting_config_names")
            continue
        base_name = _strip_metric_prefix(config.get("indcr_nm"))
        metric_name = _compose_metric_name(base_name, value_basis)
        if not base_name or not metric_name or len(metric_name) > 255:
            summary.quarantine(metric_code, "missing_or_oversized_name")
            continue
        candidate = {
            "metric_name": metric_name,
            "source_metric_code": source_metric_code,
            "value_basis": value_basis,
            "config": config,
        }
        current = selected.get(metric_code)
        if current is not None and current["metric_name"] != metric_name:
            summary.quarantine(metric_code, "conflicting_names")
            continue
        selected[metric_code] = candidate
    for issue in summary.issues:
        selected.pop(issue["code"], None)
    return selected


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
    return (term.metric_name, term.enabled, term.unit)


def _org_state(term: OrgTerm) -> tuple[Any, ...]:
    return (term.org_name, tuple(term.aliases or []), term.enabled)
