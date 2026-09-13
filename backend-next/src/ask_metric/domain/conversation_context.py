from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ask_metric.domain.result_context import ResultReference
from ask_metric.domain.semantics import LogicalDSL, SlotOperation, TaskType

CONTEXT_FIELDS = {
    "metrics",
    "orgs",
    "time",
    "dimensions",
    "filters",
    "ops",
    "options",
}
ADDITIVE_CONTEXT_FIELDS = CONTEXT_FIELDS - {"time", "options"}
FORBIDDEN_CONTEXT_KEYS = {"sql", "sql_text", "sql_params"}


class StrictContextModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConversationAct(StrEnum):
    NEW_QUERY = "NEW_QUERY"
    FOLLOW_UP = "FOLLOW_UP"
    CLARIFICATION_ANSWER = "CLARIFICATION_ANSWER"
    RESUME_TASK = "RESUME_TASK"
    REFERENCE_ACTION = "REFERENCE_ACTION"
    CANCEL = "CANCEL"


class AnchorSelection(StrEnum):
    ACTIVE_TASK = "ACTIVE_TASK"
    LAST_SUCCESSFUL_TASK = "LAST_SUCCESSFUL_TASK"
    EXPLICIT_TASK = "EXPLICIT_TASK"
    ORDINAL_TASK = "ORDINAL_TASK"
    HISTORICAL_TASK = "HISTORICAL_TASK"
    MULTIPLE_TASKS = "MULTIPLE_TASKS"
    AMBIGUOUS = "AMBIGUOUS"
    NONE = "NONE"


class FollowUpOperation(StrEnum):
    REFINE = "REFINE"
    COMPARE = "COMPARE"
    DRILL_DOWN = "DRILL_DOWN"
    EXPLAIN_RESULT = "EXPLAIN_RESULT"
    RERUN = "RERUN"
    CONTINUE = "CONTINUE"
    EXPORT = "EXPORT"
    VISUALIZE = "VISUALIZE"
    ATTRIBUTION = "ATTRIBUTION"


class FollowUpRoute(StrEnum):
    RESUME_TASK = "RESUME_TASK"
    REQUERY = "REQUERY"
    RESULT_ACTION = "RESULT_ACTION"
    PROFESSIONAL_ANALYSIS = "PROFESSIONAL_ANALYSIS"
    CLARIFY = "CLARIFY"
    REJECT = "REJECT"


class AnchorResolutionStatus(StrEnum):
    RESOLVED = "RESOLVED"
    AMBIGUOUS = "AMBIGUOUS"
    NONE = "NONE"
    INVALID_REFERENCE = "INVALID_REFERENCE"


class AnchorResolution(StrictContextModel):
    status: AnchorResolutionStatus
    selection: AnchorSelection
    selected_task_id: str | None = Field(default=None, max_length=128)
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(default_factory=list)
    reason: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def validate_resolution(self) -> AnchorResolution:
        if self.status == AnchorResolutionStatus.RESOLVED and not self.selected_task_id:
            raise ValueError("resolved anchor requires a selected task")
        if self.status != AnchorResolutionStatus.RESOLVED and self.selected_task_id:
            raise ValueError("unresolved anchor cannot include a selected task")
        if self.status == AnchorResolutionStatus.NONE and self.selection != AnchorSelection.NONE:
            raise ValueError("empty anchor must use NONE selection")
        if (
            self.status == AnchorResolutionStatus.AMBIGUOUS
            and self.selection != AnchorSelection.AMBIGUOUS
        ):
            raise ValueError("ambiguous anchor must use AMBIGUOUS selection")
        return self


class ConversationTurnResolution(StrictContextModel):
    schema_version: Literal[1] = 1
    mode: Literal["shadow"] = "shadow"
    conversation_act: ConversationAct
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(default_factory=list)
    anchor: AnchorResolution
    result_action: ResultReference | None = None
    patch_evidence: dict[str, str | None] = Field(default_factory=dict)
    task_goal: Literal["metric_query", "attribution_analysis"] = "metric_query"


class ContextMetric(StrictContextModel):
    code: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=255)


class ContextOrganization(StrictContextModel):
    code: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=255)


class ContextTimeRange(StrictContextModel):
    start: date | None = None
    end: date | None = None
    preset: Literal["latest"] | None = None
    raw_text: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def validate_range(self) -> ContextTimeRange:
        if self.preset == "latest":
            if self.start is not None or self.end is not None:
                raise ValueError("latest time cannot include start or end dates")
            return self
        if self.start is None or self.end is None:
            raise ValueError("time range requires both start and end dates")
        if self.start > self.end:
            raise ValueError("time range start cannot be after end")
        return self


