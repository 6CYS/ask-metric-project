"""语义能力合同：先判断能做什么，再询问该能力所需条件。"""

from dataclasses import dataclass


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
