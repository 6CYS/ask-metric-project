"""Analysis contracts. Facts and calculations are supplied by governed tools only."""

from datetime import date
from decimal import Decimal, localcontext
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ask_metric.domain.analysis_calculation import change, contributions  # noqa: F401

AnalysisToolName = Literal[
    "capabilities", "compare", "decompose", "decompose_org", "calculate", "finish", "clarify"
]


class AnalysisIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric_code: str | None = None
    metric_text: str | None = Field(default=None, max_length=200)
    org_code: str | None = None
    base_date: date | None = None
    report_date: date | None = None
    source_task_ids: list[str] = Field(default_factory=list, max_length=12)
    source_analysis_id: str | None = None
    goal: str = Field(default="解释指标变化来源", max_length=500)
    ambiguities: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("source_task_ids", "ambiguities", mode="before")
    @classmethod
    def absent_optional_list(cls, value):
        return [] if value is None else value


class AnalysisTarget(AnalysisIntent):
    metric_code: str
    org_code: str
    base_date: date
    report_date: date

    @model_validator(mode="after")
    def ordered_dates(self):
        if self.base_date >= self.report_date:
            raise ValueError("基期必须早于报告期")
        return self

    def dsl(self, metric_code: str | None = None) -> dict:
        return {
            "v": 1,
            "task": "metric_query",
            "metrics": [metric_code or self.metric_code],
            "orgs": [self.org_code],
            "time": {"start": str(self.base_date), "end": str(self.report_date)},
            "dimensions": [],
            "filters": [],
            "ops": [{"type": "period_compare", "method": "custom"}],
            "options": {"base_date": str(self.base_date), "current_date": str(self.report_date)},
        }


class AnalysisAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: AnalysisToolName
    metric_code: str | None = None
    org_code: str | None = None
    target_unit: str | None = None
    question: str | None = Field(default=None, max_length=500)


class AnalysisBudget(BaseModel):
    model_calls: int = Field(default=12, ge=1, le=30)
    queries: int = Field(default=24, ge=1, le=60)
    seconds: float = Field(default=120, gt=0, le=600)
    evidence_bytes: int = Field(default=64000, ge=1000, le=256000)
    depth: int = Field(default=2, ge=0, le=5)


class AnalysisSkill(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Literal["metric-change-attribution"]
    version: Literal["1.0.0", "1.1.0"]
    scope: str
    tools: list[AnalysisToolName]
    instructions: list[str] = Field(min_length=1)


class MetricRelation(BaseModel):
    """Only administrator-governed relationships may authorize decomposition."""

    model_config = ConfigDict(extra="forbid")
    parent: str
    children: list[str] = Field(min_length=1, max_length=20)
    version: str
    method: Literal["additive_balance", "unsupported_ratio"]
    unit: str
    mutually_exclusive: bool
    complete: bool
    valid_from: date
    valid_to: date
    org_codes: list[str] = Field(min_length=1)
    tolerance: Decimal = Field(default=Decimal("0.000001"), ge=0)

    @model_validator(mode="after")
    def unique_components(self):
        if len(set(self.children)) != len(self.children) or self.parent in self.children:
            raise ValueError("分项编号必须唯一且不包含总量")
        if self.valid_from > self.valid_to:
            raise ValueError("关系有效期无效")
        return self


class OrganizationRelation(MetricRelation):
    """An approved statistical sum, not an automatic permission inheritance."""

    org_codes: list[str] = Field(default_factory=list)
    metric_codes: list[str] = Field(min_length=1)
    relation_type: Literal["statistical_sum"] = "statistical_sum"


def decompose(total: dict, components: dict[str, dict | None], relation: MetricRelation) -> dict:
    with localcontext() as ctx:
        ctx.prec = 38
        return _decompose(total, components, relation)


def _decompose(total: dict, components: dict[str, dict | None], relation: MetricRelation) -> dict:
    """Signed contribution; missing values stay missing, residual is never hidden."""
    if relation.method != "additive_balance":
        return {"status": "UNSUPPORTED_METHOD", "gap": "未批准比率分解口径，不能相加比率"}
    if not relation.mutually_exclusive:
        return {"status": "OVERLAPPING_COMPONENTS", "gap": "分项非互斥，不能计算加总贡献"}
    delta = Decimal(total["difference"])
    rows, missing = [], []
    base_sum = current_sum = Decimal(0)
    for code in relation.children:
        item = components.get(code)
        if item is None:
            missing.append(code)
            continue
        base_sum += Decimal(item["base_value"])
        current_sum += Decimal(item["current_value"])
        rows.append(
            {
                "metric_code": code,
                **item,
                **contributions(item["difference"], delta),
            }
        )
    base_residual = Decimal(total["base_value"]) - base_sum
    current_residual = Decimal(total["current_value"]) - current_sum
    reconciled = (
        not missing
        and relation.complete
        and abs(base_residual) <= relation.tolerance
        and abs(current_residual) <= relation.tolerance
    )
    return {
        "status": "OK" if reconciled else "PARTIAL",
        "rows": rows,
        "missing": missing,
        "base_residual": str(base_residual),
        "current_residual": str(current_residual),
        "unexplained_change": str(current_residual - base_residual),
        "relation_version": relation.version,
        "reconciled": reconciled,
        "causality": "分项贡献说明数据变化来源，不证明业务动因",
    }
