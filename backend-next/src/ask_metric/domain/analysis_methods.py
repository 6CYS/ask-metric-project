"""公共分析协议与方法准入；不接受模型编写 SQL 或任意计算公式。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AnalysisInquiry(BaseModel):
    """补查问题与待验证判断，属于规划元数据，不是机构事实。"""

    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=300)
    prior_judgment: str = Field(min_length=1, max_length=500)
    basis_refs: list[str] = Field(min_length=1, max_length=8)
    expected_change: str = Field(min_length=1, max_length=500)


class Requirement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z][A-Za-z0-9_-]*$")
    question: str = Field(min_length=1, max_length=300)
    gap_reason: str | None = Field(default=None, max_length=300)


class AnalysisStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z][A-Za-z0-9_-]*$")
    method: Literal["observe", "compare", "trend", "ranking", "structure"]
    metric_refs: list[str] = Field(min_length=1, max_length=12)
    answers: list[str] = Field(min_length=1, max_length=8)
    depends_on: list[str] = Field(default_factory=list, max_length=12)
    comparisons: list[Literal["mom", "yoy", "ytd"]] = Field(default_factory=list, max_length=3)
    rationale: str = Field(min_length=1, max_length=500)
    position: Literal["top", "bottom"] = "top"
    top_n: int = Field(default=10, ge=1, le=100)
    relation_id: str | None = Field(default=None, max_length=100)
    organization_from_step: str | None = Field(default=None, max_length=40)


class AnalysisPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    objective: str = Field(min_length=1, max_length=500)
    requirements: list[Requirement] = Field(min_length=1, max_length=8)
    steps: list[AnalysisStep] = Field(default_factory=list, max_length=12)
    scope_notice: str = Field(min_length=1, max_length=500)
    inquiry: AnalysisInquiry | None = None
    workflow_id: Literal["profitability_ranking_v1"] | None = None

    @model_validator(mode="after")
    def validate_graph(self):
        requirements = {item.id for item in self.requirements}
        ids = {step.id for step in self.steps}
        if len(requirements) != len(self.requirements) or len(ids) != len(self.steps):
            raise ValueError("子问题或计划节点ID重复")
        seen, answered = set(), set()
        for step in self.steps:
            if not set(step.depends_on) <= seen or not set(step.answers) <= requirements:
                raise ValueError("依赖必须指向前置节点，回答的子问题必须存在")
            if len(set(step.metric_refs)) != len(step.metric_refs):
                raise ValueError("节点指标引用重复")
            if step.method == "compare" and not step.comparisons:
                raise ValueError("比较方法必须声明比较期间")
            if step.method == "structure" and not step.relation_id:
                raise ValueError("结构分析必须引用审核后的关系")
            if step.organization_from_step:
                source = next((s for s in self.steps if s.id == step.organization_from_step), None)
                if (not source or source.method != "ranking" or source.id not in seen
                        or source.id not in step.depends_on or step.method == "ranking"):
                    raise ValueError("结果机构必须引用已依赖的前置排名节点，不能从文字指定")
            seen.add(step.id)
            answered.update(step.answers)
        if any(item.id not in answered and not item.gap_reason for item in self.requirements):
            raise ValueError("每个子问题都必须有执行步骤或明确缺口")
        if len({ref for step in self.steps for ref in step.metric_refs}) > 32:
            raise ValueError("单批分析最多32个不同指标，请先查询核心指标再按证据补查")
        return self


METHODS = {
    "version": "general-analysis-v1",
    "methods": [
        {"id": "observe", "requires": "正式指标、机构、有效值", "output": "实际值和覆盖"},
        {
            "id": "compare",
            "requires": "同一正式指标的可比时点，单位与数值编码明确",
            "output": "观测值差额；适用时的取值变化率，不能冒充期间发生额",
        },
        {
            "id": "trend",
            "requires": "明确范围；未给范围时采用已披露的最近三个月窗口",
            "output": "范围内每月最后有效观测，不插值、不补零",
        },
        {
            "id": "ranking",
            "requires": "获授权的机构集合、同一适用日期",
            "output": "实际集合内排名及缺数说明",
        },
        {
            "id": "structure",
            "requires": "审核后的分母与分项关系、同机构同日同单位",
            "output": "关系允许的分项占比；不自动认定互斥可加总",
        },
    ],
    "boundaries": [
        "无阈值不判断好坏或监管达标",
        "无业务证据不推断因果",
        "未知数值编码不换算百分比",
        "基础查询与复杂分析共用执行原语",
    ],
}
