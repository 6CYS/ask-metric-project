from __future__ import annotations

import json
import re
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ask_metric.application.context_diagnostics import log_context_failure
from ask_metric.application.ports import ModelService, PermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.application.result_repository import result_inventory
from ask_metric.domain.analysis import AnalysisIntent
from ask_metric.domain.conversation_context import (
    CONTEXT_FIELDS,
    AnchorResolution,
    AnchorResolutionStatus,
    AnchorSelection,
    CandidateDslValidationCheck,
    CandidateDslValidationResult,
    ContextFilter,
    ContextMergeResult,
    ContextMetric,
    ContextOrganization,
    ContextPatch,
    ContextSnapshotSource,
    ContextTimeRange,
    ConversationAct,
    ConversationTurnResolution,
    DslFieldDifference,
    MultiturnGrayDecision,
    MultiturnGrayExecutionState,
    MultiturnRolloutReadiness,
    MultiturnRolloutThresholds,
    MultiturnShadowEvaluation,
    MultiturnShadowMetrics,
    QueryContextSnapshot,
    ShadowAdmissionDecision,
)
from ask_metric.domain.metric_matching import MetricMatcher, normalize_semantic_text
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.result_context import ResultReference
from ask_metric.domain.semantic_engine import extract_time_expression
from ask_metric.domain.semantic_normalization import (
    SemanticValidationError,
    parse_time_expression,
)
from ask_metric.domain.semantics import (
    LogicalDSL,
    MetricCatalogItem,
    OrganizationCatalogItem,
)
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import QueryTask

SNAPSHOT_OPTION_KEYS = {
    "base_date",
    "base_month",
    "current_date",
    "target_dates",
    "time_mode",
    "time_windows",
    "top_n",
}

_NEW_QUERY_MARKERS = ("先不查", "不说这个", "换个问题", "另外问", "重新问一个")
_FOLLOW_UP_MARKERS = (
    "那",
    "换成",
    "改成",
    "再加",
    "再看",
    "前面",
    "刚才",
    "上一个",
    "为什么",
    "比较",
    "对比",
    "趋势",
    "去掉",
    "取消",
)
_MODEL_HISTORY_LIMIT = 12


class _RawModelPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    set: dict[str, Any] = Field(default_factory=dict)
    add: dict[str, Any] = Field(default_factory=dict)
    remove: dict[str, Any] = Field(default_factory=dict)

    @field_validator("set", "add", "remove", mode="before")
    @classmethod
    def empty_group(cls, value):
        return {} if value is None else value


class ModelConversationUnderstanding(BaseModel):
    """Strict semantic contract returned by the conversation model."""

    model_config = ConfigDict(extra="forbid")

    conversation_act: ConversationAct
    confidence: float = Field(ge=0, le=1)
    anchor_task_id: str | None = Field(default=None, max_length=128)
    patch: _RawModelPatch = Field(default_factory=_RawModelPatch)
    inherit: list[str] = Field(default_factory=list)
    ambiguities: list[str] = Field(default_factory=list)
    reason: str = Field(min_length=1, max_length=500)
    result_action: ResultReference | None = None
    patch_evidence: dict[str, str | None] = Field(default_factory=dict)
    task_goal: Literal["metric_query", "attribution_analysis"] = "metric_query"
    analysis_intent: AnalysisIntent | None = None

    @field_validator("patch_evidence", mode="before")
    @classmethod
    def empty_evidence(cls, value):
        return {} if value is None else value

    @model_validator(mode="before")
    @classmethod
    def normalize_result_discriminator(cls, value):
        # The typed operation is more specific than a redundant generic label.
        # This is schema normalization, never a lexical classification of input.
        if isinstance(value, dict) and value.get("patch") is None:
            value = {**value, "patch": {}}
        # Some providers emit an empty nested optional field at the top level.
        # Discard only the empty form; nonempty misplaced filters remain invalid.
        if isinstance(value, dict) and "filter_evidence" in value and (
            value["filter_evidence"] is None or value["filter_evidence"] == {}
        ):
            value = {k: v for k, v in value.items() if k != "filter_evidence"}
        if (isinstance(value, dict) and value.get("conversation_act") == "FOLLOW_UP"
                and not value.get("anchor_task_id") and value.get("result_action")):
            ResultReference.model_validate(value["result_action"])
            return {**value, "conversation_act": "REFERENCE_ACTION"}
        return value

    @model_validator(mode="after")
    def validate_understanding(self) -> ModelConversationUnderstanding:
        if self.conversation_act not in {
            ConversationAct.NEW_QUERY,
            ConversationAct.FOLLOW_UP,
            ConversationAct.CLARIFICATION_ANSWER,
            ConversationAct.REFERENCE_ACTION,
        }:
            raise ValueError("unsupported model conversation act")
        if (
            self.conversation_act == ConversationAct.FOLLOW_UP
            and not self.anchor_task_id
            and self.task_goal != "attribution_analysis"
        ):
            raise ValueError("follow-up understanding requires an anchor task")
        if self.conversation_act == ConversationAct.NEW_QUERY and self.anchor_task_id:
            raise ValueError("new-query understanding cannot reference a history task")
        if self.conversation_act == ConversationAct.NEW_QUERY and self.inherit:
            raise ValueError("NEW_QUERY must not inherit history fields")
        # Partial date inheritance is explanatory metadata. Execution still uses
        # the normalized, validated absolute date in patch.set.time.
        unsupported_inherit = set(self.inherit) - (
            CONTEXT_FIELDS | {"time.year", "time.month", "time.day"}
        )
        if unsupported_inherit:
            raise ValueError("inherit contains unsupported context fields")
        return self


class ContextSnapshotBuildError(ValueError):
    pass


class ConversationActResolver:
    """Deterministic phase-four classifier; it never changes query execution."""

    def resolve(
        self,
        *,
        message: str,
        reply_to_task_id: str | None,
        tasks: Sequence[QueryTask],
    ) -> tuple[ConversationAct, float, list[str]]:
        if reply_to_task_id:
            return ConversationAct.FOLLOW_UP, 1.0, ["explicit_task_reference"]
        if marker := _first_marker(message, _NEW_QUERY_MARKERS):
            return ConversationAct.NEW_QUERY, 0.95, [f"new_query_marker:{marker}"]
        if _active_clarification_tasks(tasks):
            return ConversationAct.CLARIFICATION_ANSWER, 0.9, ["active_clarification"]
        if marker := _first_marker(message, _FOLLOW_UP_MARKERS):
            if any(_reusable_snapshot(task) is not None for task in tasks):
                return ConversationAct.FOLLOW_UP, 0.85, [f"follow_up_marker:{marker}"]
        return ConversationAct.NEW_QUERY, 0.8, ["standalone_question"]


class HistoricalTaskResolver:
    def resolve(
        self,
        *,
        conversation_act: ConversationAct,
        reply_to_task_id: str | None,
        tasks: Sequence[QueryTask],
    ) -> AnchorResolution:
        if conversation_act == ConversationAct.NEW_QUERY:
            return _empty_anchor()

        if conversation_act == ConversationAct.CLARIFICATION_ANSWER:
            active = _active_clarification_tasks(tasks)
            if len(active) == 1:
                return AnchorResolution(
                    status=AnchorResolutionStatus.RESOLVED,
                    selection=AnchorSelection.ACTIVE_TASK,
                    selected_task_id=active[0].id,
                    confidence=1.0,
                    evidence=["unique_active_clarification"],
                )
            if len(active) > 1:
                return AnchorResolution(
                    status=AnchorResolutionStatus.AMBIGUOUS,
                    selection=AnchorSelection.AMBIGUOUS,
                    confidence=0.0,
                    evidence=["multiple_active_clarifications"],
                    reason="multiple_active_clarifications",
                )
            return _empty_anchor("active_clarification_not_found")

        if reply_to_task_id:
            referenced = next((task for task in tasks if task.id == reply_to_task_id), None)
            if referenced is None or _reusable_snapshot(referenced) is None:
                return AnchorResolution(
                    status=AnchorResolutionStatus.INVALID_REFERENCE,
                    selection=AnchorSelection.NONE,
                    confidence=0.0,
                    evidence=["explicit_task_reference"],
                    reason="referenced_task_not_reusable_or_not_in_conversation",
                )
            return AnchorResolution(
                status=AnchorResolutionStatus.RESOLVED,
                selection=AnchorSelection.EXPLICIT_TASK,
                selected_task_id=referenced.id,
                confidence=1.0,
                evidence=["explicit_task_reference"],
            )

        for task in reversed(tasks):
            if _reusable_snapshot(task) is not None:
                return AnchorResolution(
                    status=AnchorResolutionStatus.RESOLVED,
                    selection=AnchorSelection.LAST_SUCCESSFUL_TASK,
                    selected_task_id=task.id,
                    confidence=0.9,
                    evidence=["latest_reusable_success"],
                )
        return _empty_anchor("reusable_success_not_found")


