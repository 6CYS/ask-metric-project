"""阶段3：合成目录、身份与独立任务准入；不连接数据库或模型。"""
from datetime import date
from types import SimpleNamespace
import pytest
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.analysis_selection import issue_selection, verify_selection
from ask_metric.api.routes.business_context import PlanAdmissionRequest, admit_semantic_plan
from ask_metric.api.routes.tasks import BasicQueryRequest
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem

METRICS = [MetricCatalogItem(code="M1", name="合成收益金额当日数", unit="元"), MetricCatalogItem(code="M2", name="合成规模金额当日数", unit="元")]
ORGS = [OrganizationCatalogItem(code="O1", name="合成机构甲"), OrganizationCatalogItem(code="O2", name="合成机构乙")]
ACTOR = ActorContext(subject="synthetic", user_id="synthetic", org_id="O1", role_code="USER", authentication_method="local_jwt", trust_level="authenticated")
class Uow:
    metric_catalog = SimpleNamespace(list_enabled=lambda: METRICS)
    organization_catalog = SimpleNamespace(list_enabled=lambda: ORGS)
    conversations = SimpleNamespace(get_owned=lambda conversation, owner: SimpleNamespace() if conversation == "conversation" else None)
    def __enter__(self): return self
    def __exit__(self, *args): pass
PERMISSIONS = SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1", "O2"})
SETTINGS = SimpleNamespace(jwt_secret="synthetic-secret")

def spec(org="O1", metric="M1", day="2026-05-31"):
    return {"org_codes": [org], "metric_codes": [metric], "time": {"start": day, "end": day}, "selection": "exact", "operation": {"kind": "value"}}

def admission(goal, specs, analysis=False):
    facts = inspect_goal(goal, date(2026, 10, 14), METRICS, ORGS)
    bindings = {str(index): [{"start": mention["start"], "end": mention["end"], "text": mention["text"], "codes": mention["resolution"]["value"]["codes"]}
        for mention in fragment["mentions"] if mention["resolution"]["status"] == "resolved"] for index, fragment in enumerate(facts["fragments"])}
    return PlanAdmissionRequest.model_validate({"conversation_id": "conversation", "session_id": "session", "goal": goal, "business_date": "2026-10-14", "analysis": analysis,
        "steps": [{"target_ref": str(index), "fragment": fragment, "origin": "analysis_selected" if analysis else "user_explicit", "spec": value} for index, (fragment, value) in enumerate(specs)], "fragment_bindings": bindings})

def admit(payload): return admit_semantic_plan(payload, ACTOR, Uow(), PERMISSIONS, SETTINGS)

def test_goal_keeps_tuple_binding_and_shared_context():
    goal = inspect_goal("查合成机构甲2026年5月31日的合成收益金额当日数；合成机构乙6月30日的合成规模金额当日数", date(2026, 10, 14), METRICS, ORGS)
    assert [part["organizations"] for part in goal["fragments"]] == [["O1"], ["O2"]]
    assert goal["fragments"][1]["calendar"]["ranges"] == [{"start": "2026-06-30", "end": "2026-06-30"}]
    shared = inspect_goal("合成机构甲2026年5月31日，查询合成收益金额当日数和合成规模金额当日数", date(2026, 10, 14), METRICS, ORGS)
    assert len(shared["fragments"]) == 1 and len(shared["fragments"][0]["mentions"]) == 2


@pytest.mark.parametrize("question", [
    "合成收益金额当日数：2026年5月31日，合成机构甲",
    "2026年5月31日，合成收益金额当日数，合成机构甲",
    "合成收益金额当日数，合成机构甲，2026年5月31日",
])
def test_complementary_fields_form_one_target_regardless_of_order(question):
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert len(facts["fragments"]) == 1
    assert facts["fragments"][0]["organizations"] == ["O1"]
    assert len(admit(admission(question, [(0, spec())]))["receipts"]) == 1


def test_postfixed_organizations_keep_distinct_complete_targets():
    question = "合成收益金额当日数2026年5月31日，合成机构甲；合成规模金额当日数2026年6月30日，合成机构乙"
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert [part["organizations"] for part in facts["fragments"]] == [["O1"], ["O2"]]
    assert len(admit(admission(question, [(0, spec()), (1, spec("O2", "M2", "2026-06-30"))]))["receipts"]) == 2
    with pytest.raises(ApplicationError):
        admit(admission(question, [(0, spec("O2")), (1, spec("O1", "M2", "2026-06-30"))]))


