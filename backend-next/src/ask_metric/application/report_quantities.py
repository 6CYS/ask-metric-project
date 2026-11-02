"""精确展示值的格式匹配，仅供表格与重复值整理使用，不解释自然语言。"""

import re
from dataclasses import dataclass
from decimal import Decimal

# 捕获整个数值词元，避免把非法符号、科学计数或错误分组的尾部当作合法值。
_NUMBER = r"[+-]*\d(?:[\d.,，eE/+-]*\d)?"
_UNITS = r"(?:个百分点|亿元|万元|元|[%％]|名|户|笔|倍|家|位)"
QUANTITY_PATTERN = rf"{_NUMBER}[ \t]*{_UNITS}"


@dataclass(frozen=True)
class Quantity:
    value: Decimal
    unit: str


def parse_quantity(text: str) -> Quantity | None:
    """只识别明确的十进制数值及单位，不猜测近似精度或业务含义。"""
    match = re.fullmatch(
        rf"([+-]?(?:\d{{1,3}}(?:[,，]\d{{3}})+|\d+)(?:\.\d+)?)[ \t]*({_UNITS})",
        text.strip(),
    )
    if match is None:
        return None
    number, unit = match.groups()
    return Quantity(Decimal(number.replace(",", "").replace("，", "")), unit.replace("％", "%"))


def matches_quantity(text: str, display: str) -> bool:
    value, source = parse_quantity(text), parse_quantity(display)
    return value is not None and source is not None and value == source