class ContextPatchGenerator:
    def generate(
        self,
        *,
        message: str,
        base: QueryContextSnapshot,
        metrics: Sequence[MetricCatalogItem],
        organizations: Sequence[OrganizationCatalogItem],
        today: date,
    ) -> ContextPatch:
        set_values: dict[str, Any] = {}
        add_values: dict[str, Any] = {}
        remove_values: dict[str, Any] = {}

        time_expression = extract_time_expression(message)
        if time_expression:
            try:
                parsed_time = parse_time_expression(time_expression, today=today)
                set_values["time"] = {
                    **parsed_time.model_dump(mode="json"),
                    "raw_text": time_expression,
                }
            except (SemanticValidationError, ValueError):
                pass

        matched_orgs = _matched_organizations(message, organizations)
        organization_values = [
            {"code": item.code, "name": item.name} for item in matched_orgs
        ]
        is_removal = _contains_any(message, ("去掉", "删除", "移除", "不要"))
        is_replacement = _contains_any(message, ("换成", "改成", "替换成"))
        is_comparison = _contains_any(message, ("比较", "对比"))
        if organization_values:
            if is_removal:
                remove_values["orgs"] = organization_values
            elif is_replacement:
                set_values["orgs"] = organization_values
            elif is_comparison:
                new_orgs = [
                    item
                    for item in organization_values
                    if item["code"] not in {value.code for value in base.orgs}
                ]
                if new_orgs:
                    add_values["orgs"] = new_orgs

        metric_resolution = MetricMatcher(list(metrics)).resolve(message)
        if (
            is_replacement
            and metric_resolution.matches
            and not metric_resolution.ambiguous_candidates
            and "orgs" not in set_values
        ):
            set_values["metrics"] = [
                {"code": item.code, "name": item.name}
                for item in metric_resolution.matches
            ]

        negative_trend = _contains_any(message, ("不要趋势", "取消趋势", "去掉趋势"))
        if negative_trend:
            remove_values["ops"] = [{"type": "trend"}]
        elif "趋势" in message:
            add_values["ops"] = [{"type": "trend", "grain": "month"}]
        elif is_comparison:
            add_values["ops"] = [{"type": "entity_compare"}]

        if _contains_any(message, ("不要按机构", "取消机构维度", "去掉机构维度")):
            remove_values["dimensions"] = ["机构", "org"]

        return ContextPatch(
            set=set_values,
            add=add_values,
            remove=remove_values,
            reason="deterministic_follow_up_delta",
        )


class QueryContextMerger:
    def merge(
        self,
        *,
        base: QueryContextSnapshot,
        patch: ContextPatch,
    ) -> ContextMergeResult:
        value = base.model_dump(mode="json")
        has_changes = bool(patch.set or patch.add or patch.remove)
        for field, replacement in patch.set.items():
            value[field] = replacement
        for field, additions in patch.add.items():
            current = list(value.get(field) or [])
            value[field] = _unique_context_values([*current, *list(additions or [])])
        for field, removals in patch.remove.items():
            if field == "options":
                current_options = dict(value.get("options") or {})
                for key in removals or []:
                    current_options.pop(str(key), None)
                value["options"] = current_options
                continue
            current = list(value.get(field) or [])
            value[field] = [
                item
                for item in current
                if not any(_context_value_matches(item, selector) for selector in removals or [])
            ]

        merged = QueryContextSnapshot.model_validate(value)
        if has_changes:
            merged.summary = _snapshot_summary(
                metrics=merged.metrics,
                organizations=merged.orgs,
                time=merged.time,
                operations=[item.model_dump(mode="json") for item in merged.ops],
            )
        modified = sorted(set(patch.set) | set(patch.add))
        removed = sorted(patch.remove)
        inherited = sorted(CONTEXT_FIELDS - set(modified) - set(removed))
        return ContextMergeResult(
            status="MERGED" if has_changes else "NO_CHANGE",
            base_task_id=base.task_id,
            patch=patch,
            merged_snapshot=merged,
            inherited_fields=inherited,
            modified_fields=modified,
            removed_fields=removed,
        )


class CandidateLogicalDslValidator:
    def validate(
        self,
        *,
        context_merge: ContextMergeResult,
        actor: ActorContext,
        metrics: Sequence[MetricCatalogItem],
        organizations: Sequence[OrganizationCatalogItem],
        permission_service: PermissionService,
        planner: QueryPlanner,
    ) -> CandidateDslValidationResult:
        checks: list[CandidateDslValidationCheck] = []
        try:
            candidate = _candidate_dsl_from_snapshot(context_merge.merged_snapshot)
            query_shape = _candidate_query_shape(candidate)
            checks.append(CandidateDslValidationCheck(name="structure", status="PASSED"))
        except (TypeError, ValueError, ValidationError) as exc:
            checks.append(_failed_check("structure", "CANDIDATE_DSL_INVALID", exc))
            checks.extend(_skipped_checks("catalog", "permission", "executable"))
            return CandidateDslValidationResult(status="INVALID", checks=checks)

        catalog_error = _candidate_catalog_error(
            candidate,
            context_merge.merged_snapshot,
            metrics,
            organizations,
        )
        if catalog_error is not None:
            code, message = catalog_error
            checks.append(
                CandidateDslValidationCheck(
                    name="catalog",
                    status="FAILED",
                    code=code,
                    message=message,
                )
            )
            checks.extend(_skipped_checks("permission", "executable"))
            return CandidateDslValidationResult(
                status="INVALID",
                candidate_dsl=candidate,
                query_shape=query_shape,
                checks=checks,
            )
        checks.append(CandidateDslValidationCheck(name="catalog", status="PASSED"))

        try:
            authorized_value = permission_service.authorize_logical_dsl(
                actor=actor,
                logical_dsl=candidate.model_dump(mode="json"),
            )
            authorized = LogicalDSL.model_validate(authorized_value)
            checks.append(CandidateDslValidationCheck(name="permission", status="PASSED"))
        except Exception as exc:
            code = str(getattr(exc, "code", "CANDIDATE_PERMISSION_DENIED"))
            checks.append(_failed_check("permission", code, exc))
            checks.extend(_skipped_checks("executable"))
            return CandidateDslValidationResult(
                status="INVALID",
                candidate_dsl=candidate,
                query_shape=query_shape,
                checks=checks,
            )

        try:
            names_by_code = {item.code: item.name for item in organizations}
            org_names = [names_by_code[code] for code in authorized.orgs]
            planner.build(authorized, query_shape, org_names=org_names)
            checks.append(CandidateDslValidationCheck(name="executable", status="PASSED"))
        except Exception as exc:
            checks.append(_failed_check("executable", "CANDIDATE_QUERY_UNSUPPORTED", exc))
            return CandidateDslValidationResult(
                status="INVALID",
                candidate_dsl=candidate,
                query_shape=query_shape,
                authorized_orgs=authorized.orgs,
                checks=checks,
            )

        return CandidateDslValidationResult(
            status="VALID",
            candidate_dsl=candidate,
            query_shape=query_shape,
            authorized_orgs=authorized.orgs,
            checks=checks,
        )


class MultiturnShadowEvaluator:
    def evaluate(
        self,
        *,
        shadow_payload: dict[str, Any],
        v1_dsl: LogicalDSL | None,
        missing_slots: Sequence[str],
    ) -> MultiturnShadowEvaluation | None:
        raw_validation = shadow_payload.get("candidate_dsl_validation")
        raw_merge = shadow_payload.get("context_merge")
        if not isinstance(raw_validation, dict) or not isinstance(raw_merge, dict):
            return None
        try:
            validation = CandidateDslValidationResult.model_validate(raw_validation)
            context_merge = ContextMergeResult.model_validate(raw_merge)
        except ValidationError:
            return None

        v1_outcome = "DSL_READY" if v1_dsl is not None else "CLARIFICATION_REQUIRED"
        comparison = "NOT_COMPARABLE"
        differences: list[DslFieldDifference] = []
        if validation.status == "VALID" and validation.candidate_dsl is not None:
            if v1_dsl is not None:
                differences = _dsl_differences(
                    validation.candidate_dsl,
                    v1_dsl,
                    context_merge=context_merge,
                )
                if any(item.classification == "CONFLICT" for item in differences):
                    comparison = "CONFLICT"
                elif differences:
                    comparison = "HISTORY_ENRICHED"
                else:
                    comparison = "MATCH"

        reasons = _admission_hold_reasons(
            shadow_payload=shadow_payload,
            validation=validation,
            context_merge=context_merge,
            comparison=comparison,
        )
        return MultiturnShadowEvaluation(
            status="EVALUATED",
            v1_outcome=v1_outcome,
            comparison=comparison,
            missing_slots=list(missing_slots),
            differences=differences,
            admission=ShadowAdmissionDecision(
                decision="HOLD" if reasons else "ELIGIBLE",
                reasons=reasons or [
                    (
                        "CANDIDATE_RESOLVES_V1_MISSING_CONTEXT"
                        if v1_dsl is None
                        else "CANDIDATE_PASSED_SHADOW_GATES"
                    )
                ],
            ),
        )


