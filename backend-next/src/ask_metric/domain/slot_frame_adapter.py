from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import TypeAdapter, ValidationError

from ask_metric.domain.semantics import (
    ChangeAction,
    ChangeField,
    FilterSlot,
    MetricSlot,
    SlotFrame,
    SlotOperation,
    TaskType,
)


@dataclass(frozen=True)
class SlotFrameAdaptation:
    raw: Any
    adapted: dict[str, Any]
    field_errors: list[dict[str, Any]]


_TASK = TypeAdapter(TaskType)
_METRIC = TypeAdapter(MetricSlot)
_FILTER = TypeAdapter(FilterSlot)
_OPERATION = TypeAdapter(SlotOperation)
_RELATION = TypeAdapter(Literal["independent", "followup", "ambiguous"] | None)
_CHANGES = TypeAdapter(dict[ChangeField, ChangeAction])


def adapt_model_slot_frame(raw: Any) -> SlotFrameAdaptation:
    if not isinstance(raw, dict):
        raise TypeError("Model SlotFrame output must be a JSON object")

    errors: list[dict[str, Any]] = []
    adapted: dict[str, Any] = {
        "task": _scalar(raw, "task", TaskType.METRIC_QUERY.value, _TASK, errors),
        "raw_metric_text": _optional_string(raw, "raw_metric_text", errors),
        "raw_metric_texts": _strings(raw, "raw_metric_texts", errors),
        "metrics": _items(raw, "metrics", _METRIC, errors),
        "time": _time(raw.get("time"), errors),
        "orgs": _strings(raw, "orgs", errors, object_name_keys=("name",)),
        "dimensions": _strings(
            raw,
            "dimensions",
            errors,
            object_name_keys=("name", "dimension", "field"),
        ),
        "filters": _items(raw, "filters", _FILTER, errors),
        "ops": _operations(raw, errors),
        "options": raw.get("options") if isinstance(raw.get("options"), dict) else {},
        "missing": _strings(raw, "missing", errors),
        "context_relation": _scalar(raw, "context_relation", None, _RELATION, errors),
        "changes": _scalar(raw, "changes", {}, _CHANGES, errors),
    }
    if raw.get("options") is not None and not isinstance(raw.get("options"), dict):
        errors.append(_error("options", "invalid_type", "Expected an object; used {}"))
    return SlotFrameAdaptation(raw=raw, adapted=adapted, field_errors=errors)


def slot_frame_json_schema() -> dict[str, Any]:
    schema = SlotFrame.model_json_schema()
    # 仅收紧外部模型协议；历史 SlotFrame 的默认值与读取兼容保持不变。
    schema["required"] = [*schema.get("required", []), "ops", "context_relation", "changes"]
    schema["properties"]["ops"]["description"] = (
        "必须显式输出操作数组；只有纯指标取值时才返回空数组。"
        "多个指标用和、及、与连接表示分别取值，不表示aggregate或sum。"
        "未知、不存在或停用是目录解析结果，不是unsupported操作。基础取值即使指标不存在，也只写raw_metric_texts并返回ops=[]，由目录校验发起指标澄清；不得添加“查询不存在的指标”之类的能力标签。"
        "每项操作必须有实体占位符之外的原文操作语义依据，不能凭指标名补运算。"
        "逐项保留实体占位符之外的请求，不能因为当前系统不支持就省略操作、维度或筛选。"
        "指标在日期区间的全部已有值、每日明细用trend且grain=day，保持整个起止范围，不求和。客户、账户或交易级底层明细才用detail，按其他维度展开用drill_down；名称占位符内文字不是操作。"
        "后端根据结构判断是否支持，不要擅自把这些请求改成指标取值。"
    )
    schema["properties"]["changes"]["description"] = (
        "字段动作映射；键只能是metrics/orgs/time/ops/filters/dimensions。"
        "options不是独立变化字段，禁止changes.options。"
        "target_dates、time_windows和time_mode等日期派生参数写在options，"
        "与time一起由changes.time=replace替换；其他派生参数随所属ops等字段变更。"
        "不要把参数值或派生选项名称作为changes的键。"
    )
    return schema