class ContextFilter(StrictContextModel):
    dimension: str = Field(min_length=1, max_length=128)
    op: Literal["eq", "in", "between", "gt", "gte", "lt", "lte"]
    value: Any


class ContextSnapshotSource(StrictContextModel):
    task_version: int = Field(ge=0)
    state_schema_version: int = Field(ge=1)
    logical_dsl_version: int = Field(ge=1)
    semantic_config_version: str | None = Field(default=None, max_length=128)


class QueryContextSnapshot(StrictContextModel):
    schema_version: Literal[1] = 1
    task_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)
    summary: str = Field(min_length=1, max_length=200)
    intent: TaskType
    query_shape: str | None = Field(default=None, max_length=64)
    metrics: list[ContextMetric] = Field(min_length=1)
    orgs: list[ContextOrganization] = Field(default_factory=list)
    time: ContextTimeRange
    dimensions: list[str] = Field(default_factory=list)
    filters: list[ContextFilter] = Field(default_factory=list)
    ops: list[SlotOperation] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)
    source: ContextSnapshotSource
    reusable: bool = True
    unusable_reason: str | None = Field(default=None, max_length=128)
    created_at: datetime

    @field_validator("dimensions")
    @classmethod
    def validate_dimensions(cls, values: list[str]) -> list[str]:
        return _unique_non_empty_strings(values, field_name="dimensions", max_length=128)

    @field_validator("ops", mode="before")
    @classmethod
    def reject_unsafe_operation_payloads(cls, values: Any) -> Any:
        if _contains_forbidden_context_key(values):
            raise ValueError("snapshot operations cannot contain SQL or SQL parameters")
        return values

    @model_validator(mode="after")
    def validate_snapshot(self) -> QueryContextSnapshot:
        _require_unique_codes(self.metrics, field_name="metrics")
        _require_unique_codes(self.orgs, field_name="orgs")
        if _contains_forbidden_context_key(self.options):
            raise ValueError("snapshot options cannot contain SQL or SQL parameters")
        if self.reusable and self.unusable_reason is not None:
            raise ValueError("reusable snapshot cannot have an unusable reason")
        if not self.reusable and not self.unusable_reason:
            raise ValueError("non-reusable snapshot requires an unusable reason")
        return self


class ContextPatch(StrictContextModel):
    schema_version: Literal[1] = 1
    set: dict[str, Any] = Field(default_factory=dict)
    add: dict[str, Any] = Field(default_factory=dict)
    remove: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_patch(self) -> ContextPatch:
        groups = {"set": self.set, "add": self.add, "remove": self.remove}
        for group_name, values in groups.items():
            unsupported = set(values) - CONTEXT_FIELDS
            if unsupported:
                fields = ", ".join(sorted(unsupported))
                raise ValueError(f"{group_name} contains unsupported fields: {fields}")
            if _contains_forbidden_context_key(values):
                raise ValueError(f"{group_name} cannot contain SQL or SQL parameters")
        non_additive = set(self.add) - ADDITIVE_CONTEXT_FIELDS
        if non_additive:
            fields = ", ".join(sorted(non_additive))
            raise ValueError(f"fields do not support add: {fields}")
        conflicts = (set(self.set) & set(self.add)) | (set(self.set) & set(self.remove))
        conflicts |= set(self.add) & set(self.remove)
        if conflicts:
            fields = ", ".join(sorted(conflicts))
            raise ValueError(f"fields cannot use multiple patch operations: {fields}")
        return self


class AnchorEvidence(StrictContextModel):
    type: str = Field(min_length=1, max_length=64)
    value: str = Field(min_length=1, max_length=255)
    matched: str | None = Field(default=None, max_length=255)


