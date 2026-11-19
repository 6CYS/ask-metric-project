"""精确展示值的格式匹配，仅供表格与重复值整理使用，不解释自然语言。"""

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

# 捕获整个数值词元，避免把非法符号、科学计数或错误分组的尾部当作合法值。
_NUMBER = r"[+-]*\d(?:[\d.,，eE/+-]*\d)?"
_UNITS = r"(?:个百分点|亿元|万元|元|[%％]|名|户|笔|倍|家|位|个|人|张|台|次|天)"
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


def matches_fact_quantity(
    text: str, atom: dict[str, Any], presentation: dict | None = None,
) -> bool:
    """原值事实只核对精确数值，量词由模型表达；历史事实仍核对已保存的单位。"""
    if presentation is not None:
        # 只认可同一格式化函数的确定结果，不以浮动容差放行相近数值。
        display = presentation["display"]
        value = parse_quantity(text)
        expected = parse_quantity(display.removeprefix("约").removeprefix("第"))
        return value is not None and expected is not None and value == expected
    if atom.get("value_policy") == "source_raw_v1":
        quantity = parse_quantity(text)
        try:
            return quantity is not None and quantity.value == Decimal(str(atom.get("value")))
        except InvalidOperation:
            return False
    return matches_quantity(text, atom["display"])
