"""Named Decimal operations on trusted facts; never evaluate model expressions."""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext

CALCULATION_VERSION = "decimal-analysis-1.0.0"
UNITS = {
    "元": ("CNY", Decimal(1)),
    "万元": ("CNY", Decimal("10000")),
    "亿元": ("CNY", Decimal("100000000")),
    "万亿元": ("CNY", Decimal("1000000000000")),
    "户": ("customers", Decimal(1)),
    "万户": ("customers", Decimal("10000")),
    "人": ("people", Decimal(1)),
    "万人": ("people", Decimal("10000")),
    "笔": ("transactions", Decimal(1)),
    "万笔": ("transactions", Decimal("10000")),
    "%": ("ratio", Decimal("0.01")),
    "比例": ("ratio", Decimal(1)),
    "百分点": ("percentage_point", Decimal(1)),
    "基点": ("percentage_point", Decimal("0.01")),
}


class CalculationError(ValueError):
    pass


def decimal(value):
    # Raw floats are not accepted as an arithmetic interface.
    if isinstance(value, (float, bool)) or value is None:
        raise CalculationError("计算输入须为有效十进制字符串或Decimal，缺失值不补零")
    try:
        number = Decimal(value)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise CalculationError("计算输入不是有效十进制数") from exc
    if not number.is_finite() or len(number.as_tuple().digits) > 38 or abs(number.adjusted()) > 30:
        raise CalculationError("计算输入非有限值或超出精度范围")
    return number


def percentage(numerator, denominator):
    with localcontext() as ctx:
        ctx.prec = 38
        n, d = decimal(numerator), decimal(denominator)
        return str(n / d * 100) if d else None


def change(base, current):
    with localcontext() as ctx:
        ctx.prec = 38
        b, c = decimal(base), decimal(current)
        delta = c - b
        return {
            "base_value": str(b),
            "current_value": str(c),
            "difference": str(delta),
            "change_rate": percentage(delta, abs(b)),
        }


def contributions(child_delta, parent_delta):
    parent = decimal(parent_delta)
    return {
        # Backward compatible net-change share: reconciled children sum to +100%.
        "contribution_pct": percentage(child_delta, parent),
        # Customer's signed impact formula: falling parent sums to -100%.
        "directional_contribution_pct": percentage(child_delta, parent.copy_abs()),
    }


def convert(value, source_unit, target_unit):
    number = decimal(value)
    if source_unit not in UNITS or target_unit not in UNITS:
        raise CalculationError("单位尚未登记，不能猜测换算系数")
    source, target = UNITS[source_unit], UNITS[target_unit]
    if source[0] != target[0]:
        raise CalculationError("不同量纲不能换算；百分比水平与百分点变化不可混用")
    with localcontext() as ctx:
        ctx.prec = 38
        factor = source[1] / target[1]
        return {
            "value": str(number * factor),
            "source_value": str(number),
            "source_unit": source_unit,
            "target_unit": target_unit,
            "factor": str(factor),
            "calculation_version": CALCULATION_VERSION,
        }


def convert_fact(fact, unit):
    """Normalize full comparison while retaining original units and evidence references."""
    if fact["unit"] == unit:
        return dict(fact)
    conversions = {
        k: convert(fact[k], fact["unit"], unit)
        for k in ("base_value", "current_value", "difference")
    }
    return {
        **fact,
        **{k: v["value"] for k, v in conversions.items()},
        "unit": unit,
        "conversion": conversions,
        "calculation_version": CALCULATION_VERSION,
    }


def formatted(value, places=2):
    if value is None:
        return "未定义"
    with localcontext() as ctx:
        ctx.prec = 50
        n = decimal(value)
        rounded = n.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
        if n and not rounded:
            return format(n.normalize(), "f")
        return f"{rounded:,.{places}f}"


def amount(value, unit, *, compact=False):
    if compact and unit in UNITS and UNITS[unit][0] == "CNY":
        trillions = convert(value, unit, "万亿元")["value"]
        if abs(decimal(trillions)) >= 1:
            return formatted(trillions) + "万亿元"
    return formatted(value) + unit
