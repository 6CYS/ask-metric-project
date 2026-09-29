"""从逐指标维护的组合同义词推导“基础指标别名 + 口径别名”。

同义词只在“指标术语”中按指标维护一处；识别索引加载目录时调用本模块推导别名，只存于内存。
只做确定性拆分，不猜业务含义：
- 同一基础指标各口径的同义词共用同一个开头；被最多口径共用的开头（并列取最长）即基础别名，
  其余部分为该口径的写法；
- 口径写法只有专属于一个口径、且至少两个基础指标这样写时才建议采用；
- 同一基础别名落到多个源指标、或与另一基础指标正式名称相同时不采用，仍按完整同义词匹配；
  检查报告列出这些冲突，供目录负责人修正同义词。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from ask_metric.domain.metric_matching import normalize_semantic_text


@dataclass(frozen=True)
class StructuredMetric:
    code: str
    source_metric_code: str
    base_name: str
    value_basis: str


def _split(synonym: str, prefix_bases: dict[str, set[str]]) -> tuple[str, str] | None:
    """按该基础指标下被最多口径共用的开头拆分；只有一个口径用过的开头不足以说明是基础别名。"""
    prefixes = [synonym[:length] for length in range(1, len(synonym))]
    prefixes = [prefix for prefix in prefixes if len(prefix_bases.get(prefix, ())) >= 2]
    if not prefixes:
        return None
    prefix = max(prefixes, key=lambda item: (len(prefix_bases[item]), len(item)))
    return prefix, synonym[len(prefix):]


def propose_alias_structure(
    metrics: Iterable[StructuredMetric], synonyms: dict[str, list[str]],
) -> dict:
    by_source: dict[str, list[StructuredMetric]] = defaultdict(list)
    for metric in metrics:
        base = normalize_semantic_text(metric.base_name)
        if base and normalize_semantic_text(metric.value_basis):
            by_source[metric.source_metric_code].append(metric)

    splits: list[tuple[StructuredMetric, str, str, str]] = []
    undecomposed = []
    for source_metrics in by_source.values():
        prefix_bases: dict[str, set[str]] = defaultdict(set)
        for metric in source_metrics:
            basis = normalize_semantic_text(metric.value_basis)
            for synonym in map(normalize_semantic_text, synonyms.get(metric.code, [])):
                for length in range(1, len(synonym)):
                    prefix_bases[synonym[:length]].add(basis)
        for metric in source_metrics:
            for raw in synonyms.get(metric.code, []):
                split = _split(normalize_semantic_text(raw), prefix_bases)
                if split is None:
                    undecomposed.append({"metric_code": metric.code, "synonym": raw})
                else:
                    splits.append((metric, raw, *split))

    # 口径写法：同一写法只属于一个口径，且至少两个基础指标这样写。
    writing_sources: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for metric, _, _, writing in splits:
        basis = normalize_semantic_text(metric.value_basis)
        writing_sources[writing][basis].add(metric.source_metric_code)
    basis_aliases: dict[tuple[str, str], int] = {}
    for writing, owners in writing_sources.items():
        supported = {basis: sources for basis, sources in owners.items() if len(sources) >= 2}
        if len(supported) == 1:
            basis, sources = next(iter(supported.items()))
            if writing != basis:
                basis_aliases[(basis, writing)] = len(sources)
    accepted_writings = {
        basis: {writing for (owner, writing) in basis_aliases if owner == basis} | {basis}
        for basis in {normalize_semantic_text(m.value_basis) for m, *_ in splits}
    }

    base_support: dict[tuple[str, str], set[str]] = defaultdict(set)
    base_names = {source: items[0].base_name for source, items in by_source.items()}
    for metric, raw, prefix, writing in splits:
        basis = normalize_semantic_text(metric.value_basis)
        if writing not in accepted_writings.get(basis, set()):
            undecomposed.append({"metric_code": metric.code, "synonym": raw})
        elif prefix != normalize_semantic_text(metric.base_name):
            base_support[(metric.source_metric_code, prefix)].add(basis)

    owners_by_alias: dict[str, set[str]] = defaultdict(set)
    for source, alias in base_support:
        owners_by_alias[alias].add(source)
    # 别名恰为另一基础指标的正式名称时同样不能自动归属。
    for source, name in base_names.items():
        owners_by_alias[normalize_semantic_text(name)].add(source)
    base_aliases = []
    for (source, alias), bases in sorted(base_support.items()):
        others = sorted(owners_by_alias[alias] - {source})
        base_aliases.append({
            "source_metric_code": source, "base_name": base_names[source], "alias": alias,
            "value_bases": len(bases), "approved": not others,
            **({"conflict_sources": others} if others else {}),
        })
    sources_by_basis: dict[str, set[str]] = defaultdict(set)
    for source, items in by_source.items():
        for metric in items:
            sources_by_basis[normalize_semantic_text(metric.value_basis)].add(source)
    return {
        "value_basis_aliases": [
            {"value_basis": basis, "alias": writing, "sources": count,
             "of_sources": len(sources_by_basis[basis]), "approved": True}
            for (basis, writing), count in sorted(basis_aliases.items())
        ],
        "base_aliases": base_aliases,
        "undecomposed": undecomposed,
        "stats": {
            "structured_metrics": sum(len(items) for items in by_source.values()),
            "synonyms": sum(len(synonyms.get(metric.code, []))
                            for items in by_source.values() for metric in items),
            "undecomposed": len(undecomposed),
            "base_aliases": len(base_aliases),
            "base_alias_conflicts": sum(not item["approved"] for item in base_aliases),
        },
    }


def derive_alias_structure(
    metrics: Iterable[StructuredMetric], synonyms: dict[str, list[str]],
) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """识别索引使用的别名：源指标编码 → 基础别名，规范口径 → 口径写法；冲突项不采用。"""
    proposal = propose_alias_structure(metrics, synonyms)
    base: dict[str, set[str]] = defaultdict(set)
    for item in proposal["base_aliases"]:
        if item["approved"]:
            base[item["source_metric_code"]].add(item["alias"])
    basis: dict[str, set[str]] = defaultdict(set)
    for item in proposal["value_basis_aliases"]:
        basis[item["value_basis"]].add(item["alias"])
    return base, basis
