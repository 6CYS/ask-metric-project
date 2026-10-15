"""跨轮状态变更准入：回放宿主规范化的 Pi 操作，不从自然语言关键词推断动作。"""

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, ValidationError

from ask_metric.application.field_resolution import (
    source_calendar_constraints,
    source_organization_codes,
)
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec, BasicQueryTime, QueryOperation
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


class SemanticChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: Literal[
        "metrics", "organizations", "comparison_organizations", "time", "selection", "operation"
    ]
    action: Literal["set", "add", "replace", "exclude", "clear", "confirm"]
    before: JsonValue
    after: JsonValue


class SemanticFieldSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: Literal["metrics", "organizations", "comparison_organizations", "time", "selection", "operation"]
    before: BasicQuerySpec
    source_semantic_receipt: str | None = Field(default=None, min_length=1, max_length=16000, repr=False)
    source_question: str | None = Field(default=None, min_length=1, max_length=8000)
    bindings: list[dict] = Field(default_factory=list, max_length=100)
    exclusions: list[dict] = Field(default_factory=list, max_length=100)


class SemanticTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    before: BasicQuerySpec
    source_question: str | None = Field(default=None, min_length=1, max_length=8000)
    source_semantic_receipt: str | None = Field(
        default=None, min_length=1, max_length=16000, repr=False
    )
    bindings: list[dict] = Field(default_factory=list, max_length=100)
    exclusions: list[dict] = Field(default_factory=list, max_length=100)
    changes: list[SemanticChange] = Field(max_length=100)
    field_sources: list[SemanticFieldSource] = Field(default_factory=list, max_length=100)


_COLLECTION_FIELDS = {"metrics", "organizations", "comparison_organizations"}
_OPERATION = TypeAdapter(QueryOperation)


def _fail(code: str, message: str) -> None:
    raise ApplicationError("TRANSITION_" + code, message, status_code=409)


def _canonical(field: str, value: JsonValue) -> JsonValue:
    if field in _COLLECTION_FIELDS:
        if (
            not isinstance(value, list)
            or any(not isinstance(code, str) or not code for code in value)
            or len(set(value)) != len(value)
        ):
            _fail("VALUE_INVALID", "状态变更集合必须是互不重复的目录身份。")
        return sorted(value)
    if value is None:
        return None
    try:
        if field == "time":
            return BasicQueryTime.model_validate(value).model_dump(mode="json", exclude_none=True)
        if field == "operation":
            return _OPERATION.validate_python(value).model_dump(mode="json", exclude_none=True)
        if field == "selection" and value in {"exact", "latest_in_range", "all_in_range"}:
            return value
    except (ValidationError, TypeError):
        pass
    _fail("VALUE_INVALID", "状态变更字段值不符合执行契约。")


def _state(spec: BasicQuerySpec) -> dict[str, JsonValue]:
    return {
        "metrics": sorted(spec.metric_codes),
        "organizations": sorted(spec.org_codes),
        "comparison_organizations": sorted(spec.comparison_scope.org_codes)
        if spec.comparison_scope
        else [],
        "time": spec.time.model_dump(mode="json", exclude_none=True),
        "selection": spec.selection,
        "operation": spec.operation.model_dump(mode="json", exclude_none=True),
    }


def _intervals(value: JsonValue) -> list[tuple[date, date]]:
    if value is None:
        return []
    if value.get("dates"):
        return [(date.fromisoformat(point), date.fromisoformat(point)) for point in value["dates"]]
    return [(date.fromisoformat(value["start"]), date.fromisoformat(value["end"]))]


def _difference(
    left: list[tuple[date, date]], right: list[tuple[date, date]]
) -> list[tuple[date, date]]:
    """区间差集用于核对新增日历范围，无需逐日展开长区间。"""
    remaining = list(left)
    for low, high in right:
        updated = []
        for start, end in remaining:
            if high < start or low > end:
                updated.append((start, end))
                continue
            if start < low:
                updated.append((start, low - timedelta(days=1)))
            if end > high:
                updated.append((high + timedelta(days=1), end))
        remaining = updated
    return remaining


