from typing import Any

from pydantic import BaseModel, Field


class TaskCommandResult(BaseModel):
    task_id: str
    conversation_id: str
    version: int
    status: str
    current_stage: str
    message_id: str | None = None
    idempotent_replay: bool = False
    clarification: dict[str, Any] | None = None
    continuation_token: str | None = None
    slot_frame: dict[str, Any] | None = None
    logical_dsl: dict[str, Any] | None = None
    missing: list[str] = Field(default_factory=list)
    query_shape: str | None = None
    resolved_question: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    timings_ms: dict[str, int] = Field(default_factory=dict)
    debug: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None


class TaskResultPage(BaseModel):
    """统一结果读取：不可变快照的分页视图；paging 只覆盖快照内 rows，不触发重算。"""

    task_id: str
    result_id: str
    status: str
    query_shape: str | None = None
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    comparisons: list[dict[str, Any]] = Field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    offset: int = 0
    limit: int = 0
    next_offset: int | None = None
    has_more: bool = False
    message: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class ConversationMessageResult(BaseModel):
    id: str
    role: str
    content: str
    created_at: str | None = None
    task_id: str | None = None
    payload: dict[str, Any] | None = None


class ConversationTaskResult(BaseModel):
    id: str
    status: str
    current_stage: str
    version: int
    original_question: str
    query_shape: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    logical_dsl: dict[str, Any] | None = None
    timings_ms: dict[str, int] = Field(default_factory=dict)
    debug: dict[str, Any] = Field(default_factory=dict)


class ConversationSnapshot(BaseModel):
    id: str
    title: str
    preview: str
    messages: list[ConversationMessageResult] = Field(default_factory=list)
    tasks: list[ConversationTaskResult] = Field(default_factory=list)


class ConversationListItem(BaseModel):
    id: str
    title: str
    preview: str
    created_at: str | None = None
    updated_at: str | None = None
    message_count: int | None = None


class ConversationCleanupResult(BaseModel):
    keep_latest: int
    deleted_count: int
    remaining_count: int
    protected_active_count: int = 0
