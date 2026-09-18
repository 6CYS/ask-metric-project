"""单来源追问的引用合并：只做来源字段合并，不读聊天历史、不调用模型。

第一阶段只支持原文可核验的单字段机构替换或日期替换；指标、筛选、操作等
其他已确认字段保持来源值。超出范围的修改显式拒绝，不静默丢弃用户条件。
"""

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import ValidationError

from ask_metric.domain.semantics import LogicalTimeRange, SlotFrame

# 日期衍生 options：修改日期时必须清除，避免旧日期区间残留进新任务
_DATE_OPTION_KEYS = (
    "target_dates",
    "time_windows",
    "current_date",
    "base_date",
    "missing_time_reason",
)


class ReferenceMergeUnsupported(ValueError):
    """追问修改超出当前支持范围（多字段同改、追加、指标/筛选/操作变化）。"""


class ReferenceSourceInvalid(ValueError):
    """冻结的来源条件缺少已确认槽位或规范 DSL，不能作为派生依据。"""


@dataclass(frozen=True)
class MergedReference:
    """合并结果：新候选槽位 + 时间未变时来源已确认的规范时间区间。"""

    frame: SlotFrame
    resolved_time: LogicalTimeRange | None


def freeze_source_reference(
    *,
    source_task_id: str,
    source_version: int,
    change_field: Literal["orgs", "time"],
    source_slots: dict[str, Any] | None,
    source_logical_dsl: dict[str, Any] | None,
) -> dict[str, Any]:
    """把已校验来源的已确认条件冻结为新任务的派生依据（存入 state_json）。"""
    if not source_slots or not source_logical_dsl:
        raise ReferenceSourceInvalid("来源任务缺少已确认条件，不能作为追问来源")
    # 提前校验可解析，失败在提交期暴露而不是留到分析期
    SlotFrame.model_validate(source_slots)
    return {
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
    """以冻结来源为底稿，应用本轮原文支持的单字段替换。

    extracted 是模型对本轮追问原文的抽取结果，只提供被替换字段的新值；
    发现原文同时修改其他字段（指标短语、另一字段）时拒绝合并。
    """
    source = SlotFrame.model_validate(reference["source_slots"])
    change_field = reference.get("change_field")
    if extracted.raw_metric_texts:
        raise ReferenceMergeUnsupported("追问涉及指标变化，暂不支持；请完整描述新问题")
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
        merged = source.model_copy(
            update={
                "time": extracted.time,
                "options": options,
                "missing": [item for item in source.missing if item != "time"],
            }
        )
        return MergedReference(frame=merged, resolved_time=None)

    raise ReferenceMergeUnsupported(f"不支持的引用修改字段: {change_field}")


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
