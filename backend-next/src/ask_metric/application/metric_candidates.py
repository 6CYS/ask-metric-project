"""目录词典、拼音和字符召回。完整名称优先，唯一最高匹配达到95%可自动确定。"""

import re
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from math import log
from threading import Lock

from hanlp_trie import Trie
from pypinyin import lazy_pinyin
from rapidfuzz.fuzz import partial_ratio_alignment, ratio

from ask_metric.domain.metric_matching import (
    _normalize_with_index,
    more_specific_name_codes,
    normalize_semantic_text,
)
from ask_metric.domain.semantics import MetricCatalogItem

METRIC_AUTO_SELECT_THRESHOLD = 0.95
_ELLIPSIS_JOINERS = re.compile(r"(?:和|及|与|以及|还有|跟|的)*$")
# 与 _normalize_with_index 的剔除集一致：按原文标点与空白把问题切成候选分段。
_PREFIX_SEGMENTS = re.compile(r"[^\s,，。！？?：:；;、（）()【】\[\]「」『』“”\"'`]+")


def unique_high_confidence_candidate(hits: list[dict]) -> dict | None:
    """阈值是相似度策略，不是概率；同码合并、并列最高仍需用户消歧。"""
    by_code: dict[str, dict] = {}
    for hit in hits:
        if hit["code"] not in by_code or hit.get("score", 0) > by_code[hit["code"]].get("score", 0):
            by_code[hit["code"]] = hit
    ordered = sorted(by_code.values(), key=lambda hit: -hit.get("score", 0))
    if not ordered or ordered[0].get("score", 0) < METRIC_AUTO_SELECT_THRESHOLD:
        return None
    if len(ordered) > 1 and ordered[0]["score"] == ordered[1].get("score", 0):
        return None
    return ordered[0]


def _grams(text: Sequence, width: int = 2) -> set[tuple]:
    return {tuple(text[i : i + width]) for i in range(max(0, len(text) - width + 1))}


@dataclass(frozen=True)
class _Term:
    code: str
    text: str
    phonetic: tuple[str, ...]


