from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date
from difflib import SequenceMatcher
from typing import Any
from uuid import uuid4

from ask_metric.domain.metric_matching import MetricMatcher, normalize_semantic_text
from ask_metric.domain.semantic_engine import extract_time_expression
from ask_metric.domain.semantic_normalization import (
    SemanticValidationError,
    normalize_slot_frame,
    parse_time_expression,
    query_shape_for,
    to_logical_dsl,
)
from ask_metric.domain.semantics import (
    LogicalDSL,
    MetricCatalogItem,
    OrganizationCatalogItem,
    SemanticPatch,
    SlotFrame,
)
from ask_metric.infrastructure.semantic.configuration import (
    ClarificationPrompts,
    SemanticConfig,
)


@dataclass(frozen=True)
class SemanticAdvance:
    slot_frame: SlotFrame
    logical_dsl: LogicalDSL | None
    query_shape: str | None
    clarification_id: str | None
    clarification_prompt: str | None
    clarification_options: list[dict[str, Any]]
    clarification_fields: list[dict[str, Any]]
    clarification_understood: dict[str, Any]
    clarification_reply_examples: list[str]


def advance_slot_frame(
    frame: SlotFrame,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    config: SemanticConfig,
    today: date,
    metric_candidates: list[MetricCatalogItem] | None = None,
) -> SemanticAdvance:
    normalized = normalize_slot_frame(frame, metrics=metrics, organizations=organizations)
    if normalized.time:
        try:
            parse_time_expression(normalized.time, today=today, default=config.default_time)
            normalized.options.pop("missing_time_reason", None)
        except (SemanticValidationError, ValueError):
            normalized.options["invalid_time_expression"] = normalized.time
            normalized.time = None
            normalized.options["missing_time_reason"] = "invalid_date"
            if "time" not in normalized.missing:
                normalized.missing.append("time")
    # Required slots are a business rule, separate from metric ambiguity.
    # Keep them in SlotFrame.missing so the existing clarification/resume path applies.
    if normalized.task.value == "metric_query":
        for slot in config.required_slots:
            if slot == "time" and not normalized.time and slot not in normalized.missing:
                normalized.missing.append(slot)
            elif (
                slot == "orgs"
                and not normalized.orgs
                and not any(operation.type in {"ranking", "top_n"} for operation in normalized.ops)
                and slot not in normalized.missing
            ):
                normalized.missing.append(slot)
    if normalized.missing:
        fields = _clarification_fields(
            normalized,
            metrics if metric_candidates is None else metric_candidates,
            organizations,
            today=today,
        )
        _configure_clarification_fields(fields, normalized, config.clarification_prompts)
        options = next(
            (
                item["options"]
                for item in fields
                if item.get("target_field", item["field"]) == "metrics"
            ),
            [],
        )
        understood = _clarification_understood(normalized)
        reply_examples = _clarification_reply_examples(normalized, fields)
        return SemanticAdvance(
            slot_frame=normalized,
            logical_dsl=None,
            query_shape=None,
            clarification_id=str(uuid4()),
            clarification_prompt=_clarification_prompt(
                fields,
                config.clarification_prompts,
                understood=understood,
                reply_examples=reply_examples,
            ),
            clarification_options=options,
            clarification_fields=fields,
            clarification_understood=understood,
            clarification_reply_examples=reply_examples,
        )
    logical_dsl = to_logical_dsl(
        normalized,
        metrics=metrics,
        organizations=organizations,
        config=config,
        today=today,
    )
    return SemanticAdvance(
        slot_frame=normalized,
        logical_dsl=logical_dsl,
        query_shape=query_shape_for(normalized),
        clarification_id=None,
        clarification_prompt=None,
        clarification_options=[],
        clarification_fields=[],
        clarification_understood={},
        clarification_reply_examples=[],
    )


