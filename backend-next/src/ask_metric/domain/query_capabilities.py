"""语义能力合同：先判断能做什么，再询问该能力所需条件。"""

from dataclasses import dataclass

from ask_metric.domain.semantics import SlotFrame


@dataclass(frozen=True)
class QueryCapability:
    operations: frozenset[str]
    requires_time: bool = True


CAPABILITIES = {
    "metric_value": QueryCapability(frozenset({"entity_compare"})),
    "metric_trend": QueryCapability(frozenset({"trend"})),
    "metric_period_compare": QueryCapability(frozenset({"period_compare"})),
    "metric_ranking": QueryCapability(frozenset({"ranking", "top_n"})),
    "metric_availability": QueryCapability(frozenset({"availability"}), requires_time=False),
}


def capability_error(frame: SlotFrame, shape: str) -> str | None:
    capability = CAPABILITIES.get(shape)
    operations = {op.type for op in frame.ops}
    if capability is None or operations - capability.operations:
        return "当前不支持这项查询操作或操作组合，本次未执行取数。"
    if frame.filters or any(value not in {"org", "机构"} for value in frame.dimensions):
        return "当前不支持这类筛选条件或维度展开，本次未执行取数。"
    if any(op.type == "period_compare" and op.method != "custom" for op in frame.ops):
        return "当前支持明确两期日期的比较；动态同比、环比请使用对应的正式指标。"
    if shape == "metric_availability" and len(frame.ops) != 1:
        return "可用日期查询不能同时执行其他计算，请分别查询。"
    return None
