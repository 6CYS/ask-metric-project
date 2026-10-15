"""结构化跨轮状态准入；合成目录，不使用数据库、模型或关键词动作识别。"""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from ask_metric.api.routes.business_context import PlanAdmissionRequest, admit_semantic_plan
from ask_metric.application.analysis_selection import issue_selection, verify_selection
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem

METRICS = [
    MetricCatalogItem(code="M1", name="合成收益金额当日数"),
    MetricCatalogItem(code="M2", name="合成规模金额当日数"),
]
ORGS = [
    OrganizationCatalogItem(code="O1", name="合成机构甲"),
    OrganizationCatalogItem(code="O2", name="合成机构乙"),
]
ACTOR = ActorContext(
    subject="synthetic",
    user_id="synthetic",
    org_id="O1",
    role_code="USER",
    authentication_method="local_jwt",
    trust_level="authenticated",
)
SETTINGS = SimpleNamespace(jwt_secret="synthetic-secret")
PERMISSIONS = SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1", "O2"})


class Uow:
    metric_catalog = SimpleNamespace(list_enabled=lambda: METRICS)
    organization_catalog = SimpleNamespace(list_enabled=lambda: ORGS)
    conversations = SimpleNamespace(
        get_owned=lambda conversation, owner: (
            SimpleNamespace() if conversation == "conversation" else None
        )
    )

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def spec(*, metrics=None, orgs=None, day="2026-05-31", selection="exact"):
    return BasicQuerySpec.model_validate(
        {
            "metric_codes": metrics or ["M1"],
            "org_codes": orgs or ["O1"],
            "time": {"start": day, "end": day},
            "selection": selection,
        }
    ).model_dump(mode="json", exclude_none=True)


def receipt(before, **changes):
    return issue_selection(
        owner="synthetic",
        conversation="conversation",
        session="session",
        goal="合成机构甲2026年5月31日的合成收益金额当日数",
        codes=before["metric_codes"],
        scope=before,
        catalog=METRICS,
        secret=SETTINGS.jwt_secret,
        **changes,
    )


def change(field, action, before, after):
    return {"field": field, "action": action, "before": before, "after": after}


def payload(question, before, after, changes, *, analysis=False):
    return {
        "conversation_id": "conversation",
        "session_id": "session",
        "business_date": "2026-10-15",
        "goal": question,
        "analysis": analysis,
        "steps": [
            {
                "target_ref": "target",
                "fragment": 0,
                "origin": "analysis_selected" if analysis else "history",
                "spec": after,
                "transition": {
                    "before": before,
                    "source_semantic_receipt": receipt(before),
                    "changes": changes,
                },
            }
        ],
    }


def admit(raw, *, permissions=PERMISSIONS, uow=None):
    return admit_semantic_plan(
        PlanAdmissionRequest.model_validate(raw), ACTOR, uow or Uow(), permissions, SETTINGS
    )


@pytest.mark.parametrize("correct", [False, True])
def test_cross_history_dates_cannot_be_covered_by_another_organization(correct):
    before = [spec(orgs=["O1"]), spec(orgs=["O2"], day="2026-06-30")]
    after = [spec(orgs=["O1"], day="2026-06-30"), spec(orgs=["O2"])] if correct else before
    raw = payload("合成机构甲改查2026年6月30日；合成机构乙改查2026年5月31日", before[0], after[0], [])
    raw["steps"] = [{"target_ref":str(i),"fragment":i,"origin":"history","spec":value,
                     "transition":{"before":before[i],"source_semantic_receipt":receipt(before[i]),
                                   "changes":[change("time","set",before[i]["time"],value["time"])] if correct else []}}
                    for i,value in enumerate(after)]
    if correct:
        assert admit(raw)["status"] == "admitted"
    else:
        with pytest.raises(ApplicationError, match="对应关系") as error:
            admit(raw)
        assert error.value.code == "PLAN_TARGET_BINDING_CONFLICT"


