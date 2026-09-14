"""历史查询结果的持久化格式；旧裁剪来源字段仅供兼容读取。"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ResultArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    result_id: str
    task_id: str
    conversation_id: str
    owner_user_id: str | None
    tenant_id: str | None = None
    source_run_id: int | None = None
    parent_result_id: str | None = None
    operation: Literal["QUERY", "CROP"] = "QUERY"
    created_at: datetime
    expires_at: datetime | None = None
    context: dict[str, Any] = Field(default_factory=dict)
    logical_dsl: dict[str, Any]
    result: dict[str, Any]
