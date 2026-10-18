"""目标事实与历史定位：合成目录、身份；不连接数据库或模型。

旧计划准入接口、签票/验票与原句覆盖复核已删除；本文件保留对
inspect_goal 片段事实（机构/日期/指标绑定、参照年份、计算标记）及
inspect-goal 历史通道（归属校验、历史机构仅作定位消歧）的有效行为断言。
"""
from datetime import date
from types import SimpleNamespace

import pytest

from ask_metric.api.routes.business_context import InspectGoalRequest, inspect_business_goal
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.requests import ActorContext
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

def spec(org="O1", metric="M1", day="2026-05-31"):
    return {"org_codes": [org], "metric_codes": [metric], "time": {"start": day, "end": day}, "selection": "exact", "operation": {"kind": "value"}}

def test_goal_keeps_tuple_binding_and_shared_context():
    goal = inspect_goal("查合成机构甲2026年5月31日的合成收益金额当日数；合成机构乙6月30日的合成规模金额当日数", date(2026, 10, 14), METRICS, ORGS)
    assert [part["organizations"] for part in goal["fragments"]] == [["O1"], ["O2"]]
    assert goal["fragments"][1]["calendar"]["ranges"] == [{"start": "2026-06-30", "end": "2026-06-30"}]
    shared = inspect_goal("合成机构甲2026年5月31日，查询合成收益金额当日数和合成规模金额当日数", date(2026, 10, 14), METRICS, ORGS)
    assert len(shared["fragments"]) == 1 and len(shared["fragments"][0]["mentions"]) == 2


def test_reference_year_prefers_caller_value_over_question_text():
    # 外部已提供参照年份时不再被原文首个“\d{4}年”覆盖，各环节同一来源。
    question = "查合成机构甲2025年5月31日的合成收益金额当日数，再看4月"
    provided = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS, reference_year=2030)
    assert provided["reference_year"] == 2030
    ranges = [value for part in provided["fragments"] for value in part["calendar"]["ranges"]]
    assert {"start": "2030-04-01", "end": "2030-04-30"} in ranges
    derived = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert derived["reference_year"] == 2025
    ranges = [value for part in derived["fragments"] for value in part["calendar"]["ranges"]]
    assert {"start": "2025-04-01", "end": "2025-04-30"} in ranges


@pytest.mark.parametrize("question", [
    "合成收益金额当日数：2026年5月31日，合成机构甲",
    "2026年5月31日，合成收益金额当日数，合成机构甲",
    "合成收益金额当日数，合成机构甲，2026年5月31日",
])
def test_complementary_fields_form_one_target_regardless_of_order(question):
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert len(facts["fragments"]) == 1
    assert facts["fragments"][0]["organizations"] == ["O1"]


def test_postfixed_organizations_form_distinct_targets():
    question = "合成收益金额当日数2026年5月31日，合成机构甲；合成规模金额当日数2026年6月30日，合成机构乙"
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert [part["organizations"] for part in facts["fragments"]] == [["O1"], ["O2"]]


def test_subject_position_population_forms_one_fragment():
    question = "合成机构甲2026年5月31日的合成收益金额当日数，在合成机构甲、合成机构乙这两家中排第几？"
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert len(facts["fragments"]) == 1


@pytest.mark.parametrize("conjunction", ["与", "和", "以及"])
def test_coordinated_org_date_pairs_share_only_the_metric(conjunction):
    question = f"分别查询合成机构甲2026年5月31日{conjunction}合成机构乙2026年6月30日的合成收益金额当日数"
    facts = inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)
    assert [part["organizations"] for part in facts["fragments"]] == [["O1"], ["O2"]]


def test_shared_orgs_and_dates_form_one_fragment():
    question = "合成机构甲和合成机构乙2026年5月31日与2026年6月30日的合成收益金额当日数"
    assert len(inspect_goal(question, date(2026, 10, 14), METRICS, ORGS)["fragments"]) == 1


def test_calendar_in_calculation_labels_does_not_create_additional_month_query():
    text = "查询合成机构甲2026年5月31日与2026年6月30日的合成收益金额当日数，计算六月减五月的差额"
    result = inspect_goal(text, date(2026, 10, 14), METRICS, ORGS)
    assert result["requires_calculation"] is True
    assert result["fragments"][0]["calendar"]["ranges"] == [
        {"start": "2026-05-31", "end": "2026-05-31"}, {"start": "2026-06-30", "end": "2026-06-30"}]
    # 明确整月取数不属于计算来源简称，不得因同句月末而删除。
    full = inspect_goal("查询合成机构甲2026年5月31日合成收益金额当日数，以及2026年5月全部记录", date(2026, 10, 14), METRICS, ORGS)
    assert any(value["start"] == "2026-05-01" for part in full["fragments"] for value in part["calendar"]["ranges"])


def test_history_identity_survives_revocation_without_granting_data_access():
    # 历史 spec 的机构只作定位消歧：失权后仍能用历史条件定位目标，
    # 但不改变当前账号权限、不返回数据、不触发重跑。
    restricted = SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"})
    body = {"question": "重新展示第一次查询中合成机构乙的结果", "business_date": "2026-10-14"}
    hidden = inspect_business_goal(InspectGoalRequest.model_validate(body), ACTOR, Uow(), restricted)
    assert not any(part["organizations"] for part in hidden["fragments"])
    body["history"] = {"conversation_id": "conversation", "session_id": "session", "sources": [{"spec": spec("O2")}]}
    result = inspect_business_goal(InspectGoalRequest.model_validate(body), ACTOR, Uow(), restricted)
    assert result["fragments"][0]["organizations"] == ["O2"]
    assert restricted.authorized_org_codes() == {"O1"}
    assert "rows" not in result


def test_history_requires_owned_conversation():
    from fastapi import HTTPException
    history = {"conversation_id": "other-conversation", "session_id": "session", "sources": [{"spec": spec("O2")}]}
    with pytest.raises(HTTPException):
        inspect_business_goal(InspectGoalRequest.model_validate({"question": "展示合成机构乙的历史结果", "business_date": "2026-10-14", "history": history}), ACTOR, Uow(), PERMISSIONS)


def test_typo_followup_does_not_register_org_identity_in_goal_facts():
    # 整句不再错字滑窗：“沐阳呢？”的完整原问只做精确覆盖，inspect_goal
    # 身份扫描保持严格精确；错字纠错由 resolve-field 机构槽位通道处理
    # （等价行为见 test_org_typo_scope.py 的 resolve-field 用例）。
    from ask_metric.application.org_aliases import derive_org_aliases
    typo_orgs = [
        OrganizationCatalogItem(code="O1", name="合成机构甲"),
        OrganizationCatalogItem(code="O2", name="合成机构乙"),
        OrganizationCatalogItem(code="O3", name="江苏沭阳农村商业银行",
                                aliases=derive_org_aliases("江苏沭阳农村商业银行")),
    ]
    assert not any(part["organizations"] for part in inspect_goal("沐阳呢？", date(2026, 10, 14), METRICS, typo_orgs)["fragments"])
