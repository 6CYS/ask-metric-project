"""指标名称归一化；目录识别统一由 application.metric_candidates 完成。"""

from __future__ import annotations

import re
import unicodedata

_STRIPPED = r"[\s,，。！？?：:；;、（）()【】\[\]「」『』“”\"'`]"


def normalize_semantic_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    return re.sub(_STRIPPED + "+", "", normalized)


def _normalize_with_index(text: str) -> tuple[str, list[int]]:
    normalized_chars: list[str] = []
    index_map: list[int] = []
    for index, character in enumerate(text):
        value = unicodedata.normalize("NFKC", character).lower()
        for normalized_character in value:
            if re.match(_STRIPPED, normalized_character):
                continue
            normalized_chars.append(normalized_character)
            index_map.append(index)
    return "".join(normalized_chars), index_map