def test_copy_field_requires_signed_original_scope_and_current_permission():
    old = spec(); source = spec(metrics=["M2"],orgs=["O2"]); after=spec(metrics=["M2"])
    raw=payload("沿用当前机构日期，指标使用第二次查询的指标",old,after,[change("metrics","set",["M1"],["M2"])])
    raw["steps"][0]["transition"]["field_sources"]=[{"field":"metrics","before":source,"source_semantic_receipt":receipt(source)}]
    assert admit(raw)["status"] == "admitted"
    denied=SimpleNamespace(authorized_org_codes=lambda **kwargs:{"O1"})
    with pytest.raises(ApplicationError) as error:
        admit(raw,permissions=denied)
    assert error.value.code == "TRANSITION_SCOPE_DENIED"
    raw["steps"][0]["transition"]["field_sources"][0]["before"]["metric_codes"]=["M1"]
    with pytest.raises(ApplicationError) as error:
        admit(raw)
    assert error.value.code == "TRANSITION_SOURCE_INVALID"


def assert_error(raw, code):
    with pytest.raises(ApplicationError) as caught:
        admit(raw)
    assert caught.value.code == code


def test_signed_source_can_change_one_field_without_repeating_other_conditions():
    before, after = spec(), spec(orgs=["O2"])
    result = admit(
        payload(
            "合成机构乙呢？", before, after, [change("organizations", "replace", ["O1"], ["O2"])]
        )
    )
    assert len(result["receipts"]) == 1
    verify_selection(
        result["receipts"][0]["receipt"],
        owner="synthetic",
        conversation="conversation",
        session="session",
        codes=["M1"],
        scope=after,
        catalog=METRICS,
        secret=SETTINGS.jwt_secret,
    )


def test_append_replays_union_and_does_not_treat_old_subject_as_a_new_obligation():
    before, after = spec(), spec(metrics=["M1", "M2"])
    assert (
        len(
            admit(
                payload(
                    "在刚才基础上追加合成规模金额当日数",
                    before,
                    after,
                    [change("metrics", "add", ["M1"], ["M1", "M2"])],
                )
            )["receipts"]
        )
        == 1
    )


def test_exclusion_is_valid_without_making_excluded_mention_a_positive_query():
    before, after = spec(metrics=["M1", "M2"]), spec(metrics=["M2"])
    assert (
        len(
            admit(
                payload(
                    "把合成收益金额当日数去掉，只保留另一项",
                    before,
                    after,
                    [change("metrics", "exclude", ["M1", "M2"], ["M2"])],
                )
            )["receipts"]
        )
        == 1
    )


@pytest.mark.parametrize(
    "field,action,old,new",
    [
        ("metrics", "add", ["M1"], ["M2"]),
        ("metrics", "exclude", ["M1"], ["M1", "M2"]),
        ("organizations", "add", ["O1"], ["O2"]),
        ("selection", "add", "exact", "latest_in_range"),
        ("metrics", "confirm", ["M1"], ["M2"]),
        ("metrics", "clear", ["M1"], ["M2"]),
    ],
)
def test_action_algebra_is_checked_independently_of_question_words(field, action, old, new):
    raw = payload(
        "合成机构乙2026年6月30日的合成规模金额当日数",
        spec(),
        spec(),
        [change(field, action, old, new)],
    )
    assert_error(raw, "TRANSITION_ACTION_INVALID")


@pytest.mark.parametrize(
    "after",
    [
        spec(orgs=["O2"]),
        spec(day="2026-06-30"),
        spec(metrics=["M2"]),
        {**spec(), "selection": "all_in_range"},
        {**spec(), "operation": {"kind": "ranking", "position": "top", "top_n": 3}},
    ],
)
def test_undeclared_field_changes_are_rejected(after):
    assert_error(
        payload("合成机构乙2026年6月30日的合成规模金额当日数", spec(), after, []),
        "TRANSITION_RESULT_MISMATCH",
    )


