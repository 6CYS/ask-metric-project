"""无模型的目录字段解析；指标唯一最高相似度达到95%可直接采用。"""

from collections.abc import Sequence
from datetime import date

from ask_metric.application.catalog_search import rank_organizations
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.domain.metric_matching import normalize_semantic_text
from ask_metric.domain.semantic_normalization import parse_time_expression
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


def resolve_catalog_field(
    entity: str,
    raw_values: list[str],
    items: Sequence[MetricCatalogItem] | Sequence[OrganizationCatalogItem],
) -> dict:
    selected = {}
    candidates = {}
    issues = []
    for raw_index, raw in enumerate(raw_values):
        normalized = normalize_semantic_text(raw)
        exact = [item for item in items if normalized and any(
            normalize_semantic_text(term) == normalized
            for term in (item.code, item.name, *item.aliases)
        )]
        if len(exact) == 1:
            selected[exact[0].code] = exact[0]
            continue
        if exact:
            hits = [{"value": item.name, "code": item.code} for item in exact]
            reason = "ambiguous"
        else:
            if entity == "metric":
                index = metric_candidate_index(items)
                result = index.resolve_candidates(raw, index.candidates(raw, limit=20))
                if result["status"] == "resolved":
                    code = result["value"]["codes"][0]
                    selected[code] = index.items[code]
                    continue
                hits = result["candidates"]
            else:
                result = rank_organizations(raw, items, limit=20)
                hits = [{"value": hit.name, "code": hit.code, "score": hit.score}
                        for hit in result.items]
            reason = "needs_confirmation" if hits else "not_found"
        issues.append({"rawValue": raw, "reason": reason})
        for hit in hits:
            candidates[(raw_index, hit["code"])] = {
                **hit, "metadata": {**hit.get("metadata", {}), "rawValueIndex": raw_index},
            }
    if issues:
        reasons = {issue["reason"] for issue in issues}
        status = next(reason for reason in ("ambiguous", "not_found", "needs_confirmation")
                      if reason in reasons)
        return {"status": status, "candidates": list(candidates.values())[:50],
                "metadata": {"issues": issues, "candidate_count": len(candidates)}}
    return {"status": "resolved", "value": {
        "codes": list(selected), "names": [item.name for item in selected.values()],
    }}


def resolve_date_field(raw: str, today: date, *, reference_year: int | None = None) -> dict:
    """复用现有日期规则；不允许 latest 或无法确定的区间进入正式查询。"""
    try:
        result = parse_time_expression(raw, today=today, reference_year=reference_year)
        if result.start is None or result.end is None or result.start > result.end:
            return {"status": "invalid"}
        return {"status": "resolved", "value": {
            "start": result.start.isoformat(), "end": result.end.isoformat(),
        }, "metadata": {"businessDate": today.isoformat()}}
    except (ValueError, OverflowError):
        return {"status": "invalid"}