class MetricCandidateIndex:
    """不可变目录快照；Trie 保存一词多码，不能用字典覆盖同名或同别名指标。"""

    def __init__(self, items: Sequence[MetricCatalogItem]):
        self.items = {item.code: item for item in items}
        self.terms: list[_Term] = []
        self.terms_by_code: dict[str, list[_Term]] = defaultdict(list)
        self.words: dict[tuple, set[int]] = defaultdict(set)
        self.sounds: dict[tuple, set[int]] = defaultdict(set)
        self.descriptions: dict[tuple, set[str]] = defaultdict(set)
        # 只使用源目录已证实的基础名称与取值口径，人工指标不拆词猜测。
        self.variants: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        self.sources_by_base: dict[str, set[str]] = defaultdict(set)
        self.source_by_code: dict[str, str] = {}
        self.names_without_source: dict[str, list[tuple[str, str]]] = defaultdict(list)
        exact: dict[str, set[str]] = defaultdict(set)
        for item in items:
            base = normalize_semantic_text(item.base_name or "")
            basis = normalize_semantic_text(item.value_basis or "")
            if (item.source_metric_code and base and basis
                    and base + basis == normalize_semantic_text(item.name)):
                self.variants[base][basis].add(item.code)
                self.sources_by_base[base].add(item.source_metric_code)
                self.source_by_code[item.code] = item.source_metric_code
            else:
                name = normalize_semantic_text(item.name)
                if len(name) >= 3:
                    self.names_without_source[name[:3]].append((item.code, name))
            for text in dict.fromkeys(
                normalize_semantic_text(t) for t in [item.name, *item.aliases]
            ):
                if not text:
                    continue
                exact[text].add(item.code)
                index = len(self.terms)
                phonetic = tuple(lazy_pinyin(text, errors=lambda value: list(value)))
                self.terms.append(_Term(item.code, text, phonetic))
                self.terms_by_code[item.code].append(self.terms[-1])
                for gram in _grams(text):
                    self.words[gram].add(index)
                for gram in _grams(phonetic):
                    self.sounds[gram].add(index)
            description = normalize_semantic_text(item.description + item.explanation)
            for gram in _grams(description):
                self.descriptions[gram].add(item.code)
        self.trie = Trie({text: sorted(codes) for text, codes in exact.items()})
        # 前缀索引：归一化名称/别名的有序表 + 文本到编码集合，供整段严格前缀查询按编码去重。
        self._codes_by_term_text = {text: sorted(codes) for text, codes in exact.items()}
        self._sorted_term_texts = sorted(self._codes_by_term_text)
        self.base_trie = Trie({base: True for base in self.variants}) if self.variants else None
        bases = {basis for variants in self.variants.values() for basis in variants}
        self.basis_trie = Trie({basis: True for basis in bases}) if bases else None

    def exact(self, question: str) -> list[dict]:
        text, positions = _normalize_with_index(question)
        # 所有命中中选择最大跨度；同跨度保留全部编码，较短别名不能覆盖完整名称。
        matches = sorted(self.trie.parse(text), key=lambda hit: (-(hit[1] - hit[0]), hit[0]))
        selected = []
        for start, end, codes in matches:
            if any(start >= left and end <= right for left, right, _ in selected):
                continue
            # 交叉而非包含的完整名称不能按长度擅自二选一，合并为歧义片段。
            overlaps = [
                (left, right, other)
                for left, right, other in selected
                if start < right and end > left
            ]
            for left, right, other in overlaps:
                selected.remove((left, right, other))
                start, end = min(start, left), max(end, right)
                codes = sorted(set(codes) | set(other))
            selected.append((start, end, codes))
        term_pairs = [(term.code, term.text) for term in self.terms]
        result = []
        previous_end = 0
        for start, end, codes in sorted(selected):
            # 唯一命中却是某更长完整名称内部的短别名时，列出更具体编码供上层降级消歧。
            # 完整正式名称本身（片段等于正式名归一化）是权威命中，不降级。
            is_alias_hit = (
                len(codes) == 1
                and normalize_semantic_text(self.items[codes[0]].name) != text[start:end]
            )
            more_specific = (
                # 同一编码的短别名后面也可能跟着尚未说完的正式名称；不能静默忽略尾部。
                more_specific_name_codes(text, start, end, "", term_pairs)
                if is_alias_hit else []
            )
            if more_specific:
                # 短别名若落在更长的用户原文中，澄清对象应是完整原文片段，而非末尾短词。
                right_context = self._alias_right_context(text, start, end, more_specific)
                start = max(
                    previous_end, start - self._alias_left_context(text, start, end, more_specific)
                )
                end = min(len(text), end + right_context)
            result.append({
                "start": positions[start],
                "end": positions[end - 1] + 1,
                "text": question[positions[start] : positions[end - 1] + 1],
                "codes": codes,
                "more_specific": more_specific,
            })
            previous_end = end
        return result

    def _alias_left_context(self, text: str, start: int, end: int, codes: list[str]) -> int:
        matched = text[start:end]
        longest = 0
        for code in codes:
            for term in self.terms_by_code[code]:
                offset = term.text.find(matched)
                while offset >= 0:
                    length = 0
                    while (length < min(start, offset)
                           and text[start - length - 1] == term.text[offset - length - 1]):
                        length += 1
                    longest = max(longest, length)
                    offset = term.text.find(matched, offset + 1)
        return longest

    def _alias_right_context(self, text: str, start: int, end: int, codes: list[str]) -> int:
        matched = text[start:end]
        longest = 0
        for code in codes:
            for term in self.terms_by_code[code]:
                offset = term.text.find(matched)
                while offset >= 0:
                    length = 0
                    tail = offset + len(matched)
                    while (end + length < len(text) and tail + length < len(term.text)
                           and text[end + length] == term.text[tail + length]):
                        length += 1
                    longest = max(longest, length)
                    offset = term.text.find(matched, offset + 1)
        return longest

    def candidates(self, question: str, *, limit: int = 10) -> list[dict]:
        text, positions = _normalize_with_index(question)
        if len(text) < 2:
            return []
        phonetic = tuple(lazy_pinyin(text, errors=lambda value: list(value)))
        votes: dict[int, float] = defaultdict(float)
        for grams, index in [(_grams(text), self.words), (_grams(phonetic), self.sounds)]:
            for gram in grams:
                postings = index.get(gram, ())
                weight = log(1 + len(self.terms) / (1 + len(postings)))
                for term_id in postings:
                    votes[term_id] += weight
        # 先倒排召回再计算相似度，避免对全目录逐条执行模糊比较。
        shortlisted = sorted(votes, key=lambda key: (-votes[key], key))[:200]
        hits: dict[str, dict] = {}
        for term_id in shortlisted:
            term = self.terms[term_id]
            if len(text) >= 3 and text in term.text and text != term.text:
                hits.setdefault(
                    term.code,
                    {
                        "value": self.items[term.code].name,
                        "code": term.code,
                        "score": 0.7,
                        "metadata": {
                            "match": "partial",
                            "start": positions[0],
                            "end": positions[-1] + 1,
                        },
                    },
                )
            for query, value, reason in [
                (text, term.text, "character"),
                (phonetic, term.phonetic, "pinyin"),
            ]:
                alignment = partial_ratio_alignment(value, query, score_cutoff=70)
                if alignment is None:
                    continue
                start, end = alignment.dest_start, alignment.dest_end
                coverage = (end - start) / len(value)
                # partial_ratio 的短子串满分不代表完整指标，须检查覆盖长度。
                score = alignment.score / 100 * min(1, coverage)
                if score < (0.84 if reason == "pinyin" else 0.72):
                    continue
                if len(value) < 3 and score < 1:
                    continue
                hit = {
                    "value": self.items[term.code].name,
                    "code": term.code,
                    "score": round(score, 4),
                    "metadata": {
                        "match": reason,
                        "term": term.text,
                        "start": positions[start],
                        "end": positions[end - 1] + 1,
                    },
                }
                previous = hits.get(term.code)
                if previous is None or hit["score"] > previous["score"]:
                    hits[term.code] = hit

        # 目录解释的字符二元组检索支持描述式提问；此分数永远不能升级为确定匹配。
        description_scores: dict[str, float] = defaultdict(float)
        description_counts: dict[str, int] = defaultdict(int)
        for gram in _grams(text):
            postings = self.descriptions.get(gram, ())
            weight = log(1 + len(self.items) / (1 + len(postings)))
            for code in postings:
                description_scores[code] += weight
                description_counts[code] += 1
        for code in sorted(description_scores, key=lambda c: (-description_scores[c], c))[:limit]:
            if code not in hits and description_counts[code] >= 2:
                hits[code] = {
                    "value": self.items[code].name,
                    "code": code,
                    "score": round(
                        min(0.79, description_scores[code] / (10 + description_scores[code])), 4
                    ),
                    "metadata": {"match": "description", "start": 0, "end": len(question)},
                }
        return sorted(
            hits.values(),
            key=lambda hit: (
                -hit["score"],
                -(hit["metadata"]["end"] - hit["metadata"]["start"]),
                hit["code"],
            ),
        )[:limit]

    def _extends_exact(self, hit: dict, match: dict, question: str) -> bool:
        """只有原文确有更长名称的相邻文字，才允许模糊长词替代精确短词。

        partial_ratio 可能把“是多少”等尾文吸入跨度，不能仅凭跨度更长判定原指标不完整。
        """
        term = hit["metadata"].get("term", "")
        fragment = normalize_semantic_text(
            question[hit["metadata"]["start"]:hit["metadata"]["end"]]
        )
        if (hit["metadata"].get("match") == "pinyin" and hit["score"] >= .95
                and len(fragment) == len(term)):
            # 完整同音词覆盖短别名时，沿用既有高分错字判定；截断名称没有完整跨度。
            return True
        exact = normalize_semantic_text(match["text"])
        offset = term.find(exact)
        if offset < 0:
            return False
        before = normalize_semantic_text(question[: match["start"]])
        after = normalize_semantic_text(question[match["end"] :])
        left, right = term[:offset], term[offset + len(exact) :]
        return bool(
            left and before and left[-1] == before[-1] or right and after and right[0] == after[0]
        )

    def resolve_candidates(self, text: str, hits: list[dict]) -> dict:
        """对完整片段重新计分，短名称的局部100%不能充当整体匹配100%。"""
        normalized = normalize_semantic_text(text)
        phonetic = tuple(lazy_pinyin(normalized, errors=lambda value: list(value)))
        rescored = []
        for hit in hits:
            if hit["metadata"].get("match") == "description":
                rescored.append(hit)
                continue
            score = max(
                (
                    max(ratio(term.text, normalized), ratio(term.phonetic, phonetic)) / 100
                    for term in self.terms_by_code[hit["code"]]
                ),
                default=0,
            )
            rescored.append({**hit, "score": score})
        rescored.sort(key=lambda hit: (-hit.get("score", 0), hit["code"]))
        selected = unique_high_confidence_candidate(rescored)
        if selected:
            return {
                "status": "resolved",
                "value": {"codes": [selected["code"]], "names": [selected["value"]]},
                "metadata": {
                    "match": "high_confidence",
                    "score": selected["score"],
                    "autoSelectThreshold": METRIC_AUTO_SELECT_THRESHOLD,
                },
            }
        return {"status": "needs_confirmation", "candidates": rescored}

    def mentions(self, question: str) -> list[dict]:
        exact = self.exact(question)
        approximate = self.candidates(question)
        # 若完整错字词覆盖了短名称，不能悄悄执行短名称对应的另一指标。
        extensions = [
            hit
            for hit in approximate
            if hit["metadata"]["match"] != "description"
            and hit["score"] >= 0.84
            and any(
                hit["code"] not in match["codes"]
                and hit["metadata"]["start"] <= match["start"]
                and hit["metadata"]["end"] >= match["end"]
                and hit["metadata"]["end"] - hit["metadata"]["start"]
                > match["end"] - match["start"]
                and self._extends_exact(hit, match, question)
                for match in exact
            )
        ]
        exact = [
            match
            for match in exact
            if not any(
                hit["metadata"]["start"] <= match["start"]
                and hit["metadata"]["end"] >= match["end"]
                for hit in extensions
            )
        ]
        result = []
        for match in exact:
            codes = match["codes"]
            more_specific = match.get("more_specific") or []
            if more_specific:
                # 短别名落在用户尚未说完整的更具体名称内部：不静默取短别名指标，交由上层确认。
                resolution = {
                    "status": "needs_confirmation",
                    "candidates": [
                        {"value": self.items[code].name, "code": code} for code in more_specific
                    ],
                }
            elif len(codes) == 1:
                resolution = {
                    "status": "resolved",
                    "value": {"codes": codes, "names": [self.items[code].name for code in codes]},
                }
            else:
                resolution = {
                    "status": "ambiguous",
                    "candidates": [
                        {"value": self.items[code].name, "code": code} for code in codes
                    ],
                }
            result.append(
                {
                    "text": match["text"],
                    "start": match["start"],
                    "end": match["end"],
                    "resolution": resolution,
                }
            )
        result.extend(self._structured_mentions(question, result))
        result.extend(self._catalog_name_ellipsis_mentions(question, result))
        result.extend(self._prefix_segment_mentions(question, result))
        remaining = [
            hit
            for hit in approximate
            if not any(
                hit["metadata"]["start"] < match["end"] and hit["metadata"]["end"] > match["start"]
                for match in result
            )
        ]
        # 候选跨度重叠时是一组待确认项；不同位置保留多组，不丢掉混合精确/错字查询。
        groups: list[dict] = []
        for hit in remaining:
            start, end = hit["metadata"]["start"], hit["metadata"]["end"]
            overlapping = [g for g in groups if start < g["end"] and end > g["start"]]
            if overlapping:
                group = overlapping[0]
                for other in overlapping[1:]:
                    group["candidates"].extend(other["candidates"])
                    group["start"], group["end"] = (
                        min(group["start"], other["start"]),
                        max(group["end"], other["end"]),
                    )
                    groups.remove(other)
                group["start"], group["end"] = min(start, group["start"]), max(end, group["end"])
                group["candidates"].append(hit)
            else:
                groups.append({"start": start, "end": end, "candidates": [hit]})
        for group in groups:
            result.append(
                {
                    "text": question[group["start"] : group["end"]],
                    "start": group["start"],
                    "end": group["end"],
                    "resolution": self.resolve_candidates(
                        question[group["start"] : group["end"]], group["candidates"]
                    ),
                }
            )
        return sorted(result, key=lambda mention: mention["start"])

    def _catalog_name_ellipsis_mentions(self, question: str, protected: list[dict]) -> list[dict]:
        """旧目录没有源字段时，仅用唯一的正式全名补齐共用前缀的省略项。"""
        if not self.names_without_source:
            return []
        text, positions = _normalize_with_index(question)
        result: list[dict] = []
        anchors = sorted(protected, key=lambda mention: mention["start"])
        for index, anchor in enumerate(anchors):
            resolution = anchor["resolution"]
            codes = resolution.get("value", {}).get("codes", [])
            if resolution["status"] != "resolved" or len(codes) != 1:
                continue
            code = codes[0]
            if code in self.source_by_code:
                continue
            name = normalize_semantic_text(self.items[code].name)
            if name != normalize_semantic_text(anchor["text"]):
                continue
            start = bisect_left(positions, anchor["end"])
            boundary_start = (
                anchors[index + 1]["start"] if index + 1 < len(anchors) else len(question)
            )
            boundary = bisect_left(
                positions, boundary_start
            )
            variants: list[tuple[str, str, int]] = []
            for other_code, other_name in self.names_without_source.get(name[:3], []):
                if other_code == code:
                    continue
                shared = 0
                for left, right in zip(name, other_name, strict=False):
                    if left != right:
                        break
                    shared += 1
                # 旧目录没有源血缘，只在两个正式名称确有较长共用前缀时尝试省略。
                if shared >= 3 and len(name) - shared >= 2 and len(other_name) - shared >= 2:
                    variants.append((other_code, other_name[shared:], shared))
            cursor = start
            while cursor < boundary:
                choices: list[tuple[int, int, int, str]] = []
                for other_code, basis, shared in variants:
                    left = text.find(basis, cursor, boundary)
                    if left >= 0 and _ELLIPSIS_JOINERS.fullmatch(text[cursor:left]):
                        choices.append((left, left + len(basis), shared, other_code))
                if not choices:
                    break
                # 连续省略按原文顺序消费；同一位置优先完整口径，再用共用前缀消歧。
                first = min(left for left, _, _, _ in choices)
                last = max(right for left, right, _, _ in choices if left == first)
                same_span = [(shared, other_code) for left, right, shared, other_code
                             in choices if left == first and right == last]
                strongest = max(shared for shared, _ in same_span)
                codes = sorted({other_code for shared, other_code in same_span
                                if shared == strongest})
                left, right = positions[first], positions[last - 1] + 1
                resolution = ({"status": "resolved", "value": {"codes": codes,
                               "names": [self.items[item].name for item in codes]}}
                              if len(codes) == 1 else
                              {"status": "ambiguous", "candidates": [
                                  {"code": item, "value": self.items[item].name}
                                  for item in codes]})
                result.append({
                    "text": question[left:right], "start": left, "end": right,
                    "resolution": resolution, "source": {"kind": "catalog_name_completion"},
                })
                cursor = last
        return result

    def _prefix_segment_mentions(self, question: str, protected: list[dict]) -> list[dict]:
        """整段是目录名称/别名严格前缀的分段：用户省略了名称尾部的取值口径。

        与省略补全通道并列，不改模糊评分阈值；段等于完整名称时由精确通道处理，这里跳过。
        """
        result: list[dict] = []
        for segment in _PREFIX_SEGMENTS.finditer(question):
            start, end = segment.span()
            if any(start < mention["end"] and end > mention["start"] for mention in protected):
                continue
            normalized = normalize_semantic_text(segment.group())
            # 过短前缀误报面太大（如“各项存款”类通用词头），低于4字不进本通道。
            if len(normalized) < 4:
                continue
            codes = self._strict_prefix_codes(normalized)
            if not codes:
                continue
            if len(codes) == 1:
                resolution = {
                    "status": "resolved",
                    "value": {
                        "codes": codes,
                        "names": [self.items[code].name for code in codes],
                    },
                }
            else:
                resolution = {
                    "status": "needs_confirmation",
                    "candidates": [
                        {"value": self.items[code].name, "code": code} for code in codes
                    ],
                }
            result.append({
                "text": question[start:end], "start": start, "end": end,
                "resolution": resolution,
                "source": {"kind": "catalog_name_prefix"},
            })
        return result

    def _strict_prefix_codes(self, prefix: str) -> list[str]:
        """返回以 prefix 为严格前缀（不含全等）的归一化名称/别名对应编码，按编码去重排序。"""
        codes: set[str] = set()
        texts = self._sorted_term_texts
        index = bisect_left(texts, prefix)
        while index < len(texts) and texts[index].startswith(prefix):
            if texts[index] != prefix:
                codes.update(self._codes_by_term_text[texts[index]])
            index += 1
        return sorted(codes)

    def _structured_mentions(self, question: str, protected: list[dict]) -> list[dict]:
        """在已出现的基础名称范围内查找源端口径，完整名称仍优先。"""
        if self.base_trie is None or self.basis_trie is None:
            return []
        text, positions = _normalize_with_index(question)
        anchors = sorted(self.base_trie.parse(text), key=lambda hit: (hit[0], -(hit[1] - hit[0])))
        selected: list[tuple[int, int, str]] = []
        for start, end, _ in anchors:
            if selected and start < selected[-1][1]:
                continue
            selected.append((start, end, text[start:end]))
        result: list[dict] = []
        for index, (start, end, base) in enumerate(selected):
            boundary = selected[index + 1][0] if index + 1 < len(selected) else len(text)
            base_left, base_right = positions[start], positions[end - 1] + 1
            anchored_sources = {
                self.source_by_code[code]
                for mention in protected
                if mention["start"] <= base_left and mention["end"] >= base_right
                for code in mention["resolution"].get("value", {}).get("codes", [])
                if code in self.source_by_code
            }
            source = next(iter(anchored_sources)) if len(anchored_sources) == 1 else None
            hits = [(end + left, end + right, text[end + left:end + right])
                    for left, right, _ in self.basis_trie.parse(text[end:boundary])]
            hits.sort(key=lambda hit: (hit[0], hit[2] not in self.variants[base],
                                       -(hit[1] - hit[0])))
            # 完整正式名称已被精确匹配保护时，从其末尾继续找后续口径。
            accepted_end = end
            for mention in protected:
                mention_codes = mention["resolution"].get("value", {}).get("codes", [])
                if (mention["start"] <= base_left and mention["end"] >= base_right
                        and mention["resolution"]["status"] == "resolved"
                        and any(code in self.source_by_code for code in mention_codes)):
                    accepted_end = max(accepted_end, bisect_left(positions, mention["end"]))
            for left_index, right_index, basis in hits:
                if left_index < accepted_end:
                    continue
                # 来源关系只能在连续口径列表内沿用；遇到别的实体就结束当前基础指标。
                if not _ELLIPSIS_JOINERS.fullmatch(text[accepted_end:left_index]):
                    break
                left, right = positions[left_index], positions[right_index - 1] + 1
                if any(left < mention["end"] and right > mention["start"]
                       for mention in [*protected, *result]):
                    continue
                accepted_end = right_index
                ordered = sorted(code for code in self.variants[base].get(basis, ())
                                 if source is None or self.source_by_code[code] == source)
                lineage_uncertain = source is None and len(self.sources_by_base[base]) > 1
                if len(ordered) == 1 and not lineage_uncertain:
                    resolution = {"status": "resolved", "value": {
                        "codes": ordered, "names": [self.items[ordered[0]].name]}}
                elif ordered:
                    resolution = {
                        "status": "needs_confirmation" if lineage_uncertain else "ambiguous",
                        "candidates": [
                            {"code": code, "value": self.items[code].name} for code in ordered
                        ],
                    }
                else:
                    resolution = {"status": "needs_confirmation", "candidates": []}
                result.append({
                    "text": question[left:right], "start": left, "end": right,
                    "resolution": resolution,
                    "source": {"kind": "catalog_base_basis", "base_start": base_left,
                               "base_end": base_right},
                })
        return result


