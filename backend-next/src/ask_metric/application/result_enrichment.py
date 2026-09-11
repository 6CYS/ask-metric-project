from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ask_metric.infrastructure.db.models import MetricTerm, OrgTerm


class CatalogResultEnricher:
    """Add display metadata from GoldenDB using two bounded batch queries."""

    def __init__(self, session_factory: Callable[[], Session]) -> None:
        self.session_factory = session_factory

    def enrich(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not rows:
            return []
        metric_codes = sorted({str(row["metric_code"]) for row in rows if row.get("metric_code")})
        org_codes = sorted({str(row["org_code"]) for row in rows if row.get("org_code")})
        with self.session_factory() as session:
            metrics = (
                session.execute(
                    select(MetricTerm).where(
                        MetricTerm.metric_code.in_(metric_codes), MetricTerm.enabled.is_(True)
                    )
                )
                .scalars()
                .all()
                if metric_codes
                else []
            )
            organizations = (
                session.execute(
                    select(OrgTerm).where(
                        OrgTerm.org_code.in_(org_codes),
                        OrgTerm.enabled.is_(True),
                    )
                )
                .scalars()
                .all()
                if org_codes
                else []
            )
        metric_map = {item.metric_code: item for item in metrics}
        org_map = {item.org_code: item for item in organizations}
        enriched: list[dict[str, Any]] = []
        for source in rows:
            row = dict(source)
            metric_code = str(row.get("metric_code") or "")
            org_code = str(row.get("org_code") or "")
            metric = metric_map.get(metric_code)
            organization = org_map.get(org_code)
            # Never trust the fact table's indcr_nm; the data-lake template does not
            # select it and names are sourced exclusively from the application catalog.
            row["metric_name"] = metric.metric_name if metric else "未登记指标"
            row["unit"] = metric.unit if metric else None
            row["org_name"] = organization.org_name if organization else "未登记机构"
            enriched.append(row)
        return enriched