def validate_transition(
    transition: SemanticTransition,
    after: BasicQuerySpec,
    *,
    question: str,
    today: date,
    metrics: Sequence[MetricCatalogItem],
    organizations: Sequence[OrganizationCatalogItem],
    allowed: set[str],
    analysis: bool = False,
    reference_year: int | None = None,
) -> None:
    """来源票在路由核验；此处独立核对目录、当前权限、操作代数和完整结果。"""
    before = transition.before
    for spec in (before, after):
        orgs = set(spec.org_codes) | (
            set(spec.comparison_scope.org_codes) if spec.comparison_scope else set()
        )
        if (
            spec.organization_scope
            or spec.comparison_scope
            and spec.comparison_scope.organization_scope
        ):
            _fail("SCOPE_INVALID", "状态变更只能使用已解析的实际机构范围。")
        if not orgs <= allowed:
            _fail("SCOPE_DENIED", "状态变更来源或结果超出当前可访问机构范围。")
        if not orgs <= {item.code for item in organizations} or not set(spec.metric_codes) <= {
            item.code for item in metrics
        }:
            _fail("CATALOG_CHANGED", "状态变更来源或结果的目录身份已不可用。")
    current = _state(before)
    mentions = metric_candidate_index(metrics).mentions(question)
    mentioned_metrics = {
        code
        for item in mentions
        if item["resolution"]["status"] == "resolved"
        for code in item["resolution"]["value"]["codes"]
    }
    # 追问中的机构错字（如“沐阳呢？”）与解析阶梯同尺补充依据；
    # 权限（SCOPE_DENIED）与目录有效性（CATALOG_CHANGED）在本函数内独立强制。
    mentioned_orgs = set(source_organization_codes(question, organizations, allow_typo=True))
    sourced_metrics = {code for source in transition.field_sources if source.field == "metrics" for code in source.before.metric_codes}
    sourced_orgs = {code for source in transition.field_sources if source.field in {"organizations", "comparison_organizations"}
                   for code in _state(source.before)[source.field]}
    # 年份可继承完整旧范围；是否续接及改哪个目标仍由 Pi 的来源提议决定。
    calendar = source_calendar_constraints(
        question, today, reference_year=reference_year or before.time.start.year
    )
    calendar_intervals = [span for value in calendar["ranges"] for span in _intervals(value)]
    for change in transition.changes:
        old = _canonical(change.field, change.before)
        new = _canonical(change.field, change.after)
        if old != current[change.field]:
            _fail("BASE_MISMATCH", "状态变更的起点与冻结来源或前一步结果不符。")
        if change.action == "confirm" and old != new:
            _fail("ACTION_INVALID", "已完成来源的确认不能同时替换条件。")
        if change.action == "clear" and new != ([] if change.field in _COLLECTION_FIELDS else None):
            _fail("ACTION_INVALID", "清空操作必须产生空字段。")
        if change.field in _COLLECTION_FIELDS:
            known = (
                {item.code for item in metrics}
                if change.field == "metrics"
                else {item.code for item in organizations}
            )
            if not set(new) <= known:
                _fail("CATALOG_CHANGED", "操作轨迹含当前目录不存在的身份。")
            if change.field != "metrics" and not set(new) <= allowed:
                _fail("SCOPE_DENIED", "操作轨迹含当前无权访问的机构。")
            if change.action == "add" and not set(old) <= set(new):
                _fail("ACTION_INVALID", "追加操作不能丢失原有成员。")
            if change.action == "exclude" and not set(new) <= set(old):
                _fail("ACTION_INVALID", "排除操作不能增加新成员。")
            added = set(new) - set(old)
            if change.field == "metrics" and added - mentioned_metrics - sourced_metrics and not analysis:
                _fail("SOURCE_UNGROUNDED", "新增指标须有本轮目录事实或获授权的分析选取依据。")
            if change.field != "metrics" and added - mentioned_orgs - sourced_orgs:
                _fail("SOURCE_UNGROUNDED", "新增机构须有本轮目录事实依据。")
        elif change.field == "time":
            old_intervals, new_intervals = _intervals(old), _intervals(new)
            if change.action == "add" and _difference(old_intervals, new_intervals):
                _fail("ACTION_INVALID", "追加日期不能丢失原有日期范围。")
            if change.action == "exclude" and _difference(new_intervals, old_intervals):
                _fail("ACTION_INVALID", "排除日期不能增加新的日期范围。")
            added_dates = _difference(new_intervals, old_intervals)
            source_dates = [span for source in transition.field_sources if source.field == "time" for span in _intervals(_state(source.before)["time"])]
            if _difference(added_dates, calendar_intervals + source_dates):
                _fail("SOURCE_UNGROUNDED", "新增日期范围须有本轮日历事实依据。")
        elif change.action in {"add", "exclude"}:
            _fail("ACTION_INVALID", "此字段不能使用集合追加或排除操作。")
        current[change.field] = new
    if current != _state(after):
        _fail("RESULT_MISMATCH", "规范化操作未完整解释最终查询；存在遗漏或未声明的字段变更。")
    # 当前基础查询不接受未解析集合，额外范围身份不得在操作轨迹之外悄悄变化。
    for field in ("schema_version", "organization_scope", "scope_fingerprint"):
        if getattr(before, field) != getattr(after, field):
            _fail("RESULT_MISMATCH", "查询范围元信息发生未声明变更。")


