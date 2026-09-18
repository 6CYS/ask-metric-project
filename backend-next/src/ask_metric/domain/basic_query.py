"""基础取数契约：只表达目录编码和数据选取方式，不接收自然语言或分析操作。"""

from datetime import date
from typing import Annotated, Any, Literal

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
    # ranking 允许空列表（缺省=层级根节点，由执行服务补全）；其余
    # selection 至少一个机构，在 validate_selection 中按 selection 分别校验。
    org_codes: list[CatalogCode] = Field(max_length=1000)
    time: BasicQueryTime
    selection: Literal["exact", "latest_in_range", "all_in_range", "ranking"]
    # 仅 selection=ranking 使用：排名方向与条数，其他 selection 不得携带。
    order: Literal["asc", "desc"] = "desc"
    top_n: int = Field(default=5, ge=1, le=100)

    @model_validator(mode="after")
    def validate_selection(self):
        if self.selection == "exact" and self.time.start != self.time.end:
            raise ValueError("exact 必须指定同一个日期")
        self.metric_codes = list(dict.fromkeys(self.metric_codes))
        self.org_codes = list(dict.fromkeys(self.org_codes))
        if self.selection != "ranking" and not self.org_codes:
            raise ValueError("必须至少指定一个机构")
        if self.selection == "ranking":
            # 排名契约：org_codes 是范围机构（至多一个，缺省=层级根节点），候选集合
            # 由执行服务扩展为其直接下级；start=end 按当日排名，区间按范围内最新一期排名。
            if len(self.org_codes) > 1:
                raise ValueError("ranking 至多指定一个范围机构")
        else:
            if self.order != "desc" or self.top_n != 5:
                raise ValueError("order/top_n 仅 selection=ranking 可用")
        return self

    def to_logical_dsl(self) -> LogicalDSL:
        # 全区间取数复用现有趋势模板，仅返回原值，不触发上层分析或聚合；
        # 排名复用 planner 排名分支（top_n 操作），执行服务先把范围机构扩展为下级集合。
        ops: list[dict[str, Any]] = []
        if self.selection == "all_in_range":
            ops = [{"type": "trend"}]
        elif self.selection == "ranking":
            ops = [{"type": "top_n", "n": self.top_n, "order": self.order}]
        return LogicalDSL(
            task=TaskType.METRIC_QUERY,
            metrics=self.metric_codes,
            orgs=self.org_codes,
            time=LogicalTimeRange(start=self.time.start, end=self.time.end),
            ops=ops,
        )

    @property
    def query_shape(self) -> str:
        if self.selection == "all_in_range":
            return "metric_trend"
        if self.selection == "ranking":
            return "metric_ranking"
        return "metric_value"
