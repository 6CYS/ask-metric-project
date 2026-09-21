from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from ask_metric.domain.semantics import MetricCatalogItem, MetricMatch


@dataclass(frozen=True)
class _TextTerm:
    item: MetricCatalogItem
    text: str
    normalized: str
    source: str
    source_priority: int


@dataclass(frozen=True)
class MetricResolution:
    matches: list[MetricMatch]
    ambiguous_candidates: list[MetricCatalogItem]
    # 已识别为完整目录名称/别名，只是编码有歧义；保护文字不等于选择指标。
    ambiguous_spans: list[tuple[int, int]] = field(default_factory=list)


def normalize_semantic_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\s,，。！？?：:；;、（）()【】\[\]「」『』“”\"'`]+", "", normalized)


class MetricMatcher:
    def __init__(self, catalog: list[MetricCatalogItem]) -> None:
        self.catalog = catalog
        self.terms = self._build_terms(catalog)

    def exact_candidates(self, text: str) -> list[MetricCatalogItem]:
        normalized = normalize_semantic_text(text)
        standard = [
            term.item
            for term in self.terms
            if term.source_priority == 0 and term.normalized == normalized
        ]
        aliases = [
            term.item
            for term in self.terms
            if term.source_priority == 1 and term.normalized == normalized
        ]
        return deduplicate_metrics(standard + aliases)

    def match(self, text: str) -> list[MetricMatch]:
        return self.resolve(text).matches

    def resolve(self, text: str) -> MetricResolution:
        normalized_text, index_map = _normalize_with_index(text)
        candidates: list[tuple[int, int, _TextTerm]] = []
        for term in self.terms:
            if not term.normalized:
                continue
            start = 0
            while True:
                position = normalized_text.find(term.normalized, start)
                if position < 0:
                    break
                candidates.append((position, position + len(term.normalized), term))
                start = position + 1
        # lambda value: (...) 是返回排序键的小函数；元组各项从左到右比较。
        # 负长度让长名称排前面，再按正式名称优先、出现位置、指标编码稳定排序。
        candidates.sort(
            key=lambda value: (
                -(value[1] - value[0]),
                value[2].source_priority,
                value[0],
                value[2].item.code,
            )
        )
        ambiguous_codes: set[str] = set()
        grouped: dict[tuple[int, int, str], list[_TextTerm]] = {}
        for start, end, term in candidates:
            grouped.setdefault((start, end, term.normalized), []).append(term)
        preferred_terms = {
            key: [
                term
                for term in terms
                if term.source_priority == min(item.source_priority for item in terms)
            ]
            for key, terms in grouped.items()
        }
        ambiguous_intervals = {
            (start, end)
            for (start, end, _), terms in preferred_terms.items()
            if len({term.item.code for term in terms}) > 1
        }
        for (start, end, _), terms in grouped.items():
            if (start, end) in ambiguous_intervals:
                ambiguous_codes.update(
                    term.item.code
                    for term in preferred_terms[(start, end, terms[0].normalized)]
                )

        selected: list[tuple[int, int, _TextTerm]] = []
        for start, end, term in candidates:
            if any(
                start < ambiguous_end and end > ambiguous_start
                for ambiguous_start, ambiguous_end in ambiguous_intervals
            ):
                continue
            overlaps = any(
                start < existing_end and end > existing_start
                for existing_start, existing_end, _ in selected
            )
            if overlaps:
                continue
            selected.append((start, end, term))
        selected.sort(key=lambda value: value[0])
        matches: list[MetricMatch] = []
        for start, end, term in selected:
            if term.source == "alias":
                more_specific = self._partial_alias_candidates(normalized_text, start, end, term)
                if more_specific:
                    ambiguous_codes.update(item.code for item in more_specific)
                    continue
            original_start = index_map[start]
            original_end = index_map[end - 1] + 1
            matches.append(
                MetricMatch(
                    code=term.item.code,
                    name=term.item.name,
                    matched_text=text[original_start:original_end],
                    start=original_start,
                    end=original_end,
                    source="standard_name" if term.source_priority == 0 else "alias",
                    exact=normalized_text == term.normalized,
                )
            )
        protected_intervals = set(ambiguous_intervals)
        for (start, end, _), terms in preferred_terms.items():
            if (start, end) not in protected_intervals:
                continue
            for term in terms:
                if term.source != "alias":
                    continue
                if self._partial_alias_candidates(normalized_text, start, end, term):
                    # 共享短别名也不能掩盖用户尚未说完整的更具体名称。
                    protected_intervals.discard((start, end))
                    break
        return MetricResolution(
            matches=matches,
            ambiguous_candidates=[item for item in self.catalog if item.code in ambiguous_codes],
            ambiguous_spans=[
                (index_map[start], index_map[end - 1] + 1)
                for start, end in sorted(protected_intervals)
            ],
        )

    def _partial_alias_candidates(
        self, text: str, start: int, end: int, matched: _TextTerm,
    ) -> list[MetricCatalogItem]:
        """Do not protect a short alias inside an unfinished, more specific catalog name."""
        strongest_extension = 0
        candidates: list[MetricCatalogItem] = []
        for term in self.terms:
            if term.item.code == matched.item.code or len(term.normalized) <= end - start:
                continue
            offset = term.normalized.find(matched.normalized)
            while offset >= 0:
                left = 0
                while (left < min(start, offset)
                       and text[start - left - 1] == term.normalized[offset - left - 1]):
                    left += 1
                right = 0
                suffix = offset + end - start
                while (end + right < len(text) and suffix + right < len(term.normalized)
                       and text[end + right] == term.normalized[suffix + right]):
                    right += 1
                extension = left + right
                if extension > strongest_extension:
                    strongest_extension = extension
                    candidates = [term.item]
                elif extension and extension == strongest_extension:
                    candidates.append(term.item)
                offset = term.normalized.find(matched.normalized, offset + 1)
        return deduplicate_metrics(candidates)

    def protect(self, text: str, matches: list[MetricMatch]) -> str:
        """标记已确认的指标名称，避免名称中的“排名”等文字被误读为查询操作。"""
        output: list[str] = []
        cursor = 0
        for match in sorted(matches, key=lambda item: item.start):
            output.append(text[cursor : match.start])
            output.append(f'<METRIC code="{match.code}">{text[match.start:match.end]}</METRIC>')
            cursor = match.end
        output.append(text[cursor:])
        return "".join(output)

    @staticmethod
    def _build_terms(catalog: list[MetricCatalogItem]) -> list[_TextTerm]:
        terms: list[_TextTerm] = []
        seen: set[tuple[str, str, str]] = set()
        for item in catalog:
            item_terms = [(item.name, "standard_name", 0)]
            item_terms.extend((alias, "alias", 1) for alias in item.aliases)
            for text, source, priority in item_terms:
                normalized = normalize_semantic_text(text)
                key = (item.code, normalized, source)
                if not normalized or key in seen:
                    continue
                seen.add(key)
                terms.append(_TextTerm(item, text, normalized, source, priority))
        return terms


