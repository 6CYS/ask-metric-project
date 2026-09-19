"""会话关系、条件完整性和澄清连续性，不依赖任何特定机构问法。"""

from datetime import date
from pathlib import Path

import pytest

from ask_metric.application.semantic_workflow import advance_slot_frame, apply_clarification_answers
from ask_metric.domain.semantic_engine import ContextResolutionError, SemanticEngine
from ask_metric.domain.semantic_reference import freeze_source_reference, merge_reference_frame
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem, SlotFrame
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

METRICS = [
    MetricCatalogItem(code="M1", name="存款余额"),
    MetricCatalogItem(code="M2", name="贷款余额"),
]
ORGS = [
    OrganizationCatalogItem(code="A", name="甲农商行", aliases=["甲行"]),
    OrganizationCatalogItem(code="B", name="乙农商行", aliases=["乙行"]),
]
CONFIG = SemanticConfigRepository(Path(__file__).parents[1] / "config/semantic-config.json").load()


def reference():
    frame = SlotFrame(
        metrics=[{"code": "M1", "name": "存款余额"}],
        orgs=["甲农商行"],
        time="2026-01-01至2026-01-31",
    )
    return freeze_source_reference(
        source_task_id="source",
        source_version=3,
        change_field="compose",
        source_slots=frame.model_dump(mode="json"),
        source_logical_dsl={"time": {"start": "2026-01-01", "end": "2026-01-31"}},
    )


def advance(frame, resolved=None):
    return advance_slot_frame(
        frame,
        metrics=METRICS,
        organizations=ORGS,
        config=CONFIG,
        today=date(2026, 9, 19),
        resolved_time_override=resolved,
    )


def analyze(question, frame, source):
    class Model:
        def analyze(self, **kwargs):
            return frame.model_dump(mode="json")

    return (
        SemanticEngine(Model())
        .analyze(
            question,
            metrics=METRICS,
            organizations=ORGS,
            config=CONFIG,
            current_date=date(2026, 9, 19),
            reference_context=source,
        )
        .slot_frame
    )


def candidate():
    return {**reference(), "mode": "candidate"}


@pytest.mark.parametrize("question", ["乙行四月份的呢？", "四月换乙行", "乙行，4月份"])
def test_wrong_new_action_still_resolves_frozen_candidate(question):
    delta = analyze(
        question,
        SlotFrame(context_relation="followup", orgs=["B"], changes={"orgs": "replace"}),
        candidate(),
    )
    merged = merge_reference_frame(candidate(), delta)
    result = advance(merged.frame, merged.resolved_time)
    assert result.logical_dsl.orgs == ["B"]
    assert result.logical_dsl.metrics == ["M1"]
    assert result.logical_dsl.time.start == date(2026, 4, 1)
    assert result.logical_dsl.time.end == date(2026, 4, 30)


@pytest.mark.parametrize("relation", [None, "ambiguous", "independent"])
def test_unproven_relationship_cannot_inherit_or_invent_missing_metric(relation):
    with pytest.raises(ContextResolutionError):
        analyze("乙行四月份的呢", SlotFrame(context_relation=relation, orgs=["B"]), candidate())


def test_independent_metric_does_not_inherit_candidate_org_or_time():
    frame = analyze(
        "贷款余额",
        SlotFrame(context_relation="independent", raw_metric_text="贷款余额"),
        candidate(),
    )
    result = advance(frame)
    assert [m.code for m in frame.metrics] == ["M2"]
    assert set(result.slot_frame.missing) == {"orgs", "time"}


def test_independent_and_delta_cannot_be_mixed():
    with pytest.raises(ContextResolutionError):
        analyze(
            "贷款余额",
            SlotFrame(
                context_relation="independent",
                raw_metric_text="贷款余额",
                changes={"metrics": "replace"},
            ),
            candidate(),
        )


@pytest.mark.parametrize("question", ["乙行四月份的呢？", "乙行2026年4月", "乙行，2026-04-30"])
def test_missing_metric_is_not_invented_from_residual_and_date_survives_clarification(question):
    frame = analyze(question, SlotFrame(orgs=["B"], missing=["metrics", "time"]), None)
    first = advance(frame)
    assert first.slot_frame.raw_metric_texts == []
    assert first.slot_frame.missing == ["metrics"]
    patched = apply_clarification_answers(
        first.slot_frame, "存款余额", metrics=METRICS, organizations=ORGS
    )
    result = advance(patched)
    assert result.logical_dsl.time.end == date(2026, 4, 30)
    assert result.logical_dsl.orgs == ["B"]


def test_unrecognized_explicit_metric_is_preserved_for_clarification(monkeypatch):
    monkeypatch.setattr(SemanticEngine, "_model_role_enabled", lambda self, role: False)
    frame = analyze(
        "乙行2026年4月火星余额", SlotFrame(orgs=["B"], raw_metric_text="火星余额"), None
    )
    result = advance(frame)
    assert result.slot_frame.missing == ["metrics"]
    assert frame.raw_metric_texts == ["火星余额"]


def test_multiple_dates_omitted_by_model_never_fall_back_to_previous_date():
    delta = analyze("四月和六月分别呢", SlotFrame(context_relation="followup"), candidate())
    merged = merge_reference_frame(candidate(), delta)
    assert advance(merged.frame, merged.resolved_time).slot_frame.missing == ["time"]


