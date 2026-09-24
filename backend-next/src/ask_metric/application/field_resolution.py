"""无模型的目录字段解析：指标唯一最高相似度达95%可直接采用；
机构写法剥离组织形式后缀后核心名唯一相等可直接解析，冲突仍交用户确认。"""

from collections.abc import Sequence
from datetime import date

from ask_metric.application.catalog_search import rank_organizations
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.domain.metric_matching import normalize_semantic_text
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.domain.time_expression import parse_discrete_dates, parse_time_expression

# 机构写法中的组织形式后缀属于封闭词类，不构成机构之间的区分信息；
# 比较时统一剥离得到核心名，覆盖“紫金/紫金农商/农商行/农商银行/银行”等写法。
_INSTITUTION_FORM_SUFFIXES = (
    "农村商业银行", "农商银行", "农商行", "农商",
    "信用联社", "信用社", "银行",
    "股份有限公司", "有限责任公司", "有限公司", "股份", "公司",
    "分行", "支行", "总行", "行",
)


def _organization_core(normalized: str) -> str:
    """反复剥离尾部的机构形式后缀；剥空时保留原文，避免失去区分信息。"""
    core = normalized
    while True:
        for suffix in _INSTITUTION_FORM_SUFFIXES:
            if core.endswith(suffix) and len(core) > len(suffix):
                core = core[: -len(suffix)]
                break
        else:
            return core


def _exact_matches(
    entity: str,
    items: Sequence[MetricCatalogItem] | Sequence[OrganizationCatalogItem],
    normalized: str,
    *,
    include_code: bool,
) -> list:
    if not normalized:
        return []
    strict = [item for item in items if any(
        normalize_semantic_text(term) == normalized
        for term in ((item.code, item.name, *item.aliases) if include_code
                     else (item.name, *item.aliases))
    )]
    if strict or entity != "organization":
        return strict
    # 核心名比较放在严格精确之后，不抢占正式名称/别名的既有优先级；
    # 剥离后多家机构核心名相同则全部返回，按歧义交用户确认。
    raw_core = _organization_core(normalized)
    if not raw_core:
        return []
    return [item for item in items if any(
        _organization_core(normalize_semantic_text(term)) == raw_core
        for term in (item.name, *item.aliases)
    )]


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
        exact = _exact_matches(entity, items, normalized, include_code=True)
        # 先尊重完整正式名称/别名；“本级”仅限定实体自身，不展开下属或放宽模糊匹配。
        if not exact and entity == "organization" and normalized.endswith("本级"):
            exact = _exact_matches(entity, items, normalized[:-2], include_code=False)
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
    """复用现有日期规则；不允许 latest 或无法确定的区间进入正式查询。

    先尝试离散多点解析（"2月末、3月末、4月末"）：命中则额外携带 dates 列表，
    start/end 取最早/最晚以兼容既有 {start,end} 消费方；否则回退单点/区间解析。
    """
    try:
        discrete = parse_discrete_dates(raw, today=today, reference_year=reference_year)
        if discrete:
            return {"status": "resolved", "value": {
                "start": discrete[0].isoformat(),
                "end": discrete[-1].isoformat(),
                "dates": [item.isoformat() for item in discrete],
            }, "metadata": {"businessDate": today.isoformat()}}
        result = parse_time_expression(raw, today=today, reference_year=reference_year)
        if result.start is None or result.end is None or result.start > result.end:
            return {"status": "invalid"}
        return {"status": "resolved", "value": {
            "start": result.start.isoformat(), "end": result.end.isoformat(),
        }, "metadata": {"businessDate": today.isoformat()}}
    except (ValueError, OverflowError):
        return {"status": "invalid"}
