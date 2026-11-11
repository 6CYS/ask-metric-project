"""报告布局使用隔离知识文件与目录，不扩大方案实际取数指标。"""

import json

import pytest
from test_business_knowledge import URL
from test_business_knowledge import environment as environment
from test_business_knowledge import metric_catalog as metric_catalog


@pytest.fixture
def layout_catalog(metric_catalog):
    from ask_metric.infrastructure.db.models import MetricTerm
    from ask_metric.infrastructure.db.session import get_app_session_factory

    with get_app_session_factory()() as session:
        session.add(MetricTerm(metric_code="ORG_C", metric_name="补查展示指标"))
        session.commit()
    return metric_catalog


def layout():
    return {
        "title": "经营对比报告",
        "sections": [
            {"id": "scale", "title": "规模与结构", "metric_codes": ["ORG_A"], "table": True},
            {"id": "income", "title": "收入专题", "metric_codes": ["ORG_C"], "table": False},
        ],
    }


def create_plan(client, **changes):
    return client.post(URL, json={
        "title": "经营对比报告", "text": "按实际证据说明差异。",
        "revision": client.get(URL).json()["revision"],
        "batch_query_enabled": True, "metric_codes": ["ORG_A"],
        "report_layout": layout(), **changes,
    })


def test_layout_round_trip_preserves_supplemental_display_metrics_without_expanding_query(
    layout_catalog,
):
    client, path, _ = layout_catalog
    submitted = layout()
    submitted["sections"][0]["metric_codes"] = [" ORG_A ", "ORG_A"]
    created = create_plan(client, report_layout=submitted)

    assert created.status_code == 201
    item = created.json()["item"]
    assert item["report_layout"] == layout()
    assert item["metric_codes"] == ["ORG_A"]
    stored = next(entry for entry in json.loads(path.read_text())["entries"]
                  if entry["id"] == item["id"])
    assert stored["report_layout"] == layout()
    listed = next(entry for entry in client.get(URL).json()["items"]
                  if entry["id"] == item["id"])
    assert listed["report_layout"] == layout()
    plan = client.get(f"/api/v1/business-knowledge/{item['id']}/analysis-plan").json()
    assert plan["entry"]["report_layout"] == layout()
    result = client.post("/api/v1/business-knowledge/search", json={
        "query": "经营对比报告",
    }).json()
    assert result["entries"][0]["report_layout"] == layout()
    assert result["entries"][0]["metric_codes"] == ["ORG_A"]
    assert [metric["code"] for metric in result["linked_catalog"]["items"]] == ["ORG_A"]


def test_legacy_edit_preserves_layout_and_explicit_null_clears_it(layout_catalog):
    client, path, _ = layout_catalog
    created = create_plan(client)
    assert created.status_code == 201
    original = created.json()
    entry_id = original["item"]["id"]
    edited = client.put(f"{URL}/{entry_id}", json={
        "title": "经营对比报告", "text": "精简表单修改正文。", "revision": original["revision"],
    })
    assert edited.status_code == 200
    assert edited.json()["item"]["report_layout"] == layout()
    cleared = client.put(f"{URL}/{entry_id}", json={
        "title": "经营对比报告", "text": "清除布局。", "report_layout": None,
        "revision": edited.json()["revision"],
    })
    assert cleared.status_code == 200
    assert "report_layout" not in cleared.json()["item"]
    assert cleared.json()["item"]["batch_query_enabled"] is True
    saved = next(entry for entry in json.loads(path.read_text())["entries"]
                 if entry["id"] == entry_id)
    assert "report_layout" not in saved


def test_layout_can_be_updated_without_resending_existing_batch_fields(layout_catalog):
    client, _, _ = layout_catalog
    created = create_plan(client)
    assert created.status_code == 201
    data = created.json()
    initial_plan = client.get(
        f"/api/v1/business-knowledge/{data['item']['id']}/analysis-plan",
    ).json()
    revised = layout()
    revised["title"] = "更新后的经营报告"
    edited = client.put(f"{URL}/{data['item']['id']}", json={
        "title": "经营对比报告", "text": "保持取数方案。", "report_layout": revised,
        "revision": data["revision"],
    })
    assert edited.status_code == 200
    assert edited.json()["item"]["report_layout"] == revised
    assert edited.json()["item"]["metric_codes"] == ["ORG_A"]
    revised_plan = client.get(
        f"/api/v1/business-knowledge/{data['item']['id']}/analysis-plan",
    ).json()
    assert revised_plan["version"] != initial_plan["version"]