def test_subject_position_population_is_same_target_not_an_empty_query():
    question = "合成机构甲2026年5月31日的合成收益金额当日数，在合成机构甲、合成机构乙这两家中排第几？"
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert len(facts["fragments"]) == 1
    position = {**spec(), "operation": {"kind": "rank_position"}, "comparison_scope": {"org_codes": ["O1", "O2"]}}
    assert len(admit(admission(question, [(0, position)]))["receipts"]) == 1


@pytest.mark.parametrize("conjunction", ["与", "和", "以及"])
def test_coordinated_org_date_pairs_share_only_the_metric(conjunction):
    question = f"分别查询合成机构甲2026年5月31日{conjunction}合成机构乙2026年6月30日的合成收益金额当日数"
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert [part["organizations"] for part in facts["fragments"]] == [["O1"], ["O2"]]
    assert len(admit(admission(question, [(0, spec()), (1, spec("O2", day="2026-06-30"))]))["receipts"]) == 2
    with pytest.raises(ApplicationError):
        admit(admission(question, [(0, {**spec(), "org_codes": ["O1", "O2"]}), (1, {**spec(day="2026-06-30"), "org_codes": ["O1", "O2"]})]))


def test_shared_orgs_and_dates_still_require_all_combinations():
    question = "合成机构甲和合成机构乙2026年5月31日与2026年6月30日的合成收益金额当日数"
    assert len(inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)["fragments"]) == 1
    with pytest.raises(ApplicationError):
        admit(admission(question, [(0, spec()), (0, spec("O2", day="2026-06-30"))]))


def test_overlapping_draft_sources_are_not_admitted_twice():
    question = "查询合成机构甲和合成机构乙2026年5月31日的合成收益金额当日数"
    combined = {**spec(), "org_codes": ["O1", "O2"]}
    with pytest.raises(ApplicationError) as caught:
        admit(admission(question, [(0, combined), (0, spec())]))
    assert caught.value.code == "PLAN_SOURCE_OVERLAP"
    assert len(admit(admission(question, [(0, spec()), (0, spec("O2"))]))["receipts"]) == 2


def test_history_signed_source_survives_readmission_and_rechecks_scope():
    original = admission("查合成机构甲2026年5月31日的合成收益金额当日数", [(0, spec())])
    receipt = admit(original)["receipts"][0]["receipt"]
    payload = admission("用刚才结果计算", [(0, spec())])
    payload.steps[0].origin = "history"
    payload.steps[0].source_semantic_receipt = receipt
    assert len(admit(payload)["receipts"]) == 1
    payload.steps[0].spec.org_codes = ["O2"]
    with pytest.raises(ApplicationError):
        admit(payload)

def test_admitted_scope_is_signed_and_verified_again_at_execution():
    payload = admission("查合成机构甲2026年5月31日的合成收益金额当日数；合成机构乙2026年6月30日的合成规模金额当日数", [(0, spec()), (1, spec("O2", "M2", "2026-06-30"))])
    receipt = admit(payload)["receipts"][0]["receipt"]
    scope = payload.steps[0].spec.model_dump(mode="json", exclude_none=True)
    verify_selection(receipt, owner="synthetic", conversation="conversation", codes=["M1"], scope=scope, catalog=METRICS, secret=SETTINGS.jwt_secret)
    for change in [{"owner": "another"}, {"conversation": "another"}, {"codes": ["M2"]}, {"scope": {**scope, "selection": "latest_in_range"}}]:
        options = {"owner": "synthetic", "conversation": "conversation", "codes": ["M1"], "scope": scope, "catalog": METRICS, "secret": SETTINGS.jwt_secret, **change}
        with pytest.raises(ApplicationError): verify_selection(receipt, **options)
    BasicQueryRequest.model_validate({**spec(), "conversation_id": "conversation", "source_semantic_receipt": receipt})

@pytest.mark.parametrize("steps", [
    [(0, spec())],
    [(0, spec("O2")), (1, spec("O1", "M2", "2026-06-30"))],
    [(0, spec(day="2026-06-30")), (1, spec("O2", "M2"))],
    [(0, spec(metric="M2")), (1, spec("O2", "M1", "2026-06-30"))],
])
def test_omitted_or_crossed_targets_fail_whole_admission(steps):
    payload = admission("查合成机构甲2026年5月31日的合成收益金额当日数；合成机构乙2026年6月30日的合成规模金额当日数", steps)
    with pytest.raises(ApplicationError): admit(payload)