def test_trace_must_replay_from_actual_previous_result():
    raw = payload(
        "合成规模金额当日数",
        spec(),
        spec(metrics=["M2"]),
        [
            change("metrics", "add", ["M1"], ["M1", "M2"]),
            change("metrics", "exclude", ["M1"], ["M2"]),
        ],
    )
    assert_error(raw, "TRANSITION_BASE_MISMATCH")


def test_excluded_member_cannot_reappear_without_a_declared_new_operation():
    before = spec(metrics=["M1", "M2"])
    assert_error(
        payload(
            "去掉合成收益金额当日数",
            before,
            before,
            [change("metrics", "exclude", ["M1", "M2"], ["M2"])],
        ),
        "TRANSITION_RESULT_MISMATCH",
    )


@pytest.mark.parametrize(
    "question,field,old,new,after",
    [
        ("继续", "metrics", ["M1"], ["M2"], spec(metrics=["M2"])),
        ("继续", "organizations", ["O1"], ["O2"], spec(orgs=["O2"])),
        ("继续", "time", spec()["time"], spec(day="2026-06-30")["time"], spec(day="2026-06-30")),
    ],
)
def test_new_identity_or_date_requires_current_facts(question, field, old, new, after):
    assert_error(
        payload(question, spec(), after, [change(field, "set", old, new)]),
        "TRANSITION_SOURCE_UNGROUNDED",
    )


def test_new_date_uses_inherited_year_but_not_an_invented_calendar():
    before, after = spec(day="2025-05-31"), spec(day="2025-06-30")
    assert (
        len(
            admit(
                payload(
                    "改为6月末",
                    before,
                    after,
                    [change("time", "set", before["time"], after["time"])],
                )
            )["receipts"]
        )
        == 1
    )
    bad = spec(day="2025-07-31")
    assert_error(
        payload("改为6月末", before, bad, [change("time", "set", before["time"], bad["time"])]),
        "TRANSITION_SOURCE_UNGROUNDED",
    )


def test_discrete_dates_append_preserves_old_points_and_allows_current_point():
    before = spec()
    after = {
        **before,
        "time": {"start": "2026-05-31", "end": "2026-06-30", "dates": ["2026-05-31", "2026-06-30"]},
    }
    assert (
        len(
            admit(
                payload(
                    "再增加2026年6月30日",
                    before,
                    after,
                    [change("time", "add", before["time"], after["time"])],
                )
            )["receipts"]
        )
        == 1
    )
    assert_error(
        payload(
            "再增加2026年6月30日",
            before,
            spec(day="2026-06-30"),
            [change("time", "add", before["time"], spec(day="2026-06-30")["time"])],
        ),
        "TRANSITION_ACTION_INVALID",
    )


def test_unchanged_history_reference_still_verifies_original_complete_scope():
    raw = payload("显示之前结果", spec(), spec(), [])
    assert len(admit(raw)["receipts"]) == 1
    raw["steps"][0]["transition"]["before"]["org_codes"] = ["O2"]
    assert_error(raw, "TRANSITION_SOURCE_INVALID")


@pytest.mark.parametrize("mutation", ["token", "session", "conversation", "before"])
def test_transition_rejects_tampered_cross_session_and_changed_source(mutation):
    raw = payload("显示结果", spec(), spec(), [])
    if mutation == "token":
        raw["steps"][0]["transition"]["source_semantic_receipt"] += "x"
    if mutation == "session":
        raw["session_id"] = "another-session"
    if mutation == "conversation":
        raw["steps"][0]["transition"]["source_semantic_receipt"] = issue_selection(
            owner="synthetic",
            conversation="another",
            session="session",
            goal="synthetic",
            codes=["M1"],
            scope=spec(),
            catalog=METRICS,
            secret=SETTINGS.jwt_secret,
        )
    if mutation == "before":
        raw["steps"][0]["transition"]["before"]["time"] = spec(day="2026-06-30")["time"]
    assert_error(raw, "TRANSITION_SOURCE_INVALID")


