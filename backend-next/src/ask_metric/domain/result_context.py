"""Versioned, JSON-persisted contracts for conversation result references."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ResultReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: Literal["READ", "CROP", "SELECT_ORG"]
    scope: Literal["CURRENT", "HISTORY", "TURN"] = "HISTORY"
    reference_text: str = Field(min_length=1, max_length=200)
    turn_index: int | None = Field(default=None, ge=1)
    metric_codes: list[str] = Field(default_factory=list)
    org_codes: list[str] = Field(default_factory=list)
    start: str | None = None
    end: str | None = None
    query_shape: str | None = None
    kind: Literal["ORIGINAL", "DERIVED", "ANY"] = "ORIGINAL"
    limit: int | None = Field(default=None, ge=1, le=1000)
    row_number: int | None = Field(default=None, ge=1, le=1000)
    filter_evidence: dict[str, str | None] = Field(default_factory=dict)

    @field_validator("filter_evidence", mode="before")
    @classmethod
    def empty_evidence(cls, value):
        return {} if value is None else value

    @field_validator("metric_codes", "org_codes", mode="before")
    @classmethod
    def empty_filters(cls, value):
        return [] if value is None else value

    @model_validator(mode="after")
    def validate_operation(self):
        if self.scope == "TURN" and self.turn_index is None:
            raise ValueError("TURN requires turn_index")
        if self.operation == "CROP" and self.limit is None:
            raise ValueError("CROP requires limit")
        if self.operation == "SELECT_ORG" and self.row_number is None:
            raise ValueError("SELECT_ORG requires row_number")
        return self


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
    context: dict[str, Any]
    logical_dsl: dict[str, Any]
    result: dict[str, Any]


class ConversationFocus(BaseModel):
    task_id: str
    result_id: str
    source_task_id: str
