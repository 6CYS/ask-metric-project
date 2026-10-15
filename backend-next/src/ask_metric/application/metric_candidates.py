"""目录指标识别：完整名称最长优先，结构化目录按“基础指标 + 口径”组合识别。

只有目录数据和用户能确定指标：完整名称、基础指标加口径的精确组合直接确定；
缺口径、口径没说完、基础指标不确定时交用户确认。拼音完全相同且唯一对应一个
词条的片段与精确匹配一同参与最长匹配；基础指标单字纠错须通过全目录竞争、语义
限定和精确口径校验才可采用。其余模糊召回只决定是否提示候选和候选顺序。
"""

import re
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from math import log
from threading import Lock

from hanlp_trie import Trie
from rapidfuzz.distance import Levenshtein
from rapidfuzz.fuzz import partial_ratio_alignment

from ask_metric.application.metric_alias_structure import StructuredMetric, derive_alias_structure
from ask_metric.application.text_correction import (
    CorrectionTerm,
    compete_correction,
)
from ask_metric.application.text_correction import (
    phonetic as _phonetic,
)
from ask_metric.domain.metric_matching import _normalize_with_index, normalize_semantic_text
from ask_metric.domain.semantics import MetricCatalogItem

# 并列连接词；标点已在归一化时剔除，顿号、逗号分隔等价于空连接。
_JOINERS = re.compile(r"(?:和|及|与|以及|还有|跟|的)*")
_LEADING_JOINER = re.compile(r"(?:和|及|与|以及|还有|跟)$")
_CANDIDATE_LIMIT = 5
# 别名命中两侧、共用后半段向前回看的最大字数。
_CONTEXT_WINDOW = 8
_CORRECTION_MIN_LENGTH = 5
_CORRECTION_MIN_SCORE = .8
_CORRECTION_MIN_MARGIN = .15
# 数量、期限、单位、否定和范围属于用户条件，不因目录只剩一个相近词条就改写。
_NUMBER = r"[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟]+"
_PROTECTED_TERMS = re.compile(
    rf"百分之(?:\d+(?:\.\d+)?|{_NUMBER})|\d+(?:\.\d+)?|第{_NUMBER}"
    rf"|{_NUMBER}(?=年|月|日|天|周|季|期|倍|成|个|户|笔|次|项|名|家|岁|级)"
    r"|百分之|百分比|百分率|占比|比率|比例|%|‰"
    r"|不包含|未包含|不包括|未包括|不含|未含|包含|包括|剔除|排除|除外|纳入|不|未|非|无|含"
    r"|不低于|不少于|不超过|不高于|以上|以下|以内|以外|至少|至多|超过|低于|高于|[<>≤≥=]"
    r"|人民币|美元|欧元|港元|日元|[万亿千百]?元|[万亿千百]?户"
    r"|年度|季度|月度|日均|月均|年均|年|月|日|天|周|季|累计|平均|总|净|毛|全部|部分|内|外"
)

_Key = tuple[str, str]  # ("base", 源指标编码) 或 ("metric", 无结构指标编码)


def _item_terms(item: MetricCatalogItem) -> list[str]:
    terms = (normalize_semantic_text(term) for term in [item.name, *item.aliases])
    return [term for term in dict.fromkeys(terms) if term]


def _grams(text: Sequence, width: int = 2) -> set[tuple]:
    return {tuple(text[i : i + width]) for i in range(max(0, len(text) - width + 1))}


@dataclass(frozen=True)
class _Term:
    key: _Key
    text: str
    phonetic: tuple[str, ...]


@dataclass(frozen=True)
class _Span:
    start: int
    end: int
    # 0 完整名称/别名；1 基础指标紧跟口径；2 仅基础指标；3 拼音相同但对应多个词条
    kind: int
    codes: frozenset[str] = frozenset()
    sources: frozenset[str] = frozenset()
    base_end: int = 0
    canons: frozenset[str] = frozenset()
    keys: frozenset[_Key] = frozenset()
    homophone: bool = False
    # 命中的是别名而非正式名称；别名被更长的用户原文包住时不能静默采用。
    alias: bool = False


