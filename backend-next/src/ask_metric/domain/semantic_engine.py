from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from difflib import SequenceMatcher
from time import perf_counter
from typing import Any, Protocol

from pydantic import ValidationError

from ask_metric.application.ports import ModelService
from ask_metric.domain.metric_matching import (
    MetricMatcher,
    deduplicate_metrics,
    normalize_semantic_text,
)
from ask_metric.domain.semantic_normalization import (
    SemanticValidationError,
    normalize_slot_frame,
    parse_time_expression,
)
from ask_metric.domain.semantic_reference import ReferenceMergeUnsupported, validate_change_map
from ask_metric.domain.semantics import (
    MetricCatalogItem,
    MetricMatch,
    MetricSlot,
    OrganizationCatalogItem,
    SlotFrame,
)
from ask_metric.domain.slot_frame_adapter import adapt_model_slot_frame, slot_frame_json_schema
from ask_metric.infrastructure.model.catalog_vectors import (
    CatalogVectorCache,
    catalog_embedding_texts,
)
from ask_metric.infrastructure.semantic.configuration import SemanticConfig

_CALENDAR_MONTH_TOKEN = r"(?:\d{1,2}|[一二三四五六七八九十]{1,3})"


@dataclass(frozen=True)
class SemanticAnalysis:
    slot_frame: SlotFrame
    metric_matches: list[MetricMatch]
    metric_candidates: list[MetricCatalogItem]
    protected_question: str
    timings_ms: dict[str, int]
    debug: dict[str, Any]


@dataclass(frozen=True)
class _ScoredMetricCandidate:
    item: MetricCatalogItem
    score: float


@dataclass(frozen=True)
class _MetricDecision:
    selected: list[MetricCatalogItem]
    candidates: list[MetricCatalogItem]
    scored_candidates: list[_ScoredMetricCandidate]
    mode: str


class InvalidSlotFrameError(ValueError):
    def __init__(self, errors: list[dict[str, Any]]) -> None:
        super().__init__("Model output is not a valid SlotFrame")
        self.errors = errors


class ContextResolutionError(ValueError):
    """候选来源与本轮关系不明确，禁止将省略句降级为缺指标的新问题。"""


class MetricCandidateSearch(Protocol):
    def search(self, question: str, *, limit: int) -> list[MetricCatalogItem]: ...


