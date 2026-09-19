from __future__ import annotations

from datetime import date
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class TaskType(StrEnum):
    METRIC_QUERY = "metric_query"
    ANOMALY_DETECTION = "anomaly_detection"
    TREND_FORECAST = "trend_forecast"
    METRIC_EXPLANATION = "metric_explanation"
    DATA_LINEAGE = "data_lineage"
    INSIGHT_REPORT = "insight_report"


class MetricSlot(BaseModel):
    code: str = Field(min_length=1)
    name: str = Field(min_length=1)


class FilterSlot(BaseModel):
    field: str = Field(min_length=1)
    op: Literal["eq", "in", "between", "gt", "gte", "lt", "lte"]
    value: Any


class AggregateOperation(BaseModel):
    type: Literal["aggregate"] = "aggregate"
    method: Literal["sum", "avg", "min", "max", "count"] = "sum"


class TrendOperation(BaseModel):
    type: Literal["trend"] = "trend"
    grain: Literal["day", "week", "month", "quarter", "year"] = "month"


class EntityCompareOperation(BaseModel):
    type: Literal["entity_compare"] = "entity_compare"
    dimension: str = "机构"
    method: Literal["value", "difference", "ratio"] = "value"


class PeriodCompareOperation(BaseModel):
    type: Literal["period_compare"] = "period_compare"
    method: Literal["yoy", "mom", "qoq", "custom"]


class RankingOperation(BaseModel):
    type: Literal["ranking"] = "ranking"
    dimension: str = "机构"
    order: Literal["asc", "desc"] = "desc"
    top_n: int | None = Field(default=None, gt=0, le=1000)


class TopNOperation(BaseModel):
    type: Literal["top_n"] = "top_n"
    n: int = Field(gt=0, le=1000)
    order: Literal["asc", "desc"] = "asc"


class DetailOperation(BaseModel):
    type: Literal["detail"] = "detail"


class DrillDownOperation(BaseModel):
    type: Literal["drill_down"] = "drill_down"
    dimension: str = Field(min_length=1)


class AvailabilityOperation(BaseModel):
    """查询实际有值的数据日期；零有效，空值不计入覆盖。"""

    type: Literal["availability"] = "availability"
    grain: Literal["day", "month"] = "month"
    selection: Literal["all", "earliest", "latest"] = "all"


class UnsupportedOperation(BaseModel):
    type: Literal["unsupported"] = "unsupported"
    capability: str = Field(min_length=1, max_length=100)


ChangeField = Literal["metrics", "orgs", "time", "ops", "filters", "dimensions"]
ChangeAction = Literal["replace", "add", "remove", "clear"]


SlotOperation = Annotated[
    AggregateOperation
    | TrendOperation
    | EntityCompareOperation
    | PeriodCompareOperation
    | RankingOperation
    | TopNOperation
    | DetailOperation
    | DrillDownOperation
    | AvailabilityOperation
    | UnsupportedOperation,
    Field(discriminator="type"),
]


