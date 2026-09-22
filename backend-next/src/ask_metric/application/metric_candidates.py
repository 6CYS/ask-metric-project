"""目录词典、拼音和字符召回。完整名称优先，唯一最高匹配达到95%可自动确定。"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from math import log
from threading import Lock

from hanlp_trie import Trie
from pypinyin import lazy_pinyin
from rapidfuzz.fuzz import partial_ratio_alignment, ratio

from ask_metric.domain.metric_matching import _normalize_with_index, normalize_semantic_text
from ask_metric.domain.semantics import MetricCatalogItem

METRIC_AUTO_SELECT_THRESHOLD = 0.95


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
        exact: dict[str, set[str]] = defaultdict(set)
        for item in items:
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
        return [
            {
                "start": positions[start],
                "end": positions[end - 1] + 1,
                "text": question[positions[start] : positions[end - 1] + 1],
                "codes": codes,
            }
            for start, end, codes in sorted(selected)
        ]

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
            resolution = (
                {
                    "status": "resolved",
                    "value": {"codes": codes, "names": [self.items[code].name for code in codes]},
                }
                if len(codes) == 1
                else {
                    "status": "ambiguous",
                    "candidates": [
                        {"value": self.items[code].name, "code": code} for code in codes
                    ],
                }
            )
            result.append(
                {
                    "text": match["text"],
                    "start": match["start"],
                    "end": match["end"],
                    "resolution": resolution,
                }
            )
        remaining = [
            hit
            for hit in approximate
            if not any(
                hit["metadata"]["start"] < match["end"] and hit["metadata"]["end"] > match["start"]
                for match in exact
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
            )
            for code, name, aliases, description, explanation in snapshot
        ]
    )


_index_lock = Lock()


def metric_candidate_index(items: Sequence[MetricCatalogItem]) -> MetricCandidateIndex:
    snapshot = tuple(
        sorted(
            (item.code, item.name, tuple(item.aliases), item.description, item.explanation)
            for item in items
        )
    )
    # 同一目录内容共享不可变索引；变化即换版本，构建锁避免并发冷启动重复建索引。
    with _index_lock:
        return _index(snapshot)