class MultiturnShadowMetricsAggregator:
    def summarize(self, tasks: Sequence[QueryTask]) -> MultiturnShadowMetrics:
        counters = {
            "total_shadow_tasks": 0,
            "follow_up_tasks": 0,
            "resolved_anchors": 0,
            "merged_contexts": 0,
            "valid_candidate_dsls": 0,
            "invalid_candidate_dsls": 0,
            "permission_denials": 0,
            "evaluated_tasks": 0,
            "eligible_tasks": 0,
            "gray_promotions": 0,
            "gray_fallbacks": 0,
            "candidate_execution_successes": 0,
            "fallback_execution_successes": 0,
            "gray_execution_failures": 0,
            "dsl_equivalent_promotions": 0,
            "reviewed_tasks": 0,
            "approved_reviews": 0,
            "rejected_reviews": 0,
        }
        for task in tasks:
            try:
                state = QueryTaskState.model_validate(task.state_json or {})
            except ValidationError:
                continue
            shadow = state.debug.get("multiturn_shadow")
            if not isinstance(shadow, dict):
                continue
            counters["total_shadow_tasks"] += 1
            if shadow.get("conversation_act") == "FOLLOW_UP":
                counters["follow_up_tasks"] += 1
            anchor = shadow.get("anchor")
            if isinstance(anchor, dict) and anchor.get("status") == "RESOLVED":
                counters["resolved_anchors"] += 1
            merge = shadow.get("context_merge")
            if isinstance(merge, dict) and merge.get("status") == "MERGED":
                counters["merged_contexts"] += 1
            validation = shadow.get("candidate_dsl_validation")
            if isinstance(validation, dict):
                if validation.get("status") == "VALID":
                    counters["valid_candidate_dsls"] += 1
                elif validation.get("status") == "INVALID":
                    counters["invalid_candidate_dsls"] += 1
                checks = validation.get("checks")
                if isinstance(checks, list) and any(
                    isinstance(check, dict)
                    and check.get("code") == "ORG_SCOPE_FORBIDDEN"
                    for check in checks
                ):
                    counters["permission_denials"] += 1
            evaluation = shadow.get("evaluation")
            if isinstance(evaluation, dict) and evaluation.get("status") == "EVALUATED":
                counters["evaluated_tasks"] += 1
                admission = evaluation.get("admission")
                if isinstance(admission, dict) and admission.get("decision") == "ELIGIBLE":
                    counters["eligible_tasks"] += 1
            gray_execution = state.multiturn_execution
            if gray_execution is not None:
                counters["gray_promotions"] += 1
                if gray_execution.dsl_equivalent:
                    counters["dsl_equivalent_promotions"] += 1
                if gray_execution.status == "FALLBACK_USED":
                    counters["gray_fallbacks"] += 1
            gray_result = shadow.get("gray_result")
            if isinstance(gray_result, dict):
                outcome = gray_result.get("outcome")
                if outcome == "CANDIDATE_SUCCEEDED":
                    counters["candidate_execution_successes"] += 1
                elif outcome == "V1_FALLBACK_SUCCEEDED":
                    counters["fallback_execution_successes"] += 1
                elif outcome in {
                    "CANDIDATE_EXECUTION_FAILED",
                    "V1_FALLBACK_EXECUTION_FAILED",
                    "V1_FALLBACK_PLANNING_FAILED",
                }:
                    counters["gray_execution_failures"] += 1
            if state.multiturn_review is not None:
                counters["reviewed_tasks"] += 1
                if state.multiturn_review.decision == "APPROVED":
                    counters["approved_reviews"] += 1
                else:
                    counters["rejected_reviews"] += 1

        candidate_total = (
            counters["valid_candidate_dsls"] + counters["invalid_candidate_dsls"]
        )
        return MultiturnShadowMetrics(
            **counters,
            anchor_resolution_rate=_rate(
                counters["resolved_anchors"], counters["follow_up_tasks"]
            ),
            candidate_valid_rate=_rate(
                counters["valid_candidate_dsls"], candidate_total
            ),
            admission_rate=_rate(
                counters["eligible_tasks"], counters["evaluated_tasks"]
            ),
            gray_success_rate=_rate(
                counters["candidate_execution_successes"]
                + counters["fallback_execution_successes"],
                counters["gray_promotions"],
            ),
            gray_fallback_rate=_rate(
                counters["gray_fallbacks"], counters["gray_promotions"]
            ),
            review_approval_rate=_rate(
                counters["approved_reviews"], counters["reviewed_tasks"]
            ),
        )


class MultiturnRolloutReadinessPolicy:
    def __init__(self, thresholds: MultiturnRolloutThresholds) -> None:
        self.thresholds = thresholds

    def evaluate(self, metrics: MultiturnShadowMetrics) -> MultiturnRolloutReadiness:
        reasons: list[str] = []
        gray_failure_rate = _rate(
            metrics.gray_execution_failures,
            metrics.gray_promotions,
        )
        if metrics.reviewed_tasks < self.thresholds.min_reviewed_samples:
            reasons.append("INSUFFICIENT_REVIEWED_SAMPLES")
        if metrics.review_approval_rate < self.thresholds.min_approval_rate:
            reasons.append("REVIEW_APPROVAL_RATE_BELOW_THRESHOLD")
        if metrics.gray_success_rate < self.thresholds.min_gray_success_rate:
            reasons.append("GRAY_SUCCESS_RATE_BELOW_THRESHOLD")
        if metrics.gray_fallback_rate > self.thresholds.max_fallback_rate:
            reasons.append("GRAY_FALLBACK_RATE_ABOVE_THRESHOLD")
        if gray_failure_rate > self.thresholds.max_failure_rate:
            reasons.append("GRAY_FAILURE_RATE_ABOVE_THRESHOLD")
        return MultiturnRolloutReadiness(
            decision="HOLD" if reasons else "READY",
            reasons=reasons or ["ALL_ROLLOUT_THRESHOLDS_MET"],
            thresholds=self.thresholds,
            metrics=metrics,
            failure_rate=gray_failure_rate,
        )


class MultiturnGrayExecutionPolicy:
    def decide(
        self,
        *,
        enabled: bool,
        allowlisted_user_ids: Sequence[str],
        actor: ActorContext | None,
        shadow_payload: dict[str, Any],
        v1_dsl: LogicalDSL | None,
        v1_query_shape: str | None,
        now: datetime | None = None,
    ) -> tuple[MultiturnGrayDecision, MultiturnGrayExecutionState | None]:
        reasons: list[str] = []
        user_id = actor.user_id if actor is not None else None
        if not enabled:
            reasons.append("GRAY_EXECUTION_DISABLED")
        if not user_id or user_id not in set(allowlisted_user_ids):
            reasons.append("USER_NOT_ALLOWLISTED")
        raw_evaluation = shadow_payload.get("evaluation")
        raw_merge = shadow_payload.get("context_merge")
        raw_validation = shadow_payload.get("candidate_dsl_validation")
        try:
            evaluation = MultiturnShadowEvaluation.model_validate(raw_evaluation)
            context_merge = ContextMergeResult.model_validate(raw_merge)
            validation = CandidateDslValidationResult.model_validate(raw_validation)
        except (TypeError, ValidationError):
            reasons.append("SHADOW_EVALUATION_INVALID")
            return MultiturnGrayDecision(decision="HOLD", reasons=reasons), None
        model_candidate_overrides_v1_conflict = (
            context_merge.patch.reason == "model_context_patch"
            and evaluation.admission.decision == "HOLD"
            and set(evaluation.admission.reasons) == {"V1_CANDIDATE_CONFLICT"}
            and validation.status == "VALID"
        )
        if (
            evaluation.admission.decision != "ELIGIBLE"
            and not model_candidate_overrides_v1_conflict
        ):
            reasons.append("SHADOW_ADMISSION_NOT_ELIGIBLE")
        if not _is_admissible_validated_patch(context_merge.patch):
            reasons.append("PATCH_OUTSIDE_VALIDATED_SCOPE")
        if (
            validation.status != "VALID"
            or validation.candidate_dsl is None
            or not validation.query_shape
        ):
            reasons.append("CANDIDATE_DSL_NOT_VALID")
        if reasons:
            return MultiturnGrayDecision(decision="HOLD", reasons=reasons), None

        return (
            MultiturnGrayDecision(
                decision="PROMOTE",
                reasons=[
                    (
                        "MODEL_INTERPRETED_VALIDATED_CANDIDATE"
                        if context_merge.patch.reason == "model_context_patch"
                        else "LOW_RISK_ALLOWLISTED_CANDIDATE"
                        if v1_dsl is not None
                        else "LOW_RISK_VALIDATED_CANDIDATE_RESOLVES_V1_CLARIFICATION"
                    )
                ],
            ),
            MultiturnGrayExecutionState(
                status="PROMOTED",
                source_task_id=context_merge.base_task_id,
                candidate_dsl=validation.candidate_dsl,
                candidate_query_shape=validation.query_shape,
                v1_dsl=v1_dsl,
                v1_query_shape=v1_query_shape,
                dsl_equivalent=(
                    v1_dsl is not None
                    and validation.candidate_dsl.model_dump(mode="json")
                    == v1_dsl.model_dump(mode="json")
                ),
                promoted_at=now or datetime.now(UTC),
            ),
        )