def apply_semantic_patch(frame: SlotFrame | dict[str, Any], raw_patch: Any) -> SlotFrame:
    patch = SemanticPatch.model_validate(raw_patch)
    current = SlotFrame.model_validate(frame)
    value = current.model_dump(mode="json")
    allowed_fields = set(SlotFrame.model_fields) - {"missing"}
    unknown_fields = set(patch.set) - allowed_fields
    if unknown_fields:
        names = ", ".join(sorted(unknown_fields))
        raise ValueError(f"Unsupported semantic patch fields: {names}")
    patch_values = dict(patch.set)
    if "metrics" in patch_values and current.options.get("metric_clarification_items"):
        patch_values["metrics"] = [
            *[item.model_dump(mode="json") for item in current.metrics],
            *list(patch_values.get("metrics") or []),
        ]
    if "orgs" in patch_values and current.options.get("organization_clarification_items"):
        patch_values["orgs"] = [*current.orgs, *list(patch_values.get("orgs") or [])]
    value.update(patch_values)
    options = dict(value.get("options") or {})
    if "metrics" in patch_values:
        options.pop("metric_clarification_items", None)
        options.pop("missing_metric_text", None)
    if "orgs" in patch_values:
        options.pop("organization_clarification_items", None)
        options.pop("missing_org_text", None)
        options.pop("missing_org_texts", None)
        options.pop("missing_org_reason", None)
    value["options"] = options
    value["missing"] = [item for item in current.missing if item not in patch_values]

    operations = list(value.get("ops") or [])
    for removal in patch.remove_ops:
        operations = [
            operation
            for operation in operations
            if not _operation_matches(operation, removal)
        ]
    operations.extend(item.model_dump(mode="json") for item in patch.add_ops)
    value["ops"] = operations
    if patch.add_ops:
        value["missing"] = [item for item in value["missing"] if item != "ops"]
    return SlotFrame.model_validate(value)


def semantic_patch_from_text(
    text: str,
    frame: SlotFrame | dict[str, Any],
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
) -> SemanticPatch:
    current = SlotFrame.model_validate(frame)
    values: dict[str, Any] = {}

    if "time" in current.missing:
        time_value = extract_time_expression(text)
        if time_value:
            values["time"] = time_value

    if "orgs" in current.missing:
        normalized_text = normalize_semantic_text(text)
        matched_orgs = []
        for organization in organizations:
            terms = [organization.name, *organization.aliases]
            if any(
                normalized_term and normalized_term in normalized_text
                for term in terms
                if (normalized_term := normalize_semantic_text(term))
            ):
                matched_orgs.append(organization.name)
        if len(matched_orgs) == 1:
            values["orgs"] = matched_orgs

    if "metrics" in current.missing:
        resolution = MetricMatcher(metrics).resolve(text)
        if len(resolution.matches) == 1 and not resolution.ambiguous_candidates:
            match = resolution.matches[0]
            values["metrics"] = [{"code": match.code, "name": match.name}]

    return SemanticPatch(set=values)


def apply_clarification_answers(
    frame: SlotFrame | dict[str, Any],
    answers: str | dict[str, Any],
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
) -> SlotFrame:
    """Apply selected catalog entities and free text in one clarification update."""
    if isinstance(answers, str):
        current = SlotFrame.model_validate(frame)
        text = answers
    else:
        current = apply_semantic_patch(frame, answers)
        selection_mode = answers.get("catalog_selection_mode")
        if selection_mode not in (None, "append"):
            raise ValueError("Unsupported catalog selection mode")
        if selection_mode == "append":
            original = SlotFrame.model_validate(frame)
            selected_fields = answers.get("set", {})
            if "metrics" in selected_fields:
                merged_metrics = {}
                for item in [*original.metrics, *current.metrics]:
                    merged_metrics.setdefault(item.code, item)
                current.metrics = list(merged_metrics.values())
            if "orgs" in selected_fields:
                current.orgs = list(dict.fromkeys([*original.orgs, *current.orgs]))
        text = answers.get("text", "")
        if not isinstance(text, str):
            raise ValueError("Clarification text must be a string")
    if not text.strip():
        return current
    patch = semantic_patch_from_text(
        text, current, metrics=metrics, organizations=organizations
    )
    return apply_semantic_patch(current, patch)


def resolved_question(frame: SlotFrame | dict[str, Any]) -> str:
    current = SlotFrame.model_validate(frame)
    metric_text = "、".join(item.name for item in current.metrics) or "指标"
    operation_types = {item.type for item in current.ops}
    if (
        current.options.get("organization_scope") == "synchronized_catalog"
        or operation_types & {"ranking", "top_n"}
    ):
        organization_text = "各家农商行"
    else:
        organization_text = "、".join(current.orgs) or "所选机构"
    time_text = (
        "最新"
        if current.time in {None, "latest", "最新", "最近", "最新一期", "最近一期", "当前最新"}
        else current.time
    )
    operation = next((item for item in current.ops if item.type in {"ranking", "top_n"}), None)
    if operation is not None:
        top_n = getattr(operation, "top_n", None) or getattr(operation, "n", None)
        if operation.type == "ranking" and operation.order == "asc":
            suffix = f"指标值最低的{top_n}家机构有哪些？" if top_n else "指标值最低的是哪些机构？"
        elif operation.type == "ranking" and operation.order == "desc":
            suffix = f"指标值最高的{top_n}家机构有哪些？" if top_n else "指标值最高的是哪些机构？"
        elif operation.order == "desc":
            suffix = f"排名后{top_n}的机构有哪些？" if top_n else "排名靠后的是哪些机构？"
        else:
            suffix = f"排名前{top_n}的机构有哪些？" if top_n else "排名情况如何？"
    elif "trend" in operation_types:
        suffix = "趋势如何？"
    elif "period_compare" in operation_types:
        suffix = "对比结果如何？"
    elif "entity_compare" in operation_types:
        suffix = "对比结果如何？"
    else:
        suffix = "是多少？"
    return f"{organization_text}{time_text}{metric_text}{suffix}"


