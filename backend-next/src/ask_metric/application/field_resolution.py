"""无模型的目录字段解析：指标与原句识别共用目录结构规则，不确定时交用户确认；
机构按“精确 → 唯一包含 → 错字纠正 → 候选澄清”阶梯解析，本级修饰只允许精确映射。"""

import re
from collections.abc import Sequence
from datetime import date

from rapidfuzz.distance import Levenshtein

from ask_metric.application.catalog_search import rank_organizations
from ask_metric.application.metric_candidates import (
    metric_candidate_index,
    resolved_metric_codes,
)
from ask_metric.application.org_aliases import org_core_form
from ask_metric.application.text_correction import (
    CorrectionTerm,
    phonetic,
    pinyin_syllable_similarity,
    pinyin_syllable_similarity_sliding,
    rank_corrections,
)
from ask_metric.domain.metric_matching import _normalize_with_index, normalize_semantic_text
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.domain.time_expression import SemanticValidationError, normalize_calendar_text, parse_discrete_dates, parse_time_expression

# 机构纠错全目录竞争的最低领先幅度；机构短名只有 2-4 字，
# 不设指标那套最短长度限制，用“编辑距离==1 或拼音全同 + 唯一领先”控制。
_ORG_CORRECTION_MIN_MARGIN = .15


_FIELD_JOINERS = re.compile(r"(?:和|及|与|以及|还有|跟|的)*")


def _covers_raw(raw: str, mentions: list[dict]) -> bool:
    """字段原值除连接词外须全部落在识别片段内。"""
    text, positions = _normalize_with_index(raw)
    rest = "".join(
        character for character, position in zip(text, positions, strict=True)
        if not any(mention["start"] <= position < mention["end"] for mention in mentions)
    )
    return _FIELD_JOINERS.fullmatch(rest) is not None


def _exact_matches(
    items: Sequence[MetricCatalogItem] | Sequence[OrganizationCatalogItem],
    normalized: str,
    *,
    include_code: bool,
) -> list:
    if not normalized:
        return []
    return [item for item in items if any(
        normalize_semantic_text(term) == normalized
        for term in ((item.code, item.name, *item.aliases) if include_code
                     else (item.name, *item.aliases))
    )]


def _normalized_terms(item: OrganizationCatalogItem) -> list[str]:
    terms = (normalize_semantic_text(term) for term in (item.name, *item.aliases))
    return [term for term in dict.fromkeys(terms) if term]


def _organization_ladder(
    normalized: str, items: Sequence[OrganizationCatalogItem],
) -> tuple[str, list]:
    """唯一包含 → 错字纠正 → 候选澄清；返回 (outcome, 机构列表)。

    contains：用户词只被唯一一家的名称或别名包含；多家包含即 ambiguous。
    corrected：编辑距离==1 或拼音全同，全目录竞争后唯一胜出（领先第二名
    margin≥0.15）；多家近距离竞争时把它们作为 ambiguous 候选交用户确认。
    字符距离是主信号，逐音节拼音相似度只作辅助分（多音字见 text_correction）。
    """
    contains = [item for item in items
                if any(normalized in term for term in _normalized_terms(item))]
    if len(contains) == 1:
        return "contains", contains
    if contains:
        return "ambiguous", contains
    by_code = {item.code: item for item in items}
    ranked = rank_corrections(
        normalized,
        (CorrectionTerm(item.code, term, phonetic(term))
         for item in items for term in _normalized_terms(item)),
        pinyin_score=pinyin_syllable_similarity,
    )
    if not ranked:
        return "none", []
    winner = ranked[0]
    runner_up = ranked[1] if len(ranked) > 1 else None
    margin = winner.score - (runner_up.score if runner_up else 0.0)
    sounds = phonetic(normalized)

    def plausible(candidate) -> bool:
        return candidate.distance == 1 or sounds == candidate.term.phonetic

    if not plausible(winner):
        return "none", []
    if margin + 1e-9 >= _ORG_CORRECTION_MIN_MARGIN:
        return "corrected", [by_code[winner.term.identity]]
    # 领先幅度不足：把同样在“距离==1 或拼音全同”范围内且贴近的候选全部交出。
    band = [candidate for candidate in ranked
            if plausible(candidate)
            and winner.score - candidate.score < _ORG_CORRECTION_MIN_MARGIN - 1e-9]
    if band:
        return "ambiguous", [by_code[candidate.term.identity] for candidate in band]
    return "none", []


