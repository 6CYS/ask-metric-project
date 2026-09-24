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

from ask_metric.domain.organization_scope import OrganizationScopeSpec
from ask_metric.domain.semantics import LogicalDSL, LogicalTimeRange, TaskType

CatalogCode = Annotated[
    str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=128)
]


class BasicQueryTime(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: date
    end: date
    # 多个离散日期点（如"2月末、3月末、4月末"）；为空表示单点或连续区间。
    # start/end 始终是这些点的最早/最晚，兼容既有 {start,end} 消费方。
    dates: list[date] | None = None

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

    @field_validator("dates", mode="before")
    @classmethod
    def require_calendar_dates(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("离散日期必须是数组")
        return [cls.require_calendar_date(item) for item in value]

    @model_validator(mode="after")
    def validate_range(self):
        if self.start > self.end:
            raise ValueError("开始日期不能晚于结束日期")
        if self.dates is not None:
            unique = sorted(dict.fromkeys(self.dates))
            if len(unique) < 2:
                raise ValueError("离散日期至少需要两个不同日期，单点请用 start/end")
            if unique[0] != self.start or unique[-1] != self.end:
                raise ValueError("离散日期的最早/最晚必须等于 start/end")
            self.dates = unique
        return self


class ValueOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["value"] = "value"


class RankingOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ranking"]
    order: Literal["asc", "desc"]
    top_n: int = Field(ge=1, le=100, strict=True)


QueryOperation = Annotated[ValueOperation | RankingOperation, Field(discriminator="kind")]


class BasicQuerySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric_codes: list[CatalogCode] = Field(min_length=1, max_length=100)
    schema_version: Literal[2] = 2
    # 始终是实际查询对象；集合通过独立范围契约解析，禁止空数组隐式扩展。
    org_codes: list[CatalogCode] = Field(default_factory=list, max_length=1000)
    organization_scope: OrganizationScopeSpec | None = None
    scope_fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    time: BasicQueryTime
    selection: Literal["exact", "latest_in_range", "all_in_range"]
    operation: QueryOperation = Field(default_factory=ValueOperation)

    @model_validator(mode="after")
    def validate_selection(self):
        has_dates = self.time.dates is not None
        # 多个离散点本质是"多个 exact 点"，各点各取一值；与区间取数方式互斥。
        if has_dates:
            if self.selection == "all_in_range":
                raise ValueError("离散日期点不能与完整时间序列取数方式共用")
            if self.operation.kind == "ranking":
                raise ValueError("逐个离散日期排名尚未实现")
        elif self.selection == "exact" and self.time.start != self.time.end:
            raise ValueError("exact 必须指定同一个日期")
        # 单日范围的最后有效日与指定日等价，规范化后仍绝不回退到前一天。
        if not has_dates and self.selection == "latest_in_range" and self.time.start == self.time.end:
            self.selection = "exact"
        self.metric_codes = list(dict.fromkeys(self.metric_codes))
        self.org_codes = list(dict.fromkeys(self.org_codes))
        if self.organization_scope is not None:
            if self.org_codes or self.scope_fingerprint is None:
                raise ValueError("集合范围必须携带已解析指纹，且不能同时指定机构编码")
        else:
            if not self.org_codes or self.scope_fingerprint is not None:
                raise ValueError("具体机构查询必须提供编码，不能携带集合指纹")
        if self.operation.kind == "ranking" and self.selection == "all_in_range":
            raise ValueError("逐日排名尚未实现，不能将完整序列静默缩为一期")
        return self

    def to_logical_dsl(self) -> LogicalDSL:
        # 全区间取数复用现有趋势模板，仅返回原值，不触发上层分析或聚合；
        # 排名与日期正交；范围服务已解析目标集合，planner 不再二次展开机构。
        ops: list[dict[str, Any]] = []
        if self.selection == "all_in_range":
            ops = [{"type": "trend"}]
        elif self.operation.kind == "ranking":
            ops = [{"type": "top_n", "n": self.operation.top_n,
                    "order": self.operation.order}]
        options: dict[str, Any] = {"query_contract_version": self.schema_version}
        if self.organization_scope is not None:
            options.update(query_scope=self.organization_scope.model_dump(mode="json"),
                           scope_fingerprint=self.scope_fingerprint)
        # 离散多点走 planner 的 METRIC_VALUE_AT_DATES 场景（stat_date IN），
        # time 仍保留 min~max 供 latest 判断等既有逻辑读取。
        if self.time.dates is not None:
            options["target_dates"] = [item.isoformat() for item in self.time.dates]
        return LogicalDSL(
            task=TaskType.METRIC_QUERY,
            metrics=self.metric_codes,
            orgs=self.org_codes,
            time=LogicalTimeRange(start=self.time.start, end=self.time.end),
            ops=ops,
            options=options,
        )

    @property
    def query_shape(self) -> str:
        if self.selection == "all_in_range":
            return "metric_trend"
        if self.operation.kind == "ranking":
            return "metric_ranking"
        return "metric_value"