@lru_cache(maxsize=2)
def _index(snapshot: tuple) -> MetricCandidateIndex:
    return MetricCandidateIndex(
        [
            MetricCatalogItem(
                code=code,
                name=name,
                aliases=list(aliases),
                description=description,
                explanation=explanation,
                source_metric_code=source_code,
                base_name=base,
                value_basis=basis,
            )
            for code, name, aliases, description, explanation, source_code, base, basis in snapshot
        ]
    )


_index_lock = Lock()


def metric_candidate_index(items: Sequence[MetricCatalogItem]) -> MetricCandidateIndex:
    snapshot = tuple(
        sorted(
            (item.code, item.name, tuple(item.aliases), item.description, item.explanation,
             item.source_metric_code, item.base_name, item.value_basis)
            for item in items
        )
    )
    # 同一目录内容共享不可变索引；变化即换版本，构建锁避免并发冷启动重复建索引。
    with _index_lock:
        return _index(snapshot)


@dataclass(frozen=True)
class _ScoredMetricCandidate:
    item: MetricCatalogItem
    score: float


def _lexical_metric_candidates(
    question: str,
    metrics: list[MetricCatalogItem],
    *,
    limit: int,
) -> list[_ScoredMetricCandidate]:
    normalized_question = normalize_semantic_text(question)
    if not normalized_question:
        return []
    scored: list[tuple[float, str, MetricCatalogItem]] = []
    for item in metrics:
        terms = [item.name, *item.aliases]
        score = max(
            (
                SequenceMatcher(
                    None,
                    normalized_question,
                    normalize_semantic_text(term),
                ).ratio()
                for term in terms
                if normalize_semantic_text(term)
            ),
            default=0.0,
        )
        if score >= 0.55:
            scored.append((score, item.code, item))
    scored.sort(key=lambda value: (-value[0], value[1]))
    return [
        _ScoredMetricCandidate(item=item, score=score)
        for score, _, item in scored[:limit]
    ]