_ORG_SUGGESTION_LIMIT = 5


def _fuzzy_org_suggestions(
    normalized: str, items: Sequence[OrganizationCatalogItem], *,
    limit: int = _ORG_SUGGESTION_LIMIT,
) -> list[dict]:
    """阶梯与目录检索均零命中时的建议候选：纠错打分排序，不参与自动解析。

    打分在“剥离组织形式后缀的核心名”上进行，取字符相似度与逐音节拼音相似度的
    较大者——长错名对全长目录名时相同后缀会稀释/放大差异（如“沐阳农村商业银行
    股份有限公司”对“江苏沭阳农村商业银行”），核心名比较保留区分度。
    无共同字且无同音音节的条目不算相似项（避免对完全无关输入仍硬塞候选）。
    """
    if not normalized:
        return []
    core_query = org_core_form(normalized) or normalized
    query_sounds = phonetic(core_query)
    query_chars = set(core_query)
    query_sound_set = set(query_sounds)
    scored: list[tuple[float, OrganizationCatalogItem]] = []
    for item in items:
        best = 0.0
        for term in _normalized_terms(item):
            core_term = org_core_form(term) or term
            term_sounds = phonetic(core_term)
            if not (query_chars & set(core_term)) and not (query_sound_set & set(term_sounds)):
                continue
            best = max(best,
                       Levenshtein.normalized_similarity(core_query, core_term),
                       pinyin_syllable_similarity_sliding(query_sounds, term_sounds))
        if best > 0:
            scored.append((best, item))
    scored.sort(key=lambda pair: (-pair[0], pair[1].code))
    return [
        {"value": item.name, "code": item.code, "score": round(score, 4),
         "metadata": {"match_kind": "fuzzy_suggestion"}}
        for score, item in scored[:limit]
    ]


