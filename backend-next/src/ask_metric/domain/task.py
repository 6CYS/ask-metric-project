from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


def append_task_trace(
    state: "QueryTaskState",
    *,
    stage: str,
    status: str,
    node: str,
    detail: dict[str, Any] | None = None,
) -> None:
    trace = state.debug.setdefault("trace", [])
    if not isinstance(trace, list):
        trace = []
        state.debug["trace"] = trace
    trace.append(
        {
            "sequence": len(trace) + 1,
            "stage": stage,
            "status": status,
            "node": node,
            "detail": detail or {},
            "occurred_at": datetime.now(UTC).isoformat(),
        }
    )


class QueryTaskStatus(StrEnum):
    RUNNING = "RUNNING"
    WAITING_USER = "WAITING_USER"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    EXPIRED = "EXPIRED"


class QueryTaskStage(StrEnum):
    INTENT_ROUTING = "INTENT_ROUTING"
    SLOT_EXTRACTION = "SLOT_EXTRACTION"
    ENTITY_RESOLUTION = "ENTITY_RESOLUTION"
    VALIDATION = "VALIDATION"
    CLARIFICATION = "CLARIFICATION"
    LOGICAL_DSL = "LOGICAL_DSL"
    LEGACY_QUERY_SPEC = "QUERY_SPEC"
    PLANNING = "PLANNING"
    EXECUTION = "EXECUTION"
    RESULT_FORMATTING = "RESULT_FORMATTING"


class QueryTaskState(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_version: int = 2
    graph_version: str | None = None
    metric_matches: list[dict[str, Any]] = Field(default_factory=list)
    slots: dict[str, Any] | None = None
    missing_slots: list[str] = Field(default_factory=list)
    candidates: dict[str, list[Any]] = Field(default_factory=dict)
    clarification: dict[str, Any] | None = None
    # Legacy stage-four drafts used slot_frame; new writes use the documented slots key.
    slot_frame: dict[str, Any] | None = None
    logical_dsl: dict[str, Any] | None = None
    config_version: str = "1"
    channel_context: dict[str, Any] = Field(default_factory=dict)
    actor_context: dict[str, Any] = Field(default_factory=dict)
    initial_message_id: str | None = None
    request_fingerprint: str | None = None
    processed_requests: dict[str, dict[str, Any]] = Field(default_factory=dict)
    clarification_answers: list[dict[str, Any]] = Field(default_factory=list)
    resolved_question: str | None = None
    execution: dict[str, Any] | None = None
    timings_ms: dict[str, int] = Field(default_factory=dict)
    debug: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def discard_legacy_query_spec(cls, value: Any) -> Any:
        if isinstance(value, dict) and "query_spec" in value:
            value = dict(value)
            value.pop("query_spec", None)
        return value
