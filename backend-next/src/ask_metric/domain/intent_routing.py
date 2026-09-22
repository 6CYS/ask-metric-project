from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError


class RoutedIntent(StrEnum):
    METRIC_QUERY = "metric_query"
    ATTRIBUTION_ANALYSIS = "attribution_analysis"
    ANOMALY_DETECTION = "anomaly_detection"
    TREND_FORECAST = "trend_forecast"
    METRIC_EXPLANATION = "metric_explanation"
    DATA_LINEAGE = "data_lineage"
    INSIGHT_REPORT = "insight_report"
    NON_METRIC_CHAT = "non_metric_chat"
    OTHER = "other"


class IntentClassification(BaseModel):
    # 旧持久提示词可能继续返回自报置信度等字段；忽略它们，只校验实际路由意图。
    model_config = ConfigDict(extra="ignore")

    intent: RoutedIntent


class InvalidIntentClassification(ValueError):
    def __init__(self, raw_output: Any, errors: list[dict[str, Any]]) -> None:
        super().__init__("Model output is not a valid intent classification")
        self.raw_output = raw_output
        self.errors = errors


def parse_intent_classification(raw_output: Any) -> IntentClassification:
    try:
        return IntentClassification.model_validate(raw_output)
    except ValidationError as exc:
        raise InvalidIntentClassification(
            raw_output,
            exc.errors(
                include_url=False,
                include_context=False,
                include_input=False,
            ),
        ) from exc
