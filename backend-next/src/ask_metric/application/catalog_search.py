"""目录检索打分：agent 目录搜索工具的后端受治理召回。

确定性命中（exact/contains/lexical）才计入 total，供调用方直接锁定编码；
embedding 余弦只产出语义近似推荐（match_type=semantic），不设绝对阈值——
不同模型余弦尺度不可比，与语义链路的 top-k 召回行为保持一致。
打分函数均为纯函数，不依赖数据库与模型，便于脱离环境直接单测。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from ask_metric.application.metric_candidates import _lexical_metric_candidates
from ask_metric.application.ports import ModelService
from ask_metric.domain.metric_matching import normalize_semantic_text
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.model.catalog_vectors import (
    CatalogVectorCache,
    catalog_embedding_texts,
)

MATCH_EXACT = "exact"
MATCH_CONTAINS = "contains"
MATCH_LEXICAL = "lexical"
MATCH_SEMANTIC = "semantic"

_SCORE_EXACT = 1.0
_SCORE_PREFIX = 0.95
_SCORE_CONTAINS = 0.9

# 词法档沿用语义链路的候选上限量级，避免长关键词漏掉尾部相关指标
_LEXICAL_LIMIT = 30


@dataclass(frozen=True)
class CatalogSearchHit:
    code: str
    name: str
    score: float
    match_type: str
    aliases: list[str]
    unit: str | None = None


@dataclass(frozen=True)
class MetricSearchResult:
    total: int
    items: list[CatalogSearchHit]
    semantic_suggestions: list[CatalogSearchHit]


@dataclass(frozen=True)
class OrgSearchResult:
    total: int
    items: list[CatalogSearchHit]


def _contains_score(keyword: str, term: str, base: float) -> float | None:
    """包含关系按长度占比折算：越接近完整名称得分越高，等长即 exact。"""
    if not keyword or not term:
        return None
    if keyword == term:
        return _SCORE_EXACT
    shorter, longer = (keyword, term) if len(keyword) <= len(term) else (term, keyword)
    if shorter not in longer:
        return None
    return base * len(shorter) / len(longer)


def _deterministic_metric_hits(
    keyword: str, items: Sequence[MetricCatalogItem]
) -> dict[str, CatalogSearchHit]:
    """确定性命中：exact > contains > lexical，同码保留最高分。"""
    hits: dict[str, CatalogSearchHit] = {}

    def register(hit: CatalogSearchHit) -> None:
        existing = hits.get(hit.code)
        if existing is None or hit.score > existing.score:
            hits[hit.code] = hit

    for item in items:
        for term in [item.code, item.name, *item.aliases]:
            score = _contains_score(keyword, normalize_semantic_text(term), _SCORE_CONTAINS)
            if score is None:
                continue
            match_type = MATCH_EXACT if score == _SCORE_EXACT else MATCH_CONTAINS
            register(
                CatalogSearchHit(
                    code=item.code,
                    name=item.name,
                    score=score,
                    match_type=match_type,
                    aliases=list(item.aliases),
                    unit=item.unit,
                )
            )
    for candidate in _lexical_metric_candidates(
        keyword, list(items), limit=_LEXICAL_LIMIT
    ):
        register(
            CatalogSearchHit(
                code=candidate.item.code,
                name=candidate.item.name,
                score=candidate.score,
                match_type=MATCH_LEXICAL,
                aliases=list(candidate.item.aliases),
                unit=candidate.item.unit,
            )
        )
    return hits


def search_metrics(
    keyword: str,
    items: Sequence[MetricCatalogItem],
    *,
    embedding_scores: dict[str, float] | None = None,
    limit: int = 10,
) -> MetricSearchResult:
    """指标检索：确定性命中排序截断，embedding top-k 仅作语义近似推荐。"""
    normalized_keyword = normalize_semantic_text(keyword)
    if not normalized_keyword:
        return MetricSearchResult(total=0, items=[], semantic_suggestions=[])
    hits = _deterministic_metric_hits(normalized_keyword, items)
    ranked = sorted(hits.values(), key=lambda hit: (-hit.score, hit.code))
    by_code = {item.code: item for item in items}
    suggestions: list[CatalogSearchHit] = []
    for code, score in (embedding_scores or {}).items():
        if code in hits:
            continue
        item = by_code.get(code)
        if item is None:
            continue
        suggestions.append(
            CatalogSearchHit(
                code=item.code,
                name=item.name,
                score=score,
                match_type=MATCH_SEMANTIC,
                aliases=list(item.aliases),
                unit=item.unit,
            )
        )
    suggestions.sort(key=lambda hit: (-hit.score, hit.code))
    return MetricSearchResult(
        total=len(ranked),
        items=ranked[:limit],
        semantic_suggestions=suggestions[:limit],
    )


def rank_organizations(
    keyword: str,
    items: Sequence[OrganizationCatalogItem],
    *,
    limit: int = 10,
) -> OrgSearchResult:
    """机构检索只保留确定性档位，不做模糊匹配。

    “沭阳农商行/泗阳农商行”类高相似名称会被模糊档误推，而机构编码确认
    要求精确性；无确定性命中就返回空，由调用方走语义链路兜底。
    """
    normalized_keyword = normalize_semantic_text(keyword)
    if not normalized_keyword:
        return OrgSearchResult(total=0, items=[])
    hits: dict[str, CatalogSearchHit] = {}
    for item in items:
        best: float | None = None
        for term in [item.code, item.name, *item.aliases]:
            normalized_term = normalize_semantic_text(term)
            if not normalized_term:
                continue
            if normalized_term.startswith(normalized_keyword) or normalized_keyword.startswith(
                normalized_term
            ):
                base = _SCORE_PREFIX
            else:
                base = _SCORE_CONTAINS
            score = _contains_score(normalized_keyword, normalized_term, base)
            if score is not None and (best is None or score > best):
                best = score
        if best is not None:
            hits[item.code] = CatalogSearchHit(
                code=item.code,
                name=item.name,
                score=best,
                match_type=MATCH_EXACT if best == _SCORE_EXACT else MATCH_CONTAINS,
                aliases=list(item.aliases),
            )
    ranked = sorted(hits.values(), key=lambda hit: (-hit.score, hit.code))
    return OrgSearchResult(total=len(ranked), items=ranked[:limit])


def _cosine(
    left: Sequence[float], right: Sequence[float], *, left_norm: float | None = None,
) -> float:
    numerator = sum(a * b for a, b in zip(left, right, strict=False))
    if left_norm is None:
        left_norm = math.sqrt(sum(value * value for value in left))
    denominator = left_norm * math.sqrt(
        sum(value * value for value in right)
    )
    return numerator / denominator if denominator else 0


def metric_embedding_scores(
    keyword: str,
    items: Sequence[MetricCatalogItem],
    *,
    model_service: ModelService,
    catalog_vector_cache: CatalogVectorCache,
    is_embedding_enabled: bool,
    embedding_top_k: int,
    batch_size: int,
    wait_seconds: float,
) -> dict[str, float] | None:
    """embedding 余弦 top-k（路由层调用，含模型与缓存副作用）。

    复用启动预热的目录向量缓存；embedding 未启用或向量条数异常时返回 None，
    调用方降级为纯词法结果，与语义链路 fallback 行为一致。
    """
    if not is_embedding_enabled or not items:
        return None
    corpus = catalog_embedding_texts(items)
    vectors = catalog_vector_cache.embed(
        model_service,
        keyword,
        corpus,
        batch_size=batch_size,
        wait_seconds=wait_seconds,
    )
    if len(vectors) != len(corpus) + 1:
        return None
    query_vector = tuple(vectors[0])
    query_norm = math.sqrt(sum(value * value for value in query_vector))
    scored = sorted(
        (
            (item.code, _cosine(query_vector, vector, left_norm=query_norm))
            for item, vector in zip(items, vectors[1:], strict=True)
        ),
        key=lambda pair: (-pair[1], pair[0]),
    )
    return dict(scored[:embedding_top_k])