class SemanticEngine:
    """理解问题并生成候选槽位：目录名称保护 → 模型抽取 → 规范化与指标消歧。

    向量检索及重排只提供候选；相似度不是业务正确率。这里不执行 SQL，输出还要
    经过澄清、目录/权限校验和查询规划才能执行。
    """
    def __init__(
        self,
        model_service: ModelService,
        metric_candidate_search: MetricCandidateSearch | None = None,
        *,
        catalog_vector_cache: CatalogVectorCache | None = None,
    ) -> None:
        self.model_service = model_service
        self.metric_candidate_search = metric_candidate_search
        self.catalog_vector_cache = catalog_vector_cache or CatalogVectorCache()

    def analyze(
        self,
        question: str,
        *,
        metrics: list[MetricCatalogItem],
        organizations: list[OrganizationCatalogItem],
        config: SemanticConfig,
        current_date: date,
        reference_context: dict[str, Any] | None = None,
    ) -> SemanticAnalysis:
        """抽取候选槽位。reference_context 只由后端构建（已校验来源的冻结条件），
        供模型理解“那江阴呢？”一类追问；合并与字段边界由后端代码执行。"""
        total_started = perf_counter()
        timings_ms: dict[str, int] = {}
        debug: dict[str, Any] = {
            "question": question,
            "catalog": {
                "metric_count": len(metrics),
                "organization_count": len(organizations),
            },
        }
        catalog_started = perf_counter()
        matcher = MetricMatcher(metrics)
        resolution = matcher.resolve(question)
        organization_terms = [
            term
            for organization in organizations
            for term in [
                organization.name,
                *organization.aliases,
                *config.organization_aliases.get(organization.name, []),
            ]
        ]
        resolved_org_codes: list[str] = []
        protected_question = _protect_resolved_entities(
            question,
            metric_matches=resolution.matches,
            ambiguous_metric_spans=resolution.ambiguous_spans,
            organizations=organizations,
            organization_aliases=config.organization_aliases,
            resolved_org_codes=resolved_org_codes,
        )
        timings_ms["catalog_match_ms"] = _elapsed_ms(catalog_started)
        model_context = {
            # Catalog-confirmed entity text must not be sent through a second,
            # unprotected prompt field. Composite metric names can contain words
            # such as "较年初" or "排名" that are not query operations.
            "question": protected_question,
            "current_date": current_date.isoformat(),
            "protected_question": protected_question,
            "metric_candidates": [],
            "organization_candidates": [
                {
                    "code": item.code,
                    "name": item.name,
                    "aliases": list(
                        dict.fromkeys(
                            [
                                *item.aliases,
                                *config.organization_aliases.get(item.name, []),
                            ]
                        )
                    ),
                }
                for item in organizations
                # 已确认实体沿用保护阶段的编码；歧义别名仍在原文中，保留所有相关候选。
                # 完整目录继续用于下方校验与集合展开，不发送无关机构给模型。
                if item.code in resolved_org_codes or any(
                    term and term in protected_question
                    for term in [item.name, *item.aliases,
                                 *config.organization_aliases.get(item.name, [])]
                )
            ],
            "existing_slot_frame": (
                {**reference_context, "mode": (
                    "context_candidate" if reference_context.get("mode") == "candidate"
                    else "reference_delta"
                )} if reference_context else None
            ),
        }
        if reference_context and reference_context.get("change_field") == "compose":
            model_context["existing_slot_frame"]["mentioned_entities"] = {
                "org_codes": resolved_org_codes,
                "metrics": [{"code": item.code, "name": item.name} for item in resolution.matches],
            }
        chat_started = perf_counter()
        raw = self.model_service.analyze(
            prompt="slot_extraction",
            context={
                "question": model_context["question"],
                "current_date": model_context["current_date"],
                "protected_question": protected_question,
                "metric_candidates_json": _json(model_context["metric_candidates"]),
                "organization_candidates_json": _json(
                    model_context["organization_candidates"]
                ),
                "existing_slot_frame_json": _json(model_context["existing_slot_frame"]),
                "slot_frame_schema_json": _json(slot_frame_json_schema()),
            },
        )
        timings_ms["chat_model_ms"] = _elapsed_ms(chat_started)
        debug["chat_model"] = {
            "prompt": "slot_extraction",
            "input": model_context,
            "output": raw,
        }
        normalization_started = perf_counter()
        try:
            adaptation = adapt_model_slot_frame(raw)
            debug["chat_model"]["adapted_output"] = adaptation.adapted
            debug["chat_model"]["field_validation_errors"] = adaptation.field_errors
            # 适配器可修复非关键展示字段，但操作/筛选/维度/参数不能“丢弃后继续”。
            # 否则格式错误的复杂请求会被缩成普通取值，甚至丢失限定条件。
            blocking_errors = [
                error for error in adaptation.field_errors
                if str(error["field"]).split("[", 1)[0]
                in {"task", "ops", "filters", "dimensions", "options",
                    "changes", "context_relation", "time", "orgs", "metrics"}
            ]
            if blocking_errors:
                raise InvalidSlotFrameError(blocking_errors)
            frame = SlotFrame.model_validate(adaptation.adapted)
        except (TypeError, ValidationError) as exc:
            errors = (
                exc.errors(
                    include_url=False,
                    include_context=False,
                    include_input=False,
                )
                if isinstance(exc, ValidationError)
                else [{"field": "$", "code": "invalid_type", "message": str(exc)}]
            )
            raise InvalidSlotFrameError(errors) from exc
        # 不再有前置意图分类；保留模型给出的任务/操作交由能力校验拒绝，
        # 不能把旧模型返回的分析目标强制改成普通指标取值。
        if reference_context and reference_context.get("mode") == "candidate":
            relation = frame.context_relation
            debug["context_resolution"] = {"relation": relation,
                                           "source_task_id": reference_context["source_task_id"]}
            if relation not in {"independent", "followup"}:
                raise ContextResolutionError("本轮上下文未确定，请说出要查询的指标、机构和日期。")
            if relation == "independent":
                if frame.changes:
                    raise ContextResolutionError(
                        "本轮上下文未确定，请说出要查询的指标、机构和日期。"
                    )
                # 独立问题的指标必须在本轮原文中有依据，不能从候选来源复制或省略。
                phrases = frame.raw_metric_texts or (
                    [frame.raw_metric_text] if frame.raw_metric_text else []
                )
                grounded = [p for p in phrases if normalize_semantic_text(p)
                            and normalize_semantic_text(p) in normalize_semantic_text(question)]
                if not resolution.matches and not grounded:
                    raise ContextResolutionError(
                        "本轮未明确新指标，请说出要查询的指标、机构和日期。"
                    )
                reference_context = None
        # 固定日历语法由已有日期解析器保留；复杂自然语言仍由模型解释。
        # 只在模型漏掉日期时补充可完整解析的单一日期，绝不恢复成来源旧日期。
        if frame.time is None:
            expression = extract_time_expression(protected_question)
            availability = any(op.type == "availability" for op in frame.ops)
            if expression and not (availability and expression in {
                "最新", "最近", "最新一期", "最近一期", "当前最新",
            }):
                frame.missing.append("time")
                if reference_context and reference_context.get("change_field") == "compose":
                    frame.changes["time"] = "replace"
                calendar_text = _normalize_calendar_text(protected_question)
                remainder = calendar_text.replace(expression, "", 1)
                if expression in calendar_text and not extract_time_expression(remainder):
                    anchor = current_date
                    if reference_context and re.fullmatch(
                        rf"{_CALENDAR_MONTH_TOKEN}月(?:末)?", expression
                    ):
                        time = reference_context.get("source_logical_dsl", {}).get("time", {})
                        start, end = time.get("start"), time.get("end")
                        if start and end and start[:4] == end[:4]:
                            anchor = date(int(start[:4]), 1, 1)
                        elif start and end:
                            raise ContextResolutionError("来源查询跨年，请明确这次月份对应的年份。")
                    try:
                        normalized_time = parse_time_expression(expression, today=anchor)
                    except (SemanticValidationError, ValueError):
                        frame.options["invalid_time_expression"] = expression
                        frame.options["missing_time_reason"] = "invalid_date"
                        frame.missing.append("time")
                    else:
                        frame.time = (
                            f"{normalized_time.start}至{normalized_time.end}"
                            if normalized_time.start else expression
                        )
                        frame.missing = [item for item in frame.missing if item != "time"]
        if resolution.matches and _plain_catalog_value_question(protected_question):
            # 全句只剩已确认实体、日期和取值语法时，没有额外操作；防止模型凭空加 detail。
            frame.ops = []
        if reference_context is not None:
            # 来源已冻结，只解析本轮变化；不能把省略句残留文字送入新问题指标兜底。
            # 显式指标、筛选和操作仍保留，由引用合并边界拒绝不支持的修改。
            if reference_context.get("change_field") == "compose":
                # 只解析模型选择的修改对象，不能把“去掉甲、保留乙”中的乙也加到移除清单。
                resolved_orgs = []
                pending_orgs = []
                for text in frame.orgs:
                    matches = [item for item in organizations if text == item.code or
                               normalize_semantic_text(text) in {
                                   normalize_semantic_text(term) for term in
                                   [item.name, *item.aliases,
                                    *config.organization_aliases.get(item.name, [])]}]
                    if len(matches) == 1:
                        resolved_orgs.append(matches[0].name)
                    else:
                        pending_orgs.append(text)
                frame.orgs = list(dict.fromkeys(resolved_orgs))
                if frame.options.get("organization_scope"):
                    frame = self._merge_code_detected_entities(
                        frame, question=question, matches=resolution.matches,
                        organizations=organizations,
                        organization_aliases=config.organization_aliases,
                    )
                    if frame.dimensions and "dimensions" not in frame.changes:
                        frame.changes["dimensions"] = "replace"
                if pending_orgs:
                    frame.missing.append("orgs")
                    frame.options["organization_clarification_items"] = [
                        {"id": f"orgs.{index}", "raw_text": text}
                        for index, text in enumerate(pending_orgs)]
                elif frame.orgs:
                    frame.missing = [field for field in frame.missing if field != "orgs"]
            else:
                frame = self._merge_code_detected_entities(
                    frame, question=question, matches=resolution.matches,
                    organizations=organizations, organization_aliases=config.organization_aliases,
                )
                if resolution.matches:
                    frame.raw_metric_texts = list(dict.fromkeys(
                        [*frame.raw_metric_texts, *(item.name for item in resolution.matches)]))
            # 引用变更中的指标也走正式目录匹配；未提指标的省略句不做残句兜底。
            candidates = []
            if reference_context.get("change_field") == "compose":
                phrases = frame.raw_metric_texts or (
                    [frame.raw_metric_text] if frame.raw_metric_text else []
                )
                if phrases:
                    selected = []
                    pending = []
                    for index, phrase in enumerate(phrases):
                        phrase = next(
                            (item.name for item in metrics if item.code == phrase), phrase
                        )
                        match = matcher.resolve(phrase)
                        decision = self._resolve_metrics(
                            phrase, question_metric_text=phrase, metrics=metrics,
                            matcher=matcher, organization_terms=[],
                            deterministic_matches=match.matches,
                            ambiguous_candidates=match.ambiguous_candidates, config=config,
                            timings_ms=timings_ms, debug=debug,
                        )
                        selected.extend(decision.selected)
                        candidates.extend(decision.candidates)
                        if not decision.selected:
                            pending.append({"id": f"metrics.{index}", "raw_text": phrase,
                                            "options": [item.model_dump(mode="json")
                                                        for item in decision.candidates]})
                    frame.metrics = [
                        MetricSlot(code=item.code, name=item.name)
                        for item in deduplicate_metrics(selected)
                    ]
                    if pending:
                        frame.missing.append("metrics")
                        frame.options["metric_clarification_items"] = pending
                    else:
                        frame.missing = [item for item in frame.missing if item != "metrics"]
                # 用户明确提到的新实体不得因模型漏字段而退回旧实体查询。
                # 来源已有实体可能只是“保留”的说明，不强行加入移除/追加列表。
                source_slots = SlotFrame.model_validate(reference_context["source_slots"])
                covered_orgs = set(source_slots.orgs) | set(frame.orgs)
                omitted_orgs = [item for item in organizations
                                if item.code in resolved_org_codes
                                and item.name not in covered_orgs]
                covered_metrics = {item.code for item in [*source_slots.metrics, *frame.metrics]}
                omitted_metrics = [item for item in resolution.matches
                                   if item.code not in covered_metrics]
                if omitted_orgs or omitted_metrics:
                    raise InvalidSlotFrameError([{
                        "field": "changes", "code": "explicit_entity_omitted",
                        "message": "本轮明确实体未被修改清单覆盖，禁止沿用旧实体执行",
                    }])
            if reference_context.get("change_field") == "compose":
                # 与来源完全相同且未声明修改的回填是空操作，规范化为继承；不同值不猜动作。
                source_slots = SlotFrame.model_validate(reference_context["source_slots"])
                for field in ("metrics", "orgs", "time", "ops", "filters", "dimensions"):
                    if (field not in frame.changes
                            and getattr(frame, field) == getattr(source_slots, field)):
                        setattr(frame, field, None if field == "time" else [])
                try:
                    validate_change_map(frame)
                except ReferenceMergeUnsupported as exc:
                    # 只纠正动作映射一次。已提取的实体、日期、操作被冻结，不重复提槽。
                    missing_actions = {
                        field
                        for field in ("metrics", "orgs", "time", "ops", "filters", "dimensions")
                        if getattr(frame, field) and field not in frame.changes
                    }
                    if ((frame.raw_metric_text or frame.raw_metric_texts)
                            and "metrics" not in frame.changes):
                        missing_actions.add("metrics")
                    repair_started = perf_counter()
                    repaired = self.model_service.analyze(
                        prompt="reference_change_map",
                        context={"question": protected_question,
                                 "source_json": _json(reference_context),
                                 "delta_json": _json(frame.model_dump(mode="json")),
                                 "error": str(exc)},
                    )
                    timings_ms["change_map_repair_ms"] = _elapsed_ms(repair_started)
                    debug["change_map_repair"] = {"attempts": 1, "initial_error": str(exc)}
                    try:
                        additions = SlotFrame.model_validate(
                            {"changes": repaired["changes"]}
                        ).changes
                        if set(additions) - set(frame.changes) - missing_actions:
                            raise ReferenceMergeUnsupported("纠正只能补齐缺失的字段动作")
                        if any(key in frame.changes and frame.changes[key] != value
                               for key, value in additions.items()):
                            raise ReferenceMergeUnsupported("纠正不能改变已声明的字段动作")
                        frame.changes = {**frame.changes, **additions}
                        validate_change_map(frame)
                    except (
                        ReferenceMergeUnsupported, ValidationError, KeyError, TypeError
                    ) as invalid:
                        raise InvalidSlotFrameError([{
                            "field": "changes", "code": "inconsistent_change_map",
                            "message": str(invalid),
                        }]) from invalid
            frame = normalize_slot_frame(frame, metrics=metrics, organizations=organizations)
            timings_ms["semantic_normalization_ms"] = _elapsed_ms(normalization_started)
            timings_ms["semantic_total_ms"] = _elapsed_ms(total_started)
            debug["mode"] = "reference_delta"
            return SemanticAnalysis(
                frame,
                resolution.matches,
                candidates,
                protected_question,
                timings_ms,
                {**debug, "slot_frame": frame.model_dump(mode="json")},
            )
        # 未知指标短语须由模型从原文提取。没有指标时保持缺项，不能把删去日期/机构
        # 后的残句当成指标；已命中目录的多指标完整性仍由下方残余检查保护。
        model_metric_texts = frame.raw_metric_texts or (
            [frame.raw_metric_text] if frame.raw_metric_text else []
        )
        validated_model_metric_texts = [
            text
            for text in model_metric_texts
            if not _is_operation_only_metric_text(text, matcher)
        ]
        metric_texts = validated_model_metric_texts
        if resolution.matches:
            # 已命中的正式实体属于原文事实，模型不能把占位符改写成另一组指标。
            # 只在实体之外继续识别未命中的原文，完整保留多指标请求的覆盖范围。
            residual = _outside_metric_text(question, resolution.matches)
            extended_org_terms = [
                *organization_terms,
                *[term + "行" for term in organization_terms if term.endswith("农商")],
            ]
            unresolved = _extract_requested_metric_texts(
                residual, organization_terms=extended_org_terms
            )
            unresolved = [
                text for text in unresolved if not _is_operation_only_metric_text(text, matcher)
            ]
            grounded_model = [
                text
                for text in validated_model_metric_texts
                if normalize_semantic_text(text) in normalize_semantic_text(residual)
            ]
            metric_texts = [match.name for match in resolution.matches] + (
                grounded_model or (
                    [] if any(op.type == "availability" for op in frame.ops) else unresolved
                )
            )
        frame.raw_metric_texts = list(dict.fromkeys(metric_texts))
        frame.raw_metric_text = (
            "、".join(frame.raw_metric_texts)
            if frame.raw_metric_texts
            else None
        )
        metric_search_text = "、".join(frame.raw_metric_texts) or frame.raw_metric_text
        pending_metric_items: list[dict[str, Any]] = []
        if len(frame.raw_metric_texts) > 1:
            phrase_decisions = []
            selected_metrics: list[MetricCatalogItem] = []
            candidate_metrics: list[MetricCatalogItem] = []
            scored_candidates: list[_ScoredMetricCandidate] = []
            unresolved_metric_items: list[tuple[dict[str, Any], bool]] = []
            for index, phrase in enumerate(frame.raw_metric_texts):
                phrase_resolution = matcher.resolve(phrase)
                phrase_decision = self._resolve_metrics(
                    phrase,
                    question_metric_text=phrase,
                    metrics=metrics,
                    matcher=matcher,
                    organization_terms=[],
                    deterministic_matches=phrase_resolution.matches,
                    ambiguous_candidates=phrase_resolution.ambiguous_candidates,
                    config=config,
                    timings_ms=timings_ms,
                    debug=debug,
                )
                phrase_decisions.append({
                    "raw_text": phrase,
                    "mode": phrase_decision.mode,
                    "selected": [item.code for item in phrase_decision.selected],
                    "candidates": [item.code for item in phrase_decision.candidates],
                })
                selected_metrics.extend(phrase_decision.selected)
                candidate_metrics.extend(phrase_decision.candidates)
                scored_candidates.extend(phrase_decision.scored_candidates)
                if not phrase_decision.selected:
                    scores = {
                        item.item.code: item.score
                        for item in phrase_decision.scored_candidates
                    }
                    lexical_evidence = _lexical_metric_candidates(
                        phrase,
                        metrics,
                        limit=1,
                    )
                    unresolved_metric_items.append(
                        (
                            {
                                "id": f"metrics.{index}",
                                "raw_text": phrase,
                                "options": [
                                    {
                                        "code": item.code,
                                        "name": item.name,
                                        "kind": "metric",
                                        **(
                                            {"score": round(scores[item.code], 4)}
                                            if item.code in scores
                                            else {}
                                        ),
                                    }
                                    for item in phrase_decision.candidates
                                ],
                            },
                            bool(
                                phrase_resolution.ambiguous_candidates
                                or lexical_evidence
                            ),
                        )
                    )
            pending_metric_items = [item for item, has_metric_evidence in unresolved_metric_items]
            decision = _MetricDecision(
                deduplicate_metrics(selected_metrics),
                deduplicate_metrics(candidate_metrics),
                _deduplicate_scored(scored_candidates),
                "phrase_list",
            )
            debug["metric_phrase_resolution"] = phrase_decisions
        else:
            decision = self._resolve_metrics(
                frame.raw_metric_text,
                question_metric_text=metric_search_text,
                metrics=metrics,
                matcher=matcher,
                organization_terms=organization_terms,
                deterministic_matches=resolution.matches,
                ambiguous_candidates=resolution.ambiguous_candidates,
                config=config,
                timings_ms=timings_ms,
                debug=debug,
            )
        if (
            not decision.selected
            and decision.mode == "fuzzy_clarification"
            and any(op.type == "period_compare" and op.method == "custom" for op in frame.ops)
        ):
            # An explicit two-date comparison may use an abbreviated metric name.
            # Let the model distinguish the base measure from official growth
            # indicators; it can select only from the recalled catalog candidates.
            selection_started = perf_counter()
            raw_selection = self.model_service.analyze(
                prompt="comparison_metric_selection",
                context={
                    "question": question,
                    "metric_phrase": frame.raw_metric_text or "",
                    "candidates_json": _json([item.model_dump() for item in decision.candidates]),
                },
            )
            timings_ms["comparison_metric_selection_ms"] = _elapsed_ms(selection_started)
            debug["comparison_metric_selection"] = raw_selection
            selected = next(
                (
                    item for item in decision.candidates
                    if item.code == raw_selection.get("metric_code")
                ),
                None,
            )
            if selected is not None and sum(
                item.name == selected.name for item in metrics
            ) == 1:
                decision = _MetricDecision(
                    [selected], decision.candidates, decision.scored_candidates,
                    "model_comparison_metric_selected",
                )
        frame.metrics = [
            MetricSlot(code=item.code, name=item.name) for item in decision.selected
        ]
        if pending_metric_items:
            frame.options["metric_clarification_items"] = pending_metric_items
            frame.options["missing_metric_text"] = "、".join(
                item["raw_text"] for item in pending_metric_items
            )
            if "metrics" not in frame.missing:
                frame.missing.append("metrics")
        elif frame.metrics:
            frame.options.pop("metric_clarification_items", None)
            frame.missing = [item for item in frame.missing if item != "metrics"]
        elif "metrics" not in frame.missing:
            frame.missing.append("metrics")
        candidates = decision.candidates
        debug["metric_resolution"] = {
            "raw_metric_text": frame.raw_metric_text,
            "raw_metric_texts": frame.raw_metric_texts,
            "mode": decision.mode,
            "selected": [
                {"code": item.code, "name": item.name} for item in decision.selected
            ],
            "candidates": [
                {"code": item.item.code, "name": item.item.name, "score": item.score}
                for item in decision.scored_candidates
            ],
            "auto_select_threshold": config.metric_matching.auto_select_threshold,
            "auto_select_margin": config.metric_matching.auto_select_margin,
        }
        frame = self._complete_catalog_context(
            frame,
            question=question,
            organizations=organizations,
            organization_aliases=config.organization_aliases,
        )
        frame = self._merge_code_detected_entities(
            frame,
            question=question,
            matches=resolution.matches,
            organizations=organizations,
            organization_aliases=config.organization_aliases,
        )
        # 模型解释自然语言；固定日历缺项已在上方共用解析器处理，此处统一验证结果。
        model_time = frame.time
        if frame.time is None:
            debug["time_resolution"] = {
                "mode": "model_time_missing",
                "model_time": None,
                "selected_time": None,
            }
        else:
            try:
                parse_time_expression(frame.time, today=current_date)
            except (SemanticValidationError, ValueError):
                frame.time = None
                frame.options["missing_time_reason"] = "invalid_date"
                frame.options["invalid_time_expression"] = model_time
                if "time" not in frame.missing:
                    frame.missing.append("time")
                debug["time_resolution"] = {
                    "mode": "invalid_model_time_rejected",
                    "model_time": model_time,
                    "selected_time": None,
                }
            else:
                debug["time_resolution"] = {
                    "mode": "valid_model_time_preserved",
                    "model_time": model_time,
                    "selected_time": model_time,
                }
        # The model may discard an invalid date instead of returning it in `time`.
        # Preserve the user-visible reason so clarification targets the date first.
        time_expression = extract_time_expression(question)
        if frame.time is None and time_expression:
            try:
                parse_time_expression(time_expression, today=current_date)
            except (SemanticValidationError, ValueError):
                frame.time = None
                frame.options["missing_time_reason"] = "invalid_date"
                frame.options["invalid_time_expression"] = time_expression
                if "time" not in frame.missing:
                    frame.missing.append("time")
        frame = normalize_slot_frame(frame, metrics=metrics, organizations=organizations)
        timings_ms["semantic_normalization_ms"] = _elapsed_ms(normalization_started)
        timings_ms["semantic_total_ms"] = _elapsed_ms(total_started)
        return SemanticAnalysis(
            frame,
            resolution.matches,
            candidates,
            protected_question,
            timings_ms,
            {
                **debug,
                "slot_frame": frame.model_dump(mode="json"),
                "metric_matches": [
                    item.model_dump(mode="json") for item in resolution.matches
                ],
            },
        )

    def _resolve_metrics(
        self,
        raw_metric_text: str | None,
        *,
        question_metric_text: str | None,
        metrics: list[MetricCatalogItem],
        matcher: MetricMatcher,
        organization_terms: list[str],
        deterministic_matches: list[MetricMatch],
        ambiguous_candidates: list[MetricCatalogItem],
        config: SemanticConfig,
        timings_ms: dict[str, int],
        debug: dict[str, Any],
    ) -> _MetricDecision:
        by_code = {item.code: item for item in metrics}
        if len(deterministic_matches) > 1 and not ambiguous_candidates:
            selected = deduplicate_metrics(
                [by_code[match.code] for match in deterministic_matches]
            )
            return _MetricDecision(selected, selected, [], "exact_multiple")
        if (
            len(deterministic_matches) == 1
            and not ambiguous_candidates
        ):
            selected = [by_code[deterministic_matches[0].code]]
            return _MetricDecision(
                selected,
                selected,
                [],
                "exact_question_longest_match",
            )
        if ambiguous_candidates:
            candidates = deduplicate_metrics(ambiguous_candidates)[
                : config.metric_matching.max_candidates
            ]
            return _MetricDecision([], candidates, [], "exact_ambiguous")
        if raw_metric_text:
            exact = matcher.exact_candidates(raw_metric_text)
            if len(exact) == 1:
                return _MetricDecision(exact, exact, [], "exact_raw_metric_text")
            if len(exact) > 1:
                candidates = exact[: config.metric_matching.max_candidates]
                return _MetricDecision([], candidates, [], "exact_ambiguous")
        elif deterministic_matches and not ambiguous_candidates:
            selected = deduplicate_metrics(
                [by_code[match.code] for match in deterministic_matches]
            )
            return _MetricDecision(selected, selected, [], "exact_question_fallback")
        if not raw_metric_text or not metrics:
            return _MetricDecision([], [], [], "no_candidates")
        scored = self._fuzzy_candidates(
            question_metric_text or raw_metric_text,
            metrics=metrics,
            config=config,
            timings_ms=timings_ms,
            debug=debug,
        )
        candidates = [item.item for item in scored]
        if not scored:
            return _MetricDecision([], [], [], "no_candidates")
        top_score = scored[0].score
        runner_up_score = scored[1].score if len(scored) > 1 else None
        has_margin = (
            runner_up_score is None
            or top_score - runner_up_score >= config.metric_matching.auto_select_margin
        )
        if top_score >= config.metric_matching.auto_select_threshold and has_margin:
            return _MetricDecision(
                [scored[0].item],
                candidates,
                scored,
                "fuzzy_auto_selected",
            )
        return _MetricDecision([], candidates, scored, "fuzzy_clarification")

    def _fuzzy_candidates(
        self,
        question: str,
        *,
        metrics: list[MetricCatalogItem],
        config: SemanticConfig,
        timings_ms: dict[str, int],
        debug: dict[str, Any],
    ) -> list[_ScoredMetricCandidate]:
        lexical = _lexical_metric_candidates(
            question,
            metrics,
            limit=config.metric_matching.max_candidates,
        )
        if not self._model_role_enabled("embedding"):
            debug["embedding"] = {"status": "disabled", "fallback": "lexical"}
            timings_ms["embedding_ms"] = 0
            return lexical
        if self.metric_candidate_search is not None:
            embedding_started = perf_counter()
            recalled = self.metric_candidate_search.search(
                question, limit=config.metric_matching.embedding_top_k
            )
            timings_ms["embedding_ms"] = _elapsed_ms(embedding_started)
            debug["embedding"] = {
                "input": {"question": question, "index": "configured_catalog_search"},
                "output": {"candidate_count": len(recalled)},
            }
            recalled = deduplicate_metrics([*recalled, *(item.item for item in lexical)])
            debug["embedding"]["output"]["lexical_candidate_count"] = len(lexical)
            reranked = self._rerank_candidates(
                question,
                recalled,
                config=config,
                timings_ms=timings_ms,
                debug=debug,
            )
            return _merge_scored_metric_candidates(
                reranked,
                lexical,
                limit=config.metric_matching.max_candidates,
            )
        corpus = catalog_embedding_texts(metrics)
        embedding_started = perf_counter()
        vectors = self.catalog_vector_cache.embed(
            self.model_service, question, corpus,
            batch_size=config.metric_matching.embedding_batch_size,
            wait_seconds=config.metric_matching.embedding_cache_wait_seconds,
        )
        timings_ms["embedding_ms"] = _elapsed_ms(embedding_started)
        debug["embedding"] = {
            "input": {"question": question, "document_count": len(corpus)},
            "output": {
                "vector_count": len(vectors),
                "dimensions": len(vectors[0]) if vectors else 0,
            },
        }
        if len(vectors) != len(corpus) + 1:
            return []
        # 只把当前问题向量转成 tuple，供所有余弦计算复用；目录矩阵仍为 float32。
        # 范数是向量长度，提前计算可避免对一万个候选重复计算同一个问题的范数。
        query_vector = tuple(vectors[0])
        query_norm = math.sqrt(sum(value * value for value in query_vector))
        # zip 按顺序配对“指标、向量”；strict=True 在数量不一致时直接报错。
        # lambda item: -item[1] 返回负相似度，令默认升序排序变成按相似度降序。
        # 最后的切片 [:top_k] 只保留召回上限，不代表这些指标都能自动确认。
        scored = sorted(
            ((item, _cosine(query_vector, vector, left_norm=query_norm))
             for item, vector in zip(metrics, vectors[1:], strict=True)),
            key=lambda item: -item[1],
        )[: config.metric_matching.embedding_top_k]
        recalled = [item for item, _ in scored]
        if not self._model_role_enabled("reranker"):
            debug["rerank"] = {"status": "disabled", "fallback": "embedding"}
            timings_ms["rerank_ms"] = 0
            return [
                _ScoredMetricCandidate(item, score) for item, score in scored
            ][: config.metric_matching.max_candidates]
        return self._rerank_candidates(
            question,
            recalled,
            config=config,
            timings_ms=timings_ms,
            debug=debug,
        )

    def _rerank_candidates(
        self,
        question: str,
        recalled: list[MetricCatalogItem],
        *,
        config: SemanticConfig,
        timings_ms: dict[str, int],
        debug: dict[str, Any],
    ) -> list[_ScoredMetricCandidate]:
        if not recalled:
            return []
        if not self._model_role_enabled("reranker"):
            debug["rerank"] = {"status": "disabled"}
            timings_ms["rerank_ms"] = 0
            return []
        rerank_started = perf_counter()
        reranked = self.model_service.rerank(
            query=question,
            documents=[f"{item.name} {' '.join(item.aliases)}" for item in recalled],
            top_n=min(config.metric_matching.rerank_top_k, len(recalled)),
        )
        timings_ms["rerank_ms"] = _elapsed_ms(rerank_started)
        debug["rerank"] = {
            "input": {"query": question, "documents": [item.name for item in recalled]},
            "output": reranked,
        }
        scored_by_code: dict[str, _ScoredMetricCandidate] = {}
        for result in reranked:
            if not isinstance(result, dict):
                continue
            index = result.get("index")
            if not isinstance(index, int) or not 0 <= index < len(recalled):
                continue
            try:
                score = float(result.get("relevance_score", 0))
            except (TypeError, ValueError):
                continue
            if score < config.metric_matching.similarity_threshold:
                continue
            item = recalled[index]
            existing = scored_by_code.get(item.code)
            if existing is None or score > existing.score:
                scored_by_code[item.code] = _ScoredMetricCandidate(item, score)
        return sorted(
            scored_by_code.values(),
            key=lambda item: (-item.score, item.item.code),
        )[: config.metric_matching.max_candidates]

    def _model_role_enabled(self, role: str) -> bool:
        checker = getattr(self.model_service, "is_enabled", None)
        return bool(checker(role)) if callable(checker) else True

    @staticmethod
    def _complete_catalog_context(
        frame: SlotFrame,
        *,
        question: str,
        organizations: list[OrganizationCatalogItem],
        organization_aliases: dict[str, list[str]],
    ) -> SlotFrame:
        if not frame.metrics:
            organization_terms = [
                term
                for organization in organizations
                for term in [
                    organization.name,
                    *organization.aliases,
                    *organization_aliases.get(organization.name, []),
                ]
            ]
            missing_metric_text = _extract_requested_metric_text(
                question,
                organization_terms=organization_terms,
            ) or frame.raw_metric_text
            if missing_metric_text:
                frame.options["missing_metric_text"] = missing_metric_text
        # Language interpretation belongs to the model. Keyword lists must not
        # delete, add or rewrite operations, dates or time modes. Catalog entities
        # are protected before inference; capability checks happen in the planner.
        return frame

    @staticmethod
    def _merge_code_detected_entities(
        frame: SlotFrame,
        *,
        question: str,
        matches: list[MetricMatch],
        organizations: list[OrganizationCatalogItem],
        organization_aliases: dict[str, list[str]],
    ) -> SlotFrame:
        model_organizations = list(frame.orgs)
        catalog_residual = _outside_metric_text(question, matches)
        requests_all_organizations = _requests_synchronized_organization_scope(
            frame.options.get("organization_scope")
        )
        if requests_all_organizations:
            # 模型选择集合语义，代码核对其原文依据。裸范围标记不能扩大查询；
            # 同时要求补充机构的矛盾响应也必须澄清，不能在展开目录后消掉 missing。
            scope_text = frame.options.get("organization_scope_text")
            protected = _protect_resolved_entities(
                question, metric_matches=matches, organizations=organizations,
                organization_aliases=organization_aliases,
            )
            invalid_missing = set(frame.missing) - {"metrics", "time", "dimensions", "ops"}
            grounded_scope = (
                isinstance(scope_text, str) and bool(scope_text.strip())
                and scope_text == scope_text.strip() and scope_text in protected
                and "<" not in scope_text and ">" not in scope_text
            )
            # 范围文字已通过原文逐字核对时，模型矛盾地多报 missing orgs 按噪声丢弃：
            # 展开目标始终是同步目录而非模型生成的机构，安全网不变；其余矛盾照旧澄清。
            if grounded_scope and not model_organizations and invalid_missing == {"orgs"}:
                frame.missing = [item for item in frame.missing if item != "orgs"]
                invalid_missing = set()
            if not grounded_scope or invalid_missing or model_organizations:
                frame.orgs = []
                for key in ("organization_scope", "organization_scope_text",
                            "organization_scope_count"):
                    frame.options.pop(key, None)
                frame.options["missing_org_reason"] = "scope_unconfirmed"
                if "orgs" not in frame.missing:
                    frame.missing.append("orgs")
                return frame
        if requests_all_organizations:
            # The enabled organization catalog is synchronized from the governed
            # 61-organization source query.  Its membership is authoritative; never
            # infer this scope from organization-name prefixes or suffixes.
            frame.orgs = [item.name for item in organizations]
            frame.options["organization_scope"] = "synchronized_catalog"
            frame.options["organization_scope_count"] = len(organizations)
            if not any(dimension in {"org", "机构"} for dimension in frame.dimensions):
                frame.dimensions.append("org")
        else:
            frame.options.pop("organization_scope", None)
            frame.options.pop("organization_scope_count", None)
            detected_orgs = []
            searchable = re.sub(
                r"^(?:请|帮我|麻烦)?(?:查询|查一下|查)?",
                "",
                catalog_residual.strip(),
            )
            for item in organizations:
                terms = sorted(
                    [item.name, *item.aliases, *organization_aliases.get(item.name, [])],
                    key=len,
                    reverse=True,
                )
                if any(term and term in searchable for term in terms):
                    detected_orgs.append(item.name)
            frame.orgs = detected_orgs
        known_organization_terms = [
            term
            for item in organizations
            for term in [
                item.name,
                *item.aliases,
                *organization_aliases.get(item.name, []),
            ]
            if term
        ]
        unknown_organization_residual = catalog_residual
        for term in sorted(set(known_organization_terms), key=len, reverse=True):
            unknown_organization_residual = unknown_organization_residual.replace(
                term,
                " " * len(term),
            )
        organization_mentions = (
            []
            if requests_all_organizations or frame.orgs
            else _extract_organization_mentions(unknown_organization_residual)
        )
        normalized_known_organization_terms = {
            normalize_semantic_text(term) for term in known_organization_terms
        }
        unknown_mentions = [
            mention
            for mention in organization_mentions
            if normalize_semantic_text(mention)
            not in normalized_known_organization_terms
        ]
        if not unknown_mentions and not frame.orgs:
            unknown_mentions = [
                item.strip()
                for item in model_organizations
                if item.strip()
                and normalize_semantic_text(item)
                not in normalized_known_organization_terms
            ]
        if unknown_mentions:
            frame.options["missing_org_reason"] = "alias_not_found"
            frame.options["missing_org_text"] = unknown_mentions[0]
            frame.options["missing_org_texts"] = unknown_mentions
            frame.options["organization_clarification_items"] = [
                {"id": f"orgs.{index}", "raw_text": item}
                for index, item in enumerate(unknown_mentions)
            ]
            if "orgs" not in frame.missing:
                frame.missing.append("orgs")
        elif frame.orgs:
            frame.missing = [item for item in frame.missing if item != "orgs"]
            for key in (
                "missing_org_reason",
                "missing_org_text",
                "missing_org_texts",
                "organization_clarification_items",
            ):
                frame.options.pop(key, None)
        return frame