def resolve_catalog_field(
    entity: str,
    raw_values: list[str],
    items: Sequence[MetricCatalogItem] | Sequence[OrganizationCatalogItem],
    *,
    suggested: list[dict] | None = None,
) -> dict:
    selected = {}
    candidates = {}
    issues = []
    # 机构解析来源：exact / contains / corrected 为目录字面与纠错命中，
    # model_inferred 为模型建议经服务端复核后的采纳；多来源取最弱（model_inferred 最弱），
    # 纠错逐条留痕，便于调用方向用户明示“按沭阳处理”。
    resolution_sources: list[str] = []
    corrections: list[dict] = []
    # (提交原值, 模型建议编码, 来源覆盖)；模型建议与 raw_values 逐条合并解析。
    entries: list[tuple[str, str | None, str | None]] = [(raw, None, None) for raw in raw_values]
    if entity == "organization" and suggested:
        seen_raw = {normalize_semantic_text(raw) for raw in raw_values}
        for entry in suggested:
            code = str(entry.get("code") or "").strip()
            name = str(entry.get("name") or "").strip()
            if code:
                entries.append((name or code, code, "model_inferred"))
            elif name and normalize_semantic_text(name) not in seen_raw:
                # 与 raw_values 字面重复的建议不重复解析，保留原值自己的字面来源。
                entries.append((name, None, "model_inferred"))
    for raw_index, (raw, suggested_code, source_override) in enumerate(entries):
        if suggested_code is not None:
            # 模型建议编码只做目录成员资格核验：命中以目录数据为准（不信任提交名称），
            # 非成员（不存在或无权限）按 not_found 交候选澄清，不判定越权。
            normalized_code = normalize_semantic_text(suggested_code)
            member = [item for item in items
                      if normalize_semantic_text(item.code) == normalized_code]
            if member:
                selected[member[0].code] = member[0]
                resolution_sources.append("model_inferred")
                continue
            result = rank_organizations(raw, items, limit=20)
            hits = [{"value": hit.name, "code": hit.code, "score": hit.score}
                    for hit in result.items]
            reason = "not_found"
            issues.append({"rawValue": raw, "reason": reason})
            for hit in hits:
                candidates[(raw_index, hit["code"])] = {
                    **hit, "metadata": {**hit.get("metadata", {}), "rawValueIndex": raw_index},
                }
            continue
        normalized = normalize_semantic_text(raw)
        exact = _exact_matches(items, normalized, include_code=True)
        # 先尊重完整正式名称/别名；“本级”仅限定实体自身，不展开下属或放宽模糊匹配。
        if not exact and entity == "organization" and normalized.endswith("本级"):
            exact = _exact_matches(items, normalized[:-2], include_code=False)
        if len(exact) == 1:
            selected[exact[0].code] = exact[0]
            resolution_sources.append(source_override or "exact")
            continue
        if exact:
            hits = [{"value": item.name, "code": item.code} for item in exact]
            reason = "ambiguous"
        else:
            if entity == "metric":
                # 与原句识别同一规则：完整名称或基础指标加口径可确定；其余只给候选。
                index = metric_candidate_index(items)
                mentions = index.mentions(raw)
                if mentions and _covers_raw(raw, mentions) and all(
                    mention["resolution"]["status"] == "resolved" for mention in mentions
                ):
                    for code in resolved_metric_codes(mentions):
                        selected[code] = index.items[code]
                    continue
                # 原值还有未识别的文字时，已识别的指标也只能作为候选，不能丢掉多余文字直接采用。
                hits = [
                    candidate for mention in mentions
                    for candidate in (
                        mention["resolution"].get("candidates", [])
                        if mention["resolution"]["status"] != "resolved" else [
                            {"value": name, "code": code} for code, name in zip(
                                mention["resolution"]["value"]["codes"],
                                mention["resolution"]["value"]["names"], strict=True,
                            )
                        ]
                    )
                    if candidate.get("code")
                ]
                reason = "needs_confirmation" if hits else "not_found"
            else:
                if normalized:
                    outcome, matched = _organization_ladder(normalized, items)
                else:
                    outcome, matched = "none", []
                if outcome in ("contains", "corrected"):
                    selected[matched[0].code] = matched[0]
                    resolution_sources.append(source_override or outcome)
                    if outcome == "corrected":
                        corrections.append({"raw": raw, "corrected_name": matched[0].name,
                                            "corrected_code": matched[0].code})
                    continue
                if outcome == "ambiguous":
                    hits = [{"value": item.name, "code": item.code} for item in matched]
                    reason = "ambiguous"
                else:
                    # 阶梯零命中：先维持目录检索候选；仍为空时给出按纠错打分排序的
                    # 建议候选（只澄清、不自动解析），避免“无可选项”的死胡同澄清。
                    result = rank_organizations(raw, items, limit=20)
                    hits = [{"value": hit.name, "code": hit.code, "score": hit.score}
                            for hit in result.items]
                    if not hits:
                        hits = _fuzzy_org_suggestions(normalized, items)
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
    result = {"status": "resolved", "value": {
        "codes": list(selected), "names": [item.name for item in selected.values()],
    }}
    if entity == "organization":
        source = next((source for source in ("model_inferred", "corrected", "contains", "exact")
                       if source in resolution_sources), "exact")
        metadata = {"resolution_source": source}
        if corrections:
            metadata["corrections"] = corrections
        result["metadata"] = metadata
    return result


def _strict_calendar_date(value) -> date | None:
    """严格 YYYY-MM-DD：与 basic_query 契约同一口径，回写相等才接受。"""
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def validate_calendar_value(value: dict, business_date: date) -> dict | None:
    """复核上游模型提交的换算日期，通过返回规范化 dict（ISO 字符串），否则 None。

    start/end 严格 YYYY-MM-DD、start<=end、跨度不超过 3660 天、end 不晚于业务日期
    （超出不截断，判失败）；dates 若存在则每项同格式、去重升序至少两个、
    首尾等于 start/end。
    """
    if not isinstance(value, dict):
        return None
    start = _strict_calendar_date(value.get("start"))
    end = _strict_calendar_date(value.get("end"))
    if start is None or end is None or start > end:
        return None
    if (end - start).days > 3660 or end > business_date:
        return None
    normalized = {"start": start.isoformat(), "end": end.isoformat()}
    raw_dates = value.get("dates")
    if raw_dates is not None:
        if not isinstance(raw_dates, list):
            return None
        points = [_strict_calendar_date(item) for item in raw_dates]
        if any(point is None for point in points):
            return None
        unique = sorted(dict.fromkeys(points))
        if len(unique) < 2 or unique[0] != start or unique[-1] != end:
            return None
        normalized["dates"] = [point.isoformat() for point in unique]
    return normalized