def test_bare_month_uses_source_year_and_cross_year_requires_confirmation():
    source = candidate()
    source["source_logical_dsl"]["time"] = {"start": "2024-01-01", "end": "2024-01-31"}
    delta = analyze("二月份呢", SlotFrame(context_relation="followup"), source)
    merged = merge_reference_frame(source, delta)
    assert advance(merged.frame).logical_dsl.time.end == date(2024, 2, 29)
    source["source_logical_dsl"]["time"]["end"] = "2025-01-31"
    with pytest.raises(ContextResolutionError):
        analyze("二月份呢", SlotFrame(context_relation="followup"), source)


def test_inconsistent_model_change_map_is_repaired_once_without_changing_source():
    import json

    from ask_metric.domain.semantic_engine import InvalidSlotFrameError

    class RepairModel:
        def __init__(self, correct):
            self.calls = []
            self.correct = correct

        def analyze(self, **request):
            self.calls.append(request)
            changes = {"time": "replace"}
            if len(self.calls) == 2 and self.correct:
                changes = {"orgs": "replace"}
            return SlotFrame(
                context_relation="followup",
                orgs=["B"],
                time="2099年1月" if len(self.calls) == 2 else "2026年4月",
                changes=changes,
            ).model_dump(mode="json")

    for correct in [True, False]:
        model = RepairModel(correct)
        kwargs = dict(
            metrics=METRICS,
            organizations=ORGS,
            config=CONFIG,
            current_date=date(2026, 9, 19),
            reference_context=candidate(),
        )
        if correct:
            result = SemanticEngine(model).analyze("乙行四月呢", **kwargs)
            assert result.slot_frame.changes == {"time": "replace", "orgs": "replace"}
            assert result.slot_frame.time == "2026年4月"
            assert result.debug["change_map_repair"]["attempts"] == 1
        else:
            with pytest.raises(InvalidSlotFrameError):
                SemanticEngine(model).analyze("乙行四月呢", **kwargs)
        assert len(model.calls) == 2
        first = json.loads(model.calls[0]["context"]["existing_slot_frame_json"])
        second = model.calls[1]["context"]
        assert first["source_slots"] == json.loads(second["source_json"])["source_slots"]
        assert model.calls[1]["prompt"] == "reference_change_map"
        assert "orgs" in second["error"]


def test_candidate_mode_requires_compose_and_is_frozen():
    from ask_metric.domain.semantic_reference import ReferenceSourceInvalid

    source = reference()
    kwargs = dict(
        source_task_id="source",
        source_version=3,
        source_slots=source["source_slots"],
        source_logical_dsl=source["source_logical_dsl"],
        mode="candidate",
    )
    assert freeze_source_reference(change_field="compose", **kwargs)["mode"] == "candidate"
    with pytest.raises(ReferenceSourceInvalid):
        freeze_source_reference(change_field="orgs", **kwargs)


def test_identical_unmodified_source_fields_are_noop_not_new_conditions():
    source = candidate()
    delta = analyze(
        "乙行四月呢",
        SlotFrame(
            context_relation="followup",
            metrics=source["source_slots"]["metrics"],
            orgs=["B"],
            time="2026年4月",
            changes={"orgs": "replace", "time": "replace"},
        ),
        source,
    )
    assert delta.metrics == []
    result = advance(merge_reference_frame(source, delta).frame)
    assert result.logical_dsl.metrics == ["M1"]
    assert result.logical_dsl.orgs == ["B"]


def test_reference_mode_participates_in_fingerprint_without_changing_explicit_legacy_key(
    monkeypatch,
):
    from ask_metric.application import task_service
    from ask_metric.application.commands import QueryReference, SubmitQuestionCommand
    from ask_metric.application.requests import ActorContext, IncomingRequest

    # 捕获散列输入，明确默认显式模式仍保持旧协议的三个字段。
    monkeypatch.setattr(task_service, "_fingerprint", lambda value: value)
    request = IncomingRequest(request_id="r", channel="web", text="乙行四月呢")
    actor = ActorContext(
        subject="synthetic", authentication_method="test", trust_level="development"
    )

    def payload(mode):
        command = SubmitQuestionCommand(
            request=request,
            actor=actor,
            idempotency_key="same",
            query_reference=QueryReference(task_id="source", version=3, mode=mode),
        )
        return task_service._question_fingerprint(command, "conversation")["query_reference"]

    assert payload("explicit") == {"task_id": "source", "version": 3, "change_field": "compose"}
    assert payload("candidate") == {**payload("explicit"), "mode": "candidate"}


@pytest.mark.parametrize("extra", [{"ops": "clear"}, {"time": "clear"}])
def test_change_map_repair_cannot_add_unrequested_actions_or_replace_existing_action(extra):
    from ask_metric.domain.semantic_engine import InvalidSlotFrameError

    class Model:
        def analyze(self, *, prompt, **kwargs):
            if prompt == "reference_change_map":
                return {"changes": {"orgs": "replace", **extra}}
            return SlotFrame(
                context_relation="followup",
                orgs=["B"],
                time="2026年4月",
                changes={"time": "replace"},
            ).model_dump(mode="json")

    with pytest.raises(InvalidSlotFrameError):
        SemanticEngine(Model()).analyze(
            "乙行四月呢",
            metrics=METRICS,
            organizations=ORGS,
            config=CONFIG,
            current_date=date(2026, 9, 19),
            reference_context=candidate(),
        )