def _outside_metric_text(
    question: str,
    matches: list[MetricMatch],
    *,
    raw_metric_text: str | None = None,
    raw_metric_texts: list[str] | None = None,
) -> str:
    characters = list(question)
    for match in matches:
        characters[match.start : match.end] = [" "] * (match.end - match.start)
    protected_raw_texts = [raw_metric_text, *(raw_metric_texts or [])]
    for protected_text in dict.fromkeys(item for item in protected_raw_texts if item):
        start = 0
        while True:
            position = question.find(protected_text, start)
            if position < 0:
                break
            end = position + len(protected_text)
            characters[position:end] = [" "] * len(protected_text)
            start = end
    return "".join(characters)


def _protect_resolved_entities(
    question: str,
    *,
    metric_matches: list[MetricMatch],
    organizations: list[OrganizationCatalogItem],
    organization_aliases: dict[str, list[str]],
    ambiguous_metric_spans: list[tuple[int, int]] | None = None,
    resolved_org_codes: list[str] | None = None,
) -> str:
    """Replace confirmed entity spans with opaque, self-closing placeholders."""

    spans: list[tuple[int, int, str]] = [
        (match.start, match.end, f'<METRIC code="{match.code}"/>')
        for match in metric_matches
    ]
    # 完整歧义别名内的“同比/排名”等同样属于实体文字。保留候选供澄清，
    # 不向模型暴露名称内部的操作词，也不伪造一个已选中的指标编码。
    for start, end in sorted(
        ambiguous_metric_spans or [], key=lambda span: -(span[1] - span[0])
    ):
        if not any(start < right and end > left for left, right, _ in spans):
            spans.append((start, end, '<METRIC unresolved="true"/>'))
    occupied = [(start, end) for start, end, _ in spans]

    term_owners: dict[str, list[OrganizationCatalogItem]] = {}
    for organization in organizations:
        for term in dict.fromkeys(
            [
                organization.name,
                *organization.aliases,
                *organization_aliases.get(organization.name, []),
            ]
        ):
            normalized = term.strip()
            if normalized:
                term_owners.setdefault(normalized, []).append(organization)

    candidates: list[tuple[int, int, str]] = []
    for term, owners in term_owners.items():
        unique_owners = {item.code: item for item in owners}
        if len(unique_owners) != 1:
            # Leave ambiguous aliases visible so the normal clarification path
            # can resolve them instead of silently selecting a catalog row.
            continue
        organization = next(iter(unique_owners.values()))
        search_start = 0
        while True:
            position = question.find(term, search_start)
            if position < 0:
                break
            end = position + len(term)
            if term.endswith("农商") and question[end : end + 1] == "行":
                end += 1
            candidates.append((position, end, organization.code))
            search_start = end

    for start, end, code in sorted(
        candidates,
        key=lambda item: (-(item[1] - item[0]), item[0]),
    ):
        if any(start < right and end > left for left, right in occupied):
            continue
        spans.append((start, end, f'<ORG code="{code}"/>'))
        occupied.append((start, end))
        if resolved_org_codes is not None:
            resolved_org_codes.append(code)

    output: list[str] = []
    cursor = 0
    for start, end, placeholder in sorted(spans, key=lambda item: item[0]):
        if start < cursor:
            continue
        output.append(question[cursor:start])
        output.append(placeholder)
        cursor = end
    output.append(question[cursor:])
    return "".join(output)


