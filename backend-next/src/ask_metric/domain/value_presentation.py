"""金额的回复展示规则；仅生成展示字段，不修改查询与计算证据。"""

from decimal import ROUND_HALF_UP, Decimal, localcontext


def money_reply_fields(value: Decimal, unit: str) -> dict[str, str]:
    """元统一展示为万元，已有万元不再换算，其他单位交给原有展示逻辑。"""
    if unit not in {"元", "万元"} or not value.is_finite():
        return {}
    with localcontext() as context:
        # 大额数值也不能受默认 Decimal 精度影响；换算始终从原始值开始。
        context.prec = max(60, len(value.as_tuple().digits) + 8, value.adjusted() + 8)
        amount = value / Decimal("10000") if unit == "元" else value
        rounded = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if not rounded:
            rounded = abs(rounded)
        return {"reply_value": format(rounded, "f"), "reply_unit": "万元"}
