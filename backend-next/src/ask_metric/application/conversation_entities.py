"""Protect catalog-confirmed metric spans at the conversation model boundary."""

import json
import re
from typing import Any

from ask_metric.domain.metric_matching import MetricMatcher
from ask_metric.domain.semantic_engine import _protect_resolved_entities

_TOKEN = re.compile(r'<METRIC code="([^"]+)"\s*/>')


class ConversationEntityProtection:
    def __init__(self, message, metrics):
        self.matcher = MetricMatcher(list(metrics))
        resolution = self.matcher.resolve(message)
        matches = [] if resolution.ambiguous_candidates else resolution.matches
        self.originals = {match.code: match.matched_text for match in matches}
        self.message = self.protect_text(message)
        self.only_entities = bool(matches) and not _TOKEN.sub("", self.message).strip(
            " \t\r\n，。！？,!?"
        )

    def protect_text(self, text: str) -> str:
        if not self.originals:
            return text
        resolution = self.matcher.resolve(text)
        matches = [] if resolution.ambiguous_candidates else [
            match for match in resolution.matches if match.code in self.originals
        ]
        return _protect_resolved_entities(
            text, metric_matches=matches, organizations=[], organization_aliases={},
        )

    def context(self, context: dict) -> dict:
        def protect(value):
            if isinstance(value, str):
                return self.protect_text(value)
            if isinstance(value, list):
                return [protect(item) for item in value]
            if isinstance(value, dict):
                return {key: protect(item) for key, item in value.items()}
            return value

        # JSON fields must stay parseable. Do not expose the same entity via an
        # unprotected catalog/history/clarification or retry-feedback field.
        return {
            key: json.dumps(protect(json.loads(value)), ensure_ascii=False)
            if key.endswith("_json") else protect(value)
            for key, value in context.items()
        }

    def restore(self, value: Any) -> Any:
        def replace(match):
            if match[1] not in self.originals:
                raise ValueError("Unknown protected metric reference")
            return self.originals[match[1]]

        if isinstance(value, str):
            return _TOKEN.sub(replace, value)
        if isinstance(value, list):
            return [self.restore(item) for item in value]
        if isinstance(value, dict):
            return {key: self.restore(item) for key, item in value.items()}
        return value

    def validate(self, understanding, *, has_history: bool, base=None):
        if understanding.task_goal != "metric_query":
            return
        if has_history and self.only_entities and understanding.conversation_act == "NEW_QUERY":
            raise ValueError(
                "Input contains only catalog entities, with a reusable query available; "
                "reconsider historical conditions instead of starting an incomplete NEW_QUERY"
            )
        if not self.originals:
            return
        for field in ("ops", "options"):
            changed = any(field in getattr(understanding.patch, group)
                          for group in ("set", "add", "remove"))
            if not changed:
                continue
            prior = getattr(base, field, None) if base else None
            if field == "ops" and prior is not None:
                prior = [op.model_dump(mode="json", exclude_none=True) for op in prior]
            if (understanding.patch.set.get(field) == prior
                    and field not in understanding.patch.add
                    and field not in understanding.patch.remove):
                continue
            quote = (understanding.patch_evidence.get(field)
                     or understanding.patch_evidence.get("ops"))
            if not quote or quote not in self.message or _TOKEN.search(quote):
                raise ValueError(
                    f"Changed {field} requires patch_evidence.{field} quoting an explicit "
                    "instruction outside protected metric names; otherwise preserve it"
                )
