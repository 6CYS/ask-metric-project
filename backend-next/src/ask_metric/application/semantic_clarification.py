"""当前任务的目录确认后重新解析，模型调用在数据库工作单元之外完成。"""

import json
from datetime import date

from ask_metric.domain.intent_routing import RoutedIntent, parse_intent_classification
from ask_metric.domain.metric_matching import MetricMatcher, normalize_semantic_text
from ask_metric.domain.organization_matching import resolve_organizations
from ask_metric.domain.query_execution import QueryPlanError, explicit_selection_range
from ask_metric.domain.semantic_engine import SemanticEngine, prepare_model_question
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem, SlotFrame
from ask_metric.infrastructure.semantic.configuration import SemanticConfig


def review_clarification(
    before: SlotFrame,
    after: SlotFrame,
    text: str,
    *,
    engine: SemanticEngine,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    config: SemanticConfig,
    today: date,
) -> tuple[SlotFrame, bool]:
    # 待补日期时输入另一组完整实体属于新问题，不能只截取日期执行旧查询。
    typed_metrics = MetricMatcher(metrics).resolve(text).matches
    typed_orgs = resolve_organizations(text, organizations, config.organization_aliases).matches
    if (
        "metrics" not in before.missing
        and any(
            item.code not in {metric.code for metric in after.metrics} for item in typed_metrics
        )
    ) or (
        "orgs" not in before.missing
        and any(item.item.name not in after.orgs for item in typed_orgs)
    ):
        return after, True
    changed = (
        before.metrics != after.metrics
        or before.orgs != after.orgs
        or before.time != after.time
        or before.missing != after.missing
    )
    if not changed and text.strip():
        routing = engine.model_service.analyze(
            prompt="intent_routing",
            context={
                "question": prepare_model_question(text, metrics, organizations, config),
                "allowed_intents_json": json.dumps([item.value for item in RoutedIntent]),
            },
        )
        if parse_intent_classification(routing).intent is not RoutedIntent.METRIC_QUERY:
            return after, True
    if "metrics" not in before.missing or not after.metrics or before.metrics == after.metrics:
        return after, False
    source = before.options.get("semantic_source_question")
    if not isinstance(source, str):
        return after, False
    pending = before.options.get("metric_clarification_items") or []
    selected = [item for item in after.metrics if item not in before.metrics]
    replacements = []
    unbound = []
    for item in pending:
        phrase = item.get("raw_text", "")
        allowed = {option.get("code") for option in item.get("options", [])}
        candidates = [metric for metric in selected if metric.code in allowed]
        if len(pending) == 1 and len(selected) == 1:
            candidates = selected
        # 仅替换用户已确认且原文位置唯一的短语，避免跨项猜测绑定关系。
        if len(candidates) != 1 or not phrase or source.count(phrase) != 1:
            unbound.append(item)
            continue
        if (
            len(pending) > 1
            and sum(
                any(option.get("code") == candidates[0].code for option in other.get("options", []))
                for other in pending
            )
            > 1
        ):
            unbound.append(item)
            continue
        replacements.append((source.index(phrase), len(phrase), candidates[0].name))
    if not replacements and unbound:
        after.options["metric_clarification_items"] = unbound
        if "metrics" not in after.missing:
            after.missing.append("metrics")
        return after, False
    if not replacements:
        phrase = before.raw_metric_text
        if len(selected) != 1 or not phrase or source.count(phrase) != 1:
            return after, False
        replacements.append((source.index(phrase), len(phrase), selected[0].name))
    retained_requests = []
    for start, length, name in replacements:
        phrase = source[start : start + length]
        # 只允许确认名称补全原短语；若无法证明其为名称的一部分，保留整段
        # 原文再解析。这样错误抽取的长短语不会连同筛选、维度或第二项被删除。
        remaining = iter(normalize_semantic_text(name))
        if not all(character in remaining for character in normalize_semantic_text(phrase)):
            retained_requests.append(phrase)
    for quote in before.options.get("operation_evidence", []):
        if isinstance(quote, str) and any(
            quote in source[start : start + length] and quote not in name
            for start, length, name in replacements
        ):
            retained_requests.append(quote)
    for start, length, name in sorted(replacements, reverse=True):
        source = source[:start] + name + source[start + length :]
    # 模型可能将操作句混入待确认短语。确认指标不能顺带删除真实操作的原文。
    if retained_requests:
        source += "，" + "，".join(dict.fromkeys(retained_requests))
    if typed_metrics:
        # 补充回答也可能新增第二个尚未明确的指标，不能只取其中一个完整名称。
        source += "。" + text
    reviewed = engine.analyze(
        source, metrics=metrics, organizations=organizations, config=config, current_date=today
    ).slot_frame
    # 已确认条件归当前任务所有，重新解释操作不会覆盖用户补充的目录和日期。
    selected_metrics = {item.code: item for item in [*after.metrics, *reviewed.metrics]}
    reviewed.metrics = list(selected_metrics.values())
    reviewed.orgs = after.orgs or reviewed.orgs
    reviewed.time = after.time or reviewed.time
    # 指标确认只消除该实体内部的误判；已请求的维度和筛选不能随之被清空。
    reviewed.dimensions = list(dict.fromkeys([*before.dimensions, *reviewed.dimensions]))
    for condition in before.filters:
        if condition not in reviewed.filters:
            reviewed.filters.append(condition)
    for field in ("metrics", "orgs", "time"):
        if field == "metrics" and reviewed.options.get("metric_clarification_items"):
            continue
        if field == "time" and after.time is None and reviewed.time is not None:
            continue
        if field == "orgs" and not after.orgs and reviewed.orgs:
            continue
        reviewed.missing = [value for value in reviewed.missing if value != field]
        if field in after.missing:
            reviewed.missing.append(field)
    try:
        explicit_selection_range(after.options)
    except QueryPlanError:
        pass  # 旧的非法空数组不能覆盖本次模型复核后的日期。
    else:
        for key in ("target_dates", "time_windows", "time_mode"):
            if key in after.options:
                reviewed.options[key] = after.options[key]
    return reviewed, False