def _operation_matches(operation: dict[str, Any], removal: dict[str, Any]) -> bool:
    return bool(removal) and all(operation.get(key) == value for key, value in removal.items())


def _clarification_fields(
    frame: SlotFrame,
    candidates: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    *,
    today: date,
) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    for missing in frame.missing:
        if missing == "metrics":
            pending_items = frame.options.get("metric_clarification_items")
            if isinstance(pending_items, list) and pending_items:
                preserved = [
                    {
                        "code": item.code,
                        "name": item.name,
                        "kind": "metric",
                    }
                    for item in frame.metrics
                ]
                for index, pending in enumerate(pending_items):
                    if not isinstance(pending, dict):
                        continue
                    raw_text = _clean_option_text(pending.get("raw_text"))
                    pending_options = pending.get("options")
                    options = pending_options if isinstance(pending_options, list) else []
                    fields.append({
                        "field": str(pending.get("id") or f"metrics.{index}"),
                        "target_field": "metrics",
                        "type": "metric",
                        "label": f"查询指标 {index + 1}",
                        "reason": "metric_ambiguous" if options else "metric_not_found",
                        "raw_text": raw_text,
                        "message": (
                            f'指标“{raw_text}”存在多个可能匹配，请确认一个标准指标。'
                            if options
                            else f'指标库中未找到“{raw_text}”的可靠匹配，请搜索并选择一个标准指标。'
                        ),
                        "selection_mode": "single",
                        "min_selections": 1,
                        "max_selections": 1,
                        "options": options,
                        "preserved_options": preserved,
                        "search_required": not options,
                    })
                continue
            metric_text = _clean_option_text(frame.options.get("missing_metric_text"))
            options = [
                {"code": item.code, "name": item.name, "kind": "metric", "unit": item.unit}
                for item in candidates[:3]
            ]
            reason = "metric_ambiguous" if options else (
                "metric_not_found" if metric_text else "metric_required"
            )
            if options:
                message = (
                    f'指标“{metric_text}”存在多个可能匹配，请从相似指标中确认，'
                    "或搜索指标库选择具体指标。"
                    if metric_text
                    else "检测到多个可能的指标，请确认一个具体指标。"
                )
            elif metric_text:
                message = f'指标库中未找到“{metric_text}”的可靠匹配，请搜索并选择一个具体指标。'
            else:
                message = "问题中缺少具体指标，请从指标库搜索并选择。"
            fields.append({
                "field": "metrics",
                "target_field": "metrics",
                "type": "metric",
                "label": "查询指标",
                "reason": reason,
                "raw_text": metric_text,
                "message": message,
                "selection_mode": "single" if metric_text else "multiple",
                "min_selections": 1,
                "max_selections": 1 if metric_text else None,
                "options": options,
                "preserved_options": [],
                "search_required": not options,
            })
            continue
        if missing == "time":
            invalid_expression = _clean_option_text(
                frame.options.get("invalid_time_expression")
            )
            reason = frame.options.get("missing_time_reason")
            if reason == "invalid_date":
                message = (
                    f'日期“{invalid_expression}”不存在，请重新选择有效的起止日期。'
                    if invalid_expression
                    else "输入的日期不存在，请重新选择有效的起止日期。"
                )
            elif reason == "year_required":
                message = "查询月份缺少年份，请选择完整的起止日期。"
            else:
                message = "问题中缺少查询时间，请选择起始日期和结束日期。"
            suggested_start, suggested_end = _suggested_date_range(
                invalid_expression, today=today
            )
            fields.append({
                "field": "time",
                "type": "date_range",
                "label": "查询日期",
                "reason": reason or "time_required",
                "message": message,
                "selection_mode": "date_range",
                "options": [],
                "suggested_start": suggested_start,
                "suggested_end": suggested_end,
            })
            continue
        if missing == "orgs":
            pending_items = frame.options.get("organization_clarification_items")
            if isinstance(pending_items, list) and pending_items:
                preserved = [
                    {"code": item.code, "name": item.name, "kind": "organization"}
                    for item in organizations
                    if item.name in frame.orgs
                ]
                for index, pending in enumerate(pending_items):
                    if not isinstance(pending, dict):
                        continue
                    raw_text = _clean_option_text(pending.get("raw_text"))
                    options = _organization_candidates(raw_text, organizations)
                    fields.append({
                        "field": str(pending.get("id") or f"orgs.{index}"),
                        "target_field": "orgs",
                        "type": "organization",
                        "label": f"查询机构 {index + 1}",
                        "reason": "organization_not_found",
                        "raw_text": raw_text,
                        "message": (
                            f'机构库中未找到“{raw_text}”的精确匹配，请确认一个标准机构。'
                        ),
                        "selection_mode": "single",
                        "min_selections": 1,
                        "max_selections": 1,
                        "options": options,
                        "preserved_options": preserved,
                        "search_required": not options,
                    })
                continue
            organization_text = _clean_option_text(
                frame.options.get("missing_org_text")
            )
            options = _organization_candidates(organization_text, organizations)
            unknown = frame.options.get("missing_org_reason") == "alias_not_found"
            if unknown and organization_text:
                message = (
                    f'机构库中未找到“{organization_text}”的精确匹配，请确认相似机构，'
                    "或搜索机构库选择具体机构。"
                )
            elif unknown:
                message = "输入的机构不在当前机构库中，请搜索并选择一个具体机构。"
            else:
                message = "问题中缺少具体机构，请从机构库搜索并选择。"
            fields.append({
                "field": "orgs",
                "target_field": "orgs",
                "type": "organization",
                "label": "查询机构",
                "reason": (
                    "organization_not_found" if unknown else "organization_required"
                ),
                "message": message,
                "selection_mode": "single" if unknown else "multiple",
                "min_selections": 1,
                "max_selections": 1 if unknown else None,
                "options": options,
                "preserved_options": [
                    {"code": item.code, "name": item.name, "kind": "organization"}
                    for item in organizations
                    if item.name in frame.orgs
                ],
                "search_required": not options,
            })
            continue
        fields.append({
            "field": missing,
            "type": "unsupported",
            "label": missing,
            "reason": "unsupported_clarification_field",
            "message": f"查询条件“{missing}”无法通过当前选择器补全，请取消后重新提问。",
            "selection_mode": "unsupported",
            "options": [],
        })
    return fields