class FollowUpRelation(StrictContextModel):
    schema_version: Literal[1] = 1
    conversation_act: ConversationAct
    operation: FollowUpOperation
    route: FollowUpRoute
    parent_task_id: str = Field(min_length=1, max_length=128)
    source_task_ids: list[str] = Field(min_length=1)
    anchor_selection: AnchorSelection
    anchor_confidence: float = Field(ge=0, le=1)
    anchor_evidence: list[AnchorEvidence] = Field(default_factory=list)
    inherited_fields: list[str] = Field(default_factory=list)
    modified_fields: list[str] = Field(default_factory=list)
    removed_fields: list[str] = Field(default_factory=list)

    @field_validator("source_task_ids")
    @classmethod
    def validate_source_task_ids(cls, values: list[str]) -> list[str]:
        return _unique_non_empty_strings(
            values,
            field_name="source_task_ids",
            max_length=128,
        )

    @field_validator("inherited_fields", "modified_fields", "removed_fields")
    @classmethod
    def validate_lineage_fields(cls, values: list[str]) -> list[str]:
        normalized = _unique_non_empty_strings(
            values,
            field_name="lineage fields",
            max_length=64,
        )
        unsupported = set(normalized) - CONTEXT_FIELDS
        if unsupported:
            fields = ", ".join(sorted(unsupported))
            raise ValueError(f"lineage contains unsupported fields: {fields}")
        return normalized

    @model_validator(mode="after")
    def validate_relation(self) -> FollowUpRelation:
        if self.conversation_act not in {
            ConversationAct.FOLLOW_UP,
            ConversationAct.REFERENCE_ACTION,
        }:
            raise ValueError("follow-up relation requires a follow-up or reference action")
        if self.anchor_selection in {AnchorSelection.AMBIGUOUS, AnchorSelection.NONE}:
            raise ValueError("persisted follow-up relation requires a resolved anchor")
        if self.parent_task_id not in self.source_task_ids:
            raise ValueError("parent task must be included in source tasks")
        lineage_groups = [
            set(self.inherited_fields),
            set(self.modified_fields),
            set(self.removed_fields),
        ]
        if any(
            left & right
            for index, left in enumerate(lineage_groups)
            for right in lineage_groups[index + 1 :]
        ):
            raise ValueError("lineage fields must not overlap")
        return self


class QueryResultReference(StrictContextModel):
    schema_version: Literal[1] = 1
    task_id: str = Field(min_length=1, max_length=128)
    query_run_id: int | None = Field(default=None, ge=1)
    result_id: str = Field(min_length=1, max_length=128)
    storage_key: str = Field(min_length=1, max_length=500)
    columns: list[str] = Field(default_factory=list)
    row_count: int = Field(ge=0)
    complete: bool
    truncated: bool
    summary: str | None = Field(default=None, max_length=500)
    created_at: datetime
    expires_at: datetime | None = None

    @field_validator("columns")
    @classmethod
    def validate_columns(cls, values: list[str]) -> list[str]:
        return _unique_non_empty_strings(values, field_name="columns", max_length=128)

    @model_validator(mode="after")
    def validate_reference(self) -> QueryResultReference:
        if self.complete and self.truncated:
            raise ValueError("a complete result cannot be truncated")
        if self.expires_at is not None and self.expires_at <= self.created_at:
            raise ValueError("result expiration must be after creation")
        return self


class ContextMergeResult(StrictContextModel):
    schema_version: Literal[1] = 1
    status: Literal["MERGED", "NO_CHANGE"]
    base_task_id: str = Field(min_length=1, max_length=128)
    patch: ContextPatch
    merged_snapshot: QueryContextSnapshot
    inherited_fields: list[str] = Field(default_factory=list)
    modified_fields: list[str] = Field(default_factory=list)
    removed_fields: list[str] = Field(default_factory=list)

    @field_validator("inherited_fields", "modified_fields", "removed_fields")
    @classmethod
    def validate_merge_fields(cls, values: list[str]) -> list[str]:
        normalized = _unique_non_empty_strings(
            values,
            field_name="merge lineage fields",
            max_length=64,
        )
        unsupported = set(normalized) - CONTEXT_FIELDS
        if unsupported:
            fields = ", ".join(sorted(unsupported))
            raise ValueError(f"merge lineage contains unsupported fields: {fields}")
        return normalized

    @model_validator(mode="after")
    def validate_merge(self) -> ContextMergeResult:
        lineage = [
            set(self.inherited_fields),
            set(self.modified_fields),
            set(self.removed_fields),
        ]
        if any(
            left & right
            for index, left in enumerate(lineage)
            for right in lineage[index + 1 :]
        ):
            raise ValueError("merge lineage fields must not overlap")
        has_changes = bool(self.patch.set or self.patch.add or self.patch.remove)
        if self.status == "MERGED" and not has_changes:
            raise ValueError("merged result requires a non-empty patch")
        if self.status == "NO_CHANGE" and has_changes:
            raise ValueError("no-change result requires an empty patch")
        if self.merged_snapshot.task_id != self.base_task_id:
            raise ValueError("merged snapshot must retain the base task identity")
        return self


