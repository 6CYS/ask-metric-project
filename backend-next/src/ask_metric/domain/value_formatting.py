"""受控数值展示：只派生可核验的展示文本，不修改事实和计算精度。"""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ask_metric.core.errors import ApplicationError
from ask_metric.domain.metric_value_semantics import is_ordinal_metric
from ask_metric.domain.value_presentation import MONEY_UNIT_SCALES

CountUnit = Literal["个", "户", "人", "笔", "家", "张", "台", "次", "天"]


class ValueFormat(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: str = Field(min_length=1, max_length=200)
    kind: Literal["money", "count", "ranking", "ratio", "number"]
    unit: CountUnit | None = None

    @model_validator(mode="after")
    def validate_unit(self):
        if self.unit is not None and self.kind != "count":
            raise ValueError("只有计数格式可指定量词；金额和比例单位由服务端确定")
        return self


def _decimal(value) -> Decimal | None:
    try:
        result = Decimal(str(value))
        return result if result.is_finite() else None
    except InvalidOperation:
        return None


def _compact(value: Decimal, *, grouping=True) -> str:
    text = format(value, ",f" if grouping else "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _display(value: Decimal, places: int, unit: str, *, prefix="", notice="") -> dict:
    quantum = Decimal(1).scaleb(-places)
    rounded = value.quantize(quantum, rounding=ROUND_HALF_UP)
    changed = rounded != value
    if not rounded and value:
        # 非零不能伪装为零，也不展开无限小数；正负方向始终保留。
        number = ("负值，绝对值" if value < 0 else "") + "小于" + _compact(quantum)
    else:
        number = _compact(abs(rounded) if not rounded else rounded)
    return {
        "value": format(value, "f"),
        "display": prefix + number + unit + notice,
        "unit": unit or prefix or "原值",
        "rounded": changed,
        "notice": notice,
    }


def format_value(atom: dict, metric: dict, spec: ValueFormat | None) -> dict | None:
    value = _decimal(atom.get("value"))
    if value is None or atom.get("type") not in {"fact", "calculation"}:
        return None
    raw = atom.get("value_policy", metric.get("value_policy")) == "source_raw_v1"
    old_unit = None if raw else atom.get("unit") or metric.get("unit")
    derived_percent = atom.get("type") == "calculation" and not raw and old_unit == "%"
    kind = (
        spec.kind
        if spec
        else (
            "ratio"
            if old_unit == "%"
            else "money"
            if old_unit in MONEY_UNIT_SCALES
            else "ranking"
            if old_unit == "名" or is_ordinal_metric(metric)
            else "ratio"
            if metric.get("quantity_kind") == "ratio"
            or metric.get("source_value_encoding") in {"ratio", "percent"}
            else "count"
            if old_unit in {"个", "户", "人", "笔", "家", "张", "台", "次", "天"}
            else "number"
        )
    )
    if derived_percent:
        kind = "ratio"
    with localcontext() as precision:
        precision.prec = max(60, len(value.as_tuple().digits) + abs(value.adjusted()) + 20)
        if kind == "money":
            source_scale = Decimal(1) if raw else MONEY_UNIT_SCALES.get(old_unit or "")
            if source_scale is None:
                # 旧单位不明不能被新的展示声明改写；保留原值并说明口径。
                return {
                    **_display(value, 4, "", prefix="原值", notice="（金额单位待确认）"),
                    "kind": "number",
                }
            # 金额正文统一用万元，缩放只影响展示，不改写事实及运算精度。
            result = _display(value * source_scale / MONEY_UNIT_SCALES["万元"], 2, "万元")
        elif kind in {"count", "ranking"}:
            unit = (
                "名"
                if kind == "ranking"
                else (spec.unit if spec and spec.unit else old_unit or "个")
            )
            if value != value.to_integral_value():
                result = _display(value, 4, "", prefix="原值", notice="（数量/名次口径待确认）")
            else:
                result = _display(value, 0, unit, prefix="第" if kind == "ranking" else "")
        elif kind == "ratio":
            encoding = (
                metric.get("source_value_encoding")
                if raw
                else atom.get("value_encoding") or metric.get("value_encoding")
            )
            difference = atom.get("type") == "calculation" and (
                atom.get("name") == "difference" or atom.get("comparison_role") == "difference"
            )
            percent_unit = "个百分点" if difference and not raw else "%"
            if not raw and encoding == "ratio":
                result = _display(value * 100, 2, percent_unit)
            elif encoding == "percent":
                result = _display(value, 2, percent_unit)
            elif encoding == "ratio":
                result = _display(value, 4, "", prefix="比值")
            else:
                result = _display(value, 4, "", prefix="原值", notice="，比例口径待确认")
        else:
            result = _display(value, 4, "")
        return {**result, "kind": kind}


def value_presentations(sources: list[dict], formats: list[ValueFormat]) -> dict[str, dict]:
    if not formats:
        return {}  # 历史请求沿用原协议，不重新解释已保存正文。
    atoms, metrics, identities = {}, {}, {}
    for source in sources:
        catalog = {item["code"]: item for item in source["metric_descriptors"]}
        for atom in source["evidence_items"]:
            ref = atom["ref"]
            metric = catalog.get(atom.get("metric_code"), {})
            atoms[ref], metrics[ref] = atom, metric
            derived_percent = (
                atom.get("type") == "calculation"
                and atom.get("unit") == "%"
                and atom.get("value_policy") != "source_raw_v1"
            )
            identities[ref] = (metric.get("code"), metric.get("binding_ref"), derived_percent)
    selected: dict[tuple, ValueFormat] = {}
    for spec in formats:
        if spec.ref not in atoms or atoms[spec.ref].get("type") not in {"fact", "calculation"}:
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE", "展示格式须引用本次已授权数值事实。", status_code=422
            )
        identity = identities[spec.ref]
        previous = selected.get(identity)
        metric = metrics[spec.ref]
        kind = metric.get("quantity_kind")
        if previous and previous.kind == spec.kind == "count" and not (previous.unit and spec.unit):
            spec = spec.model_copy(update={"unit": spec.unit or previous.unit})
        if (
            previous
            and (
                previous.kind != spec.kind
                or previous.unit is not None
                and spec.unit is not None
                and previous.unit != spec.unit
            )
            or is_ordinal_metric(metric)
            and spec.kind != "ranking"
            or (kind == "ratio" or metric.get("source_value_encoding") in {"ratio", "percent"})
            and spec.kind != "ratio"
        ):
            raise ApplicationError(
                "ANALYSIS_REPORT_FORMAT",
                "同一正式指标须使用一致的展示类型和量词，不能改变已确认的名次或比例类型。",
                status_code=422,
            )
        selected[identity] = spec
    return {
        ref: result
        for ref, atom in atoms.items()
        if (result := format_value(atom, metrics[ref], selected.get(identities[ref])))
    }