class MetricCandidateIndex:
    """不可变目录快照；一词多码全部保留，不能用字典覆盖同名或同别名指标。"""

    def __init__(self, items: Sequence[MetricCatalogItem]):
        self.items = {item.code: item for item in items}
        # 源指标编码 → 规范口径 → 指标编码；只收录“基础名称 + 口径 = 正式名称”的可信结构。
        self.variants: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        self.source_by_code: dict[str, str] = {}
        self.base_names: dict[str, str] = {}
        self.base_terms: dict[str, set[str]] = defaultdict(set)
        self.basis_terms: dict[str, set[str]] = defaultdict(set)
        self.full_terms: dict[str, set[str]] = defaultdict(set)
        structured: list[StructuredMetric] = []
        for item in items:
            name = normalize_semantic_text(item.name)
            for text in _item_terms(item):
                self.full_terms[text].add(item.code)
            base = normalize_semantic_text(item.base_name or "")
            basis = normalize_semantic_text(item.value_basis or "")
            if not (item.source_metric_code and base and basis and base + basis == name):
                continue
            source = item.source_metric_code
            self.variants[source][basis].add(item.code)
            self.source_by_code[item.code] = source
            self.base_names.setdefault(source, (item.base_name or "").strip())
            self.base_terms[base].add(source)
            self.basis_terms[basis].add(basis)
            structured.append(StructuredMetric(item.code, source, base, basis))
        # 基础别名与口径别名从“指标术语”维护的组合同义词推导，只存于内存，不另设维护入口。
        base_aliases, basis_aliases = derive_alias_structure(
            structured, {item.code: item.aliases for item in items}
        )
        for source, aliases in base_aliases.items():
            for alias in aliases:
                self.base_terms[alias].add(source)
        for basis, aliases in basis_aliases.items():
            for alias in aliases:
                self.basis_terms[alias].add(basis)
        self.full_trie = (
            Trie({text: sorted(codes) for text, codes in self.full_terms.items()})
            if self.full_terms else None
        )
        self.base_trie = (
            Trie({text: sorted(sources) for text, sources in self.base_terms.items()})
            if self.base_terms else None
        )
        self._basis_max = max(map(len, self.basis_terms), default=0)
        self._sorted_basis_texts = sorted(self.basis_terms)

        # 模糊与同音词条：结构化目录只到基础指标，口径永远精确匹配。
        self.terms: list[_Term] = []
        for text, sources in self.base_terms.items():
            for source in sorted(sources):
                self.terms.append(_Term(("base", source), text, _phonetic(text)))
        descriptions: dict[_Key, str] = defaultdict(str)
        for item in items:
            source = self.source_by_code.get(item.code)
            key = ("base", source) if source else ("metric", item.code)
            descriptions[key] += normalize_semantic_text(item.description + item.explanation)
            if source:
                continue
            for text in _item_terms(item):
                self.terms.append(_Term(key, text, _phonetic(text)))
        self.sound_terms: dict[tuple[str, ...], set[_Key]] = defaultdict(set)
        self.words: dict[tuple, set[int]] = defaultdict(set)
        self.sounds: dict[tuple, set[int]] = defaultdict(set)
        for index, term in enumerate(self.terms):
            if len(term.phonetic) == len(term.text):
                self.sound_terms[term.phonetic].add(term.key)
            for gram in _grams(term.text):
                self.words[gram].add(index)
            for gram in _grams(term.phonetic):
                self.sounds[gram].add(index)
        self._sound_lengths = sorted({len(sound) for sound in self.sound_terms}, reverse=True)
        self.descriptions: dict[tuple, set[_Key]] = defaultdict(set)
        for key, description in descriptions.items():
            for gram in _grams(description):
                self.descriptions[gram].add(key)
        self._description_keys = len(descriptions)

    # ---- 目录结构查询 ----

    def codes_for(self, sources: Iterable[str], canons: Iterable[str]) -> set[str]:
        canons = list(canons)
        return {code for source in sources for basis in canons
                for code in self.variants[source].get(basis, ())}

    def valid_canons(self, sources: Iterable[str]) -> set[str]:
        return {basis for source in sources for basis in self.variants[source]}

    def display(self, key: _Key) -> str:
        return self.base_names[key[1]] if key[0] == "base" else self.items[key[1]].name

    def _basis_at(self, text: str, start: int, boundary: int) -> tuple[int, set[str]] | None:
        """从 start 起的最长完整口径（含口径别名）。"""
        for length in range(min(self._basis_max, boundary - start), 0, -1):
            canons = self.basis_terms.get(text[start : start + length])
            if canons:
                return start + length, canons
        return None

    def _longer_basis_canons(self, prefix: str, sources: Iterable[str]) -> set[str]:
        """以 prefix 为严格前缀、且确属这些基础指标的口径。"""
        valid = self.valid_canons(sources)
        texts = self._sorted_basis_texts
        found: set[str] = set()
        position = bisect_left(texts, prefix)
        while position < len(texts) and texts[position].startswith(prefix):
            if texts[position] != prefix:
                found |= self.basis_terms[texts[position]] & valid
            position += 1
        return found

    def _unfinished_basis(
        self, text: str, positions: list[int], start: int, boundary: int,
        sources: Iterable[str], complete_end: int,
    ) -> tuple[int, set[str]] | None:
        """用户停在某个口径中途（如“较同期增”）：原文恰在更长口径的前缀处停顿。"""
        sources = list(sources)
        end, canons = start, set()
        while end < boundary:
            found = self._longer_basis_canons(text[start : end + 1], sources)
            if not found:
                break
            end, canons = end + 1, found
        if end > complete_end and canons and _is_pause(text, positions, end, boundary):
            return end, canons
        return None

    def _read_chain(
        self, text: str, positions: list[int], cursor: int, boundary: int, sources: Iterable[str],
    ) -> list[tuple[int, int, frozenset[str], bool]]:
        """基础指标之后以连接词相连的连续口径；遇到其他文字即停止。"""
        sources = list(sources)
        members = []
        while cursor < boundary:
            start = _JOINERS.match(text, cursor, boundary).end()
            hit = self._basis_at(text, start, boundary)
            unfinished = self._unfinished_basis(
                text, positions, start, boundary, sources, hit[0] if hit else start
            )
            if unfinished:
                members.append((start, unfinished[0], frozenset(unfinished[1]), True))
                cursor = unfinished[0]
            elif hit:
                members.append((start, hit[0], frozenset(hit[1]), False))
                cursor = hit[0]
            else:
                break
        return members

    # ---- 片段识别 ----

    def _base_spans(self, text: str, positions: list[int], start: int, end: int,
                    sources: frozenset[str], *, homophone: bool,
                    unfinished_names: set[tuple[int, int]]) -> list[_Span]:
        alias = not homophone and not any(
            normalize_semantic_text(self.base_names[source]) == text[start:end]
            for source in sources
        )
        spans = [_Span(start, end, 2, sources=sources, base_end=end,
                       homophone=homophone, alias=alias)]
        hit = self._basis_at(text, end, len(text))
        if hit and self._unfinished_basis(text, positions, end, len(text), sources, hit[0]):
            # 口径没说完时，同位置的完整正式名称（如“…较同期”）不能代替用户未说完的口径。
            unfinished_names.add((start, hit[0]))
            return spans
        codes = self.codes_for(sources, hit[1]) if hit else set()
        if codes:
            spans.append(_Span(start, hit[0], 1, frozenset(codes), sources, end,
                               frozenset(hit[1]), homophone=homophone, alias=alias))
        return spans

    def _homophone_spans(self, text: str, positions: list[int],
                         unfinished_names: set[tuple[int, int]]) -> list[_Span]:
        """拼音与目录词条完全相同、字数相同的片段按精确词典参与最长匹配。"""
        phonetic = _phonetic(text)
        if len(phonetic) != len(text):
            return []
        spans: list[_Span] = []
        for start in range(len(text)):
            for length in self._sound_lengths:
                end = start + length
                if end > len(text):
                    continue
                keys = self.sound_terms.get(phonetic[start:end])
                fragment = text[start:end]
                if not keys or fragment in self.base_terms or fragment in self.full_terms:
                    continue
                if len(keys) > 1:
                    spans.append(_Span(start, end, 3, keys=frozenset(keys), homophone=True))
                    continue
                kind, value = next(iter(keys))
                if kind == "metric":
                    spans.append(_Span(start, end, 0, frozenset({value}), homophone=True))
                else:
                    spans.extend(self._base_spans(
                        text, positions, start, end, frozenset({value}), homophone=True,
                        unfinished_names=unfinished_names,
                    ))
        return spans

    def _select(self, text: str, positions: list[int]) -> list[_Span]:
        spans: list[_Span] = []
        unfinished_names: set[tuple[int, int]] = set()
        if self.base_trie is not None:
            for start, end, sources in self.base_trie.parse(text):
                spans.extend(self._base_spans(
                    text, positions, start, end, frozenset(sources), homophone=False,
                    unfinished_names=unfinished_names,
                ))
        spans.extend(self._homophone_spans(text, positions, unfinished_names))
        if self.full_trie is not None:
            for start, end, codes in self.full_trie.parse(text):
                if (start, end) in unfinished_names:
                    continue
                alias = not any(normalize_semantic_text(self.items[code].name) == text[start:end]
                                for code in codes)
                base_end = start
                if len(codes) == 1 and not alias and codes[0] in self.source_by_code:
                    base_name = self.base_names[self.source_by_code[codes[0]]]
                    base_end = start + len(normalize_semantic_text(base_name))
                spans.append(_Span(start, end, 0, frozenset(codes), base_end=base_end,
                                   alias=alias))
        selected: list[_Span] = []
        ordered = sorted(spans, key=lambda item: (
            item.start - item.end, item.homophone, item.kind, item.start,
        ))
        for span in ordered:
            if any(other.start <= span.start and span.end <= other.end for other in selected):
                continue
            crossing = [other for other in selected
                        if span.start < other.end and span.end > other.start]
            if crossing:
                mergeable = [span, *crossing]
                if any(item.kind > 1 or item.homophone for item in mergeable):
                    continue
                # 交叉而非包含的完整名称不能按长度擅自二选一，合并为歧义片段。
                for other in crossing:
                    selected.remove(other)
                span = _Span(
                    min(item.start for item in mergeable), max(item.end for item in mergeable),
                    0, frozenset().union(*(item.codes for item in mergeable)),
                )
            selected.append(span)
        selected = [span for span in selected
                    if not self._alias_inside_longer_text(text, positions, span, selected)]
        return sorted(selected, key=lambda item: item.start)

    def _alias_inside_longer_text(self, text: str, positions: list[int], span: _Span,
                                  selected: list[_Span]) -> bool:
        """别名命中两侧紧连的文字能召回更长的其他词条时，交给模糊确认而不静默采用。

        只针对别名：完整正式名称是权威命中。召回只用于决定要不要让用户确认。
        """
        if not span.alias or span.homophone:
            return False
        occupied = [(other.start, other.end) for other in selected if other is not span]

        def free(index: int) -> bool:
            return not any(start <= index < end for start, end in occupied)

        left = span.start
        while (left > 0 and span.start - left < _CONTEXT_WINDOW and free(left - 1)
               and not _is_pause(text, positions, left, len(text))):
            left -= 1
        right = span.end
        while (right < len(text) and right - span.end < _CONTEXT_WINDOW and free(right)
               and self._basis_at(text, right, len(text)) is None
               and not _is_pause(text, positions, right, len(text))):
            right += 1
        if (left, right) == (span.start, span.end):
            return False
        # 同一基础指标的更长正式名称被打错字时同样要确认，因此不排除别名自身的词条。
        width = span.end - span.start
        return any(
            len(hit["term"]) > width
            and left + hit["start"] <= span.start and left + hit["end"] >= span.end
            and hit["end"] - hit["start"] > width
            for hit in self.recall(text[left:right])
        )

    def mentions(self, question: str) -> list[dict]:
        text, positions = _normalize_with_index(question)
        return _Parse(self, question, text, positions).run()

    # ---- 模糊召回（只决定是否提示候选） ----

    @staticmethod
    def _term_span(value: Sequence, query: Sequence, threshold: float, *,
                   anchored_ends: Sequence[int] = ()) -> tuple[float, int, int] | None:
        """召回对齐只缩小搜索区间；实体跨度由完整词条编辑比对确定。

        partial_ratio 会偏好截掉错字的短子串，不能直接作为用户原文边界。已知口径
        前的边界优先作为锚点；比较仍覆盖整个目录词条，错字只产生待确认候选。
        """
        allowance = int(len(value) * (1 - threshold))
        alignment = partial_ratio_alignment(value, query, score_cutoff=70)
        if alignment is None:
            return None

        def best_span(ends: Sequence[int]) -> tuple[float, int, int] | None:
            best: tuple[float, int, int] | None = None
            best_order: tuple[float, int, int, int] | None = None
            for end in ends:
                for width in range(max(2, len(value) - allowance), len(value) + allowance + 1):
                    start = end - width
                    if start < 0 or end > len(query):
                        continue
                    score = Levenshtein.normalized_similarity(value, query[start:end])
                    if score < threshold or (len(value) < 3 and score < 1):
                        continue
                    # 相同编辑距离时保留与完整目录词条等长的原文，避免截掉末尾错字。
                    order = (score, -abs(width - len(value)), -start, -end)
                    if best_order is None or order > best_order:
                        best, best_order = (score, start, end), order
            return best

        anchored = best_span(anchored_ends)
        if anchored is not None:
            return anchored
        return best_span(range(
            max(2, alignment.dest_end - allowance),
            min(len(query), alignment.dest_end + allowance) + 1,
        ))

    def recall(self, text: str, *, basis_boundary: bool = False) -> list[dict]:
        """倒排召回后比对完整词条；描述召回只在无名称命中时补充。"""
        if len(text) < 2:
            return []
        phonetic = _phonetic(text)
        votes: dict[int, float] = defaultdict(float)
        for grams, index in [(_grams(text), self.words), (_grams(phonetic), self.sounds)]:
            for gram in grams:
                postings = index.get(gram, ())
                weight = log(1 + len(self.terms) / (1 + len(postings)))
                for term_id in postings:
                    votes[term_id] += weight
        # 先倒排召回再计算相似度，避免对全目录逐条执行模糊比较。
        shortlisted = sorted(votes, key=lambda key: (-votes[key], key))[:200]
        hits = []
        anchored_ends = [len(text)] if basis_boundary else []
        if basis_boundary and (joiner := _LEADING_JOINER.search(text)):
            anchored_ends.append(joiner.start())
        for term_id in shortlisted:
            term = self.terms[term_id]
            best: tuple[float, int, int] | None = None
            if len(text) >= 3 and text in term.text and text != term.text:
                best = (0.7, 0, len(text))
            for query, value, reason in [(text, term.text, "character"),
                                         (phonetic, term.phonetic, "pinyin")]:
                span = self._term_span(
                    value, query, 0.84 if reason == "pinyin" else 0.72,
                    anchored_ends=anchored_ends,
                )
                if span is None:
                    continue
                if best is None or span[0] > best[0]:
                    best = span
            if best is not None:
                hits.append({"key": term.key, "term": term.text, "score": round(best[0], 4),
                             "start": best[1], "end": best[2]})
        if hits:
            return hits
        scores: dict[_Key, float] = defaultdict(float)
        counts: dict[_Key, int] = defaultdict(int)
        for gram in _grams(text):
            postings = self.descriptions.get(gram, ())
            weight = log(1 + self._description_keys / (1 + len(postings)))
            for key in postings:
                scores[key] += weight
                counts[key] += 1
        return [
            {"key": key, "term": "", "score": round(min(.79, scores[key] / (10 + scores[key])), 4),
             "start": 0, "end": len(text)}
            for key in sorted(scores, key=lambda key: (-scores[key], key))[:_CANDIDATE_LIMIT]
            if counts[key] >= 2
        ]

    def base_correction(self, text: str) -> dict | None:
        """全词条、全身份竞争；不使用召回截断、口径过滤后的候选数推定唯一。"""
        competition = compete_correction(
            text,
            (CorrectionTerm(term.key, term.text, term.phonetic) for term in self.terms),
            min_length=_CORRECTION_MIN_LENGTH,
            min_term_length=_CORRECTION_MIN_LENGTH,
            min_character_score=_CORRECTION_MIN_SCORE,
            min_margin=_CORRECTION_MIN_MARGIN,
            exclude_containment=True,
            protected_pattern=_PROTECTED_TERMS,
        )
        if competition is None:
            return None
        winner = competition.winner
        key = winner.term.identity
        # 只有基础指标允许纠错采用；完整指标词条仍按精确词典处理。
        if key[0] != "base":
            return None
        runner_up = competition.runner_up
        runner_up_score = runner_up.score if runner_up else 0.0
        return {
            "source_metric_code": key[1], "formal_base_name": self.base_names[key[1]],
            "matched_term": winner.term.text, "normalized_base_text": text,
            "method": "single_character_edit", "edit_distance": winner.distance,
            "score": round(winner.score, 4), "character_score": round(winner.character_score, 4),
            "pinyin_score": round(winner.pinyin_score, 4),
            "runner_up_score": round(runner_up_score, 4),
            "margin": round(competition.margin, 4), "min_score": _CORRECTION_MIN_SCORE,
            "min_margin": _CORRECTION_MIN_MARGIN,
            "competition_scope": "all_enabled_catalog_terms",
            "dictionary_identity_count": competition.identity_count,
            "dictionary_term_count": len(self.terms),
            "runner_up": ({"kind": runner_up.term.identity[0],
                           "identity": runner_up.term.identity[1],
                           "name": self.display(runner_up.term.identity),
                           "score": round(runner_up_score, 4)}
                          if runner_up else None),
        }