def test_union_of_codes_is_insufficient_for_each_org_metric_combination():
    payload = admission("查合成机构甲和合成机构乙2026年5月31日的合成收益金额当日数和合成规模金额当日数", [(0, spec()), (0, spec("O2", "M2"))])
    with pytest.raises(ApplicationError): admit(payload)
    payload.steps[0].spec.org_codes = ["O1", "O2"]
    payload.steps[1].spec.org_codes = ["O1", "O2"]
    assert len(admit(payload)["receipts"]) == 2

def test_analysis_selection_can_add_but_cannot_drop_explicit_metric_or_scope():
    payload = admission("分析合成机构甲2026年5月31日的经营情况", [(0, spec()), (0, spec(metric="M2"))], analysis=True)
    assert len(admit(payload)["receipts"]) == 2
    payload = admission("分析合成机构甲2026年5月31日的合成收益金额当日数", [(0, spec(metric="M2"))], analysis=True)
    assert len(admit(payload)["receipts"]) == 1  # 分析可先执行有效子目标；任务账本保留未取证的显式指标。

def test_source_receipt_rejects_malformed_tampered_or_changed_catalog():
    options = {"owner": "synthetic", "conversation": "conversation", "codes": ["M1"], "scope": spec(), "catalog": METRICS, "secret": SETTINGS.jwt_secret}
    receipt = issue_selection(**options, session="session", goal="synthetic goal")
    for token in ["", ".", "hello.world", receipt + "x"]:
        with pytest.raises(ApplicationError): verify_selection(token, **options)
    with pytest.raises(ApplicationError): verify_selection(receipt, **{**options, "catalog": [MetricCatalogItem(code="M1", name="更改后的正式指标", unit="元")]})


def test_calendar_in_calculation_labels_does_not_create_additional_month_query():
    text = "查询合成机构甲2026年5月31日与2026年6月30日的合成收益金额当日数，计算六月减五月的差额"
    result = inspect_goal(text, date(2026, 10, 14), METRICS, ORGS)
    assert result["requires_calculation"] is True
    assert result["fragments"][0]["calendar"]["ranges"] == [
        {"start": "2026-05-31", "end": "2026-05-31"}, {"start": "2026-06-30", "end": "2026-06-30"}]
    assert len(admit(admission(text, [(0, spec()), (0, spec(day="2026-06-30"))]))["receipts"]) == 2
    # 明确整月取数不属于计算来源简称，不得因同句月末而删除。
    full = inspect_goal("查询合成机构甲2026年5月31日合成收益金额当日数，以及2026年5月全部记录", date(2026, 10, 14), METRICS, ORGS)
    assert any(value["start"] == "2026-05-01" for part in full["fragments"] for value in part["calendar"]["ranges"])


def test_history_delta_keeps_inherited_binding_and_checks_new_explicit_date():
    old = admission("查合成机构甲2026年5月31日的合成收益金额当日数", [(0, spec())])
    def update(day):
        payload = admission("日期改为2026年6月30日", [(0, spec(day=day))])
        step = payload.steps[0]; step.origin = "history"; step.source_question = old.goal
        step.bindings = old.fragment_bindings["0"]
        return payload
    assert len(admit(update("2026-06-30"))["receipts"]) == 1
    with pytest.raises(ApplicationError): admit(update("2026-05-31"))


def test_history_identity_survives_revocation_without_granting_data_access():
    from ask_metric.api.routes.business_context import InspectGoalRequest, inspect_business_goal
    original = admission("查合成机构乙2026年5月31日的合成收益金额当日数", [(0, spec("O2"))])
    receipt = admit(original)["receipts"][0]["receipt"]
    restricted = SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"})
    body = {"question": "重新展示第一次查询中合成机构乙的结果", "business_date": "2026-10-14"}
    hidden = inspect_business_goal(InspectGoalRequest.model_validate(body), ACTOR, Uow(), restricted, SETTINGS)
    assert not any(part["organizations"] for part in hidden["fragments"])
    body["history"] = {"conversation_id": "conversation", "session_id": "session", "sources": [{"spec": spec("O2"), "receipt": receipt}]}
    result = inspect_business_goal(InspectGoalRequest.model_validate(body), ACTOR, Uow(), restricted, SETTINGS)
    assert result["fragments"][0]["organizations"] == ["O2"]
    assert restricted.authorized_org_codes() == {"O1"}
    assert "rows" not in result
    body["history"]["sources"][0]["spec"] = spec("O1")
    with pytest.raises(ApplicationError) as error:
        inspect_business_goal(InspectGoalRequest.model_validate(body), ACTOR, Uow(), restricted, SETTINGS)
    assert error.value.code == "ANALYSIS_SOURCE_INVALID"


