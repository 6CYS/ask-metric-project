"""指标关系的维护契约；分类、完整组成声明与比例依赖分别表达。"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MetricCode = Annotated[str, Field(min_length=1, max_length=150)]


class MetricRelationFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    kind: Literal["classification", "composition", "ratio"] = "classification"
    status: Literal["draft", "approved", "retired"] = "draft"
    parent: MetricCode
    children: list[MetricCode] = Field(min_length=1, max_length=15)
    source: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def distinct_members(self) -> "MetricRelationFields":
        if self.parent in self.children or len(set(self.children)) != len(self.children):
            raise ValueError("指标关系不能自包含或重复")
        if self.kind == "ratio" and len(self.children) != 2:
            raise ValueError("比例依赖须依次选择分子和分母")
        return self


class MetricRelation(MetricRelationFields):
    id: str = Field(min_length=1, max_length=100)