def test_layout_requires_batch_plan_and_cannot_be_left_on_disabled_batch_mode(layout_catalog):
    client, path, _ = layout_catalog
    before = path.read_bytes()
    refused = create_plan(client, batch_query_enabled=False)
    assert refused.status_code == 422
    assert path.read_bytes() == before
    created = create_plan(client)
    assert created.status_code == 201
    data = created.json()
    before = path.read_bytes()
    refused = client.put(f"{URL}/{data['item']['id']}", json={
        "title": "经营对比报告", "text": "关闭批量取数。", "batch_query_enabled": False,
        "revision": data["revision"],
    })
    assert refused.status_code == 422
    assert path.read_bytes() == before
    cleared = client.put(f"{URL}/{data['item']['id']}", json={
        "title": "经营对比报告", "text": "关闭批量取数并清除布局。",
        "batch_query_enabled": False, "report_layout": None, "revision": data["revision"],
    })
    assert cleared.status_code == 200
    assert "report_layout" not in cleared.json()["item"]


def test_new_layout_does_not_implicitly_enable_batch_query(layout_catalog):
    client, path, _ = layout_catalog
    before = path.read_bytes()
    refused = client.post(URL, json={
        "title": "报告", "text": "布局不能替代明确的批量取数配置。",
        "report_layout": layout(), "metric_codes": ["ORG_A"],
        "revision": client.get(URL).json()["revision"],
    })
    assert refused.status_code == 422
    assert path.read_bytes() == before


@pytest.mark.parametrize("method,suffix", [("post", ""), ("put", "/legacy")])
def test_unknown_layout_metric_never_writes_knowledge(layout_catalog, method, suffix):
    client, path, _ = layout_catalog
    before = path.read_bytes()
    invalid = layout()
    invalid["sections"][1]["metric_codes"] = ["MISSING"]
    response = getattr(client, method)(URL + suffix, json={
        "title": "经营对比报告", "text": "未知展示指标。", "report_layout": invalid,
        "batch_query_enabled": True, "metric_codes": ["ORG_A"],
        "revision": client.get(URL).json()["revision"],
    })
    assert response.status_code == 422
    assert response.json()["code"] == "BUSINESS_KNOWLEDGE_METRIC_NOT_FOUND"
    assert path.read_bytes() == before


@pytest.mark.parametrize("invalid", [
    {"title": "", "sections": []},
    {"title": "甲" * 201, "sections": layout()["sections"]},
    {"title": "报告", "sections": []},
    {"title": "报告", "sections": [
        {"id": str(index), "title": "专题", "metric_codes": [], "table": False}
        for index in range(13)
    ]},
    {"title": "报告", "sections": [layout()["sections"][0], layout()["sections"][0]]},
    {"title": "报告", "sections": [
        {"id": "a" * 65, "title": "专题", "metric_codes": [], "table": False},
    ]},
    {"title": "报告", "sections": [
        {"id": "a", "title": "甲" * 101, "metric_codes": [], "table": False},
    ]},
    {"title": "报告", "sections": [
        {"id": "a", "title": "专题", "metric_codes": ["a" * 151], "table": True},
    ]},
    {"title": "报告", "sections": [
        {"id": "a", "title": "专题", "metric_codes": ["ORG_A"], "table": "true"},
    ]},
    {"title": "报告", "sections": [
        {"id": "a", "title": "专题", "metric_codes": [f"A{i}" for i in range(100)],
         "table": True},
        {"id": "b", "title": "专题", "metric_codes": ["OTHER"], "table": True},
    ]},
])
def test_invalid_layout_never_changes_saved_knowledge(layout_catalog, invalid):
    client, path, _ = layout_catalog
    before = path.read_bytes()
    response = create_plan(client, report_layout=invalid)
    assert response.status_code == 422
    assert response.json()["code"] == "REQUEST_INVALID"
    assert path.read_bytes() == before


def test_entries_without_layout_keep_the_legacy_serialized_shape(environment):
    client, _, _ = environment
    assert all("report_layout" not in entry for entry in client.get(URL).json()["items"])
    result = client.post("/api/v1/business-knowledge/search", json={"query": "原有资料"}).json()
    assert all("report_layout" not in entry for entry in result["entries"])