def resolve_date_field(
    raw: str,
    today: date,
    *,
    reference_year: int | None = None,
    model_value: dict | None = None,
) -> dict:
    """复用现有日期规则；不允许 latest 或无法确定的区间进入正式查询。

    顺序：先处理“近 N 年”歧义（默认滚动 N 年截至今天，附“最近 N 个完整年度”
    备选口径，不再阻塞澄清），再走确定性解析（离散多点 → 单点/区间）；确定性
    规则不支持该表达且 model_value 通过 validate_calendar_value 复核时，采纳
    模型换算结果。解析命中确定性规则时忽略 model_value。
    """
    try:
        recent_years = re.fullmatch(r"(?:近|最近|过去)\s*(\d+|[一二两三四五六七八九十]+)\s*个?年", raw.strip())
        if recent_years:
            amount = recent_years.group(1)
            # 默认滚动 N 年与备选完整年度共用 time_expression 既有口径；
            # N 非法（非 1..100 或 start 年份溢出）时抛错落入 invalid。
            rolling = parse_time_expression(f"向前滚动{amount}年，截至今天", today=today)
            complete = parse_time_expression(f"最近{amount}个完整年度", today=today)
            return {"status": "resolved", "value": {
                "start": rolling.start.isoformat(), "end": rolling.end.isoformat(),
            }, "alternative": {
                "label": f"最近{amount}个完整年度",
                "start": complete.start.isoformat(), "end": complete.end.isoformat(),
            }, "metadata": {
                "resolution_source": "deterministic", "businessDate": today.isoformat(),
            }}
        discrete = parse_discrete_dates(raw, today=today, reference_year=reference_year)
        if discrete:
            return {"status": "resolved", "value": {
                "start": discrete[0].isoformat(),
                "end": discrete[-1].isoformat(),
                "dates": [item.isoformat() for item in discrete],
            }, "metadata": {
                "resolution_source": "deterministic", "businessDate": today.isoformat(),
            }}
        result = parse_time_expression(raw, today=today, reference_year=reference_year)
        if result.start is None or result.end is None or result.start > result.end:
            return {"status": "invalid", "metadata": {
                "reason": "unsupported_expression", "businessDate": today.isoformat(),
            }}
        return {"status": "resolved", "value": {
            "start": result.start.isoformat(), "end": result.end.isoformat(),
        }, "metadata": {"resolution_source": "deterministic", "businessDate": today.isoformat()}}
    except SemanticValidationError as error:
        # 表达不支持时给模型换算一次兜底机会；日历值非法（含 N 越界）不兜底。
        if error.reason == "unsupported_expression" and model_value is not None:
            normalized = validate_calendar_value(model_value, today)
            if normalized is not None:
                return {"status": "resolved", "value": normalized, "metadata": {
                    "resolution_source": "model", "businessDate": today.isoformat(),
                }}
        return {"status": "invalid", "metadata": {
            "reason": error.reason,
            "businessDate": today.isoformat(),
        }}
    except (ValueError, OverflowError):
        return {"status": "invalid", "metadata": {
            "reason": "invalid_calendar", "businessDate": today.isoformat(),
        }}


def source_organization_codes(question: str, items: Sequence[OrganizationCatalogItem],
                              *, allow_typo: bool = False) -> list[str]:
    """独立扫描目录实体依据；最长片段优先，不能由模型提交集合反推完整目标。

    allow_typo=True 时追加错字片段依据（原文片段与目录词条一字之差或拼音全同，
    且全目录竞争唯一胜出——与解析阶梯同一把尺子）。仅准入/解析对账开启：
    这些路径的权限与目录有效性另有独立强制校验，且结论经明示或候选确认对用户
    可见。身份隐藏类扫描（inspect_goal 片段）必须保持严格精确，防止把被撤权
    机构的精确名称当成在权机构的错字而静默替身。
    """
    text = normalize_semantic_text(question)
    hits: dict[tuple[int, int], set[str]] = {}
    for item in items:
        # 目录别名已在加载时合并派生短称，扫描名称与别名即覆盖常用写法。
        terms = {normalize_semantic_text(term) for term in (item.name, *item.aliases)}
        for term in terms:
            if not term:
                continue
            start = text.find(term)
            while start >= 0:
                hits.setdefault((start, start + len(term)), set()).add(item.code)
                start = text.find(term, start + 1)
    chosen: list[tuple[int, int]] = []
    codes: set[str] = set()
    for span, members in sorted(hits.items(), key=lambda item: (-(item[0][1] - item[0][0]), item[0][0])):
        if any(span[0] < other[1] and other[0] < span[1] for other in chosen):
            continue
        chosen.append(span)
        codes.update(members)
    if allow_typo:
        codes.update(_typo_org_spans(text, items, chosen))
    return sorted(codes)