class ConversationShadowService:
    def __init__(self, model_service: ModelService | None = None) -> None:
        self.model_service = model_service
        self.act_resolver = ConversationActResolver()
        self.task_resolver = HistoricalTaskResolver()
        self.patch_generator = ContextPatchGenerator()
        self.context_merger = QueryContextMerger()
        self.dsl_validator = CandidateLogicalDslValidator()

    def understand(
        self,
        *,
        message: str,
        reply_to_task_id: str | None,
        tasks: Sequence[QueryTask],
        metrics: Sequence[MetricCatalogItem],
        organizations: Sequence[OrganizationCatalogItem],
        today: date,
        clarification_context: dict[str, Any] | None = None,
    ) -> tuple[ConversationTurnResolution, ContextPatch | None, list[str], list[str]]:
        """Use the model for semantics; return only catalog-normalized patch values."""

        if not tasks and not reply_to_task_id:
            return (
                ConversationTurnResolution(
                    conversation_act=ConversationAct.NEW_QUERY,
                    confidence=1.0,
                    evidence=["no_conversation_history"],
                    anchor=_empty_anchor(),
                ),
                None,
                [],
                [],
            )
        if self.model_service is None:
            raise ValueError(
                "Conversation understanding requires a model; lexical fallback is disabled"
            )
        reusable = [
            {
                **snapshot.model_dump(mode="json"),
                "turn_index": index + 1,
                "original_question": task.original_question,
                "was_clarified": bool((task.state_json or {}).get("clarification_answers")),
                "confirmed_question": (task.state_json or {}).get("resolved_question"),
            }
            for index, task in enumerate(tasks)
            if (snapshot := _reusable_snapshot(task)) is not None
        ][-_MODEL_HISTORY_LIMIT:]
        for item in reusable:
            if len(item["orgs"]) > 8:
                item["org_scope_count"] = len(item["orgs"])
                item["orgs"] = []
                item["summary"] = (
                    f"{item['org_scope_count']}家机构 · {item['time']} · "
                    + "、".join(m["name"] for m in item["metrics"])
                )
        for item in reusable:
            item["is_current_focus"] = item is reusable[-1]
        active = [
            {
                "task_id": task.id,
                "question": task.original_question,
                "status": task.status,
                "stage": task.current_stage,
            }
            for task in tasks[-_MODEL_HISTORY_LIMIT:]
            if task.status == "WAITING_USER"
        ]
        catalog_matches = _explicit_catalog_matches(
            message,
            metrics=metrics,
            organizations=organizations,
            today=today,
        )
        model_context = {
            "current_date": today.isoformat(),
            "user_input": message,
            "reply_to_task_id": reply_to_task_id or "",
            "current_focus_json": json.dumps(
                reusable[-1] if reusable else None,
                ensure_ascii=False,
            ),
            "history_json": json.dumps(reusable, ensure_ascii=False, default=str),
            "active_tasks_json": json.dumps(active, ensure_ascii=False),
            "catalog_matches_json": json.dumps(catalog_matches, ensure_ascii=False),
            "contract_feedback": "无",
            "clarification_context_json": json.dumps(clarification_context, ensure_ascii=False),
            "clarification_resume_contract": (
                "澄清恢复协议（本次优先适用）：本轮是修正clarification_context_json中的"
                "original_question，不是单独理解最新短句。按user_inputs顺序合并整个待执行请求，"
                "最新回答纠正冲突字段，未冲突的条件保留。输出相对于原成功查询锚点的完整patch。"
                "显式回复ID是查询基准，不是丢弃待执行追问的理由。例如江阴7月贷款→"
                "紫金6月31日→6月底，patch必须同时包含紫金和2026-06-30，不能继承江阴。"
                "previous_understanding为模型草稿，不能当作用户确认。无效日期不得自动改成月末；"
                "用户明确修正后去掉旧歧义。恢复查询输出FOLLOW_UP，恢复结果操作输出"
                "REFERENCE_ACTION，不输出CLARIFICATION_ANSWER/NEW_QUERY。"
                "修改指标的引用依据可以来自整个待执行请求的user_inputs。"
                if clarification_context
                else ""
            ),
        }
        result_summaries, result_focus_id = result_inventory(tasks)
        model_context["results_json"] = json.dumps(
            [
                {
                    **s,
                    "orgs": s["orgs"] if len(s["orgs"]) <= 8 else [],
                    "org_scope_count": len(s["orgs"]),
                }
                for s in result_summaries
            ],
            ensure_ascii=False,
        )
        model_context["result_focus_id"] = result_focus_id or ""
        analysis_history = [
            {
                "analysis_id": t.id,
                "question": t.original_question,
                "target": (t.state_json or {}).get("analysis_target"),
                "status": t.status,
                "stop_reason": (t.state_json or {}).get("analysis_stop_reason"),
            }
            for t in tasks
            if (t.state_json or {}).get("analysis_target")
        ][-_MODEL_HISTORY_LIMIT:]
        # Analysis metadata never contains result cells or model reasoning.
        model_context["analysis_context_json"] = json.dumps(analysis_history, ensure_ascii=False)
        if analysis_history:
            latest = tasks[-1]
            latest_raw = latest.state_json or {}
            current = json.loads(model_context["current_focus_json"]) or {}
            current.update(
                {
                    "latest_user_task_id": latest.id,
                    "active_task_goal": "attribution_analysis"
                    if latest_raw.get("analysis_started")
                    else "metric_query",
                    "active_analysis_target": latest_raw.get("analysis_target"),
                    "query_focus_is_independent": True,
                }
            )
            if latest_raw.get("analysis_target"):
                current = {
                    "task_id": latest.id,
                    "task_goal": "attribution_analysis",
                    "intent": "attribution_analysis",
                    "original_question": latest.original_question,
                    "active_analysis_target": latest_raw["analysis_target"],
                    "latest_user_task_id": latest.id,
                    "active_task_goal": "attribution_analysis",
                }
                for item in reusable:
                    item["is_current_focus"] = False
                model_context["history_json"] = json.dumps(
                    reusable, ensure_ascii=False, default=str
                )
            model_context["current_focus_json"] = json.dumps(current, ensure_ascii=False)
        for attempt in range(2):
            try:
                raw = self.model_service.analyze(
                    prompt="multiturn_context_patch",
                    context=model_context,
                )
            except Exception as exc:
                log_context_failure(exc, stage="model_call", attempt=attempt + 1)
                raise
            try:
                understanding = ModelConversationUnderstanding.model_validate(raw)
                if understanding.task_goal == "attribution_analysis":
                    return (
                        ConversationTurnResolution(
                            conversation_act=understanding.conversation_act,
                            confidence=understanding.confidence,
                            anchor=_empty_anchor(),
                            evidence=["model_conversation_understanding", understanding.reason],
                            task_goal=understanding.task_goal,
                            analysis_intent=understanding.analysis_intent,
                        ),
                        None,
                        understanding.ambiguities,
                        [],
                    )
                if clarification_context and understanding.conversation_act not in {
                    ConversationAct.FOLLOW_UP,
                    ConversationAct.REFERENCE_ACTION,
                }:
                    raise ValueError(
                        "Resume must resolve the original task as FOLLOW_UP "
                        "or REFERENCE_ACTION, using the supplied clarification"
                    )
                if understanding.conversation_act == ConversationAct.CLARIFICATION_ANSWER:
                    active_ids = {item["task_id"] for item in active}
                    if not active_ids or (
                        understanding.anchor_task_id
                        and understanding.anchor_task_id not in active_ids
                    ):
                        raise ValueError(
                            "CLARIFICATION_ANSWER requires an active WAITING_USER task"
                        )
            except (ValueError, TypeError) as exc:
                log_context_failure(
                    exc, stage="understanding_contract", attempt=attempt + 1,
                    retry_planned=not bool(attempt),
                )
                if attempt:
                    raise
                model_context["contract_feedback"] = (
                    f"上一次输出不满足结构契约：{exc}。请重新结合历史理解，"
                    f"不要自行猜测缺失条件。上一次输出：{json.dumps(raw, ensure_ascii=False)}"
                )
                continue
            anchor_task = next(
                (task for task in tasks if task.id == understanding.anchor_task_id),
                None,
            )
            anchor_snapshot = _reusable_snapshot(anchor_task) if anchor_task is not None else None
            repeated_clarified = [
                t
                for t in tasks
                if _reusable_snapshot(t) is not None
                and (t.state_json or {}).get("clarification_answers")
                and normalize_semantic_text(t.original_question) == normalize_semantic_text(message)
            ]
            if (
                not attempt
                and understanding.conversation_act == ConversationAct.NEW_QUERY
                and repeated_clarified
            ):
                model_context["contract_feedback"] = (
                    "当前输入与此前经过澄清的原始问题相同。原句曾不能直接执行；"
                    "请结合was_clarified与confirmed_question判断原句是否仍依赖已确认条件。"
                    "重复不完整原句应继承已确认指标，不等同于重复一个完整新问题。"
                    "不能仅凭重复就判NEW_QUERY。重新输出完整JSON。"
                )
                continue
            omissions = _explicit_catalog_patch_omissions(
                understanding,
                catalog_matches=catalog_matches,
                today=today,
                base=anchor_snapshot,
            )
            if clarification_context:
                previous = clarification_context.get("previous_understanding") or {}
                previous_patch = previous.get("patch") or {}
                changed = set().union(
                    *(getattr(understanding.patch, group) for group in ("set", "add", "remove"))
                )
                prior_fields = set().union(
                    *(previous_patch.get(group, {}) for group in ("set", "add", "remove"))
                )
                unresolved_fields = {
                    a.split(":")[1]
                    for a in previous.get("ambiguities", [])
                    if a.startswith("semantic:")
                }
                lost_fields = prior_fields - changed - unresolved_fields
                if anchor_snapshot:
                    for field in ("metrics", "orgs"):
                        if previous_patch.get("set", {}).get(field) == [
                            item.model_dump(mode="json") for item in getattr(anchor_snapshot, field)
                        ]:
                            lost_fields.discard(field)
                if lost_fields:
                    if not attempt:
                        model_context["contract_feedback"] = (
                            "恢复patch遗漏了待执行请求此前已识别的修改字段："
                            + "、".join(sorted(lost_fields))
                            + "。这里必须输出相对于原成功查询的完整patch，"
                            "不能因为本次只补充日期就退回原机构/指标。"
                            "若用户明确恢复原条件，也请在set中明确写出恢复后的值。"
                            "请结合澄清上下文输出完整JSON。"
                        )
                        continue
                    omissions.extend(sorted(lost_fields))
            if (
                not attempt
                and anchor_snapshot is not None
                and any(a.startswith("semantic:orgs:") for a in understanding.ambiguities)
                and len(catalog_matches["orgs"]) == 1
                and {o.code for o in anchor_snapshot.orgs} == {catalog_matches["orgs"][0]["code"]}
            ):
                model_context["contract_feedback"] = (
                    "用户提及的机构在目录中唯一匹配，且与所选锚点相同。"
                    "相同条件确认是有效追问，可以返回空patch并继承机构。"
                    "除非用户明确表达其他口径，不得凭空猜测另一个同地区机构。"
                    "请重新审查orgs歧义并输出完整JSON。"
                )
                continue
            patch = None
            catalog_ambiguities = []
            if understanding.conversation_act in {
                ConversationAct.FOLLOW_UP,
                ConversationAct.REFERENCE_ACTION,
            }:
                try:
                    patch, catalog_ambiguities = _normalize_model_patch(
                        understanding.patch,
                        metrics=metrics,
                        organizations=organizations,
                        today=today,
                        base=anchor_snapshot,
                        explicit_metrics=catalog_matches["metrics"],
                        known_metrics=[metric for item in reusable for metric in item["metrics"]],
                    )
                except (ValueError, TypeError) as exc:
                    log_context_failure(exc, stage="patch_normalization", attempt=attempt + 1)
                    raise
                metric_groups = [
                    patch.set.get("metrics", []),
                    patch.add.get("metrics", []),
                    patch.remove.get("metrics", []),
                ]
                changed_codes = {m["code"] for group in metric_groups for m in group}
                base_codes = {m.code for m in anchor_snapshot.metrics} if anchor_snapshot else set()
                explicitly_named_codes = {m["code"] for m in catalog_matches["metrics"]}
                if (
                    changed_codes
                    and changed_codes != base_codes
                    and not (changed_codes <= explicitly_named_codes)
                ):
                    quote = understanding.patch_evidence.get("metrics", "")
                    raw_metrics = [
                        text
                        for group in (
                            understanding.patch.set,
                            understanding.patch.add,
                            understanding.patch.remove,
                        )
                        if "metrics" in group
                        for text in _model_text_list(group["metrics"], field="metrics")
                    ]
                    grounding_text = message
                    if clarification_context:
                        grounding_text += json.dumps(
                            clarification_context.get("user_inputs", []), ensure_ascii=False
                        )
                    grounded = bool(
                        quote
                        and quote in grounding_text
                        and any(
                            normalize_semantic_text(quote) in normalize_semantic_text(text)
                            for text in raw_metrics
                        )
                    )
                    if not grounded:
                        if not attempt:
                            model_context["contract_feedback"] = (
                                "本次patch修改了指标，但当前输入中缺少对应的明确依据。"
                                "若用户确实要求换指标，请在patch_evidence.metrics逐字引用"
                                "本轮指标短语，该短语应包含在patch指标表述中。"
                                "若用户只确认或修改机构/日期，不要猜测其他指标，应删除metrics修改并继承。"
                                "请输出完整修正JSON。"
                            )
                            continue
                        catalog_ambiguities.append("semantic:metrics:指标修改缺少本轮原文依据")
            incomplete_phrases = [
                item
                for item in catalog_ambiguities
                if item.startswith("metrics:") and item.endswith(":not_found")
            ]
            if attempt or (not omissions and not incomplete_phrases):
                break
            if incomplete_phrases and not omissions:
                model_context["contract_feedback"] = (
                    "上次已识别追问，但指标短语未能匹配目录："
                    + "、".join(incomplete_phrases)
                    + "。请保留所选锚点和其他条件，结合原始历史问题补全被省略的业务属性"
                    "（例如余额、日均），不要把目录名称额外附带的限定强加给用户。"
                    "不要更换业务口径或猜测编号。请输出完整修正JSON。上次输出："
                    + json.dumps(raw, ensure_ascii=False)
                )
                continue
            model_context["contract_feedback"] = (
                "上一次输出遗漏或错误处理了当前输入中已确认的字段："
                + "、".join(omissions)
                + "。请重新判断这些字段应当set、add还是remove并输出完整JSON；"
                "不得把它们列入inherit。"
            )
        anchor_id = understanding.anchor_task_id
        if reply_to_task_id and anchor_id and anchor_id != reply_to_task_id:
            raise ValueError("model anchor conflicts with explicit task reference")
        resolution = self._resolution_from_model(
            understanding=understanding,
            reply_to_task_id=reply_to_task_id,
            tasks=tasks,
        )
        model_ambiguities = list(dict.fromkeys(understanding.ambiguities))
        # Validate literal calendar dates independently of a model-proposed correction.
        # This is value validation, never a rule for classifying follow-ups.
        invalid_date = _invalid_explicit_calendar_date(message, base=anchor_snapshot, today=today)
        if invalid_date:
            model_ambiguities.append(f"semantic:time:{invalid_date}不是有效日期，请明确日期")
        model_ambiguities.extend(
            f"semantic:{field}:模型未正确处理当前输入中已确认的字段"
            for field in omissions
            if f"semantic:{field}:模型未正确处理当前输入中已确认的字段" not in model_ambiguities
        )
        ambiguities = list(model_ambiguities)
        if resolution.conversation_act in {
            ConversationAct.FOLLOW_UP,
            ConversationAct.REFERENCE_ACTION,
        }:
            ambiguities = _unresolved_model_ambiguities(
                model_ambiguities,
                raw_patch=understanding.patch,
                normalized_patch=patch,
                catalog_ambiguities=catalog_ambiguities,
            )
            ambiguities.extend(item for item in catalog_ambiguities if item not in ambiguities)
        return resolution, patch, ambiguities, understanding.inherit

    def _resolution_from_model(
        self,
        *,
        understanding: ModelConversationUnderstanding,
        reply_to_task_id: str | None,
        tasks: Sequence[QueryTask],
    ) -> ConversationTurnResolution:
        act = understanding.conversation_act
        if act in {ConversationAct.NEW_QUERY, ConversationAct.REFERENCE_ACTION}:
            anchor = _empty_anchor()
        elif act == ConversationAct.CLARIFICATION_ANSWER:
            anchor = self.task_resolver.resolve(
                conversation_act=act,
                reply_to_task_id=reply_to_task_id,
                tasks=tasks,
            )
        else:
            selected_id = reply_to_task_id or understanding.anchor_task_id
            anchor = self.task_resolver.resolve(
                conversation_act=act,
                reply_to_task_id=selected_id,
                tasks=tasks,
            )
        return ConversationTurnResolution(
            conversation_act=act,
            confidence=understanding.confidence,
            evidence=["model_conversation_understanding", understanding.reason],
            anchor=anchor,
            result_action=understanding.result_action,
            patch_evidence=understanding.patch_evidence,
        )

    def resolve(
        self,
        *,
        message: str,
        reply_to_task_id: str | None,
        tasks: Sequence[QueryTask],
    ) -> ConversationTurnResolution:
        act, confidence, evidence = self.act_resolver.resolve(
            message=message,
            reply_to_task_id=reply_to_task_id,
            tasks=tasks,
        )
        return ConversationTurnResolution(
            conversation_act=act,
            confidence=confidence,
            evidence=evidence,
            anchor=self.task_resolver.resolve(
                conversation_act=act,
                reply_to_task_id=reply_to_task_id,
                tasks=tasks,
            ),
        )

    def build_context_candidate(
        self,
        *,
        resolution: ConversationTurnResolution,
        message: str,
        tasks: Sequence[QueryTask],
        metrics: Sequence[MetricCatalogItem],
        organizations: Sequence[OrganizationCatalogItem],
        today: date,
        patch: ContextPatch | None = None,
    ) -> ContextMergeResult | None:
        selected_task_id = resolution.anchor.selected_task_id
        if resolution.conversation_act != ConversationAct.FOLLOW_UP or not selected_task_id:
            return None
        base_task = next((task for task in tasks if task.id == selected_task_id), None)
        base = _reusable_snapshot(base_task) if base_task is not None else None
        if base is None:
            return None
        if patch is None and self.model_service is not None:
            raise ValueError("Model-routed follow-up requires a model patch")
        effective_patch = patch if patch is not None else self.patch_generator.generate(
            message=message,
            base=base,
            metrics=metrics,
            organizations=organizations,
            today=today,
        )
        return self.context_merger.merge(base=base, patch=effective_patch)

    def validate_context_candidate(
        self,
        *,
        context_merge: ContextMergeResult,
        actor: ActorContext,
        metrics: Sequence[MetricCatalogItem],
        organizations: Sequence[OrganizationCatalogItem],
        permission_service: PermissionService,
        planner: QueryPlanner,
    ) -> CandidateDslValidationResult:
        return self.dsl_validator.validate(
            context_merge=context_merge,
            actor=actor,
            metrics=metrics,
            organizations=organizations,
            permission_service=permission_service,
            planner=planner,
        )