class CandidateDslValidationCheck(StrictContextModel):
    name: Literal["structure", "catalog", "permission", "executable"]
    status: Literal["PASSED", "FAILED", "SKIPPED"]
    code: str | None = Field(default=None, max_length=128)
    message: str | None = Field(default=None, max_length=500)


class CandidateDslValidationResult(StrictContextModel):
    schema_version: Literal[1] = 1
    status: Literal["VALID", "INVALID", "NO_CHANGE"]
    candidate_dsl: LogicalDSL | None = None
    query_shape: str | None = Field(default=None, max_length=64)
    authorized_orgs: list[str] = Field(default_factory=list)
    checks: list[CandidateDslValidationCheck] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_candidate_result(self) -> CandidateDslValidationResult:
        failed = any(check.status == "FAILED" for check in self.checks)
        if self.status == "VALID" and (self.candidate_dsl is None or failed):
            raise ValueError("valid candidate requires a DSL and no failed checks")
        if self.status == "INVALID" and not failed:
            raise ValueError("invalid candidate requires at least one failed check")
        if self.status == "NO_CHANGE" and (self.candidate_dsl is not None or failed):
            raise ValueError("no-change candidate cannot include a DSL or failed checks")
        return self


class DslFieldDifference(StrictContextModel):
    field: Literal[
        "task",
        "metrics",
        "time",
        "orgs",
        "dimensions",
        "filters",
        "ops",
        "options",
    ]
    classification: Literal["PATCH_DELTA", "HISTORY_INHERITANCE", "CONFLICT"]
    candidate_value: Any
    v1_value: Any


class ShadowAdmissionDecision(StrictContextModel):
    decision: Literal["ELIGIBLE", "HOLD"]
    reasons: list[str] = Field(default_factory=list)


class MultiturnShadowEvaluation(StrictContextModel):
    schema_version: Literal[1] = 1
    status: Literal["EVALUATED", "NOT_APPLICABLE"]
    v1_outcome: Literal["DSL_READY", "CLARIFICATION_REQUIRED", "NOT_AVAILABLE"]
    comparison: Literal["MATCH", "HISTORY_ENRICHED", "CONFLICT", "NOT_COMPARABLE"]
    missing_slots: list[str] = Field(default_factory=list)
    differences: list[DslFieldDifference] = Field(default_factory=list)
    admission: ShadowAdmissionDecision


class MultiturnShadowMetrics(StrictContextModel):
    schema_version: Literal[1] = 1
    total_shadow_tasks: int = Field(ge=0)
    follow_up_tasks: int = Field(ge=0)
    resolved_anchors: int = Field(ge=0)
    merged_contexts: int = Field(ge=0)
    valid_candidate_dsls: int = Field(ge=0)
    invalid_candidate_dsls: int = Field(ge=0)
    permission_denials: int = Field(ge=0)
    evaluated_tasks: int = Field(ge=0)
    eligible_tasks: int = Field(ge=0)
    gray_promotions: int = Field(ge=0)
    gray_fallbacks: int = Field(ge=0)
    candidate_execution_successes: int = Field(ge=0)
    fallback_execution_successes: int = Field(ge=0)
    gray_execution_failures: int = Field(ge=0)
    dsl_equivalent_promotions: int = Field(ge=0)
    reviewed_tasks: int = Field(ge=0)
    approved_reviews: int = Field(ge=0)
    rejected_reviews: int = Field(ge=0)
    anchor_resolution_rate: float = Field(ge=0, le=1)
    candidate_valid_rate: float = Field(ge=0, le=1)
    admission_rate: float = Field(ge=0, le=1)
    gray_success_rate: float = Field(ge=0, le=1)
    gray_fallback_rate: float = Field(ge=0, le=1)
    review_approval_rate: float = Field(ge=0, le=1)


class MultiturnGrayDecision(StrictContextModel):
    decision: Literal["PROMOTE", "HOLD"]
    reasons: list[str] = Field(default_factory=list)