# 错字依据只扫描短名/别名级片段：全长名称的错写由澄清候选承接，不做依据。
_TYPO_TERM_MIN_LENGTH = 2
_TYPO_TERM_MAX_LENGTH = 10


def _typo_org_spans(text: str, items: Sequence[OrganizationCatalogItem],
                    chosen: list[tuple[int, int]]) -> set[str]:
    """在未被精确命中覆盖的原文窗口中找错字依据；同阶梯判定：距离==1 或拼音全同 + 唯一领先。"""
    terms_by_length: dict[int, list[CorrectionTerm]] = {}
    for item in items:
        for term in _normalized_terms(item):
            if _TYPO_TERM_MIN_LENGTH <= len(term) <= _TYPO_TERM_MAX_LENGTH:
                terms_by_length.setdefault(len(term), []).append(
                    CorrectionTerm(item.code, term, phonetic(term)))
    codes: set[str] = set()
    for length, terms in terms_by_length.items():
        if len(text) < length:
            continue
        for start in range(len(text) - length + 1):
            span = (start, start + length)
            if any(span[0] < other[1] and other[0] < span[1] for other in chosen):
                continue
            window = text[start:start + length]
            ranked = rank_corrections(window, terms, pinyin_score=pinyin_syllable_similarity)
            if not ranked:
                continue
            winner = ranked[0]
            runner_up = ranked[1] if len(ranked) > 1 else None
            margin = winner.score - (runner_up.score if runner_up else 0.0)
            if winner.distance != 1 and phonetic(window) != winner.term.phonetic:
                continue
            if margin + 1e-9 < _ORG_CORRECTION_MIN_MARGIN:
                continue
            chosen.append(span)
            codes.add(winner.term.identity)
    return codes


_SOURCE_MONTH = r"[0-9一二两三四五六七八九十]{1,3}月份?(?:末|底)?"
_SOURCE_YEAR = r"(?:\d{4}年|今年|本年|去年|上年|前年)"
_SOURCE_POINT = rf"(?:(?:{_SOURCE_YEAR})?(?:(?:第)?[一二三四1-4]季度|[上下]半年)|\d{{4}}-\d{{1,2}}-\d{{1,2}}|(?:{_SOURCE_YEAR})?{_SOURCE_MONTH}(?:\d{{1,2}}(?:日|号))?|{_SOURCE_YEAR}(?:末|底|初)?)"
_SOURCE_CALENDAR = re.compile(
    rf"(?:向前)?滚动\s*(?:\d+|[一二两三四五六七八九十]+)\s*年\s*(?:[,，]?\s*截至(?:今天|今日))?|"
    rf"{_SOURCE_POINT}\s*(?:至|到|~|～)\s*{_SOURCE_POINT}|{_SOURCE_POINT}|"
    r"(?:近|最近|过去)\s*(?:\d+|[一二两三四五六七八九十]+)\s*个?(?:完整)?[年月天]|今天|今日|昨天"
)


def source_calendar_constraints(question: str, today: date, *, reference_year: int | None = None) -> dict:
    """扫描日历词法并复用同一解析器；不推测整句意图，不把局部匹配当完整范围。"""
    ranges: list[dict] = []
    unresolved: list[str] = []
    for match in _SOURCE_CALENDAR.finditer(normalize_calendar_text(question)):
        expression = match.group()
        parsed = resolve_date_field(expression, today, reference_year=reference_year)
        if parsed["status"] == "resolved":
            ranges.append(parsed["value"])
        else:
            unresolved.append(expression)
    return {"ranges": ranges, "unresolved": unresolved}
