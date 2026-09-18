"""引用追问的时间继承：未修改时间时 DSL 使用来源规范区间，不按今天重新解析。"""

from datetime import date

from ask_metric.application.semantic_workflow import advance_slot_frame
from ask_metric.domain.semantics import (
    LogicalTimeRange,
    MetricCatalogItem,
    OrganizationCatalogItem,
    SlotFrame,
)
from ask_metric.infrastructure.semantic.configuration import SemanticConfig

_METRICS = [MetricCatalogItem(code="M001", name="存款余额", unit="元")]
_ORGS = [OrganizationCatalogItem(code="3201", name="无锡分行")]
_CONFIG = SemanticConfig(
    version="test",
    tasks=["metric_query"],
    operations=[],
    required_slots=["metrics", "orgs", "time"],
    clarification_prompts={"field_labels": {"metrics": "指标", "orgs": "机构", "time": "日期"}},
)


def _merged_frame() -> SlotFrame:
    # 合并后的追问槽位：机构已替换，时间字符串是来源原文表达
    return SlotFrame(
        metrics=[{"code": "M001", "name": "存款余额"}],
        time="上个月",
        orgs=["无锡分行"],
    )


def test_advance_with_resolved_time_override_keeps_source_range() -> None:
    # 来源规范区间是 7 月；若按今天（9-18）重新解析“上个月”会得到 8 月，
    # override 生效时应保持来源的 7 月
    override = LogicalTimeRange(start=date(2026, 7, 1), end=date(2026, 7, 31))
    advance = advance_slot_frame(
        _merged_frame(),
        metrics=_METRICS,
        organizations=_ORGS,
        config=_CONFIG,
        today=date(2026, 9, 18),
        resolved_time_override=override,
    )
    assert advance.logical_dsl is not None
    assert advance.logical_dsl.time is not None
    assert advance.logical_dsl.time.start == date(2026, 7, 1)
    assert advance.logical_dsl.time.end == date(2026, 7, 31)


def test_advance_without_override_resolves_against_today() -> None:
    advance = advance_slot_frame(
        _merged_frame(),
        metrics=_METRICS,
        organizations=_ORGS,
        config=_CONFIG,
        today=date(2026, 9, 18),
    )
    assert advance.logical_dsl is not None
    assert advance.logical_dsl.time is not None
    # 不带 override 时按当前业务日期解析“上个月”为 8 月
    assert advance.logical_dsl.time.start == date(2026, 8, 1)
    assert advance.logical_dsl.time.end == date(2026, 8, 31)