def _normalize_with_index(text: str) -> tuple[str, list[int]]:
    normalized_chars: list[str] = []
    index_map: list[int] = []
    for index, character in enumerate(text):
        value = unicodedata.normalize("NFKC", character).lower()
        for normalized_character in value:
            if re.match(
                r"[\s,，。！？?：:；;、（）()【】\[\]「」『』“”\"'`]",
                normalized_character,
            ):
                continue
            normalized_chars.append(normalized_character)
            index_map.append(index)
    return "".join(normalized_chars), index_map


def deduplicate_metrics(items: list[MetricCatalogItem]) -> list[MetricCatalogItem]:
    """按正式编码去重，保留第一次出现的对象及顺序，不改变候选优先级。"""
    values: dict[str, MetricCatalogItem] = {}
    for item in items:
        # setdefault 只在键不存在时写入；直接赋值则会覆盖前面优先级更高的对象。
        values.setdefault(item.code, item)
    return list(values.values())


def conflicting_metric_references(
    question: str, selected_codes: list[str], catalog: list[MetricCatalogItem],
) -> list[tuple[MetricCatalogItem, MetricMatch]]:
    """校验明确完整名称被另一指标短名称/别名替代的冲突，不承担工具选择或编码替换。"""
    matches = MetricMatcher(catalog).resolve(question).matches
    explicit_codes = {match.code for match in matches}
    conflicts = []
    for item in catalog:
        if item.code not in selected_codes or item.code in explicit_codes:
            continue
        # 用户明确提供编码时保持编码查询语义；自然语言的不完整指代仍由 pi 判断。
        if re.search(rf"(?<![\w]){re.escape(item.code)}(?![\w])", question, re.ASCII):
            continue
        terms = [normalize_semantic_text(term) for term in [item.name, *item.aliases]]
        for match in matches:
            full = normalize_semantic_text(match.matched_text)
            if match.source == "standard_name" and any(
                term and len(term) < len(full) and term in full for term in terms
            ):
                conflicts.append((item, match))
    return conflicts
