import json
from pathlib import Path
from string import Formatter

from pydantic import BaseModel, Field, model_validator


class MetricMatchingConfig(BaseModel):
    max_candidates: int = Field(default=3, gt=0, le=100)
    embedding_top_k: int = Field(default=30, gt=0, le=1000)
    embedding_batch_size: int = Field(default=16, gt=0, le=128)
    embedding_cache_wait_seconds: float = Field(default=60, gt=0, le=600)
    rerank_top_k: int = Field(default=10, gt=0, le=100)
    similarity_threshold: float = Field(default=0.5, ge=0, le=1)
    auto_select_threshold: float = Field(default=0.85, ge=0, le=1)
    auto_select_margin: float = Field(default=0.15, ge=0, le=1)

    @model_validator(mode="after")
    def validate_threshold_order(self) -> "MetricMatchingConfig":
        if self.auto_select_threshold < self.similarity_threshold:
            raise ValueError("auto_select_threshold cannot be below similarity_threshold")
        return self


class ClarificationPrompts(BaseModel):
    metrics_with_options: str = "匹配到多个可能的指标，请确认：{options}。"
    metrics_without_options: str = "请补充要查询的具体指标名称。"
    missing_fields: str = "请补充或确认：{fields}。"
    field_labels: dict[str, str] = Field(default_factory=dict)
    scenarios: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_templates(self) -> "ClarificationPrompts":
        templates = {
            "metrics_with_options": (self.metrics_with_options, {"options"}),
            "metrics_without_options": (self.metrics_without_options, set()),
            "missing_fields": (self.missing_fields, {"fields"}),
            **{
                f"scenarios.{name}": (template, {"time", "metric", "organization", "options"})
                for name, template in self.scenarios.items()
            },
        }
        for name, (template, allowed) in templates.items():
            try:
                for _, field, spec, conversion in Formatter().parse(template):
                    if field is not None and (field not in allowed or spec or conversion):
                        raise ValueError(f"unsupported placeholder {{{field}}}")
            except ValueError as exc:
                raise ValueError(f"Invalid clarification template {name}: {exc}") from exc
        return self


class SemanticConfig(BaseModel):
    version: str
    tasks: list[str]
    operations: list[str]
    default_time: str = "latest"
    required_slots: list[str] = Field(default_factory=list)
    dimension_names: dict[str, str] = Field(default_factory=dict)
    organization_aliases: dict[str, list[str]] = Field(default_factory=dict)
    clarification_prompts: ClarificationPrompts
    metric_matching: MetricMatchingConfig = Field(default_factory=MetricMatchingConfig)


class SemanticConfigRepository:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> SemanticConfig:
        with self.path.open("r", encoding="utf-8") as file:
            return SemanticConfig.model_validate(json.load(file))
