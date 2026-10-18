"""机构错字纠错限定机构槽位，完整原问只做精确覆盖。

合成目录（张家港/大丰/启东/江阴），不连接数据库或模型。覆盖验收 A4/A7 后端锚点：
- 整句“大聪明”不再经滑窗纠错虚增“大丰”目录事实；
- 机构槽位原值“启动”仍经解析阶梯纠错为启东并留痕（供宿主明示确认）；
- 模型预纠值回记原文槽位；无依据的建议保持待确认。

旧计划准入跨轮变更侧的错字放行规则随接口删除（跨轮修改的绑定
由宿主统一状态负责）。
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
from ask_metric.domain.semantics import OrganizationCatalogItem

URL = "/api/v1/business-context/resolve-field"


def _item(code: str, name: str) -> OrganizationCatalogItem:
    return OrganizationCatalogItem(code=code, name=name, aliases=derive_org_aliases(name))


ITEMS = [
    _item("320581", "江苏张家港农村商业银行股份有限公司"),
    _item("320175", "江苏大丰农村商业银行"),
    _item("320681", "江苏启东农村商业银行"),
    _item("320582", "江苏江阴农村商业银行股份有限公司"),
]
ALLOWED = [item.code for item in ITEMS]


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


def test_whole_question_typo_does_not_register_catalog_fact(client):
    """A4：整句“大聪明”只做精确覆盖，不能把“大聪”错认成“大丰”登记为目录事实。"""
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["张家港"],
        "source_question": "张家港行今年3月末大聪明有多少？",
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320581"]
    assert body["metadata"]["source_codes"] == ["320581"]
    assert "320175" not in str(body)


def test_slot_raw_value_typo_still_corrects_with_explicit_trace(client):
    """A7：机构槽位原值“启动”经解析阶梯纠正为启东，纠错留痕供明示确认。"""
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["启动"], "source_question": "只看启动",
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320681"]
    assert body["metadata"]["resolution_source"] == "corrected"
    assert body["metadata"]["corrections"][0]["raw"] == "启动"
    # 槽位原值确为本轮连续原文：错字依据回记到该槽位。
    assert body["metadata"]["source_codes"] == ["320681"]


def test_slot_excerpt_typo_still_grounds_suggestion(client):
    """槽位 excerpt（模型绑定且确为本轮连续原文）保留错字对账。"""
    body = client.post(URL, json={
        "entity": "organization", "raw_values": [], "source_question": "只看启动",
        "suggested": [{"code": "320681", "excerpt": "启动"}],
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320681"]


def test_precorrected_slot_value_is_rebound_to_original_wording(client):
    """模型把原文“启动”预纠成“启东”时，回记原文槽位供重新解析并保留纠正痕迹。"""
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["启东"], "source_question": "只看启动",
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320681"]
    assert body["metadata"]["source_codes"] == ["320681"]
    assert body["metadata"]["hint_source_bound"] is True
    assert body["metadata"]["extractedRawValues"] == ["启动"]
    assert body["metadata"]["corrections"][0] == {
        "raw": "启动", "corrected_name": "江苏启东农村商业银行", "corrected_code": "320681",
    }


def test_unrelated_slot_value_is_not_rebound_from_whole_question(client):
    """整句虽有近音机构片段，但槽位身份与扫描结果不一致时不得回记来源。"""
    body = client.post(URL, json={
        "entity": "organization", "raw_values": ["张家港"], "source_question": "张家港行今年3月末大聪明有多少？",
    }).json()
    assert body["status"] == "resolved"
    assert body["value"]["codes"] == ["320581"]
    assert body["metadata"]["source_codes"] == ["320581"]
    assert "320175" not in str(body)
