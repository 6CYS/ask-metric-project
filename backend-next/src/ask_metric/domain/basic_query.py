"""基础取数契约：只表达目录编码和数据选取方式，不接收自然语言或分析操作。"""

from datetime import date
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from ask_metric.domain.semantics import LogicalDSL, LogicalTimeRange, TaskType

CatalogCode = Annotated[
    str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=128)
]


class BasicQueryTime(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: date
    end: date

    @field_validator("start", "end", mode="before")
    @classmethod
    def require_calendar_date(cls, value):
        # 不接受时间戳/日期时间的隐式转换；调用方必须给出明确的业务日期。
        if type(value) is date:
            return value
        if not isinstance(value, str) or len(value) != 10:
            raise ValueError("日期必须为 YYYY-MM-DD")
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError("日期必须为 YYYY-MM-DD")
        return parsed

    @model_validator(mode="after")
    def validate_range(self):
        if self.start > self.end:
            raise ValueError("开始日期不能晚于结束日期")
        return self


class BasicQuerySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric_codes: list[CatalogCode] = Field(min_length=1, max_length=100)
    org_codes: list[CatalogCode] = Field(min_length=1, max_length=1000)
    time: BasicQueryTime
    selection: Literal["exact", "latest_in_range", "all_in_range"]

    @model_validator(mode="after")
    def validate_selection(self):
        if self.selection == "exact" and self.time.start != self.time.end:
            raise ValueError("exact 必须指定同一个日期")
        self.metric_codes = list(dict.fromkeys(self.metric_codes))
        self.org_codes = list(dict.fromkeys(self.org_codes))
        return self

    def to_logical_dsl(self) -> LogicalDSL:
        # 全区间取数复用现有趋势模板，仅返回原值，不触发上层分析或聚合。
        return LogicalDSL(
            task=TaskType.METRIC_QUERY,
            metrics=self.metric_codes,
            orgs=self.org_codes,
            time=LogicalTimeRange(start=self.time.start, end=self.time.end),
            ops=[{"type": "trend"}] if self.selection == "all_in_range" else [],
        )

    @property
    def query_shape(self) -> str:
        return "metric_trend" if self.selection == "all_in_range" else "metric_value"
