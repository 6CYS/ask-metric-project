"""合并经校验的来源与本轮字段操作；不读聊天历史，不调用模型。

compose 支持多字段替换、追加、移除和清空；旧单字段协议保留严格边界。
最终能力、目录、权限及日期要求由共享语义和执行链重新校验。
"""

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import ValidationError

from ask_metric.domain.semantics import (
    LogicalDSL,
    LogicalTimeRange,
    MetricCatalogItem,
    OrganizationCatalogItem,
    SlotFrame,
)

# 日期衍生 options：修改日期时必须清除，避免旧日期区间残留进新任务
_DATE_OPTION_KEYS = (
    "time_mode",
    "invalid_time_expression",
    "target_dates",
    "time_windows",
    "current_date",
    "base_date",
    "missing_time_reason",
)


class ReferenceMergeUnsupported(ValueError):
    """追问修改清单不一致或超出当前协议能力。"""


class ReferenceSourceInvalid(ValueError):
    """冻结的来源条件缺少已确认槽位或规范 DSL，不能作为派生依据。"""


@dataclass(frozen=True)
class MergedReference:
    """合并结果：新候选槽位 + 时间未变时来源已确认的规范时间区间。"""

    frame: SlotFrame
    resolved_time: LogicalTimeRange | None


def structured_source_slots(
    logical_dsl: dict[str, Any] | None,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
) -> dict[str, Any]:
    """从结构化查询的正式执行条件恢复槽位；不从结果样例或聊天文字猜条件。"""
    try:
        dsl = LogicalDSL.model_validate(logical_dsl)
        if not dsl.metrics or not dsl.orgs or not dsl.time.start or not dsl.time.end:
            raise ReferenceSourceInvalid("来源结构化查询缺少完整的正式条件")
        if any(op.get("type") == "top_n" for op in dsl.ops):
            # 结构化排名中的机构表示父级范围，语义排名表示候选集合；不能混用。
            raise ReferenceSourceInvalid("来源排名查询尚不能转换为语义追问条件")
        metric_by_code = {item.code: item for item in metrics}
        org_by_code = {item.code: item for item in organizations}
        frame = SlotFrame(
            task=dsl.task,
            metrics=[{"code": code, "name": metric_by_code[code].name}
                     for code in dsl.metrics],
            orgs=[org_by_code[code].name for code in dsl.orgs],
            time=f"{dsl.time.start}至{dsl.time.end}",
            dimensions=list(dsl.dimensions),
            filters=[{"field": item.dimension, "op": item.op, "value": item.value}
                     for item in dsl.filters],
            # 基础查询的 trend 表示区间全部记录，缺省粒度不能变成语义层的月度。
            ops=[{"grain": "day", **op} if op.get("type") == "trend" else op
                 for op in dsl.ops],
            options=dict(dsl.options),
        )
    except (ValidationError, KeyError) as exc:
        raise ReferenceSourceInvalid("来源结构化查询条件无效或目录项已不可用") from exc
    return frame.model_dump(mode="json")


def freeze_source_reference(
    *,
    source_task_id: str,
    source_version: int,
    change_field: Literal["orgs", "time", "compose"],
    source_slots: dict[str, Any] | None,
    source_logical_dsl: dict[str, Any] | None,
    mode: Literal["explicit", "candidate"] = "explicit",
) -> dict[str, Any]:
    """把已校验来源的已确认条件冻结为新任务的派生依据（存入 state_json）。"""
    if mode == "candidate" and change_field != "compose":
        raise ReferenceSourceInvalid("候选上下文只能通过通用修改协议解析")
    if not source_slots or not source_logical_dsl:
        raise ReferenceSourceInvalid("来源任务缺少已确认条件，不能作为追问来源")
    # 提前校验可解析，失败在提交期暴露而不是留到分析期
    SlotFrame.model_validate(source_slots)
    return {
        "mode": mode,
        "source_task_id": source_task_id,
        "source_version": source_version,
        "change_field": change_field,
        "source_slots": source_slots,
        "source_logical_dsl": source_logical_dsl,
    }


def merge_reference_frame(
    reference: dict[str, Any],
    extracted: SlotFrame,
) -> MergedReference:
    """以冻结来源为底稿应用本轮修改；旧 orgs/time 协议保持单字段限制。"""
    source = SlotFrame.model_validate(reference["source_slots"])
    change_field = reference.get("change_field")
    if change_field == "compose":
        return _compose_reference(reference, source, extracted)
    if extracted.raw_metric_texts or extracted.raw_metric_text or extracted.metrics:
        raise ReferenceMergeUnsupported("追问涉及指标变化，暂不支持；请完整描述新问题")
    if extracted.filters or extracted.dimensions:
        raise ReferenceMergeUnsupported("追问涉及筛选或维度变化，暂不支持；请完整描述新问题")
    extra_options = set(extracted.options) - set(_DATE_OPTION_KEYS) - {
        "missing_org_reason", "invalid_time_expression", "missing_metric_text",
    }
    if extra_options:
        raise ReferenceMergeUnsupported("追问涉及查询口径变化，暂不支持；请完整描述新问题")
    if extracted.ops:
        raise ReferenceMergeUnsupported("追问涉及查询操作变化，暂不支持；请完整描述新问题")

    if change_field == "orgs":
        if not extracted.orgs:
            raise ReferenceMergeUnsupported("追问中没有识别到可替换的机构")
        if extracted.time:
            raise ReferenceMergeUnsupported("同一追问同时修改机构和日期暂不支持")
        merged = source.model_copy(
            update={
                "orgs": list(dict.fromkeys(extracted.orgs)),
                "missing": [item for item in source.missing if item != "orgs"],
            }
        )
        resolved_time = _source_time(reference)
        return MergedReference(frame=merged, resolved_time=resolved_time)

    if change_field == "time":
        if not extracted.time:
            raise ReferenceMergeUnsupported("追问中没有识别到可替换的日期")
        if extracted.orgs:
            raise ReferenceMergeUnsupported("同一追问同时修改日期和机构暂不支持")
        options = {
            key: value
            for key, value in source.options.items()
            if key not in _DATE_OPTION_KEYS
        }
        options.update({key: value for key, value in extracted.options.items()
                        if key in _DATE_OPTION_KEYS})
        merged = source.model_copy(
            update={
                "time": extracted.time,
                "options": options,
                "missing": [item for item in source.missing if item != "time"],
            }
        )
        return MergedReference(frame=merged, resolved_time=None)

    raise ReferenceMergeUnsupported(f"不支持的引用修改字段: {change_field}")


