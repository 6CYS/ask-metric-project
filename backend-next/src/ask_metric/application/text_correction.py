"""错字纠正共用实现：拼音封装与全目录竞争的 Levenshtein 比对。

指标基础名纠错（metric_candidates）与机构短名纠错（field_resolution）共用
同一竞争规则：每个目录身份先取最佳词条，再全目录排名，只有唯一领先者才允许
静默纠正。注意 pypinyin 多音字只取默认读音，拼音可能漏报或误报同音，
因此字符编辑距离始终是主信号，拼音（含逐音节相似度）只作辅助分。
"""

from __future__ import annotations

from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from pypinyin import lazy_pinyin
from rapidfuzz.distance import Levenshtein

if TYPE_CHECKING:
    from re import Pattern


def phonetic(text: str) -> tuple[str, ...]:
    """逐字默认读音；非汉字字符原样保留（与原 metric_candidates 行为一致）。"""
    return tuple(lazy_pinyin(text, errors=lambda value: list(value)))


def pinyin_similarity(left: tuple[str, ...], right: tuple[str, ...]) -> float:
    """音节序列整体编辑相似度；单字多音差异视为一次替换。"""
    return Levenshtein.normalized_similarity(left, right)


def pinyin_syllable_similarity(left: tuple[str, ...], right: tuple[str, ...]) -> float:
    """逐音节字母相似度的均值；音节数不同为 0。

    机构短名只有 2-4 字，整序列比较会把“沐/沭”（韵母相同）与“沐/泗”（全异）
    判成同分；逐音节比较让近音错字在竞争中领先，又不至于把整词拼音全同的
    判定权交给辅助信号。纠错竞争要求低噪声，长度不同直接归零。
    """
    if not left or len(left) != len(right):
        return 0.0
    return sum(
        Levenshtein.normalized_similarity(a, b) for a, b in zip(left, right, strict=True)
    ) / len(left)


def pinyin_syllable_similarity_sliding(left: tuple[str, ...], right: tuple[str, ...]) -> float:
    """音节数不同时滑动对齐取最佳窗口的逐音节相似度。

    只用于零命中澄清候选的排序（如“用户短名对目录较长核心名”），
    不参与纠错采纳与门槛判定。
    """
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    return max(
        sum(Levenshtein.normalized_similarity(a, b)
            for a, b in zip(left, right[offset : offset + len(left)], strict=True))
        / len(left)
        for offset in range(len(right) - len(left) + 1)
    )


@dataclass(frozen=True)
class CorrectionTerm:
    """参与竞争的一条目录词条；同一身份（指标/机构）可有多条。"""

    identity: Hashable
    text: str
    phonetic: tuple[str, ...]


@dataclass(frozen=True)
class CorrectionScore:
    term: CorrectionTerm
    # 综合分 = max(字符分, 拼音分)；排名与领先幅度都用综合分。
    score: float
    character_score: float
    pinyin_score: float
    distance: int


@dataclass(frozen=True)
class CorrectionCompetition:
    winner: CorrectionScore
    runner_up: CorrectionScore | None
    margin: float
    identity_count: int


def rank_corrections(
    text: str,
    terms: Iterable[CorrectionTerm],
    *,
    pinyin_score: Callable[[tuple[str, ...], tuple[str, ...]], float] = pinyin_similarity,
) -> list[CorrectionScore]:
    """每个身份只保留最佳词条后全目录排名：综合分降序，平分按身份升序稳定决胜。"""
    sounds = phonetic(text)
    best: dict[Hashable, CorrectionScore] = {}
    for term in terms:
        character = Levenshtein.normalized_similarity(text, term.text)
        pinyin = pinyin_score(sounds, term.phonetic)
        score = max(character, pinyin)
        candidate = CorrectionScore(term, score, character, pinyin,
                                    Levenshtein.distance(text, term.text))
        previous = best.get(term.identity)
        if previous is None or (score, character) > (previous.score, previous.character_score):
            best[term.identity] = candidate
    return sorted(best.values(), key=lambda item: (-item.score, item.term.identity))


def compete_correction(
    text: str,
    terms: Iterable[CorrectionTerm],
    *,
    min_length: int = 1,
    min_term_length: int = 1,
    min_character_score: float = 0.0,
    min_margin: float = 0.15,
    allow_pinyin_equal: bool = False,
    exclude_containment: bool = False,
    protected_pattern: Pattern[str] | None = None,
    pinyin_score: Callable[[tuple[str, ...], tuple[str, ...]], float] = pinyin_similarity,
) -> CorrectionCompetition | None:
    """全词条、全身份竞争；唯一领先且满足门槛才允许采用，不使用召回截断推定唯一。"""
    if len(text) < min_length:
        return None
    ranked = rank_corrections(text, terms, pinyin_score=pinyin_score)
    if not ranked:
        return None
    winner = ranked[0]
    runner_up = ranked[1] if len(ranked) > 1 else None
    margin = winner.score - (runner_up.score if runner_up else 0.0)
    winner_term = winner.term
    if (len(winner_term.text) < min_term_length
            or (winner.distance != 1
                and not (allow_pinyin_equal and phonetic(text) == winner_term.phonetic))
            or winner.character_score < min_character_score
            or margin + 1e-9 < min_margin
            or (exclude_containment and (
                winner_term.text.startswith(text) or winner_term.text.endswith(text)
                or text.startswith(winner_term.text) or text.endswith(winner_term.text)))
            or (protected_pattern is not None
                and protected_pattern.findall(text)
                != protected_pattern.findall(winner_term.text))):
        return None
    return CorrectionCompetition(winner, runner_up, margin, len(ranked))
