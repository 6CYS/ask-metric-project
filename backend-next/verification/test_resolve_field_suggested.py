"""resolve-field 的 suggested 通道：模型建议经服务端复核，不信任提交内容。

模拟 agent-service 的真实请求形状（raw_values 为空 + suggested），
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


def test_raw_values_and_suggested_merge_into_one_response(client):
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["江阴"],
        "suggested": [{"name": "沐阳"}],
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320582", "321321"]
    # 多来源取最弱：model_inferred 弱于 exact。
    assert body["metadata"]["resolution_source"] == "model_inferred"


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
    assert body["status"] == "not_found"
    assert body["metadata"]["issues"] == [{"rawValue": "不存在xyz", "reason": "not_found"}]
