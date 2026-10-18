"""已采纳日历（model_value）在 resolve-field 的复用与反例。

合成目录，固定业务日 2026-10-17，不连接数据库或模型。覆盖验收 A5 后端锚点：
- 词法不支持的区间表达经 resolve-field 采纳 model_value 后，直接复用为来源
  对账，不再用旧词法重扫同一表达；
- 确定性命中维持原文词法对账；
- 只命中区间一端（漏另一端）的表达拒绝按单点执行，来源扫描保持未决。

旧计划准入侧的 model_value 复核随接口删除（跨轮时间修改的日历
事实由宿主统一状态负责）。
"""

from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.business_context import router
from ask_metric.api.routes.catalogs import get_overview_permissions, get_uow
from ask_metric.application.requests import ActorContext
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem

BUSINESS_DATE = date(2026, 10, 17)
METRICS = [MetricCatalogItem(code="M1", name="合成收益金额当日数", unit="元")]
ORGS = [OrganizationCatalogItem(code="O1", name="合成机构甲")]
ACTOR = ActorContext(
    subject="synthetic", user_id="synthetic", org_id="O1", role_code="USER",
    authentication_method="local_jwt", trust_level="authenticated",
)
PERMISSIONS = SimpleNamespace(authorized_org_codes=lambda **kwargs: {"O1"})


class Uow:
    metric_catalog = SimpleNamespace(list_enabled=lambda: METRICS)
    organization_catalog = SimpleNamespace(list_enabled=lambda: ORGS)
    conversations = SimpleNamespace(get_owned=lambda conversation, owner: SimpleNamespace())

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_uow] = Uow
    app.dependency_overrides[get_overview_permissions] = lambda: PERMISSIONS
    app.dependency_overrides[require_actor] = lambda: ACTOR
    return TestClient(app)


def test_resolve_field_reuses_adopted_value_as_source_calendar(client):
    body = client.post("/api/v1/business-context/resolve-field", json={
        "entity": "date", "raw_values": ["从去年最后一天到今年九月底"],
        "business_date": "2026-10-17",
        "source_question": "查询合成机构甲从去年最后一天到今年九月底的全部已有记录",
        "model_value": {"start": "2025-12-31", "end": "2026-09-30"},
    }).json()
    assert body["status"] == "resolved"
    assert body["metadata"]["resolution_source"] == "model"
    # 已采纳结果直接复用为来源对账，不再用旧词法重扫同一表达。
    assert body["metadata"]["source_calendar"] == {
        "ranges": [{"start": "2025-12-31", "end": "2026-09-30"}], "unresolved": [],
    }


def test_resolve_field_deterministic_hit_keeps_lexical_source_calendar(client):
    body = client.post("/api/v1/business-context/resolve-field", json={
        "entity": "date", "raw_values": ["今年3月末"],
        "business_date": "2026-10-17",
        "source_question": "张家港行今年3月末大聪明有多少？",
        "model_value": {"start": "2020-03-31", "end": "2020-03-31"},
    }).json()
    assert body["status"] == "resolved"
    assert body["metadata"]["resolution_source"] == "deterministic"
    assert body["value"] == {"start": "2026-03-31", "end": "2026-03-31"}
    assert body["metadata"]["source_calendar"]["ranges"] == [
        {"start": "2026-03-31", "end": "2026-03-31"},
    ]


@pytest.mark.parametrize("raw", ["到2026年9月末", "到2026年9月末的全部已有记录", "2021年末到"])
def test_resolve_field_refuses_model_value_for_one_sided_range(client, raw):
    """A5d 反例：只解释一端的表达不能靠模型单点换算截成完整日历。"""
    body = client.post("/api/v1/business-context/resolve-field", json={
        "entity": "date", "raw_values": [raw],
        "business_date": "2026-10-17",
        "source_question": f"查询张家港行个人活期存款余额当日数，{raw}",
        "model_value": {"start": "2026-09-30", "end": "2026-09-30"},
    }).json()
    assert body["status"] == "invalid"
    assert body["metadata"]["reason"] == "incomplete_range"


def test_source_calendar_keeps_open_range_unresolved():
    """只给出一端的区间在整句来源扫描中仍为未解释，不按单点执行。"""
    from ask_metric.application.field_resolution import source_calendar_constraints
    source = source_calendar_constraints(
        "查询张家港行个人活期存款余额当日数，到2026年9月末的全部已有记录",
        BUSINESS_DATE,
    )
    assert source["unresolved"]
    assert all(not (value["start"] == value["end"] == "2026-09-30") for value in source["ranges"])