def _is_pause(text: str, positions: list[int], index: int, boundary: int) -> bool:
    """归一化位置 index 处用户是否停顿：句首句末、下一实体、被剔除的标点空白或连接词。"""
    if index >= boundary or index <= 0:
        return True
    if positions[index] > positions[index - 1] + 1:
        return True
    return _JOINERS.match(text, index, boundary).end() > index


class _Parse:
    """一次原句识别的可变状态；识别结果只引用当前目录的正式名称与编码。"""

    def __init__(self, index: MetricCandidateIndex, question: str, text: str,
                 positions: list[int]):
        self.index = index
        self.question = question
        self.text = text
        self.positions = positions
        self.result: list[dict] = []
        self.covered: list[tuple[int, int]] = []
        self.group_count = 0

    def run(self) -> list[dict]:
        spans = self.index._select(self.text, self.positions)
        for position, span in enumerate(spans):
            boundary = spans[position + 1].start if position + 1 < len(spans) else len(self.text)
            if span.kind == 0:
                self._name_span(span, boundary)
            elif span.kind == 3:
                self._candidate_group(span.start, span.end, boundary,
                                      {key: 1.0 for key in span.keys})
            else:
                self._base_span(span, boundary)
        for start, end in self._uncovered():
            self._fuzzy_segment(start, end)
        return sorted(self.result, key=lambda mention: mention["start"])

    # ---- 输出 ----

    def _emit(self, start: int, end: int, resolution: dict, kind: str,
              group: dict | None = None) -> None:
        left, right = self.positions[start], self.positions[end - 1] + 1
        mention = {"text": self.question[left:right], "start": left, "end": right,
                   "resolution": resolution, "source": {"kind": kind}}
        if group is not None:
            mention["group"] = group
        self.result.append(mention)
        self.covered.append((start, end))

    def _group(self, source: str | None) -> dict:
        self.group_count += 1
        return {"id": f"g{self.group_count}",
                "base_name": self.index.base_names.get(source or "", "")}

    def _resolved(self, codes: Iterable[str], **metadata) -> dict:
        codes = sorted(codes)
        return {"status": "resolved", "value": {
            "codes": codes, "names": [self.index.items[code].name for code in codes],
        }, "metadata": metadata}

    def _listing(self, status: str, codes: Iterable[str], **metadata) -> dict:
        # 按编码排序，与改造前一致：基础指标自身编码最短，“当日数”等基础口径排在前面。
        ordered = sorted(codes)
        resolution = {"status": status, "candidates": [self._candidate(code) for code in ordered]}
        if metadata:
            resolution["metadata"] = metadata
        return resolution

    def _candidate(self, code: str) -> dict:
        # 带上口径，用户只回答“当日数”时也能按原文确定是哪个候选。
        item = self.index.items[code]
        candidate = {"value": item.name, "code": code}
        if code in self.index.source_by_code:
            candidate["metadata"] = {"value_basis": item.value_basis}
        return candidate

    def _member(self, sources: frozenset[str], canons: frozenset[str], partial: bool,
                **metadata) -> dict:
        codes = self.index.codes_for(sources, canons)
        if partial:
            return self._listing("needs_confirmation", codes, issue="value_basis_incomplete")
        if len(codes) == 1:
            return self._resolved(codes, **metadata)
        if not codes:
            return {"status": "needs_confirmation", "candidates": [],
                    "metadata": {"issue": "value_basis_not_found"}}
        lineage = len({self.index.source_by_code[code] for code in codes}) > 1
        return self._listing("needs_confirmation" if lineage else "ambiguous", codes)

    @staticmethod
    def _match(span: _Span, understood_as: str) -> dict:
        if span.homophone:
            return {"match": "homophone", "understood_as": understood_as}
        return {"match": "exact"}

    # ---- 精确与同音片段 ----

    def _name_span(self, span: _Span, boundary: int) -> None:
        codes = sorted(span.codes)
        if len(codes) != 1:
            self._emit(span.start, span.end, self._listing("ambiguous", codes), "catalog_name")
            return
        source = self.index.source_by_code.get(codes[0])
        group = self._group(source) if source else None
        match = self._match(span, self.index.items[codes[0]].name)
        self._emit(span.start, span.end, self._resolved(codes, **match), "catalog_name", group)
        if not source:
            return
        members = self._chain(None, span.end, boundary, frozenset({source}), group, **match)
        if span.base_end > span.start:
            canons = {normalize_semantic_text(self.index.items[codes[0]].value_basis or "")}
            canons.update(canon for _, _, member, partial in members if not partial
                          for canon in member)
            self._shared_tail(span.start, span.base_end, canons)

    def _base_span(self, span: _Span, boundary: int) -> None:
        sources = span.sources
        codes = span.codes
        if span.kind == 1:
            sources = frozenset(self.index.source_by_code[code] for code in codes)
        group = self._group(sorted(sources)[0])
        match = self._match(span, self.index.base_names[sorted(sources)[0]])
        canons = set(span.canons)
        if span.kind == 1:
            if len(codes) == 1:
                resolution = self._resolved(codes, **match)
            else:
                status = "needs_confirmation" if len(sources) > 1 else "ambiguous"
                resolution = self._listing(status, codes)
            self._emit(span.start, span.end, resolution, "catalog_base_basis", group)
            if resolution["status"] == "resolved":
                sources = frozenset({self.index.source_by_code[resolution["value"]["codes"][0]]})
            members = self._chain(None, span.end, boundary, sources, group, **match)
        else:
            members = self._chain(span.start, span.end, boundary, sources, group, **match)
            if not members:
                self._missing_basis(span.start, span.end, sources, group,
                                    **({"understood_as": match["understood_as"]}
                                       if span.homophone else {}))
        canons.update(canon for _, _, member, partial in members if not partial
                      for canon in member)
        self._shared_tail(span.start, span.base_end, canons)

    def _chain(self, merge_start: int | None, cursor: int, boundary: int,
               sources: frozenset[str], group: dict | None, **metadata) -> list:
        members = self.index._read_chain(self.text, self.positions, cursor, boundary, sources)
        for position, (start, end, canons, partial) in enumerate(members):
            resolution = self._member(sources, canons, partial, **metadata)
            # 基础指标本身不单列：并入第一个口径片段，替换后的原句仍是完整名称。
            first_start = merge_start if merge_start is not None and position == 0 else start
            self._emit(first_start, end, resolution, "catalog_base_basis", group)
            if resolution["status"] == "resolved":
                sources = frozenset({
                    self.index.source_by_code[resolution["value"]["codes"][0]]
                })
        return members

    def _missing_basis(self, start: int, end: int, sources: frozenset[str],
                       group: dict | None, **metadata) -> None:
        # 只说了基础指标：追问口径，候选是该基础指标在目录中实际存在的指标。
        codes = self.index.codes_for(sources, self.index.valid_canons(sources))
        self._emit(start, end, self._listing(
            "needs_confirmation", codes, issue="missing_value_basis", **metadata,
        ), "catalog_base", group)

    def _shared_tail(self, base_start: int, base_end: int, canons: set[str]) -> None:
        """“对公和个人日均存款余额”：前一片段 + 本基础指标的后半段恰为目录中的另一基础指标。

        不自动展开，只作为待确认项，避免把“对公”静默丢掉。
        """
        floor = max((end for _, end in self.covered if end <= base_start), default=0)
        joiner = _LEADING_JOINER.search(self.text[floor:base_start])
        if joiner:
            x_end = floor + joiner.start()
        elif base_start > floor and _is_pause(self.text, self.positions, base_start,
                                              len(self.text)):
            x_end = base_start
        else:
            return
        tail = self.text[base_start:base_end]
        for x_start in range(max(floor, x_end - _CONTEXT_WINDOW), x_end):
            head = self.text[x_start:x_end]
            for cut in range(1, len(tail)):
                sources = self.index.base_terms.get(head + tail[cut:])
                if not sources:
                    continue
                codes = self.index.codes_for(sources, canons) or self.index.codes_for(
                    sources, self.index.valid_canons(sources)
                )
                self._emit(x_start, x_end, self._listing(
                    "needs_confirmation", codes, issue="shared_tail",
                ), "catalog_shared_tail", self._group(sorted(sources)[0]))
                return

    # ---- 模糊片段 ----

    def _uncovered(self) -> list[tuple[int, int]]:
        segments, cursor = [], 0
        for start, end in sorted(self.covered):
            if start > cursor:
                segments.append((cursor, start))
            cursor = max(cursor, end)
        if cursor < len(self.text):
            segments.append((cursor, len(self.text)))
        return segments

    def _fuzzy_segment(self, segment_start: int, segment_end: int) -> None:
        # 口径只精确匹配：召回区间在口径处截断，基础指标候选不能吞掉口径文字。
        pieces, cursor, position = [], segment_start, segment_start
        while position < segment_end:
            hit = self.index._basis_at(self.text, position, segment_end)
            if hit is None:
                position += 1
                continue
            if position > cursor:
                pieces.append((cursor, position))
            cursor = position = hit[0]
        if cursor < segment_end:
            pieces.append((cursor, segment_end))
        for piece_start, piece_end in pieces:
            if any(start <= piece_start and piece_end <= end for start, end in self.covered):
                continue
            hits = self.index.recall(
                self.text[piece_start:piece_end],
                basis_boundary=self.index._basis_at(self.text, piece_end, segment_end) is not None,
            )
            # 召回跨度重叠的是同一组待确认项；不同位置保留多组。
            groups: list[dict] = []
            for hit in sorted(hits, key=lambda item: (item["start"], -item["score"])):
                start, end = piece_start + hit["start"], piece_start + hit["end"]
                group = next((g for g in groups if start < g["end"] and end > g["start"]), None)
                if group is None:
                    groups.append({"start": start, "end": end, "scores": {}})
                    group = groups[-1]
                group["start"], group["end"] = min(start, group["start"]), max(end, group["end"])
                group["scores"][hit["key"]] = max(group["scores"].get(hit["key"], 0),
                                                  hit["score"])
            for group in groups:
                if any(group["start"] < end and group["end"] > start
                       for start, end in self.covered):
                    continue
                self._candidate_group(group["start"], group["end"], segment_end,
                                      group["scores"])

    def _candidate_group(self, start: int, end: int, boundary: int,
                         scores: dict[_Key, float]) -> None:
        """高置信纠错单独校验；其余基础指标候选仍由用户确认。"""
        if self._correct_base(start, end, boundary):
            return
        ranked = sorted(scores, key=lambda key: (-scores[key], key))
        base_sources = frozenset(value for kind, value in ranked if kind == "base")
        members = (self.index._read_chain(self.text, self.positions, end, boundary, base_sources)
                   if base_sources else [])
        eligible = [value for kind, value in ranked if kind == "base"
                    and all(self.index.codes_for({value}, canons)
                            for _, _, canons, _ in members)][:_CANDIDATE_LIMIT]
        if members and eligible and not any(partial for *_, partial in members):
            # 口径明确：同组各口径共享同一组基础指标候选，用户确认一次全部生效。
            group = self._group(None)
            for position, (member_start, member_end, canons, _) in enumerate(members):
                candidates = [
                    {"value": self.index.items[code].name, "code": code, "metadata": {
                        "kind": "base", "source_metric_code": source,
                        "base_name": self.index.base_names[source], "group": group["id"],
                    }}
                    for source in eligible
                    for code in sorted(self.index.codes_for({source}, canons))
                ]
                self._emit(start if position == 0 else member_start, member_end, {
                    "status": "needs_confirmation", "candidates": candidates,
                    "metadata": {"issue": "base_uncertain"},
                }, "fuzzy_base_basis", group)
            return
        # 口径缺失或不完整：先确认基础指标，口径在确认后按目录追问。
        candidates = []
        for kind, value in ranked[:_CANDIDATE_LIMIT]:
            candidate = {"value": self.index.display((kind, value)),
                         "score": round(scores[(kind, value)], 4)}
            if kind == "metric":
                candidate["code"] = value
            else:
                candidate["metadata"] = {"kind": "base_only", "source_metric_code": value}
            candidates.append(candidate)
        self._emit(start, members[-1][1] if members else end, {
            "status": "needs_confirmation", "candidates": candidates,
            "metadata": {"issue": "base_uncertain"},
        }, "fuzzy_base")

    def _correct_base(self, start: int, end: int, boundary: int) -> bool:
        correction = self.index.base_correction(self.text[start:end])
        if correction is None:
            return False
        source = correction["source_metric_code"]
        members = self.index._read_chain(self.text, self.positions, end, boundary, {source})
        if not members or any(partial for *_, partial in members):
            return False
        selected = []
        for _, _, canons, _ in members:
            codes = self.index.codes_for({source}, canons)
            if len(canons) != 1 or len(codes) != 1:
                return False
            code = next(iter(codes))
            item = self.index.items[code]
            # 正式名称撞码或源结构不一致时，不能借模糊纠错绕过精确识别的歧义门禁。
            if (self.index.full_terms[normalize_semantic_text(item.name)] != {code}
                    or normalize_semantic_text(item.base_name or "")
                    != normalize_semantic_text(correction["formal_base_name"])):
                return False
            selected.append(item)
        group = self._group(source)
        original_base = self.question[self.positions[start]:self.positions[end - 1] + 1]
        for position, ((member_start, member_end, _, _), item) in enumerate(
                zip(members, selected, strict=True)):
            metadata = {"match": "fuzzy_correction",
                        "understood_as": correction["formal_base_name"],
                        "correction": {**correction, "original_base_text": original_base,
                                       "formal_metric": {"code": item.code, "name": item.name,
                                                         "value_basis": item.value_basis}}}
            self._emit(start if position == 0 else member_start, member_end,
                       self._resolved([item.code], **metadata), "fuzzy_base_basis", group)
        return True


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
            for code, name, aliases, description, explanation, source_code, base, basis
            in snapshot
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