class SlotFrame(BaseModel):
    task: TaskType = TaskType.METRIC_QUERY
    raw_metric_text: str | None = Field(default=None, max_length=500)
    raw_metric_texts: list[str] = Field(default_factory=list)
    metrics: list[MetricSlot] = Field(default_factory=list)
    time: str | None = None
    orgs: list[str] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[FilterSlot] = Field(default_factory=list)
    ops: list[SlotOperation] = Field(default_factory=list)
    options: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "多个独立日期分别取值：target_dates 为全部 YYYY-MM-DD 日期的数组，"
            "time 为最早至最晚范围；连续区间不能因此生成 target_dates。"
            "多个独立期间分别取值：time_windows 为包含 start/end 的对象数组。"
            "两期增减比较使用 current_date/base_date，不能用 target_dates 代替比较。"
        ),
    )
    missing: list[str] = Field(default_factory=list)
    context_relation: Literal["independent", "followup", "ambiguous"] | None = Field(
        default=None, description="有候选来源时必须声明本轮与来源的关系；未确认关系禁止继承。",
    )
    changes: dict[ChangeField, ChangeAction] = Field(
        default_factory=dict,
        description="引用追问的字段操作；值取本轮同名字段。未列出的字段继承来源。",
    )

    @field_validator("raw_metric_text", mode="before")
    @classmethod
    def normalize_raw_metric_text(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("raw_metric_texts", mode="before")
    @classmethod
    def normalize_raw_metric_texts(cls, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        normalized = []
        for item in value:
            if isinstance(item, str) and item.strip() and item.strip() not in normalized:
                normalized.append(item.strip())
        return normalized

    @field_validator("time", mode="before")
    @classmethod
    def discard_structured_model_time(cls, value: Any) -> Any:
        # Keep the existing SlotFrame string contract; structured model output is unsupported.
        return value if isinstance(value, str) else None

    @field_validator("dimensions", mode="before")
    @classmethod
    def normalize_dimension_objects(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return []
        normalized = []
        for item in value:
            if isinstance(item, str):
                normalized.append(item)
            elif isinstance(item, dict):
                name = item.get("name") or item.get("dimension") or item.get("field")
                if isinstance(name, str) and name.strip():
                    normalized.append(name)
        return normalized

    @field_validator("filters", mode="before")
    @classmethod
    def discard_invalid_filters(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return []
        return [
            item
            for item in value
            if isinstance(item, dict)
            and isinstance(item.get("field"), str)
            and item.get("op") in {"eq", "in", "between", "gt", "gte", "lt", "lte"}
        ]

    @field_validator("orgs", mode="before")
    @classmethod
    def normalize_organization_objects(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return value
        return [
            item["name"]
            if isinstance(item, dict)
            and isinstance(item.get("name"), str)
            and item["name"].strip()
            else item
            for item in value
        ]

    @field_validator("ops", mode="before")
    @classmethod
    def normalize_simple_operation_names(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return value
        simple_operations = {
            "aggregate",
            "trend",
            "entity_compare",
            "period_compare",
            "ranking",
            "detail",
        }
        return [
            (
                {"type": item, "method": "mom"}
                if item == "period_compare"
                else {"type": item}
            )
            if isinstance(item, str) and item in simple_operations
            else item
            for item in value
        ]

    @model_validator(mode="after")
    def deduplicate_simple_arrays(self) -> SlotFrame:
        self.raw_metric_texts = list(dict.fromkeys(self.raw_metric_texts))
        self.orgs = list(dict.fromkeys(self.orgs))
        self.dimensions = list(dict.fromkeys(self.dimensions))
        self.missing = list(dict.fromkeys(self.missing))
        return self


class LogicalTimeRange(BaseModel):
    start: date | None = None
    end: date | None = None
    preset: Literal["latest"] | None = None


class LogicalFilter(BaseModel):
    dimension: str
    op: Literal["eq", "in", "between", "gt", "gte", "lt", "lte"]
    value: Any


class LogicalDSL(BaseModel):
    v: Literal[1] = 1
    task: TaskType
    metrics: list[str] = Field(default_factory=list)
    time: LogicalTimeRange
    orgs: list[str] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[LogicalFilter] = Field(default_factory=list)
    ops: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class MetricCatalogItem(BaseModel):
    code: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    description: str = ""
    unit: str | None = None
    explanation: str = ""


class OrganizationCatalogItem(BaseModel):
    code: str
    name: str
    aliases: list[str] = Field(default_factory=list)


class MetricMatch(BaseModel):
    code: str
    name: str
    matched_text: str
    start: int
    end: int
    source: Literal["standard_name", "alias"]
    exact: bool = False


class SemanticPatch(BaseModel):
    set: dict[str, Any] = Field(default_factory=dict)
    add_ops: list[SlotOperation] = Field(default_factory=list)
    remove_ops: list[dict[str, Any]] = Field(default_factory=list)
