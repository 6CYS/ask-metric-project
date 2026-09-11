from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Any

from ask_metric.domain.query_execution import QueryExecutionPlan, json_safe


def process_query_result(
    plan: QueryExecutionPlan,
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    safe_rows = [json_safe(row) for row in rows]
    if plan.shape.value == "metric_period_compare":
        safe_rows = _process_period_compare(rows)
    comparisons = []
    for operation in plan.result_operations:
        if operation.get("type") == "entity_compare":
            comparisons.extend(_process_entity_compare(rows, operation, plan.parameters))
    # Persist unscaled, unrounded values for tables, downloads and fact audits.
    # Unit conversion and display precision belong exclusively to the answer renderer.
    return safe_rows, comparisons


def _process_period_compare(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        key = (str(row["metric_code"]), str(row["org_name"]))
        grouped[key][str(row["period"])] = row
    results = []
    for (metric_code, org_name), periods in sorted(grouped.items()):
        current = periods.get("current")
        base = periods.get("base")
        current_value = current.get("metric_value") if current else None
        base_value = base.get("metric_value") if base else None
        difference = None
        change_rate = None
        if current_value is None:
            status = "current_missing"
        elif base_value is None:
            status = "base_missing"
        elif Decimal(str(base_value)) == 0:
            status = "base_zero"
            difference = Decimal(str(current_value)) - Decimal(str(base_value))
        else:
            status = "ok"
            difference = Decimal(str(current_value)) - Decimal(str(base_value))
            change_rate = difference / abs(Decimal(str(base_value)))
        sample = current or base or {}
        results.append(
            json_safe(
                {
                    "metric_code": metric_code,
                    "metric_name": sample.get("metric_name"),
                    "unit": sample.get("unit"),
                    "org_name": org_name,
                    "current_date": current.get("stat_date") if current else None,
                    "current_value": current_value,
                    "base_date": base.get("stat_date") if base else None,
                    "base_value": base_value,
                    "difference": difference,
                    "change_rate": change_rate,
                    "status": status,
                }
            )
        )
    return results


def _process_entity_compare(
    rows: list[dict[str, Any]],
    operation: dict[str, Any],
    parameters: dict[str, Any],
) -> list[dict[str, Any]]:
    requested_orgs = parameters.get("org_names") or parameters.get("org_codes") or []
    grouped: dict[tuple[str, Any], dict[str, dict[str, Any]]] = defaultdict(dict)
    requested_labels: dict[str, str] = {}
    for row in rows:
        grouped[(str(row["metric_code"]), row.get("stat_date"))][str(row["org_name"])] = row
        if row.get("org_code") is not None:
            requested_labels[str(row["org_code"])] = str(row["org_name"])
    results = []
    for (metric_code, stat_date), org_rows in sorted(grouped.items(), key=str):
        ordered_names = [
            requested_labels.get(name, name)
            for name in requested_orgs
            if requested_labels.get(name, name) in org_rows
        ]
        ordered_names.extend(name for name in sorted(org_rows) if name not in ordered_names)
        if len(ordered_names) < 2:
            continue
        left_name, right_name = ordered_names[:2]
        left = Decimal(str(org_rows[left_name]["metric_value"]))
        right = Decimal(str(org_rows[right_name]["metric_value"]))
        ratio = None if right == 0 else left / right
        results.append(
            json_safe(
                {
                    "metric_code": metric_code,
                    "unit": org_rows[left_name].get("unit"),
                    "stat_date": stat_date,
                    "left_org": left_name,
                    "left_value": left,
                    "right_org": right_name,
                    "right_value": right,
                    "difference": left - right,
                    "ratio": ratio,
                    "higher_org": (
                        left_name if left > right else right_name if right > left else None
                    ),
                    "status": "ratio_unavailable" if right == 0 else "ok",
                    "method": operation.get("method", "value"),
                }
            )
        )
    return results