def _configure_clarification_fields(
    fields: list[dict[str, Any]], frame: SlotFrame, prompts: ClarificationPrompts
) -> None:
    scenario_names = {
        "metric_required": "metric_missing",
        "organization_required": "organization_missing",
        "organization_not_found": "organization_unknown",
        "time_required": "time_missing",
    }
    for field in fields:
        target = field.get("target_field", field["field"])
        label = prompts.field_labels.get(target)
        if label:
            # Preserve the index for independent selectors in multi-entity clarification.
            index = str(field["field"]).rpartition(".")[2]
            field["label"] = f"{label} {int(index) + 1}" if index.isdigit() else label
        reason = field["reason"]
        scenario = scenario_names.get(reason, reason)
        # Display identities only where names cannot distinguish catalog entries.
        identities: dict[str, set[str]] = {}
        for item in field["options"]:
            identities.setdefault(str(item["name"]), set()).add(str(item.get("code", "")))
        for item in field["options"]:
            if len(identities[str(item["name"])]) > 1:
                identity = " · ".join(str(item[key]) for key in ("code", "unit") if item.get(key))
                item["display_label"] = f"{item['name']}（{identity}）"
        options = "、".join(
            str(item.get("display_label") or item["name"]) for item in field["options"]
        )
        context = {
            "options": options,
            "time": _clean_option_text(frame.options.get("invalid_time_expression"))
            or frame.time or "",
            "metric": field.get("raw_text")
            or _clean_option_text(frame.options.get("missing_metric_text")) or "",
            "organization": field.get("raw_text")
            or _clean_option_text(frame.options.get("missing_org_text")) or "",
        }
        if scenario in prompts.scenarios:
            field["message"] = prompts.scenarios[scenario].format(**context)
        elif target == "metrics":
            field["message"] = (
                prompts.metrics_with_options.format(options=options)
                if field["options"]
                else prompts.metrics_without_options.format()
            )