class MultiturnGrayExecutionState(StrictContextModel):
    schema_version: Literal[1] = 1
    status: Literal["PROMOTED", "FALLBACK_USED"]
    source_task_id: str = Field(min_length=1, max_length=128)
    candidate_dsl: LogicalDSL
    candidate_query_shape: str = Field(min_length=1, max_length=64)
    v1_dsl: LogicalDSL | None = None
    v1_query_shape: str | None = Field(default=None, min_length=1, max_length=64)
    dsl_equivalent: bool
    promoted_at: datetime
    fallback_at: datetime | None = None
    fallback_reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_gray_state(self) -> MultiturnGrayExecutionState:
        if (self.v1_dsl is None) != (self.v1_query_shape is None):
            raise ValueError("v1 fallback DSL and query shape must be provided together")
        if self.status == "PROMOTED" and (
            self.fallback_at is not None or self.fallback_reason is not None
        ):
            raise ValueError("promoted state cannot contain fallback metadata")
        if self.status == "FALLBACK_USED" and (
            self.fallback_at is None or not self.fallback_reason
        ):
            raise ValueError("fallback state requires time and reason")
        if self.status == "FALLBACK_USED" and self.v1_dsl is None:
            raise ValueError("fallback state requires a v1 fallback DSL")
        return self


class MultiturnGrayResult(StrictContextModel):
    schema_version: Literal[1] = 1
    outcome: Literal[
        "CANDIDATE_SUCCEEDED",
        "V1_FALLBACK_SUCCEEDED",
        "CANDIDATE_EXECUTION_FAILED",
        "V1_FALLBACK_EXECUTION_FAILED",
        "V1_FALLBACK_PLANNING_FAILED",
    ]
    consistency: Literal[
        "STRUCTURALLY_EQUIVALENT",
        "CANDIDATE_ONLY",
        "V1_FALLBACK_USED",
    ]
    run_id: int | None = Field(default=None, ge=1)
    recorded_at: datetime


class MultiturnHumanReview(StrictContextModel):
    schema_version: Literal[1] = 1
    decision: Literal["APPROVED", "REJECTED"]
    reason_codes: list[str] = Field(default_factory=list)
    notes: str | None = Field(default=None, max_length=1000)
    reviewer_user_id: str = Field(min_length=1, max_length=128)
    reviewed_at: datetime

    @field_validator("reason_codes")
    @classmethod
    def validate_reason_codes(cls, values: list[str]) -> list[str]:
        return _unique_non_empty_strings(
            values,
            field_name="review reason codes",
            max_length=128,
        )

    @model_validator(mode="after")
    def require_rejection_reason(self) -> MultiturnHumanReview:
        if self.decision == "REJECTED" and not self.reason_codes and not self.notes:
            raise ValueError("rejected review requires a reason code or notes")
        return self


class MultiturnReviewSample(StrictContextModel):
    task_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=1, max_length=1000)
    task_status: str = Field(min_length=1, max_length=32)
    conversation_act: str = Field(min_length=1, max_length=64)
    comparison: str | None = Field(default=None, max_length=64)
    admission: str | None = Field(default=None, max_length=32)
    gray_outcome: str | None = Field(default=None, max_length=64)
    review: MultiturnHumanReview | None = None


class MultiturnRolloutThresholds(StrictContextModel):
    min_reviewed_samples: int = Field(ge=1)
    min_approval_rate: float = Field(ge=0, le=1)
    min_gray_success_rate: float = Field(ge=0, le=1)
    max_fallback_rate: float = Field(ge=0, le=1)
    max_failure_rate: float = Field(ge=0, le=1)


class MultiturnRolloutReadiness(StrictContextModel):
    schema_version: Literal[1] = 1
    decision: Literal["READY", "HOLD"]
    reasons: list[str] = Field(default_factory=list)
    thresholds: MultiturnRolloutThresholds
    metrics: MultiturnShadowMetrics
    failure_rate: float = Field(ge=0, le=1)


def _unique_non_empty_strings(
    values: list[str],
    *,
    field_name: str,
    max_length: int,
) -> list[str]:
    normalized: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field_name} must contain non-empty strings")
        item = value.strip()
        if len(item) > max_length:
            raise ValueError(f"{field_name} contains a value that is too long")
        if item in normalized:
            raise ValueError(f"{field_name} must not contain duplicates")
        normalized.append(item)
    return normalized


def _require_unique_codes(values: list[Any], *, field_name: str) -> None:
    codes = [item.code for item in values]
    if len(codes) != len(set(codes)):
        raise ValueError(f"{field_name} must not contain duplicate codes")


def _contains_forbidden_context_key(value: Any) -> bool:
    if isinstance(value, dict):
        if set(value) & FORBIDDEN_CONTEXT_KEYS:
            return True
        return any(_contains_forbidden_context_key(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_forbidden_context_key(item) for item in value)
    return False