def resolved_metric_codes(mentions: list[dict]) -> set[str]:
    """已确定片段的指标编码。"""
    return {
        code
        for mention in mentions
        if mention["resolution"]["status"] == "resolved"
        for code in mention["resolution"]["value"]["codes"]
    }


def conflicting_metric_references(
    question: str, selected_codes: list[str], catalog: list[MetricCatalogItem],
) -> list[tuple[MetricCatalogItem, MetricCatalogItem]]:
    """校验明确完整名称被另一指标短名称/别名替代的冲突，不承担工具选择或编码替换。"""
    index = metric_candidate_index(catalog)
    mentions = [mention for mention in index.mentions(question)
                if mention["resolution"]["status"] == "resolved"]
    explicit = resolved_metric_codes(mentions)
    conflicts = []
    for item in catalog:
        if item.code not in selected_codes or item.code in explicit:
            continue
        # 用户明确提供编码时保持编码查询语义；自然语言的不完整指代仍由 pi 判断。
        if re.search(rf"(?<![\w]){re.escape(item.code)}(?![\w])", question, re.ASCII):
            continue
        terms = [normalize_semantic_text(term) for term in [item.name, *item.aliases]]
        for mention in mentions:
            matched = index.items[mention["resolution"]["value"]["codes"][0]]
            full = normalize_semantic_text(mention["text"])
            if full == normalize_semantic_text(matched.name) and any(
                term and len(term) < len(full) and term in full for term in terms
            ):
                conflicts.append((item, matched))
    return conflicts