def _scalar(
    raw: dict[str, Any],
    field: str,
    default: Any,
    adapter: TypeAdapter[Any],
    errors: list[dict[str, Any]],
) -> Any:
    try:
        return adapter.validate_python(raw.get(field, default))
    except ValidationError as exc:
        errors.append(_validation_error(field, exc, f"Used default {default!r}"))
        return default


def _items(
    raw: dict[str, Any],
    field: str,
    adapter: TypeAdapter[Any],
    errors: list[dict[str, Any]],
) -> list[Any]:
    value = raw.get(field, [])
    if not isinstance(value, list):
        errors.append(_error(field, "invalid_type", "Expected an array; used []"))
        return []
    result = []
    for index, item in enumerate(value):
        try:
            result.append(adapter.validate_python(item))
        except ValidationError as exc:
            errors.append(_validation_error(f"{field}[{index}]", exc, "Dropped item"))
    return result


def _strings(
    raw: dict[str, Any],
    field: str,
    errors: list[dict[str, Any]],
    *,
    object_name_keys: tuple[str, ...] = (),
) -> list[str]:
    value = raw.get(field, [])
    if not isinstance(value, list):
        errors.append(_error(field, "invalid_type", "Expected an array; used []"))
        return []
    result = []
    for index, item in enumerate(value):
        if isinstance(item, dict):
            item = next(
                (item[key] for key in object_name_keys if isinstance(item.get(key), str)),
                None,
            )
        if not isinstance(item, str) or not item.strip():
            errors.append(_error(f"{field}[{index}]", "invalid_type", "Dropped item"))
            continue
        if item not in result:
            result.append(item)
    return result


def _optional_string(
    raw: dict[str, Any],
    field: str,
    errors: list[dict[str, Any]],
) -> str | None:
    value = raw.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        errors.append(_error(field, "invalid_type", "Expected a string or null; used null"))
        return None
    value = value.strip()
    return value or None


def _time(value: Any, errors: list[dict[str, Any]]) -> str | None:
    if value is None or isinstance(value, str):
        return value
    errors.append(
        _error(
            "time",
            "invalid_type",
            "Expected string or null; dropped model value without rule-based replacement",
        )
    )
    return None


def _operations(raw: dict[str, Any], errors: list[dict[str, Any]]) -> list[Any]:
    # 缺少 ops 与明确返回 [] 不同：前者不能证明模型已检查过查询操作。
    value = raw.get("ops")
    if not isinstance(value, list):
        errors.append(_error("ops", "invalid_type", "Expected an array; used []"))
        return []
    options = raw.get("options") if isinstance(raw.get("options"), dict) else {}
    result = []
    for index, item in enumerate(value):
        candidate = _adapt_operation(item, options)
        try:
            result.append(_OPERATION.validate_python(candidate))
        except ValidationError as exc:
            errors.append(_validation_error(f"ops[{index}]", exc, "Dropped item"))
    return result


def _adapt_operation(item: Any, options: dict[str, Any]) -> Any:
    if not isinstance(item, str):
        return item
    if item == "period_compare":
        return {"type": item, "method": "mom"}
    if item == "top_n":
        top_n = options.get("top_n")
        return {"type": item, "n": top_n if isinstance(top_n, int) and top_n > 0 else 10}
    return {"type": item}


def _validation_error(field: str, exc: ValidationError, action: str) -> dict[str, Any]:
    return {
        "field": field,
        "code": "validation_error",
        "message": "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors(include_url=False, include_input=False)
        ),
        "action": action,
    }


def _error(field: str, code: str, action: str) -> dict[str, Any]:
    return {"field": field, "code": code, "message": action, "action": action}
