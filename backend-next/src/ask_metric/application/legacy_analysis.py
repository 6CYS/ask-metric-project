"""Read-only compatibility for persisted results from the retired analysis prototype.

No scheduler, model, Skill or checkpoint dependency belongs in this module.
"""

from typing import Any

from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError


def is_legacy_analysis(raw: dict[str, Any], query_shape: str | None = None) -> bool:
    return bool(
        raw.get("analysis_started")
        or raw.get("analysis_target")
        or raw.get("internal_analysis_id")
        or query_shape == "attribution_analysis"
        or (raw.get("clarification") or {}).get("type") == "analysis"
    )


def require_query_task(raw: dict[str, Any], query_shape: str | None = None) -> None:
    if is_legacy_analysis(raw, query_shape):
        raise ApplicationError(
            "LEGACY_ANALYSIS_READ_ONLY",
            "旧归因分析已停用，历史记录仅供查看和导出。请重新发起指标查询。",
            status_code=409,
        )


def authorize_legacy_analysis(raw, actor, permission_service):
    """Recheck the target and every cached evidence scope before reading or exporting."""
    scopes: set[tuple[str, str]] = set()
    target = raw.get("analysis_target")
    if target:
        if not isinstance(target, dict) or not all(
            isinstance(target.get(key), str) and target[key].strip()
            for key in ("metric_code", "org_code")
        ):
            raise PermissionDeniedError("旧归因结果缺少有效的权限范围")
        scopes.add((target["metric_code"], target["org_code"]))

    def collect(value):
        if isinstance(value, dict):
            if value.get("metric_code") and value.get("org_code"):
                metric, org = value["metric_code"], value["org_code"]
                if not isinstance(metric, str) or not isinstance(org, str):
                    raise PermissionDeniedError("旧归因证据权限范围无效")
                scopes.add((metric, org))
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(raw.get("analysis_tools", {}))
    for metric, org in sorted(scopes):
        dsl = {"task": "metric_query", "metrics": [metric], "orgs": [org]}
        authorized = permission_service.authorize_logical_dsl(actor=actor, logical_dsl=dsl)
        if authorized.get("orgs") != dsl["orgs"]:
            raise PermissionDeniedError("旧归因证据机构范围已变化")