class QueryContextSnapshotFactory:
    def __init__(
        self,
        *,
        now_provider: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.now_provider = now_provider

    def build(
        self,
        *,
        task_id: str,
        conversation_id: str,
        task_version: int,
        query_shape: str | None,
        state: QueryTaskState,
        metrics: Sequence[MetricCatalogItem],
        organizations: Sequence[OrganizationCatalogItem],
    ) -> QueryContextSnapshot:
        try:
            dsl = LogicalDSL.model_validate(state.logical_dsl)
            resolved_metrics = _resolve_metrics(dsl.metrics, metrics)
            resolved_orgs = _resolve_organizations(dsl.orgs, organizations)
            time = ContextTimeRange.model_validate(
                {
                    **dsl.time.model_dump(mode="json"),
                    "raw_text": _raw_time_text(state),
                }
            )
            filters = [
                ContextFilter.model_validate(item.model_dump(mode="json"))
                for item in dsl.filters
            ]
            options = {
                key: value
                for key, value in dsl.options.items()
                if key in SNAPSHOT_OPTION_KEYS
            }
            summary = _snapshot_summary(
                metrics=resolved_metrics,
                organizations=resolved_orgs,
                time=time,
                operations=dsl.ops,
            )
            return QueryContextSnapshot(
                task_id=task_id,
                conversation_id=conversation_id,
                summary=summary,
                intent=dsl.task,
                query_shape=query_shape,
                metrics=resolved_metrics,
                orgs=resolved_orgs,
                time=time,
                dimensions=dsl.dimensions,
                filters=filters,
                ops=dsl.ops,
                options=options,
                source=ContextSnapshotSource(
                    task_version=task_version,
                    state_schema_version=state.schema_version,
                    logical_dsl_version=dsl.v,
                    semantic_config_version=state.config_version,
                ),
                created_at=self.now_provider(),
            )
        except (TypeError, ValueError, ValidationError) as exc:
            raise ContextSnapshotBuildError(str(exc)) from exc


def _resolve_metrics(
    codes: list[str],
    catalog: Sequence[MetricCatalogItem],
) -> list[ContextMetric]:
    by_code = {item.code: item for item in catalog}
    unknown = [code for code in codes if code not in by_code]
    if unknown:
        raise ContextSnapshotBuildError(
            f"unknown metric codes in logical DSL: {', '.join(unknown)}"
        )
    return [ContextMetric(code=code, name=by_code[code].name) for code in codes]


def _resolve_organizations(
    identifiers: list[str],
    catalog: Sequence[OrganizationCatalogItem],
) -> list[ContextOrganization]:
    by_identifier = {
        identifier: item
        for item in catalog
        for identifier in (item.code, item.name, *item.aliases)
    }
    unknown = [value for value in identifiers if value not in by_identifier]
    if unknown:
        raise ContextSnapshotBuildError(
            f"unknown organization identifiers in logical DSL: {', '.join(unknown)}"
        )
    resolved: list[ContextOrganization] = []
    seen_codes: set[str] = set()
    for identifier in identifiers:
        item = by_identifier[identifier]
        if item.code in seen_codes:
            continue
        seen_codes.add(item.code)
        resolved.append(ContextOrganization(code=item.code, name=item.name))
    return resolved


def _raw_time_text(state: QueryTaskState) -> str | None:
    slots = state.slots or state.slot_frame or {}
    value = slots.get("time") if isinstance(slots, dict) else None
    return value.strip() if isinstance(value, str) and value.strip() else None


def _snapshot_summary(
    *,
    metrics: list[ContextMetric],
    organizations: list[ContextOrganization],
    time: ContextTimeRange,
    operations: list[dict[str, Any]],
) -> str:
    organization_text = "、".join(item.name for item in organizations) or "默认机构范围"
    metric_text = "、".join(item.name for item in metrics)
    parts = [organization_text, _time_summary(time), metric_text]
    operation_text = _operation_summary(operations)
    if operation_text:
        parts.append(operation_text)
    summary = " · ".join(parts)
    return summary if len(summary) <= 200 else summary[:197] + "..."


def _time_summary(value: ContextTimeRange) -> str:
    if value.preset == "latest":
        return "最新一期"
    if value.start == value.end:
        return _format_date(value.start)
    return f"{_format_date(value.start)}至{_format_date(value.end)}"


def _format_date(value: date | None) -> str:
    if value is None:
        return "未指定时间"
    return value.isoformat()


def _operation_summary(operations: list[dict[str, Any]]) -> str | None:
    labels = {
        "aggregate": "汇总",
        "trend": "趋势",
        "entity_compare": "机构比较",
        "period_compare": "期间比较",
        "ranking": "排名",
        "top_n": "Top N",
        "detail": "明细",
        "drill_down": "下钻",
    }
    values = [labels.get(str(item.get("type"))) for item in operations]
    return "、".join(dict.fromkeys(value for value in values if value)) or None


def _first_marker(message: str, markers: Sequence[str]) -> str | None:
    normalized = message.strip()
    return next((marker for marker in markers if marker in normalized), None)


def _active_clarification_tasks(tasks: Sequence[QueryTask]) -> list[QueryTask]:
    return [
        task
        for task in tasks
        if task.status == "WAITING_USER" and task.current_stage == "CLARIFICATION"
    ]


def _empty_anchor(reason: str | None = None) -> AnchorResolution:
    return AnchorResolution(
        status=AnchorResolutionStatus.NONE,
        selection=AnchorSelection.NONE,
        confidence=1.0 if reason is None else 0.0,
        evidence=[],
        reason=reason,
    )


def _reusable_snapshot(task: QueryTask) -> QueryContextSnapshot | None:
    if task.status != "SUCCEEDED" or (task.state_json or {}).get("internal_analysis_id"):
        return None
    try:
        state = QueryTaskState.model_validate(task.state_json or {})
        raw_snapshot = getattr(state, "context_snapshot", None)
        if raw_snapshot is None:
            return None
        snapshot = QueryContextSnapshot.model_validate(raw_snapshot)
    except (TypeError, ValueError, ValidationError):
        return None
    return snapshot if snapshot.reusable else None


def _contains_any(message: str, markers: Sequence[str]) -> bool:
    return any(marker in message for marker in markers)


def _matched_organizations(
    message: str,
    organizations: Sequence[OrganizationCatalogItem],
) -> list[OrganizationCatalogItem]:
    normalized_message = normalize_semantic_text(message)
    matched: list[OrganizationCatalogItem] = []
    for organization in organizations:
        terms = [organization.name, *organization.aliases]
        if any(
            normalized_term in normalized_message
            for term in terms
            if (normalized_term := normalize_semantic_text(term))
        ):
            matched.append(organization)
    return matched


def _invalid_explicit_calendar_date(
    message: str, *, base: QueryContextSnapshot | None, today: date,
) -> str | None:
    expression = extract_time_expression(message) or ""
    match = re.fullmatch(r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日", expression)
    if match is None:
        match = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", expression)
    if match is None:
        return None
    year, month, day = match.groups()
    inherited_year = base.time.start.year if base and base.time and base.time.start else today.year
    try:
        date(int(year) if year else inherited_year, int(month), int(day))
    except ValueError:
        return expression
    return None


def _explicit_catalog_matches(
    message: str,
    *,
    metrics: Sequence[MetricCatalogItem],
    organizations: Sequence[OrganizationCatalogItem],
    today: date,
) -> dict[str, list[dict[str, str]]]:
    """Provide compact, code-authoritative catalog evidence to the semantic model."""

    metric_resolution = MetricMatcher(list(metrics)).resolve(message)
    metric_matches = (
        []
        if metric_resolution.ambiguous_candidates
        else [
            {"code": item.code, "name": item.name, "matched_text": item.matched_text}
            for item in metric_resolution.matches
        ]
    )
    organization_matches = [
        {"code": item.code, "name": item.name}
        for item in _matched_organizations(message, organizations)
    ]
    time_matches: list[dict[str, str]] = []
    time_expression = extract_time_expression(message)
    if time_expression:
        # This is only a mention hint. A partial match such as "六月" within
        # "六月最后一天" must not override the model's date interpretation.
        time_matches.append({"raw_text": time_expression})
    return {
        "metrics": metric_matches,
        "orgs": organization_matches,
        "time": time_matches,
    }


def _explicit_catalog_patch_omissions(
    understanding: ModelConversationUnderstanding,
    *,
    catalog_matches: dict[str, list[dict[str, str]]],
    today: date,
    base: QueryContextSnapshot | None = None,
) -> list[str]:
    """Detect model output that omits or contradicts an explicit input field."""

    if understanding.conversation_act != ConversationAct.FOLLOW_UP:
        return []
    changed_fields = (
        set(understanding.patch.set)
        | set(understanding.patch.add)
        | set(understanding.patch.remove)
    )
    confirmed_unchanged = set()
    if base is not None:
        for field in ("metrics", "orgs"):
            explicit_codes = {item["code"] for item in catalog_matches.get(field, [])}
            base_codes = {item.code for item in getattr(base, field)}
            if explicit_codes and explicit_codes == base_codes:
                confirmed_unchanged.add(field)
        if "time" in understanding.inherit and "time" not in changed_fields:
            expression = extract_time_expression(" ".join(
                item["raw_text"] for item in catalog_matches.get("time", [])
            ))
            if expression:
                try:
                    parsed = _normalize_model_time(expression, today)
                    if (parsed.get("start") == base.time.start.isoformat()
                            and parsed.get("end") == base.time.end.isoformat()):
                        confirmed_unchanged.add("time")
                except (TypeError, ValueError, AttributeError):
                    pass
    omissions = [
        field
        for field in ("metrics", "orgs", "time")
        if catalog_matches.get(field)
        and field not in changed_fields
        and field not in confirmed_unchanged
    ]
    time_ambiguous = any(a.startswith("semantic:time:") for a in understanding.ambiguities)
    if time_ambiguous:
        omissions = [field for field in omissions if field != "time"]
    if catalog_matches.get("time") and "time" in changed_fields and not time_ambiguous:
        raw_time = understanding.patch.set.get("time")
        try:
            _normalize_model_time(raw_time, today)
        except (TypeError, ValueError, ValidationError):
            if "time" not in omissions:
                omissions.append("time")
    return omissions


def _unique_context_values(values: list[Any]) -> list[Any]:
    unique: list[Any] = []
    seen: set[str] = set()
    for value in values:
        if isinstance(value, dict) and value.get("code"):
            identity = f"code:{value['code']}"
        elif isinstance(value, dict) and value.get("type"):
            identity = f"type:{value['type']}"
        else:
            identity = json.dumps(value, ensure_ascii=False, sort_keys=True)
        if identity not in seen:
            seen.add(identity)
            unique.append(value)
    return unique


def _context_value_matches(value: Any, selector: Any) -> bool:
    if isinstance(value, dict) and isinstance(selector, dict):
        return bool(selector) and all(value.get(key) == item for key, item in selector.items())
    if isinstance(value, dict):
        return selector in {value.get("code"), value.get("name"), value.get("dimension")}
    if isinstance(selector, dict):
        return value in {selector.get("code"), selector.get("name"), selector.get("dimension")}
    return value == selector


def _candidate_dsl_from_snapshot(snapshot: QueryContextSnapshot) -> LogicalDSL:
    return LogicalDSL(
        task=snapshot.intent,
        metrics=[item.code for item in snapshot.metrics],
        time=snapshot.time.model_dump(mode="json", exclude={"raw_text"}),
        orgs=[item.code for item in snapshot.orgs],
        dimensions=snapshot.dimensions,
        filters=[
            {
                "dimension": item.dimension,
                "op": item.op,
                "value": item.value,
            }
            for item in snapshot.filters
        ],
        ops=[item.model_dump(mode="json") for item in snapshot.ops],
        options=snapshot.options,
    )


def _candidate_query_shape(dsl: LogicalDSL) -> str:
    operation_types = {str(item.get("type") or "") for item in dsl.ops}
    if operation_types & {"detail", "drill_down"}:
        return "metric_detail"
    if "aggregate" in operation_types:
        return "metric_aggregate"
    if operation_types & {"ranking", "top_n"}:
        return "metric_ranking"
    if "period_compare" in operation_types:
        return "metric_period_compare"
    if "trend" in operation_types:
        return "metric_trend"
    return "metric_value"


def _candidate_catalog_error(
    candidate: LogicalDSL,
    snapshot: QueryContextSnapshot,
    metrics: Sequence[MetricCatalogItem],
    organizations: Sequence[OrganizationCatalogItem],
) -> tuple[str, str] | None:
    metric_by_code = {item.code: item for item in metrics}
    snapshot_metric_names = {item.code: item.name for item in snapshot.metrics}
    missing_metrics = [
        code
        for code in candidate.metrics
        if code not in metric_by_code
        or metric_by_code[code].name != snapshot_metric_names.get(code)
    ]
    if missing_metrics:
        return (
            "CANDIDATE_METRIC_NOT_IN_CATALOG",
            "Metrics are no longer available in the current catalog: "
            + ", ".join(missing_metrics),
        )
    organization_by_code = {item.code: item for item in organizations}
    snapshot_org_names = {item.code: item.name for item in snapshot.orgs}
    missing_organizations = [
        code
        for code in candidate.orgs
        if code not in organization_by_code
        or organization_by_code[code].name != snapshot_org_names.get(code)
    ]
    if missing_organizations:
        return (
            "CANDIDATE_ORG_NOT_IN_CATALOG",
            "Organizations are no longer available in the current catalog: "
            + ", ".join(missing_organizations),
        )
    return None


def _failed_check(name: str, code: str, exc: Exception) -> CandidateDslValidationCheck:
    return CandidateDslValidationCheck.model_validate(
        {
            "name": name,
            "status": "FAILED",
            "code": code,
            "message": str(exc)[:500] or type(exc).__name__,
        }
    )


def _skipped_checks(*names: str) -> list[CandidateDslValidationCheck]:
    return [
        CandidateDslValidationCheck.model_validate(
            {"name": name, "status": "SKIPPED", "code": "PREVIOUS_CHECK_FAILED"}
        )
        for name in names
    ]


def _dsl_differences(
    candidate: LogicalDSL,
    v1_dsl: LogicalDSL,
    *,
    context_merge: ContextMergeResult,
) -> list[DslFieldDifference]:
    candidate_value = candidate.model_dump(mode="json")
    v1_value = v1_dsl.model_dump(mode="json")
    modified = set(context_merge.modified_fields) | set(context_merge.removed_fields)
    differences: list[DslFieldDifference] = []
    for field in (
        "task",
        "metrics",
        "time",
        "orgs",
        "dimensions",
        "filters",
        "ops",
        "options",
    ):
        candidate_field = candidate_value.get(field)
        v1_field = v1_value.get(field)
        if candidate_field == v1_field:
            continue
        if _empty_context_value(v1_field):
            classification = (
                "PATCH_DELTA" if field in modified else "HISTORY_INHERITANCE"
            )
        else:
            classification = "CONFLICT"
        differences.append(
            DslFieldDifference.model_validate(
                {
                    "field": field,
                    "classification": classification,
                    "candidate_value": candidate_field,
                    "v1_value": v1_field,
                }
            )
        )
    return differences


def _empty_context_value(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _admission_hold_reasons(
    *,
    shadow_payload: dict[str, Any],
    validation: CandidateDslValidationResult,
    context_merge: ContextMergeResult,
    comparison: str,
) -> list[str]:
    reasons: list[str] = []
    if shadow_payload.get("conversation_act") != "FOLLOW_UP":
        reasons.append("NOT_A_FOLLOW_UP")
    anchor = shadow_payload.get("anchor")
    if not isinstance(anchor, dict) or anchor.get("status") != "RESOLVED":
        reasons.append("ANCHOR_NOT_RESOLVED")
    if _safe_confidence(shadow_payload.get("confidence")) < 0.85:
        reasons.append("CONVERSATION_ACT_CONFIDENCE_LOW")
    if not isinstance(anchor, dict) or _safe_confidence(anchor.get("confidence")) < 0.9:
        reasons.append("ANCHOR_CONFIDENCE_LOW")
    if context_merge.status != "MERGED":
        reasons.append("NO_CONTEXT_DELTA")
    if validation.status != "VALID":
        reasons.append(f"CANDIDATE_DSL_{validation.status}")
    if comparison == "CONFLICT":
        reasons.append("V1_CANDIDATE_CONFLICT")
    return reasons


def _safe_confidence(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _normalize_model_patch(
    raw: _RawModelPatch,
    *,
    metrics: Sequence[MetricCatalogItem],
    organizations: Sequence[OrganizationCatalogItem],
    today: date,
    base: QueryContextSnapshot | None = None,
    explicit_metrics: Sequence[dict[str, Any]] = (),
    known_metrics: Sequence[dict[str, Any]] = (),
) -> tuple[ContextPatch, list[str]]:
    groups = {"set": raw.set, "add": raw.add, "remove": raw.remove}
    normalized: dict[str, dict[str, Any]] = {name: {} for name in groups}
    ambiguities: list[str] = []
    for group_name, values in groups.items():
        unsupported = set(values) - CONTEXT_FIELDS
        if unsupported:
            raise ValueError(
                f"model patch contains unsupported fields: {', '.join(sorted(unsupported))}"
            )
        for field, value in values.items():
            if field == "metrics":
                resolved, errors = _resolve_model_metric_values(
                    value, metrics, base=base, explicit_metrics=explicit_metrics,
                    known_metrics=known_metrics,
                )
                if errors:
                    ambiguities.extend(errors)
                elif resolved:
                    normalized[group_name][field] = resolved
            elif field == "orgs":
                resolved, errors = _resolve_model_organization_values(
                    value, organizations
                )
                if errors:
                    ambiguities.extend(errors)
                elif resolved:
                    normalized[group_name][field] = resolved
            elif field == "time":
                if group_name != "set":
                    raise ValueError("time only supports set in a model patch")
                try:
                    normalized[group_name][field] = _normalize_model_time(value, today)
                except (TypeError, ValueError, ValidationError) as exc:
                    ambiguities.append(f"time:{str(exc)}")
            else:
                normalized[group_name][field] = value
    return (
        ContextPatch(
            set=normalized["set"],
            add=normalized["add"],
            remove=normalized["remove"],
            reason="model_context_patch",
        ),
        list(dict.fromkeys(ambiguities)),
    )


def _unresolved_model_ambiguities(
    values: Sequence[str],
    *,
    raw_patch: _RawModelPatch,
    normalized_patch: ContextPatch,
    catalog_ambiguities: Sequence[str],
) -> list[str]:
    """Drop only catalog-confirmation hints that code has uniquely resolved.

    True semantic ambiguity uses the ``semantic:`` prefix and is never discarded.
    This function interprets the model contract, not the user's natural language.
    """

    changed_fields = set(raw_patch.set) | set(raw_patch.add) | set(raw_patch.remove)
    resolved_fields = (
        set(normalized_patch.set)
        | set(normalized_patch.add)
        | set(normalized_patch.remove)
    )
    failed_catalog_fields = {
        value.split(":", 1)[0]
        for value in catalog_ambiguities
        if ":" in value
    }
    remaining: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized.startswith("semantic:"):
            remaining.append(value)
            continue
        field = normalized.split(":", 1)[0]
        resolved_catalog_confirmation = (
            field in {"metrics", "orgs"}
            and field in changed_fields
            and field in resolved_fields
            and field not in failed_catalog_fields
        )
        if not resolved_catalog_confirmation:
            remaining.append(value)
    return remaining


def _resolve_model_metric_values(
    value: Any,
    catalog: Sequence[MetricCatalogItem],
    *,
    base: QueryContextSnapshot | None = None,
    explicit_metrics: Sequence[dict[str, Any]] = (),
    known_metrics: Sequence[dict[str, Any]] = (),
) -> tuple[list[dict[str, str]], list[str]]:
    texts = _model_text_list(value, field="metrics")
    by_code = {item.code: item for item in catalog}
    matcher = MetricMatcher(list(catalog))
    resolved: list[dict[str, str]] = []
    errors: list[str] = []
    for text in texts:
        # A unique literal catalog match in this input is stronger evidence than
        # a display name expanded by the model (which may have duplicate codes).
        explicit = [
            item for item in explicit_metrics
            if normalize_semantic_text(text) in {
                normalize_semantic_text(item["name"]),
                normalize_semantic_text(item["matched_text"]),
            }
        ]
        if len(explicit) == 1 and explicit[0]["code"] in by_code:
            item = by_code[explicit[0]["code"]]
            if explicit[0]["matched_text"] != item.code:
                item = _preserve_bound_metric(item, base, by_code)
            if item.code not in {current["code"] for current in resolved}:
                resolved.append({"code": item.code, "name": item.name})
            continue
        # A repeated display name must not rebind an already confirmed identity.
        inherited = [
            metric for metric in (base.metrics if base else [])
            if normalize_semantic_text(text) in {
                normalize_semantic_text(metric.code), normalize_semantic_text(metric.name)
            }
        ]
        if len(inherited) == 1:
            metric = inherited[0]
            if metric.code not in {current["code"] for current in resolved}:
                resolved.append({"code": metric.code, "name": metric.name})
            continue
        # Switching back to a previously confirmed metric can reuse its identity
        # within this conversation. Conflicting historical bindings stay ambiguous.
        known_codes = {
            metric["code"] for metric in known_metrics
            if normalize_semantic_text(text) == normalize_semantic_text(metric["name"])
            and metric["code"] in by_code
        }
        if len(known_codes) == 1:
            item = by_code[next(iter(known_codes))]
            if item.code not in {current["code"] for current in resolved}:
                resolved.append({"code": item.code, "name": item.name})
            continue
        item = by_code.get(text)
        if item is None:
            exact = matcher.exact_candidates(text)
            if len(exact) > 1:
                errors.append(
                    f"metrics:{text}:ambiguous_codes:" + ",".join(item.code for item in exact)
                )
                continue
            if len(exact) == 1:
                item = exact[0]
        if item is None:
            resolution = matcher.resolve(text)
            if len(resolution.matches) == 1 and not resolution.ambiguous_candidates:
                item = resolution.matches[0]
            else:
                candidates = resolution.ambiguous_candidates or resolution.matches
                suffix = ",".join(candidate.name for candidate in candidates[:5])
                errors.append(f"metrics:{text}:{suffix or 'not_found'}")
                continue
        if text != item.code:
            item = _preserve_bound_metric(item, base, by_code)
        if item.code not in {current["code"] for current in resolved}:
            resolved.append({"code": item.code, "name": item.name})
    return resolved, errors


def _preserve_bound_metric(item, base, by_code):
    """A model alias expansion cannot switch between identical display names.

    A different metric code requires an explicit code or structured clarification.
    Data availability is deliberately never used to select a catalog identity.
    """
    same_name = [m for m in (base.metrics if base else [])
                 if normalize_semantic_text(m.name) == normalize_semantic_text(item.name)]
    if len(same_name) == 1 and same_name[0].code in by_code:
        return by_code[same_name[0].code]
    return item


def _resolve_model_organization_values(
    value: Any,
    catalog: Sequence[OrganizationCatalogItem],
) -> tuple[list[dict[str, str]], list[str]]:
    texts = _model_text_list(value, field="orgs")
    by_identifier: dict[str, list[OrganizationCatalogItem]] = {}
    for item in catalog:
        for identifier in (item.code, item.name, *item.aliases):
            normalized = normalize_semantic_text(identifier)
            if normalized:
                by_identifier.setdefault(normalized, []).append(item)
    resolved: list[dict[str, str]] = []
    errors: list[str] = []
    for text in texts:
        matched = by_identifier.get(normalize_semantic_text(text), [])
        if not matched:
            normalized_text = normalize_semantic_text(text)
            matched = [
                item
                for item in catalog
                if any(
                    normalized_identifier in normalized_text
                    or normalized_text in normalized_identifier
                    for identifier in (item.name, *item.aliases)
                    if (normalized_identifier := normalize_semantic_text(identifier))
                )
            ]
        candidates = list(
            {item.code: item for item in matched}.values()
        )
        if len(candidates) != 1:
            errors.append(
                f"orgs:{text}:"
                + (",".join(item.name for item in candidates[:5]) or "not_found")
            )
            continue
        item = candidates[0]
        if item.code not in {current["code"] for current in resolved}:
            resolved.append({"code": item.code, "name": item.name})
    return resolved, errors


def _model_text_list(value: Any, *, field: str) -> list[str]:
    values = value if isinstance(value, list) else [value]
    normalized: list[str] = []
    for item in values:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict) and isinstance(item.get("name"), str):
            # Ignore model-provided codes; catalog resolution below remains authoritative.
            text = item["name"].strip()
        else:
            text = ""
        if not text:
            raise ValueError(
                f"model patch field {field} must contain non-empty text values"
            )
        normalized.append(text)
    if not normalized:
        raise ValueError(f"model patch field {field} must contain non-empty text values")
    return list(dict.fromkeys(normalized))


def _normalize_model_time(value: Any, today: date) -> dict[str, Any]:
    if isinstance(value, list) and len(value) == 1:
        value = value[0]
    if isinstance(value, str):
        parsed = parse_time_expression(value, today=today)
        return {**parsed.model_dump(mode="json"), "raw_text": value}
    parsed = ContextTimeRange.model_validate(value)
    return parsed.model_dump(mode="json")


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def _is_low_risk_time_patch(patch: ContextPatch) -> bool:
    return (
        set(patch.set) == {"time"}
        and not patch.add
        and not patch.remove
        and isinstance(patch.set.get("time"), dict)
    )


def _is_admissible_validated_patch(patch: ContextPatch) -> bool:
    if patch.reason == "model_context_patch":
        return bool(patch.set or patch.add or patch.remove)
    return _is_low_risk_time_patch(patch)