def validate_change_map(delta: SlotFrame) -> None:
    """模型字段值与修改动作必须成对；共享校验，不替模型猜 add/replace。"""
    # 操作清单与值必须一致，不能悄悄丢弃模型抽取出的额外限制。
    for field in ("metrics", "orgs", "time", "ops", "filters", "dimensions"):
        value = getattr(delta, field)
        if value and field not in delta.changes:
            raise ReferenceMergeUnsupported(f"追问的 {field} 条件未声明修改方式，请重新表述")
    if (delta.raw_metric_text or delta.raw_metric_texts) and "metrics" not in delta.changes:
        raise ReferenceMergeUnsupported("指标指代与修改方式不一致，请明确要沿用或修改的指标")


def _compose_reference(
    reference: dict[str, Any], source: SlotFrame, delta: SlotFrame,
) -> MergedReference:
    changes = dict(delta.changes)
    if not changes:
        raise ReferenceMergeUnsupported("未能确定本次追问要修改的条件，请说明要查询的目标")
    allowed_options = {*_DATE_OPTION_KEYS,
                       "organization_scope", "organization_scope_text", "organization_scope_count",
                       "missing_metric_text", "metric_clarification_items", "missing_org_reason",
                       "missing_org_text", "missing_org_texts", "organization_clarification_items"}
    if set(delta.options) - allowed_options:
        raise ReferenceMergeUnsupported("追问包含尚未支持的查询参数，本次未执行取数")
    validate_change_map(delta)
    merged = source.model_copy(deep=True)
    merged.changes = changes
    merged.missing = []
    for field, action in changes.items():
        old, value = getattr(source, field), getattr(delta, field)
        if field == "time" and action not in {"replace", "clear"}:
            raise ReferenceMergeUnsupported("日期支持替换或清空；多个期间请明确完整日期范围")
        if action == "clear":
            if value:
                raise ReferenceMergeUnsupported(f"清空 {field} 时不能同时提供新值")
            updated = None if field == "time" else []
        elif action == "replace":
            if not value and field not in delta.missing and field in {"metrics", "orgs", "time"}:
                raise ReferenceMergeUnsupported(f"替换 {field} 需要明确新条件；清空请明确说明")
            updated = value
        elif action == "add":
            if not value and field not in delta.missing:
                raise ReferenceMergeUnsupported(f"追加 {field} 需要明确新条件")
            updated = [*old, *(item for item in value if item not in old)]
        else:
            if not value or any(item not in old for item in value):
                raise ReferenceMergeUnsupported("要移除的条件不在来源查询中，请明确移除对象")
            updated = [item for item in old if item not in value]
        setattr(merged, field, updated)
        if field in delta.missing and action != "clear":
            merged.missing.append(field)
    if "metrics" in changes:
        merged.raw_metric_text = delta.raw_metric_text
        merged.raw_metric_texts = list(delta.raw_metric_texts)
    # 来源的诊断候选不能污染本轮；普通查询选项仍继承并接受执行能力校验。
    diagnostic = {"missing_metric_text", "metric_clarification_items", "missing_org_reason",
                  "organization_clarification_items"}
    merged.options = {k: v for k, v in source.options.items() if k not in diagnostic}
    if "orgs" in changes:
        for key in ("organization_scope", "organization_scope_text", "organization_scope_count"):
            merged.options.pop(key, None)
    availability = any(op.type == "availability" for op in merged.ops)
    # 可用日期是输出；切换为覆盖查询时不能把上一期日期当作隐含筛选。
    if "time" not in changes and availability and "ops" in changes:
        merged.time = None
        merged.changes["time"] = "clear"
    if "time" in merged.changes:
        for key in _DATE_OPTION_KEYS:
            merged.options.pop(key, None)
    merged.options.update(delta.options)
    if "ops" in changes and not any(op.type == "period_compare" for op in merged.ops):
        for key in ("current_date", "base_date"):
            merged.options.pop(key, None)
    if "time" in merged.changes and merged.changes["time"] == "clear":
        for key in _DATE_OPTION_KEYS:
            merged.options.pop(key, None)
    # 继承无日期的覆盖查询也是合法的；切回取值后会由必填规则要求时间。
    resolved = None
    if "time" not in merged.changes and merged.time:
        resolved = _source_time(reference)
    return MergedReference(frame=merged, resolved_time=resolved)


def _source_time(reference: dict[str, Any]) -> LogicalTimeRange | None:
    """来源已确认的规范时间区间；缺失或不可解析时拒绝继承。"""
    dsl = reference.get("source_logical_dsl") or {}
    raw = dsl.get("time")
    if not raw:
        raise ReferenceMergeUnsupported("来源查询没有可继承的已确认时间")
    try:
        return LogicalTimeRange.model_validate(raw)
    except ValidationError as exc:
        raise ReferenceMergeUnsupported("来源时间格式无法继承") from exc
