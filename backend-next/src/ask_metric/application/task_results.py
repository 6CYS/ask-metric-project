from typing import Any, Literal

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


class BasicQueryStatus(BaseModel):
    """按幂等键只读回查基础查询的真实状态，供调用方对账；不创建任务、不执行 SQL。

    interrupted 表示执行登记后超时未结束，原执行不会再成功发布结果。
    """

    task_id: str
    version: int
    status: Literal["running", "succeeded", "failed", "interrupted"]
    result_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class TaskResultPage(BaseModel):
    """统一结果读取：不可变快照的分页视图；paging 只覆盖快照内 rows，不触发重算。"""

    task_id: str
    result_id: str
    status: str
    query_shape: str | None = None
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    comparisons: list[dict[str, Any]] = Field(default_factory=list)
    facts: list[dict[str, Any]] = Field(default_factory=list)
    calculation_scope_id: str | None = None
    row_count: int = 0
    truncated: bool = False
    offset: int = 0
    limit: int = 0
    next_offset: int | None = None
    has_more: bool = False
    message: str | None = None
    # 结构化正文块；旧快照无此字段时透传 None，前端回退渲染 message。
    answer_blocks: list[dict[str, Any]] | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)
