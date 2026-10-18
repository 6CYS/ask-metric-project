"""resolve-field 的 suggested 通道：模型建议经服务端复核，不信任提交内容。

覆盖完整 raw_values + suggested 和旧版空原值建议请求，
权限过滤与 org-catalog 测试同一写法；目录别名按运行时合并形态构造。
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.business_context import router
from ask_metric.api.routes.catalogs import get_overview_permissions, get_uow
from ask_metric.application.org_aliases import derive_org_aliases
from ask_metric.application.requests import ActorContext

URL = "/api/v1/business-context/resolve-field"


def _item(code: str, name: str):
    from ask_metric.domain.semantics import OrganizationCatalogItem

    return OrganizationCatalogItem(code=code, name=name, aliases=derive_org_aliases(name))


ITEMS = [
    _item("321321", "江苏沭阳农村商业银行股份有限公司"),
    _item("321323", "江苏泗阳农村商业银行股份有限公司"),
    _item("320582", "江苏江阴农村商业银行股份有限公司"),
]
# 泗阳（321323）在目录中存在但对当前账号不可见。
ALLOWED = ["321321", "320582"]


@pytest.fixture
def client():
    class Uow:
        organization_catalog = SimpleNamespace(list_enabled=lambda: ITEMS)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_uow] = Uow
    app.dependency_overrides[get_overview_permissions] = lambda: SimpleNamespace(
        authorize_logical_dsl=lambda **kwargs: {"orgs": ALLOWED},
    )
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="synthetic", user_id="synthetic", org_id="320582", role_code="USER",
        authentication_method="local_jwt", trust_level="authenticated",
    )
    return TestClient(app)


def test_suggested_code_resolves_with_catalog_name_and_model_inferred(client):
    response = client.post(URL, json={
        "entity": "organization", "raw_values": [],
        "suggested": [{"code": "320582", "name": "模型随口写的名称", "excerpt": "用户原文"}],
    })
    body = response.json()
    assert body["status"] == "resolved"
    assert body["value"] == {
        "codes": ["320582"], "names": ["江苏江阴农村商业银行股份有限公司"],
    }
    assert body["metadata"]["resolution_source"] == "model_inferred"


def test_suggested_code_unauthorized_or_unknown_is_not_found_not_forbidden(client):
    for code in ("321323", "999999"):
        body = client.post(URL, json={
            "entity": "organization", "raw_values": [], "suggested": [{"code": code}],
        }).json()
        assert body["status"] == "not_found"
        assert "value" not in body


def test_suggested_name_without_hit_gets_fuzzy_suggestions(client):
    # 与目录有共同音节：给建议候选而非死胡同；完全无关输入才 not_found。
    body = client.post(URL, json={
        "entity": "organization", "raw_values": [],
        "suggested": [{"name": "锡银类无法命中的名称"}],
    }).json()
    assert body["status"] == "needs_confirmation"
    assert body["candidates"]
    assert all(c["metadata"]["match_kind"] == "fuzzy_suggestion" for c in body["candidates"])
    body = client.post(URL, json={
        "entity": "organization", "raw_values": [],
        "suggested": [{"name": "xyz123"}],
    }).json()
    assert body["status"] == "not_found"
    assert body["candidates"] == []


def test_suggested_name_typo_resolves_but_reports_model_inferred(client):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": [], "suggested": [{"name": "沐阳"}],
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["321321"]
    # 纠错路径被采纳，但来源按模型建议标记；纠错留痕仍保留。
    assert body["metadata"]["resolution_source"] == "model_inferred"
    assert body["metadata"]["corrections"][0]["corrected_code"] == "321321"


@pytest.mark.parametrize("suggested", [
    {},
    [{}],
    [{"code": "   "}],
    [{"name": ""}],
    [{"code": "x" * 256}],
    [{"name": "x" * 256}],
    {"code": "320582"},
    ["江阴"],
])
def test_invalid_suggested_shape_rejected_422(client, suggested):
    response = client.post(URL, json={
        "entity": "organization", "raw_values": [], "suggested": suggested,
    })
    assert response.status_code == 422


def test_empty_raw_values_without_suggested_rejected_422(client):
    response = client.post(URL, json={"entity": "organization", "raw_values": []})
    assert response.status_code == 422


def test_raw_values_determine_members_suggestion_does_not_append(client):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["江阴"],
        "suggested": [{"name": "沐阳"}],
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320582"]
    assert body["metadata"]["resolution_source"] == "exact"


def test_suggested_name_duplicating_raw_value_keeps_literal_source(client):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["江阴"],
        "suggested": [{"name": "江阴"}],
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320582"]
    assert body["metadata"]["resolution_source"] == "exact"


def test_suggested_merges_issues_and_candidates(client):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["不存在xyz"],
        "suggested": [{"code": "320582"}],
    }).json()
    assert body["status"] == "needs_confirmation"
    assert body["metadata"]["issues"] == [{"rawValue": "不存在xyz", "rawValueIndex": 0, "reason": "not_found"}]


def test_ungrounded_suggestion_overridden_by_unique_typo_ground(client):
    """模型把「沐阳」错换成江阴时：原文错字唯一登记沭阳，以原文为准并明示纠正。"""
    response = client.post(URL, json={
        "entity": "organization", "raw_values": [], "source_question": "沐阳的呢？",
        "suggested": [{"code": "320582", "name": "江苏江阴农村商业银行股份有限公司", "excerpt": "沐阳"}],
    })
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "resolved"
    assert body["value"] == {"codes": ["321321"], "names": ["江苏沭阳农村商业银行股份有限公司"]}
    assert body["metadata"]["resolution_source"] == "corrected"
    assert body["metadata"]["corrections"] == [
        {"raw": "沐阳", "corrected_name": "江苏沭阳农村商业银行股份有限公司", "corrected_code": "321321"}]


def test_ungrounded_suggestion_without_text_ground_stays_confirmation(client):
    """原文无目录事实（昵称/无关联措辞）：模型建议保持待确认并置顶。"""
    response = client.post(URL, json={
        "entity": "organization", "raw_values": [], "source_question": "那个银行的呢？",
        "suggested": [{"code": "320582", "name": "江苏江阴农村商业银行股份有限公司", "excerpt": "那个银行的"}],
    })
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "needs_confirmation"
    assert body["candidates"][0]["code"] == "320582"
    assert body["metadata"]["reason"] == "model_suggestion_requires_confirmation"


def test_partial_suggestion_keeps_complete_raw_organization_set(client):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["沭阳", "江阴"], "source_question": "查询沭阳、江阴同一天的指标",
        "suggested": [{"code": "321321", "excerpt": "沭阳"}],
    }).json()
    assert body["status"] == "resolved"
    assert set(body["value"]["codes"]) == set(ALLOWED)
    assert set(body["metadata"]["source_codes"]) == set(ALLOWED)


@pytest.mark.parametrize("raw,question,hint,expected", [
    (["沭阳"], "把江阴换成沭阳", {"code": "320582", "excerpt": "江阴"}, ["321321"]),
    (["江阴", "沭阳"], "查询江阴指标", {"code": "320582", "excerpt": "江阴"}, ["320582", "321321"]),
    (["江阴"], "查询江阴指标", {"code": "320582", "name": "错误名称"}, ["320582"]),
])
def test_hint_never_overwrites_or_expands_complete_raw_values(client, raw, question, hint, expected):
    body = client.post(URL, json={"entity": "organization", "raw_values": raw,
                                  "source_question": question, "suggested": [hint]}).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == expected
    assert body["metadata"]["resolution_source"] == "exact"


def test_pending_organization_slots_preserve_known_and_zero_candidate_members(client):
    raw = ["江阴", "xyz123", "农村商业银行"]
    body = client.post(URL, json={"entity": "organization", "raw_values": raw}).json()
    assert body["status"] != "resolved"
    assert body["metadata"]["partialMembers"]["codes"] == ["320582"]
    assert body["metadata"]["pendingRawValues"] == ["320582", "xyz123", "农村商业银行"]
    assert {entry["rawValueIndex"] for entry in body["metadata"]["issues"]} == {1, 2}
    assert all(entry["metadata"]["rawValueIndex"] == 2 for entry in body["candidates"])
    confirmed = client.post(URL, json={"entity": "organization", "raw_values": ["江阴", "xyz123", "321321"]}).json()
    assert confirmed["status"] == "not_found"
    assert set(confirmed["metadata"]["partialMembers"]["codes"]) == set(ALLOWED)
    assert confirmed["metadata"]["issues"][0]["rawValue"] == "xyz123"


def test_hidden_exact_institution_is_not_corrected_to_visible_near_name(client):
    body = client.post(URL, json={"entity": "organization", "raw_values": ["江阴", "泗阳"],
                                  "source_question": "查询江阴、泗阳指标",
                                  "suggested": [{"code": "321321", "excerpt": "泗阳"}]}).json()
    assert body["status"] == "not_found"
    assert "value" not in body
    assert body["metadata"]["partialMembers"]["codes"] == ["320582"]
    assert body["metadata"]["source_codes"] == ["320582"]
    assert not body["candidates"]
    assert "321321" not in str(body)
    assert "321323" not in str(body)


def test_legacy_hint_uses_own_excerpt_not_other_subject_in_question(client):
    body = client.post(URL, json={"entity": "organization", "raw_values": [],
        "source_question": "把江阴换成沐阳", "suggested": [{"code": "320582", "excerpt": "沐阳"}]}).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["321321"]


@pytest.mark.parametrize("raw", [["泗阳", "农村商业银行"], ["泗洋", "xyz123"]])
def test_pending_metadata_does_not_publish_hidden_resolved_codes(client, raw):
    body = client.post(URL, json={"entity": "organization", "raw_values": raw}).json()
    assert body["status"] == "not_found"
    assert body["metadata"]["pendingRawValues"][0] == raw[0]
    assert "321323" not in str(body)
    assert any(entry["rawValueIndex"] == 0 for entry in body["metadata"]["issues"])



def test_ungrounded_canonical_hint_keeps_its_ambiguous_user_excerpt(client):
    body = client.post(URL, json={"entity": "organization", "raw_values": ["江苏沭阳农村商业银行股份有限公司"],
        "source_question": "查询江阴和农村商业银行", "suggested": [{"code": "321321", "excerpt": "农村商业银行"}]}).json()
    assert body["status"] == "ambiguous"
    assert body["metadata"]["hint_source_bound"] is True
    assert body["metadata"]["pendingRawValues"] == ["农村商业银行"]
    assert {entry["code"] for entry in body["candidates"]} == set(ALLOWED)
    assert "value" not in body



def test_hint_excerpt_cannot_borrow_another_organization_from_whole_question(client):
    body = client.post(URL, json={"entity": "organization", "raw_values": ["江苏江阴农村商业银行股份有限公司"],
        "source_question": "江阴和锡银分别是多少", "suggested": [{"code": "320582", "excerpt": "锡银"}]}).json()
    assert body["status"] != "resolved"
    assert body["metadata"]["hint_source_bound"] is True
    assert body["metadata"]["extractedRawValues"] == ["锡银"]
    assert "value" not in body


def test_literal_raw_identity_stays_authoritative_when_hint_excerpt_conflicts(client):
    body = client.post(URL, json={"entity": "organization", "raw_values": ["江阴"],
        "source_question": "江阴和锡银分别是多少", "suggested": [{"code": "320582", "excerpt": "锡银"}]}).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320582"]


@pytest.mark.parametrize("hint", [{"code": "320582", "excerpt": "江阴"}, {"code": "320582"}])
def test_known_member_hint_does_not_prefer_another_pending_slot(client, hint):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["江阴", "农村商业银行"],
        "source_question": "查询江阴和农村商业银行两家",
        "suggested": [hint],
    }).json()
    assert body["status"] == "ambiguous"
    assert body["metadata"]["partialMembers"]["codes"] == ["320582"]
    assert body["metadata"]["pendingRawValues"] == ["320582", "农村商业银行"]
    assert body["candidates"]
    assert not any(candidate.get("preferred") for candidate in body["candidates"])
    assert all(candidate["metadata"]["rawValueIndex"] == 1 for candidate in body["candidates"])