def verify_transition_fragment(
    fragment: dict,
    transitions: Sequence[SemanticTransition],
    *,
    after_specs: Sequence[BasicQuerySpec],
    metrics: Sequence[MetricCatalogItem],
    today: date,
    reference_year: int | None = None,
) -> None:
    """原句实体必须在已声明来源或操作账本内解释，不能借续接遗漏无关新目标。"""
    states = [_state(transition.before) for transition in transitions] + [
        _state(spec) for spec in after_specs
    ]
    metric_codes = {code for state in states for code in state["metrics"]}
    org_codes = {
        code
        for state in states
        for field in ("organizations", "comparison_organizations")
        for code in state[field]
    }
    intervals = [span for state in states for span in _intervals(state["time"])]
    # 跨目标不能只对集合并集对账：甲的日期不能由乙的旧范围补齐。
    # execution transitions 与 after_specs 按同一顺序配对；后续项仅为只读上下文。
    executions = list(zip(transitions[:len(after_specs)], after_specs))
    explicit_orgs = set(fragment["organizations"])
    if explicit_orgs:
        for org in explicit_orgs:
            bound = [(transition, spec) for transition, spec in executions
                     if org in spec.org_codes or spec.comparison_scope
                     and org in spec.comparison_scope.org_codes]
            removed = any(org in change.before and org not in change.after
                          for transition, _ in executions for change in transition.changes
                          if change.field in {"organizations", "comparison_organizations"})
            if not bound and removed:
                continue
            # 没有执行变化的来源只能解释真实只读上下文，不能替另一机构证明日期。
            local = [spec for _, spec in bound]
            if not local:
                local.extend(context.before for context in transitions[len(after_specs):]
                             if org in context.before.org_codes)
            if not local:
                raise ApplicationError("PLAN_TARGETS_INCOMPLETE", "本轮明确机构尚无完整绑定来源。", status_code=409)
            required_metrics = {code for mention in fragment["mentions"]
                                if mention["resolution"]["status"] == "resolved"
                                for code in mention["resolution"]["value"]["codes"]}
            removed_metrics = {code for transition, _ in bound for change in transition.changes
                               if change.field == "metrics" for code in change.before
                               if code not in change.after}
            required_metrics -= removed_metrics
            calendars = [] if fragment.get("calendar_source") == "shared" else fragment["calendar"]["ranges"]
            old_dates = [span for transition, _ in bound for change in transition.changes
                         if change.field == "time" and change.before != change.after
                         for span in _difference(_intervals(change.before), _intervals(change.after))]
            for metric in required_metrics or {None}:
                matching = [spec for spec in local if metric is None or metric in spec.metric_codes]
                if not matching:
                    raise ApplicationError("PLAN_TARGETS_INCOMPLETE", "机构与指标的绑定尚未完整覆盖。", status_code=409)
                for calendar in calendars:
                    required_dates = _difference(_intervals(calendar), old_dates)
                    covered_dates = [span for spec in matching for span in _intervals(_state(spec)["time"])]
                    if required_dates and _difference(required_dates, covered_dates):
                        raise ApplicationError("PLAN_TARGET_BINDING_CONFLICT",
                                               "机构、指标与日期的对应关系未完整进入执行目标。", status_code=409)
    for transition in transitions:
        for change in transition.changes:
            if change.field == "metrics":
                metric_codes.update(change.before)
                metric_codes.update(change.after)
            elif change.field in {"organizations", "comparison_organizations"}:
                org_codes.update(change.before)
                org_codes.update(change.after)
            elif change.field == "time":
                intervals.extend(_intervals(change.before))
                intervals.extend(_intervals(change.after))
    complete = set(fragment["organizations"]) <= org_codes
    index = metric_candidate_index(metrics)
    for mention in fragment["mentions"]:
        resolution = mention["resolution"]
        if resolution["status"] == "resolved":
            complete = complete and set(resolution["value"]["codes"]) <= metric_codes
        else:
            # 已确认旧身份可解释同一基础名；不把歧义候选集合全部当作查询目标。
            candidates = {item.get("code") for item in resolution.get("candidates", [])}
            for item in resolution.get("candidates", []):
                source = item.get("metadata", {}).get("source_metric_code")
                candidates.update(
                    code for codes in index.variants.get(source, {}).values() for code in codes
                )
            complete = complete and bool(candidates & metric_codes)
    calendars = [fragment["calendar"]]
    if reference_year is None:
        # 省略年份沿用 Pi 已选定来源的年份，不能固定套用今天所在年份。
        calendars.extend(
            source_calendar_constraints(
                fragment["question"], today, reference_year=transition.before.time.start.year
            )
            for transition in transitions
        )
    complete = complete and any(
        (calendar["ranges"] or not fragment["calendar"]["ranges"])
        and all(not _difference(_intervals(value), intervals) for value in calendar["ranges"])
        for calendar in calendars
    )
    if not complete:
        raise ApplicationError(
            "PLAN_TARGETS_INCOMPLETE",
            "本轮目录或日期事实未归属任何已声明来源及变更，请补全提案或澄清目标。",
            status_code=409,
        )
