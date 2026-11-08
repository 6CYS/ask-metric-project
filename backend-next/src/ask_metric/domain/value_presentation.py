"""查询和分析共用的数值展示；不修改原始事实和计算值。"""

from decimal import ROUND_HALF_UP, Decimal, localcontext

MONEY_UNIT_SCALES = {"元": Decimal(1), "万元": Decimal("10000"), "亿元": Decimal("100000000")}


def _rounded_display(value: Decimal) -> str:
    rounded = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    # 小额和微小比例仍需保留方向，不能把已知非零事实展示成零。
    if not rounded:
        rounded = value.normalize() if value else abs(rounded)
    return format(rounded, "f")


def money_reply_fields(value: Decimal, unit: str | None) -> dict[str, str]:
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
        return {"reply_value": _rounded_display(amount), "reply_unit": display_unit}


def display_number(value: str, metric: dict, *, difference: bool = False) -> str:
    if metric.get("value_policy") == "source_raw_v1":
        return f"{value}（原始值，单位未提供）"
    amount = Decimal(value)
    unit = metric.get("unit") or "（单位未提供）"
    money = money_reply_fields(amount, unit)
    if money:
        return money["reply_value"] + money["reply_unit"]
    with localcontext() as context:
        context.prec = max(60, len(amount.as_tuple().digits) + 12, amount.adjusted() + 12)
        if unit == "%":
            encoding = metric.get("value_encoding")
            if encoding not in {"ratio", "percent"}:
                return f"原始值 {value}（目录单位%，数值编码待确认）"
            if encoding == "ratio":
                amount *= 100
            hint = metric.get("analysis_hint") or {}
            unit = "个百分点" if difference or hint.get("comparison_role") == "difference" else "%"
        return _rounded_display(amount) + unit
