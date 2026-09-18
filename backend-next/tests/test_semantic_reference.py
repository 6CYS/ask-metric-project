"""单来源追问的领域合并规则：只允许原文支持的单字段机构/日期替换。

合并是纯函数，不依赖模型与数据库；时间未修改时携带来源已确认规范区间。
"""

import pytest

from ask_metric.domain.semantic_reference import (
    ReferenceMergeUnsupported,
    ReferenceSourceInvalid,
    freeze_source_reference,
    merge_reference_frame,
)
from ask_metric.domain.semantics import SlotFrame


def _source_slots() -> dict:
    return SlotFrame(
        metrics=[{"code": "M001", "name": "存款余额"}],
        time="2026年8月",
        orgs=["无锡分行"],
        options={"target_dates": ["2026-08-01"], "current_date": "2026-08-31"},
    ).model_dump(mode="json")


def _source_dsl() -> dict:
    return {
        "task": "metric_query",
        "metrics": ["M001"],
        "time": {"start": "2026-08-01", "end": "2026-08-31", "preset": None},
        "orgs": ["3201"],
        "dimensions": [],
        "filters": [],
        "ops": [],
        "options": {},
    }


def _reference(change_field: str = "orgs") -> dict:
    return freeze_source_reference(
        source_task_id="task-src",
        source_version=3,
        change_field=change_field,  # type: ignore[arg-type]
        source_slots=_source_slots(),
        source_logical_dsl=_source_dsl(),
    )


class TestFreeze:
    def test_freeze_requires_confirmed_conditions(self) -> None:
        with pytest.raises(ReferenceSourceInvalid):
            freeze_source_reference(
                source_task_id="t", source_version=1, change_field="orgs",
                source_slots=None, source_logical_dsl=None,
            )

    def test_freeze_keeps_version_and_field(self) -> None:
        reference = _reference()
        assert reference["source_task_id"] == "task-src"
        assert reference["source_version"] == 3
        assert reference["change_field"] == "orgs"


class TestMergeOrgs:
    def test_replace_orgs_and_inherit_source_time(self) -> None:
        extracted = SlotFrame(orgs=["江阴支行"])
        merged = merge_reference_frame(_reference("orgs"), extracted)
        assert merged.frame.orgs == ["江阴支行"]
        assert merged.frame.metrics[0].code == "M001"
        assert merged.frame.time == "2026年8月"
        # 时间未变：携带来源已确认规范区间，不以今天重新解释
        assert merged.resolved_time is not None
        assert merged.resolved_time.start.isoformat() == "2026-08-01"
        assert merged.resolved_time.end.isoformat() == "2026-08-31"

    def test_reject_missing_orgs(self) -> None:
        with pytest.raises(ReferenceMergeUnsupported):
            merge_reference_frame(_reference("orgs"), SlotFrame())

    def test_reject_simultaneous_time_change(self) -> None:
        extracted = SlotFrame(orgs=["江阴支行"], time="2026年7月")
        with pytest.raises(ReferenceMergeUnsupported, match="同时修改"):
            merge_reference_frame(_reference("orgs"), extracted)

    def test_reject_metric_change(self) -> None:
        extracted = SlotFrame(orgs=["江阴支行"], raw_metric_texts=["贷款余额"])
        with pytest.raises(ReferenceMergeUnsupported, match="指标"):
            merge_reference_frame(_reference("orgs"), extracted)


class TestMergeTime:
    def test_replace_time_and_clear_date_options(self) -> None:
        extracted = SlotFrame(time="2026年7月")
        merged = merge_reference_frame(_reference("time"), extracted)
        assert merged.frame.time == "2026年7月"
        assert merged.frame.orgs == ["无锡分行"]
        assert "target_dates" not in merged.frame.options
        assert "current_date" not in merged.frame.options
        # 时间被替换：重新按当前业务日期解析，不携带来源区间
        assert merged.resolved_time is None

    def test_reject_missing_time(self) -> None:
        with pytest.raises(ReferenceMergeUnsupported):
            merge_reference_frame(_reference("time"), SlotFrame())

    def test_reject_org_change_in_time_followup(self) -> None:
        extracted = SlotFrame(time="2026年7月", orgs=["江阴支行"])
        with pytest.raises(ReferenceMergeUnsupported, match="同时修改"):
            merge_reference_frame(_reference("time"), extracted)


class TestSourceTime:
    def test_missing_source_time_rejects_inheritance(self) -> None:
        reference = _reference("orgs")
        reference["source_logical_dsl"]["time"] = None
        with pytest.raises(ReferenceMergeUnsupported, match="时间"):
            merge_reference_frame(reference, SlotFrame(orgs=["江阴支行"]))
