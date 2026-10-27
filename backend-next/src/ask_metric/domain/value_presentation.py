"""金额的回复展示规则；仅生成展示字段，不修改查询与计算证据。"""

from decimal import ROUND_HALF_UP, Decimal, localcontext

MONEY_UNIT_SCALES = {"元": Decimal(1), "万元": Decimal("10000"), "亿元": Decimal("100000000")}


def money_reply_fields(value: Decimal, unit: str) -> dict[str, str]:
    """按金额量级选择可读单位，未知单位不推测；原始值仍保留在查询证据中。"""
    if unit not in MONEY_UNIT_SCALES or not value.is_finite():
        return {}
    with localcontext() as context:
        # 大额数值也不能受默认 Decimal 精度影响；换算始终从原始值开始。
        context.prec = max(60, len(value.as_tuple().digits) + 12, value.adjusted() + 12)
        yuan = value * MONEY_UNIT_SCALES[unit]
        display_unit = "亿元" if abs(yuan) >= MONEY_UNIT_SCALES["亿元"] else (
            "万元" if abs(yuan) >= MONEY_UNIT_SCALES["万元"] else "元"
        )
        amount = yuan / MONEY_UNIT_SCALES[display_unit]
        rounded = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if not rounded:
            rounded = abs(rounded)
        return {"reply_value": format(rounded, "f"), "reply_unit": display_unit}
