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
        fact_rows = _read_rows(
            source_engine,
            f"SELECT DISTINCT {fact_metric_code_field} AS indcr_no, "
            f"{fact_source_metric_code_field} AS orig_indcr_no, "
            f"{fact_value_basis_field} AS indcr_nm "
            f"FROM {fact_table} "
            f"WHERE {fact_snapshot_field} = "
            f"(SELECT MAX({fact_snapshot_field}) FROM {fact_table})",
        )
        selected, catalog_skipped, catalog_errors = _build_metric_catalog(fact_rows, configs)
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
                term.enabled = True
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
            f"WHERE {snapshot_field} = (SELECT MAX({snapshot_field}) FROM {source_table}) "
            f"AND {corporation_code_field} <= :corporation_code_max "
            f"AND {corporation_code_field} <> :excluded_corporation_code "
            f"AND (({hierarchy_field} = :legal_entity_hier_code "
            f"AND {corporation_code_field} <> :head_office_corporation_code) "
            f"OR {hierarchy_field} = :head_office_hier_code)",
            {
                "corporation_code_max": corporation_code_max,
                "excluded_corporation_code": excluded_corporation_code,
                "head_office_corporation_code": head_office_corporation_code,
                "legal_entity_hier_code": legal_entity_hier_code,
                "head_office_hier_code": head_office_hier_code,
            },
        )
        selected, skipped = _select_latest(rows, "org_no", ["source_load_date"])
        if len(selected) != expected_count:
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
                # Existing aliases are manually maintained and must be preserved.
                # New organizations deliberately start without aliases.
                term.aliases = list(term.aliases or [])
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


def _build_metric_catalog(
    fact_rows: list[dict[str, Any]], configs: dict[str, dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], int, int]:
    selected: dict[str, dict[str, Any]] = {}
    skipped = 0
    errors = 0
    for fact in fact_rows:
        metric_code = str(fact.get("indcr_no") or "").strip()
        source_metric_code = str(
            fact.get("orig_indcr_no") or fact.get("indcr_no") or ""
        ).strip()
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
            "value_basis": value_basis,
            "config": config,
        }
        current = selected.get(metric_code)
        if current is not None and current["metric_name"] != metric_name:
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
    if not qualifier or qualifier == base_name:
        return base_name
    if qualifier.startswith(base_name) or base_name.endswith(qualifier):
        return qualifier if qualifier.startswith(base_name) else base_name
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
    return (term.metric_name, term.enabled)


def _org_state(term: OrgTerm) -> tuple[Any, ...]:
    return (term.org_name, tuple(term.aliases or []), term.enabled)