def _normalize_calendar_text(text: str) -> str:
    """统一日期词内部的排版空白；不拼接数字片段，也不删除一般文本分隔。"""
    number = r"0-9零〇一二两三四五六七八九十"
    text = re.sub(rf"(?<=[{number}])\s+(?=[年月日])", "", text)
    text = re.sub(rf"(?<=[年月])\s+(?=[{number}])", "", text)
    text = re.sub(r"(?<=月)\s+(?=[份末底])", "", text)
    # 提取和从原句剥离日期共用相同写法，避免“月份”残留为待识别指标。
    return re.sub(
        rf"({_CALENDAR_MONTH_TOKEN}月)份?(底)?",
        lambda match: match.group(1) + ("末" if match.group(2) else ""),
        text,
    )


def extract_time_expression(text: str) -> str | None:
    text = _normalize_calendar_text(text)
    fixed_holiday = re.search(
        r"(?:(\d{4})年)?(双十一|双十二|元旦|国庆)(?:当天|当日)?",
        text,
    )
    if fixed_holiday:
        year, holiday = fixed_holiday.groups()
        return f"{year}年{holiday}" if year else holiday
    chinese_day_range = re.search(
        r"(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:至|到|~|～)\s*"
        r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日",
        text,
    )
    if chinese_day_range:
        year, month, day, end_year, end_month, end_day = chinese_day_range.groups()
        return (
            f"{int(year):04d}-{int(month):02d}-{int(day):02d}至"
            f"{int(end_year or year):04d}-{int(end_month):02d}-{int(end_day):02d}"
        )
    numeric_range = re.search(
        r"(?<!\d)(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})"
        r"\s*(?:至|到|~|～)\s*"
        r"(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)",
        text,
    )
    if numeric_range:
        year, month, day, end_year, end_month, end_day = numeric_range.groups()
        return (
            f"{int(year):04d}-{int(month):02d}-{int(day):02d}至"
            f"{int(end_year):04d}-{int(end_month):02d}-{int(end_day):02d}"
        )
    chinese_month_range = re.search(
        rf"(\d{{4}})年({_CALENDAR_MONTH_TOKEN})月份?(?:末|底)?\s*"
        rf"(?:至|到|~|～)\s*"
        rf"(?:(\d{{4}})年)?({_CALENDAR_MONTH_TOKEN})月份?(?:末|底)?",
        text,
    )
    if chinese_month_range:
        start_year, start_month, end_year, end_month = chinese_month_range.groups()
        return (
            f"{start_year}年{start_month}月至"
            f"{end_year + '年' if end_year else ''}{end_month}月"
        )
    numeric_date = re.search(
        r"(?<!\d)(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)",
        text,
    )
    if numeric_date:
        year, month, day = numeric_date.groups()
        return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    patterns = [
        r"\d{4}年\d{1,2}月份?\d{1,2}日",
        rf"(?:今年|去年|上年|前年){_CALENDAR_MONTH_TOKEN}月份?(?:末|底)?",
        rf"\d+年前{_CALENDAR_MONTH_TOKEN}月份?末?",
        rf"\d{{4}}年{_CALENDAR_MONTH_TOKEN}月末(?:较|比|对比|比较)"
        rf"{_CALENDAR_MONTH_TOKEN}月末",
        rf"\d{{4}}年{_CALENDAR_MONTH_TOKEN}月份?至{_CALENDAR_MONTH_TOKEN}月份?",
        rf"\d{{4}}年{_CALENDAR_MONTH_TOKEN}月份?(?:末|底)?",
        r"\d{1,2}月份?\d{1,2}日",
        rf"{_CALENDAR_MONTH_TOKEN}月份?(?:末|底)",
        rf"{_CALENDAR_MONTH_TOKEN}月份?",
        r"近\s*\d+\s*天",
        r"近\s*(?:\d+|[一二两三四五六七八九十]+)\s*个?月",
        r"(?:(?:\d{4}年|今年|本年))?(?:第)?[一二三四1-4]季度",
        r"本季度|本季|上季度|上季|今年|本年|去年|上年|前年",
        r"本月|上个月|上月|今天|今日|昨天",
        r"当前最新|最新一期|最近一期|最新|最近",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            # A partial match at the start of an unsupported range must never
            # override a complete, validated time range returned by the model.
            if re.match(r"\s*(?:至|到|~|～|-)\s*", text[match.end() :]):
                continue
            if match.group(0) in {"今年", "本年", "去年", "上年"} and re.match(
                r"\s*的?\s*(?:春节|清明节?|端午节?|中秋节?|劳动节|国庆节?)",
                text[match.end() :],
            ):
                # The year token qualifies a natural holiday. Returning only
                # “今年” would overwrite the model's correctly normalized
                # holiday dates with an entire year-to-date range.
                continue
            return match.group(0).replace("月份", "月").replace("月底", "月末")
    return None


def _requests_synchronized_organization_scope(model_scope: Any) -> bool:
    # Group-language interpretation belongs to the model.  This boundary only
    # accepts a controlled scope identifier that the backend knows how to expand.
    if isinstance(model_scope, str) and model_scope in {
        "synchronized_catalog",
        "all_rural_commercial_banks",
        "rural_commercial_banks",
    }:
        return True
    if isinstance(model_scope, dict):
        scope_type = str(model_scope.get("type") or "").casefold()
        group = str(model_scope.get("group") or "").casefold()
        if scope_type in {"group", "organization_group"} and group in {
            "rural_commercial_banks",
            "synchronized_catalog",
        }:
            return True
    return False


def _extract_organization_mentions(text: str) -> list[str]:
    text = _normalize_calendar_text(text)
    time_expression = extract_time_expression(text)
    if time_expression:
        text = text.replace(time_expression, " ", 1)
    mentions = []
    for segment in re.split(r"\s*(?:、|，|,|；|;|以及|并且|和|与)\s*", text):
        match = re.search(
            r"[一-鿿]{2,}?(?:农村商业银行|农商银行|农商行|银行|农信|联社)",
            segment,
        )
        if not match:
            continue
        value = re.sub(
            r"^(?:请|帮我|麻烦|查询|查一下|查)+",
            "",
            match.group(0),
        ).strip()
        value = re.sub(r"^(?:各家|各|所有|全部)", "", value).strip()
        if value in {"农商行", "农商银行", "农村商业银行", "银行", "农信", "联社"}:
            continue
        if value and value not in mentions:
            mentions.append(value)
    return mentions


def _lexical_metric_candidates(
    question: str,
    metrics: list[MetricCatalogItem],
    *,
    limit: int,
) -> list[_ScoredMetricCandidate]:
    normalized_question = normalize_semantic_text(question)
    if not normalized_question:
        return []
    scored: list[tuple[float, str, MetricCatalogItem]] = []
    for item in metrics:
        terms = [item.name, *item.aliases]
        score = max(
            (
                SequenceMatcher(
                    None,
                    normalized_question,
                    normalize_semantic_text(term),
                ).ratio()
                for term in terms
                if normalize_semantic_text(term)
            ),
            default=0.0,
        )
        if score >= 0.55:
            scored.append((score, item.code, item))
    scored.sort(key=lambda value: (-value[0], value[1]))
    return [
        _ScoredMetricCandidate(item=item, score=score)
        for score, _, item in scored[:limit]
    ]


def _merge_scored_metric_candidates(
    *groups: list[_ScoredMetricCandidate],
    limit: int,
) -> list[_ScoredMetricCandidate]:
    by_code: dict[str, _ScoredMetricCandidate] = {}
    for group in groups:
        for candidate in group:
            existing = by_code.get(candidate.item.code)
            if existing is None or candidate.score > existing.score:
                by_code[candidate.item.code] = candidate
    return sorted(
        by_code.values(),
        key=lambda item: (-item.score, item.item.code),
    )[:limit]


def _extract_requested_metric_text(
    text: str,
    *,
    organization_terms: list[str] | None = None,
) -> str | None:
    value = _normalize_calendar_text(text).strip()
    calendar_prefix = r"(?:(?:今年|本年|去年|上年|前年|\d{4}年|\d+年前))?"
    value = re.sub(
        rf"{calendar_prefix}{_CALENDAR_MONTH_TOKEN}月\d{{1,2}}日",
        " ",
        value,
    )
    value = re.sub(
        rf"{calendar_prefix}{_CALENDAR_MONTH_TOKEN}月(?:末|底)",
        " ",
        value,
    )
    value = re.sub(
        rf"{calendar_prefix}(?:第)?[一二三四1-4]季度",
        " ",
        value,
    )
    # Parallel time windows can contain the same conjunctions used by metric lists.
    # Remove every explicit time expression before deciding whether metrics are parallel.
    for _ in range(12):
        time_expression = extract_time_expression(value)
        if not time_expression or time_expression not in value:
            break
        value = value.replace(time_expression, "", 1)
    value = re.sub(
        r"(?<!\d)\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}(?!\d)",
        "",
        value,
    )
    value = re.sub(r"^(?:请|帮我|麻烦)?(?:查询|查一下|查)?", "", value).strip()
    value = re.sub(r"^(?:对比|比较|对照)(?:一下)?", "", value).strip()
    for term in sorted(set(organization_terms or []), key=len, reverse=True):
        if term:
            value = value.replace(term, " ")
    value = " ".join(value.split())
    value = re.sub(
        r"^(?:(?:、|，|,|；|;|以及|并且|和|与)\s*)+",
        "",
        value,
    ).strip()
    value = re.sub(
        r"^[\u4e00-\u9fff]{2,}?(?:农商银行|农商行|农村商业银行|银行)",
        "",
        value,
        count=1,
    ).strip()
    value = re.sub(
        r"(?:排名)?前(?:\d+|[一二两三四五六七八九十]+)(?:名)?(?:的)?(?:机构|农商行)?$",
        "",
        value,
    ).strip()
    value = re.sub(r"(?:各|所有|全部)?(?:机构|农商行)(?:排名|排行)?$", "", value).strip()
    value = re.sub(
        r"(?:的)?(?:季度末值|季末值|期末值|月末值|年末值|季初值|期初值|月初值|年初值)"
        r"(?:是多少|多少|如何)?[？?]?$",
        "",
        value,
    ).strip()
    value = re.sub(
        r"(?:分别)?(?:是多少|有多少|多少|如何|是什么|情况怎样)[？?]?$",
        "",
        value,
    ).strip(" 。.，,、；;")
    return value or None


def explicit_catalog_references(
    question: str,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    organization_aliases: dict[str, list[str]],
) -> dict[str, set[str]]:
    """只返回原文明示且无歧义的目录实体；与语义解析共用最长名称保护规则。"""
    resolution = MetricMatcher(metrics).resolve(question)
    org_codes: list[str] = []
    _protect_resolved_entities(
        question,
        metric_matches=resolution.matches,
        organizations=organizations,
        organization_aliases=organization_aliases,
        resolved_org_codes=org_codes,
    )
    return {"orgs": set(org_codes), "metrics": {match.code for match in resolution.matches}}


def is_direct_catalog_query(
    question: str,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    organization_aliases: dict[str, list[str]],
    require_complete: bool = False,
) -> bool:
    resolution = MetricMatcher(metrics).resolve(question)
    if not resolution.matches or resolution.ambiguous_candidates:
        return False
    protected = _protect_resolved_entities(
        question,
        metric_matches=resolution.matches,
        organizations=organizations,
        organization_aliases=organization_aliases,
    )
    if require_complete and (
        '<ORG code="' not in protected or not extract_time_expression(protected)
    ):
        return False
    return _plain_catalog_value_question(protected)


def _plain_catalog_value_question(protected: str) -> bool:
    value = _normalize_calendar_text(re.sub(r"<(?:METRIC|ORG)\s[^>]*/>", " ", protected))
    for _ in range(12):
        expression = extract_time_expression(value)
        if not expression or expression not in value:
            break
        value = value.replace(expression, " ", 1)
    # 完整消耗输入才成立；比较、排名、明细、筛选等残留词均不能被删除或降级。
    return bool(
        re.fullmatch(
            r"(?:(?:请|帮我|麻烦|查询|查一下|查|的|和|与|以及|及|分别|是多少|有多少|多少|是什么)|[\s，,、。.?？：:；;])+",
            value,
        )
    )


def _extract_requested_metric_texts(
    text: str,
    *,
    organization_terms: list[str] | None = None,
) -> list[str]:
    """Split an explicit metric list without splitting ordinary metric names."""
    combined = _extract_requested_metric_text(
        text,
        organization_terms=organization_terms,
    )
    if not combined:
        return []
    if not re.search(r"、|，|,|；|;|以及|并且", combined):
        return [combined]
    parts = [
        re.sub(r"^(?:(?:以及|并且|和|与|至|到|~|～)\s*)+", "", item).strip(
            " ，,、；;"
        )
        for item in re.split(r"\s*(?:、|，|,|；|;|以及|并且)\s*", combined)
    ]
    return list(dict.fromkeys(item for item in parts if item))


def _is_operation_only_metric_text(text: str, matcher: MetricMatcher) -> bool:
    """Reject a model phrase that only names an operation, unless it is a catalog term."""
    if matcher.exact_candidates(text):
        return False
    return normalize_semantic_text(text) in {
        "对比",
        "比较",
        "对照",
        "差异",
        "趋势",
        "走势",
        "排名",
        "排行",
    }


def _cosine(
    left: Sequence[float], right: Sequence[float], *, left_norm: float | None = None,
) -> float:
    numerator = sum(a * b for a, b in zip(left, right, strict=False))
    if left_norm is None:
        left_norm = math.sqrt(sum(value * value for value in left))
    denominator = left_norm * math.sqrt(
        sum(value * value for value in right)
    )
    return numerator / denominator if denominator else 0


def _deduplicate_scored(
    items: list[_ScoredMetricCandidate],
) -> list[_ScoredMetricCandidate]:
    values: dict[str, _ScoredMetricCandidate] = {}
    for item in items:
        existing = values.get(item.item.code)
        if existing is None or item.score > existing.score:
            values[item.item.code] = item
    return sorted(values.values(), key=lambda item: (-item.score, item.item.code))


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))