def _clarification_prompt(
    fields: list[dict[str, Any]],
    prompts: ClarificationPrompts,
    *,
    understood: dict[str, Any],
    reply_examples: list[str],
) -> str:
    understood_text = _understood_text(understood)
    opening = (
        f"我已经识别到{understood_text}，但还需要补充一些信息。"
        if understood_text
        else "我可以继续帮您查询，但还需要补充一些信息。"
    )
    details = "\n".join(
        f"{index}. {item['message']}"
        for index, item in enumerate(fields, start=1)
    )
    example = reply_examples[0] if reply_examples else "请直接补充缺少的查询条件"
    labels = "、".join(dict.fromkeys(str(item["label"]) for item in fields))
    missing_fields = prompts.missing_fields.format(fields=labels)
    return f"{opening}\n\n{missing_fields}\n{details}\n\n您可以直接回复：“{example}”。"


def _clarification_understood(frame: SlotFrame) -> dict[str, Any]:
    understood: dict[str, Any] = {}
    if frame.metrics:
        understood["metrics"] = [item.name for item in frame.metrics]
    if frame.orgs:
        understood["orgs"] = list(frame.orgs)
    if frame.time:
        understood["time"] = frame.time
    if frame.ops:
        understood["operations"] = [item.type for item in frame.ops]
    return understood


def _understood_text(understood: dict[str, Any]) -> str:
    parts: list[str] = []
    metrics = understood.get("metrics")
    organizations = understood.get("orgs")
    time_value = understood.get("time")
    if isinstance(metrics, list) and metrics:
        parts.append(f"指标为{'、'.join(str(item) for item in metrics)}")
    if isinstance(organizations, list) and organizations:
        parts.append(f"机构为{'、'.join(str(item) for item in organizations)}")
    if isinstance(time_value, str) and time_value:
        parts.append(f"时间为{time_value}")
    return "，".join(parts)


def _clarification_reply_examples(
    frame: SlotFrame,
    fields: list[dict[str, Any]],
) -> list[str]:
    values: list[str] = []
    for field in fields:
        field_type = field.get("type")
        options = field.get("options")
        first_option = options[0] if isinstance(options, list) and options else None
        if field_type == "metric":
            if isinstance(first_option, dict) and first_option.get("name"):
                values.append(str(first_option["name"]))
            else:
                values.append("具体指标名称")
        elif field_type == "organization":
            if isinstance(first_option, dict) and first_option.get("name"):
                values.append(str(first_option["name"]))
            else:
                values.append("具体机构名称")
        elif field_type == "date_range":
            suggested_start = field.get("suggested_start")
            suggested_end = field.get("suggested_end")
            if suggested_start and suggested_end and suggested_start != suggested_end:
                values.append(f"{suggested_start}至{suggested_end}")
            elif suggested_end:
                values.append(str(suggested_end))
            else:
                values.append("2026年3月末")

    if len(values) == 1:
        return values
    if values:
        return ["，".join(values)]
    if frame.missing:
        return ["请补充" + "、".join(frame.missing)]
    return []


def _organization_candidates(
    raw_text: str | None,
    organizations: list[OrganizationCatalogItem],
) -> list[dict[str, Any]]:
    if not raw_text:
        return []
    normalized_query = normalize_semantic_text(raw_text)
    if not normalized_query:
        return []
    scored: list[tuple[float, OrganizationCatalogItem]] = []
    for item in organizations:
        terms = [item.name, *item.aliases]
        score = max(
            (
                SequenceMatcher(
                    None,
                    normalized_query,
                    normalize_semantic_text(term),
                ).ratio()
                for term in terms
                if normalize_semantic_text(term)
            ),
            default=0.0,
        )
        if score >= 0.45:
            scored.append((score, item))
    scored.sort(key=lambda value: (-value[0], value[1].code))
    return [
        {
            "code": item.code,
            "name": item.name,
            "kind": "organization",
            "score": round(score, 4),
        }
        for score, item in scored[:3]
    ]


def _suggested_date_range(raw_text: str | None, *, today: date) -> tuple[str, str]:
    if raw_text:
        match = re.fullmatch(r"(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?", raw_text.strip())
        if match:
            year, month, day = map(int, match.groups())
            if 1 <= month <= 12:
                day = min(max(day, 1), calendar.monthrange(year, month)[1])
                suggested = date(year, month, day).isoformat()
                return suggested, suggested
    suggested = today.isoformat()
    return suggested, suggested


def _clean_option_text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