@pytest.mark.parametrize("field,value", [("session_id", "other-session"), ("conversation_id", "other-conversation")])
def test_history_identity_requires_original_session_and_owned_conversation(field, value):
    from fastapi import HTTPException
    from ask_metric.api.routes.business_context import InspectGoalRequest, inspect_business_goal
    receipt = admit(admission("查合成机构乙2026年5月31日的合成收益金额当日数", [(0, spec("O2"))]))["receipts"][0]["receipt"]
    history = {"conversation_id": "conversation", "session_id": "session", "sources": [{"spec": spec("O2"), "receipt": receipt}], field: value}
    with pytest.raises((ApplicationError, HTTPException)):
        inspect_business_goal(InspectGoalRequest.model_validate({"question": "展示合成机构乙的历史结果", "business_date": "2026-10-14", "history": history}), ACTOR, Uow(), PERMISSIONS, SETTINGS)


def test_typo_followup_grounds_matching_org_but_not_unrelated_org():
    # 追问错字（“沐阳呢？”）按解析阶梯同尺登记目录事实：与错字相符的机构准入放行，
    # 不相符的机构（模型换错对象）仍须被拒；inspect_goal 身份扫描保持严格精确。
    from ask_metric.application.org_aliases import derive_org_aliases
    typo_orgs = [
        OrganizationCatalogItem(code="O1", name="合成机构甲"),
        OrganizationCatalogItem(code="O2", name="合成机构乙"),
        OrganizationCatalogItem(code="O3", name="江苏沭阳农村商业银行",
                                aliases=derive_org_aliases("江苏沭阳农村商业银行")),
    ]
    class TypoUow:
        metric_catalog = SimpleNamespace(list_enabled=lambda: METRICS)
        organization_catalog = SimpleNamespace(list_enabled=lambda: typo_orgs)
        conversations = Uow.conversations
        def __enter__(self): return self
        def __exit__(self, *args): pass
    typo_uow = TypoUow()
    typo_permissions = SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1", "O2", "O3"})

    def typo_admit(payload):
        return admit_semantic_plan(payload, ACTOR, typo_uow, typo_permissions, SETTINGS)

    old = admission("查合成机构甲2026年5月31日的合成收益金额当日数", [(0, spec())])

    def followup(target_org):
        facts = inspect_goal("沐阳呢？", date(2026, 10, 14), METRICS, typo_orgs)
        bindings = {str(index): [{"start": m["start"], "end": m["end"], "text": m["text"],
                                  "codes": m["resolution"]["value"]["codes"]}
                                 for m in fragment["mentions"] if m["resolution"]["status"] == "resolved"]
                    for index, fragment in enumerate(facts["fragments"])}
        # 与生产一致：跨轮变更必须携带 transition（before=冻结来源 + 操作轨迹），
        # 机构变更的目录事实依据由 validate_transition 核验。
        transition = {"before": spec(), "source_question": old.goal, "bindings": old.fragment_bindings["0"],
                      "changes": [{"field": "organizations", "action": "set",
                                   "before": ["O1"], "after": [target_org]}]}
        payload = PlanAdmissionRequest.model_validate({
            "conversation_id": "conversation", "session_id": "session", "goal": "沐阳呢？",
            "business_date": "2026-10-14", "analysis": False,
            "steps": [{"target_ref": "0", "fragment": 0, "origin": "history",
                       "source_question": old.goal, "bindings": old.fragment_bindings["0"],
                       "spec": spec(org=target_org), "transition": transition}],
            "fragment_bindings": bindings})
        return payload

    # 错字原文不进入 inspect_goal 的机构身份（严格扫描，不静默替身）。
    assert not any(part["organizations"] for part in inspect_goal("沐阳呢？", date(2026, 10, 14), METRICS, typo_orgs)["fragments"])
    # 与错字相符的机构（沭阳）准入放行。
    assert len(typo_admit(followup("O3"))["receipts"]) == 1
    # 模型换错对象（合成机构乙）时准入仍拒绝。
    with pytest.raises(ApplicationError) as error:
        typo_admit(followup("O2"))
    assert "SOURCE_UNGROUNDED" in error.value.code