def test_current_permission_and_catalog_are_rechecked_for_retained_source():
    raw = payload(
        "显示结果",
        spec(orgs=["O1", "O2"]),
        spec(orgs=["O1"]),
        [change("organizations", "exclude", ["O1", "O2"], ["O1"])],
    )
    with pytest.raises(ApplicationError) as caught:
        admit(raw, permissions=SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"}))
    assert caught.value.code == "TRANSITION_SCOPE_DENIED"
    stale = Uow()
    stale.metric_catalog = SimpleNamespace(list_enabled=lambda: [METRICS[1]])
    with pytest.raises(ApplicationError) as caught:
        admit(payload("显示结果", spec(), spec(), []), uow=stale)
    assert caught.value.code == "TRANSITION_SOURCE_INVALID"


def test_legacy_frame_metric_coverage_is_only_compatibility_source():
    raw = payload(
        "合成机构乙呢",
        spec(),
        spec(orgs=["O2"]),
        [change("organizations", "replace", ["O1"], ["O2"])],
    )
    transition = raw["steps"][0]["transition"]
    del transition["source_semantic_receipt"]
    transition["source_question"] = "合成收益金额当日数"
    transition["bindings"] = [
        {
            "start": 0,
            "end": len("合成收益金额当日数"),
            "text": "合成收益金额当日数",
            "codes": ["M1"],
        }
    ]
    assert len(admit(raw)["receipts"]) == 1
    del transition["source_question"]
    assert_error(raw, "TRANSITION_SOURCE_MISSING")


def test_analysis_may_select_enabled_support_metric_with_existing_authorization():
    before, after = spec(), spec(metrics=["M1", "M2"])
    assert (
        len(
            admit(
                payload(
                    "继续分析",
                    before,
                    after,
                    [change("metrics", "add", ["M1"], ["M1", "M2"])],
                    analysis=True,
                )
            )["receipts"]
        )
        == 1
    )
    raw = payload(
        "继续分析", before, after, [change("metrics", "add", ["M1"], ["M1", "M2"])], analysis=True
    )
    raw["analysis"] = False
    assert_error(raw, "ANALYSIS_NOT_AUTHORIZED")


def test_new_steps_in_mixed_request_still_require_complete_fragment_coverage():
    raw = payload("合成机构乙2026年6月30日的合成规模金额当日数", spec(), spec(), [])
    raw["steps"].append(
        {
            "target_ref": "new",
            "fragment": 0,
            "origin": "user_explicit",
            "spec": spec(orgs=["O2"], day="2026-06-30"),
        }
    )
    mention = "合成规模金额当日数"
    start = raw["goal"].index(mention)
    raw["fragment_bindings"] = {
        "0": [{"start": start, "end": start + len(mention), "text": mention, "codes": ["M2"]}]
    }
    assert_error(raw, "PLAN_TARGETS_INCOMPLETE")


@pytest.mark.parametrize(
    "question", ["另外还要合成规模金额当日数", "还有合成机构乙", "日期再看2026年6月30日"]
)
def test_transition_cannot_silently_ignore_unaccounted_current_facts(question):
    assert_error(payload(question, spec(), spec(), []), "PLAN_TARGETS_INCOMPLETE")


def test_mixed_new_and_transition_cannot_drop_an_unassigned_new_fragment():
    first = "合成机构乙2026年6月30日的合成规模金额当日数"
    raw = payload(first + "；合成机构甲2026年7月31日的合成收益金额当日数", spec(), spec(), [])
    raw["steps"].append(
        {
            "target_ref": "new",
            "fragment": 0,
            "origin": "user_explicit",
            "spec": spec(metrics=["M2"], orgs=["O2"], day="2026-06-30"),
        }
    )
    mention = "合成规模金额当日数"
    start = first.index(mention)
    raw["fragment_bindings"] = {
        "0": [{"start": start, "end": start + len(mention), "text": mention, "codes": ["M2"]}]
    }
    assert_error(raw, "PLAN_TARGET_BINDING_CONFLICT")


def test_comparison_scope_is_a_separate_declared_and_authorized_field():
    before = spec()
    after = {
        **before,
        "operation": {"kind": "rank_position"},
        "comparison_scope": {"org_codes": ["O1", "O2"]},
    }
    changes = [
        change("operation", "set", {"kind": "value"}, {"kind": "rank_position"}),
        change("comparison_organizations", "set", [], ["O1", "O2"]),
    ]
    assert (
        len(admit(payload("在合成机构甲和合成机构乙中排第几", before, after, changes))["receipts"])
        == 1
    )
    assert_error(
        payload("在合成机构甲和合成机构乙中排第几", before, after, changes[:1]),
        "TRANSITION_RESULT_MISMATCH",
    )


def test_action_trace_can_clear_then_set_without_restoring_a_discarded_member():
    before, after = spec(), spec(metrics=["M2"])
    assert (
        len(
            admit(
                payload(
                    "只改查合成规模金额当日数",
                    before,
                    after,
                    [change("metrics", "clear", ["M1"], []), change("metrics", "set", [], ["M2"])],
                )
            )["receipts"]
        )
        == 1
    )


def test_normalized_set_members_are_order_independent_but_retained_identity_is_exact():
    before = spec(metrics=["M1", "M2"])
    assert (
        len(
            admit(
                payload(
                    "显示原结果",
                    before,
                    before,
                    [change("metrics", "confirm", ["M2", "M1"], ["M1", "M2"])],
                )
            )["receipts"]
        )
        == 1
    )


@pytest.mark.parametrize(
    "mutation", ["missing_before", "unknown_field", "duplicate_codes", "invalid_time"]
)
def test_transition_schema_and_values_do_not_accept_unstructured_trace(mutation):
    raw = payload("合成规模金额当日数", spec(), spec(), [change("metrics", "set", ["M1"], ["M1"])])
    event = raw["steps"][0]["transition"]["changes"][0]
    if mutation == "missing_before":
        del event["before"]
        with pytest.raises(ValidationError):
            PlanAdmissionRequest.model_validate(raw)
    elif mutation == "unknown_field":
        event["field"] = "anything"
        with pytest.raises(ValidationError):
            PlanAdmissionRequest.model_validate(raw)
    elif mutation == "duplicate_codes":
        event["after"] = ["M1", "M1"]
        assert_error(raw, "TRANSITION_VALUE_INVALID")
    else:
        event.update(
            field="time", before=spec()["time"], after={"start": "2026-02-30", "end": "2026-02-30"}
        )
        assert_error(raw, "TRANSITION_VALUE_INVALID")


def test_source_receipt_optional_session_check_preserves_existing_callers():
    before = spec()
    token = receipt(before)
    options = dict(
        owner="synthetic",
        conversation="conversation",
        codes=["M1"],
        scope=before,
        catalog=METRICS,
        secret=SETTINGS.jwt_secret,
    )
    verify_selection(token, **options)
    with pytest.raises(ApplicationError):
        verify_selection(token, **options, session="another")


def context_source(before):
    return {"before": before, "source_semantic_receipt": receipt(before), "changes": []}


def retained_context_payload():
    before, after = spec(), spec(day="2026-06-30")
    raw = payload(
        "合成机构甲改为2026年6月30日；合成机构乙的合成规模金额当日数保持原结果",
        before,
        after,
        [change("time", "set", before["time"], after["time"])],
    )
    raw["context_sources"] = [context_source(spec(metrics=["M2"], orgs=["O2"]))]
    return raw


def test_retained_context_explains_other_target_but_only_changed_target_gets_receipt():
    raw = retained_context_payload()
    result = admit(raw)
    assert [item["target_ref"] for item in result["receipts"]] == ["target"]
    verify_selection(
        result["receipts"][0]["receipt"],
        owner="synthetic",
        conversation="conversation",
        session="session",
        codes=["M1"],
        scope=spec(day="2026-06-30"),
        catalog=METRICS,
        secret=SETTINGS.jwt_secret,
    )
    raw["context_sources"] = []
    assert_error(raw, "PLAN_TARGETS_INCOMPLETE")


@pytest.mark.parametrize("mutation", ["before", "token", "session", "changes"])
def test_retained_context_must_be_unchanged_and_have_valid_frozen_source(mutation):
    raw = retained_context_payload()
    context = raw["context_sources"][0]
    if mutation == "before":
        context["before"]["time"] = spec(day="2026-07-31")["time"]
    elif mutation == "token":
        context["source_semantic_receipt"] += "x"
    elif mutation == "session":
        before = context["before"]
        context["source_semantic_receipt"] = issue_selection(
            owner="synthetic",
            conversation="conversation",
            session="another-session",
            goal="synthetic",
            codes=before["metric_codes"],
            scope=before,
            catalog=METRICS,
            secret=SETTINGS.jwt_secret,
        )
    else:
        context["changes"] = [change("metrics", "confirm", ["M2"], ["M2"])]
    assert_error(
        raw, "TRANSITION_CONTEXT_INVALID" if mutation == "changes" else "TRANSITION_SOURCE_INVALID"
    )


def test_retained_context_rechecks_current_permissions_even_without_executing_it():
    with pytest.raises(ApplicationError) as caught:
        admit(
            retained_context_payload(),
            permissions=SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"}),
        )
    assert caught.value.code == "TRANSITION_SCOPE_DENIED"


def test_retained_context_cannot_replace_new_target_strict_coverage():
    first = "查合成机构甲2026年5月31日的合成收益金额当日数"
    raw = payload(first + "；合成机构乙2026年5月31日的合成规模金额当日数", spec(), spec(), [])
    raw["steps"][0].pop("transition")
    raw["steps"][0]["origin"] = "user_explicit"
    raw["context_sources"] = [context_source(spec(metrics=["M2"], orgs=["O2"]))]
    mention = "合成收益金额当日数"
    start = first.index(mention)
    raw["fragment_bindings"] = {
        "0": [{"start": start, "end": start + len(mention), "text": mention, "codes": ["M1"]}]
    }
    assert_error(raw, "PLAN_TARGETS_INCOMPLETE")


def mixed_shared_fragment_payload():
    before, after = spec(), spec(day="2026-06-30")
    question = "合成机构甲2026年6月30日的合成收益金额当日数和合成规模金额当日数"
    raw = payload(question, before, after, [change("time", "set", before["time"], after["time"])])
    raw["steps"].append(
        {
            "target_ref": "new",
            "fragment": 0,
            "origin": "user_explicit",
            "spec": spec(metrics=["M2"], day="2026-06-30"),
        }
    )
    raw["fragment_bindings"] = {
        "0": [
            {
                "start": question.index(metric.name),
                "end": question.index(metric.name) + len(metric.name),
                "text": metric.name,
                "codes": [metric.code],
            }
            for metric in METRICS
        ]
    }
    return raw


def test_shared_fragment_counts_transition_after_and_ordinary_new_as_one_complete_goal():
    result = admit(mixed_shared_fragment_payload())
    assert [item["target_ref"] for item in result["receipts"]] == ["target", "new"]


@pytest.mark.parametrize("mutation", ["org", "date", "missing"])
def test_shared_fragment_does_not_relax_new_target_binding_or_allow_omission(mutation):
    raw = mixed_shared_fragment_payload()
    if mutation == "org":
        raw["steps"][1]["spec"]["org_codes"] = ["O2"]
    elif mutation == "date":
        raw["steps"][1]["spec"]["time"] = spec(day="2026-07-31")["time"]
    else:
        raw["steps"].pop()
    assert_error(
        raw, "PLAN_TARGETS_INCOMPLETE" if mutation == "missing" else "PLAN_TARGET_BINDING_CONFLICT"
    )


def test_shared_fragment_old_subject_is_explained_by_transition_not_requested_again():
    third = MetricCatalogItem(code="M3", name="合成新指标当日数")
    catalog = [*METRICS, third]
    uow = Uow()
    uow.metric_catalog = SimpleNamespace(list_enabled=lambda: catalog)
    before, after = spec(), spec(metrics=["M2"])
    question = (
        "合成机构甲2026年5月31日，把合成收益金额当日数换成合成规模金额当日数和合成新指标当日数"
    )
    raw = payload(question, before, after, [change("metrics", "replace", ["M1"], ["M2"])])
    raw["steps"].append(
        {
            "target_ref": "new",
            "fragment": 0,
            "origin": "user_explicit",
            "spec": spec(metrics=["M3"]),
        }
    )
    raw["fragment_bindings"] = {
        "0": [
            {
                "start": question.index(metric.name),
                "end": question.index(metric.name) + len(metric.name),
                "text": metric.name,
                "codes": [metric.code],
            }
            for metric in catalog
        ]
    }
    assert [item["target_ref"] for item in admit(raw, uow=uow)["receipts"]] == ["target", "new"]


@pytest.mark.parametrize("source_kind", ["context", "transition"])
def test_malformed_legacy_source_bindings_produce_business_error(source_kind):
    raw = retained_context_payload()
    source = (
        raw["context_sources"][0] if source_kind == "context" else raw["steps"][0]["transition"]
    )
    del source["source_semantic_receipt"]
    source["source_question"] = (
        "合成规模金额当日数" if source_kind == "context" else "合成收益金额当日数"
    )
    source["bindings"] = [{}]
    assert_error(raw, "TRANSITION_SOURCE_INVALID")


def test_unused_revoked_context_does_not_block_valid_execution_and_keeps_diagnostic():
    before, after = spec(), spec(day="2026-06-30")
    raw = payload(
        "仅将合成机构甲日期改为2026年6月30日",
        before,
        after,
        [change("time", "set", before["time"], after["time"])],
    )
    raw["context_sources"] = [context_source(spec(metrics=["M2"], orgs=["O2"]))]
    result = admit(raw, permissions=SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"}))
    assert [item["target_ref"] for item in result["receipts"]] == ["target"]
    assert result["context_diagnostics"] == [
        {"index": 0, "code": "TRANSITION_SCOPE_DENIED", "ignored": True}
    ]


def test_unrelated_invalid_contexts_are_all_diagnosed_without_becoming_sources():
    before, after = spec(), spec(day="2026-06-30")
    raw = payload(
        "仅将合成机构甲日期改为2026年6月30日",
        before,
        after,
        [change("time", "set", before["time"], after["time"])],
    )
    bad = context_source(spec(metrics=["M2"], orgs=["O2"]))
    bad["source_semantic_receipt"] += "x"
    missing = {"before": spec(metrics=["M2"], orgs=["O2"]), "changes": []}
    raw["context_sources"] = [bad, missing]
    result = admit(raw)
    assert result["context_diagnostics"] == [
        {"index": 0, "code": "TRANSITION_SOURCE_INVALID", "ignored": True},
        {"index": 1, "code": "TRANSITION_SOURCE_MISSING", "ignored": True},
    ]
    raw["goal"] += "，还用合成机构乙的合成规模金额当日数"
    with pytest.raises(ApplicationError) as caught:
        admit(raw)
    assert caught.value.code == "TRANSITION_SOURCE_INVALID"
    assert caught.value.details == {
        "context_sources": [
            {"index": 0, "code": "TRANSITION_SOURCE_INVALID"},
            {"index": 1, "code": "TRANSITION_SOURCE_MISSING"},
        ]
    }


def test_valid_context_can_explain_required_fact_when_an_unused_alternative_is_invalid():
    raw = retained_context_payload()
    valid = raw["context_sources"][0]
    invalid = context_source(spec(metrics=["M2"], orgs=["O2"]))
    invalid["source_semantic_receipt"] += "x"
    raw["context_sources"] = [invalid, valid]
    result = admit(raw)
    assert len(result["receipts"]) == 1
    assert result["context_diagnostics"] == [
        {"index": 0, "code": "TRANSITION_SOURCE_INVALID", "ignored": True}
    ]


def test_unused_context_with_actions_remains_a_protocol_error():
    before, after = spec(), spec(day="2026-06-30")
    raw = payload(
        "仅将合成机构甲日期改为2026年6月30日",
        before,
        after,
        [change("time", "set", before["time"], after["time"])],
    )
    context = context_source(spec(metrics=["M2"], orgs=["O2"]))
    context["changes"] = [change("metrics", "confirm", ["M2"], ["M2"])]
    raw["context_sources"] = [context]
    assert_error(raw, "TRANSITION_CONTEXT_INVALID")


def test_revoked_retained_context_cannot_explain_a_fact_or_receive_execution_receipt():
    raw = retained_context_payload()
    with pytest.raises(ApplicationError) as caught:
        admit(raw, permissions=SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"}))
    assert caught.value.code == "TRANSITION_SCOPE_DENIED"
    assert caught.value.details == {
        "context_sources": [{"index": 0, "code": "TRANSITION_SCOPE_DENIED"}]
    }


def test_new_only_admission_remains_strict_even_if_an_unrelated_context_is_rejected():
    first = "查合成机构甲2026年5月31日的合成收益金额当日数"
    raw = payload(first, spec(), spec(), [])
    raw["steps"][0].pop("transition")
    raw["steps"][0]["origin"] = "user_explicit"
    raw["context_sources"] = [context_source(spec(metrics=["M2"], orgs=["O2"]))]
    mention = "合成收益金额当日数"
    start = first.index(mention)
    raw["fragment_bindings"] = {
        "0": [{"start": start, "end": start + len(mention), "text": mention, "codes": ["M1"]}]
    }
    result = admit(raw, permissions=SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"}))
    assert len(result["receipts"]) == 1
    assert result["context_diagnostics"][0]["code"] == "TRANSITION_SCOPE_DENIED"
    raw["goal"] += "；合成机构甲2026年5月31日的合成规模金额当日数"
    assert_error(raw, "PLAN_TARGETS_INCOMPLETE")


@pytest.mark.parametrize("correct", [False, True])
def test_org_metric_bindings_checked_even_when_dates_are_inherited(correct):
    before = [spec(metrics=["M2"], orgs=["O1"]), spec(metrics=["M1"], orgs=["O2"])]
    after = [spec(metrics=["M1"], orgs=["O1"]), spec(metrics=["M2"], orgs=["O2"])] if correct else before
    raw = payload("合成机构甲改查合成收益金额当日数；合成机构乙改查合成规模金额当日数", before[0], after[0], [])
    raw["steps"] = [{"target_ref": str(i), "fragment": i, "origin": "history", "spec": value,
                     "transition": {"before": before[i], "source_semantic_receipt": receipt(before[i]),
                                    "changes": [change("metrics", "set", before[i]["metric_codes"], value["metric_codes"])] if correct else []}}
                    for i, value in enumerate(after)]
    if correct:
        assert admit(raw)["status"] == "admitted"
    else:
        assert_error(raw, "PLAN_TARGETS_INCOMPLETE")
