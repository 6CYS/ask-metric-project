from datetime import UTC, datetime, timedelta
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

    # slots/slot_frame/missing_slots/candidates/clarification/clarification_answers/
    # resolved_question 等是旧语义链路遗留字段，仅为读取历史任务 JSON 兼容保留，
    # 新链路不再写入（basic_query 路径只写 logical_dsl/debug）。
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


def running_execution_is_stale(
    task_status: str | None, state: QueryTaskState, stale_after: timedelta
) -> bool:
    """已登记的执行超过时限仍为 running，视为进程中断（原执行不会再落库成功）。

    没有开始时间的记录来自升级前，按已中断处理；原执行若仍在落库会因版本冲突失败。
    """
    execution = state.execution or {}
    if (execution.get("status") != "running" or execution.get("summary") is not None
            or task_status != QueryTaskStatus.RUNNING.value):
        return False
    return _older_than(execution.get("started_at"), stale_after)


def submitted_task_is_stale(
    task_status: str | None, state: QueryTaskState, stale_after: timedelta
) -> bool:
    """任务已创建但一直未登记执行（提交请求在执行前中断），超过时限即不会再有结果。"""
    if state.execution is not None or task_status != QueryTaskStatus.RUNNING.value:
        return False
    return _older_than((state.debug.get("task_create") or {}).get("submitted_at"), stale_after)


def _older_than(timestamp: Any, age: timedelta) -> bool:
    try:
        started_at = datetime.fromisoformat(str(timestamp))
    except ValueError:
        return True
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    return datetime.now(UTC) - started_at > age
