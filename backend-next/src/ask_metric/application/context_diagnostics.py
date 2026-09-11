"""Bounded context diagnostics: never serialize model input or exception repr."""
from __future__ import annotations

import json
import logging
from uuid import uuid4

from pydantic import ValidationError

logger = logging.getLogger(__name__)

_FIELDS = set("""
conversation_act confidence anchor_task_id patch set add remove inherit ambiguities reason
result_action patch_evidence task_goal analysis_intent metrics orgs time filters options
code name start end mode expression year month day time.year time.month time.day
task_id metric_code org_code field op value values limit offset sort direction operation
result_id source_result_id target_dates time_windows top_n time_mode base_date current_date
intent dimension dimensions operator order_by scope period source target query_shape
""".split())
_RULES = {
    "unsupported model conversation act",
    "follow-up understanding requires an anchor task",
    "new-query understanding cannot reference a history task",
    "NEW_QUERY must not inherit history fields",
    "inherit contains unsupported context fields",
    "Conversation understanding requires a model; lexical fallback is disabled",
    "Resume must resolve the original task as FOLLOW_UP or REFERENCE_ACTION, "
    "using the supplied clarification",
    "CLARIFICATION_ANSWER requires an active WAITING_USER task",
    "model anchor conflicts with explicit task reference",
    "Model-routed follow-up requires a model patch",
    "time only supports set in a model patch",
}


def _rule(message: str) -> str:
    message = message.removeprefix("Value error, ")
    if message in _RULES:
        return message
    if message.startswith("model patch contains unsupported fields:"):
        return "model patch contains unsupported fields (names redacted)"
    return "custom validation failed (exception text withheld)"


def context_failure(exc: Exception, *, stage: str) -> dict:
    previous = getattr(exc, "_context_diagnostic", None)
    if isinstance(previous, dict):
        return dict(previous)
    detail = {"diagnostic_id": str(uuid4()), "stage": stage, "type": type(exc).__name__}
    if isinstance(exc, ValidationError):
        errors = exc.errors(include_url=False, include_context=False, include_input=False)
        detail["error_count"] = len(errors)
        detail["errors_truncated"] = len(errors) > 12
        detail["validation_errors"] = [
            {
                "loc": [part if isinstance(part, int) or part in _FIELDS else "<unknown-field>"
                        for part in error["loc"][:10]],
                "type": error["type"],
                # Custom validators can embed user/model data in their messages.
                "reason": _rule(error["msg"])
                if error["type"] in {"value_error", "assertion_error"}
                else error["type"],
            }
            for error in errors[:12]
        ]
    elif isinstance(exc, (ValueError, TypeError)):
        detail["reason"] = _rule(str(exc))
    # Numeric provider metadata is useful for separating transport and contract errors.
    for key in ("status_code", "duration_ms"):
        value = getattr(exc, key, None)
        if isinstance(value, (int, float)):
            detail[key] = value
    return detail


def log_context_failure(
    exc: Exception, *, stage: str, attempt: int | None = None,
    retry_planned: bool = False, task_id: str | None = None,
    conversation_id: str | None = None, request_id: str | None = None,
) -> dict:
    detail = context_failure(exc, stage=stage)
    if attempt is not None:
        detail.update(attempt=attempt, retry_planned=retry_planned,
                      prompt="multiturn_context_patch")
    # Preserve the deepest failure stage and attempt when the outer task logs it.
    exc._context_diagnostic = detail
    event = {**detail, "boundary": stage, "task_id": task_id,
             "conversation_id": conversation_id, "request_id": request_id}
    logger.warning("context_parse_failure %s", json.dumps(event, ensure_ascii=True))
    return dict(detail)
