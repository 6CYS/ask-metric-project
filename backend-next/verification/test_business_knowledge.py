"""业务知识维护与运行读取使用隔离文件，不修改真实知识或访问业务库。"""

import argparse
import hashlib
import importlib.util
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.router import api_router
from ask_metric.application import business_overview
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError, install_exception_handlers

URL = "/api/v1/catalog/business-knowledge"


@pytest.fixture
def environment(tmp_path):
    path = tmp_path / "business-knowledge.json"
    path.write_text(json.dumps({"schema_version": 1, "entries": [
        {"id": "legacy", "topic": "loan", "title": "原有资料", "text": "隔离测试正文",
         "source": "测试来源", "role": "不能替代正式口径",
         "url": "https://example.com/legacy", "date": "2026-10-01"},
        {"id": "disabled", "topic": "loan", "title": "已停用", "text": "停用正文",
         "enabled": False},
    ]}, ensure_ascii=False), encoding="utf-8")
    app = FastAPI()
    app.state.settings = SimpleNamespace(business_knowledge_path=path)
    app.include_router(api_router)
    install_exception_handlers(app)
    app.dependency_overrides[require_actor] = lambda: actor("SYSTEM_ADMIN")
    return TestClient(app), path, app


def actor(role):
    return ActorContext(subject="test-user", role_code=role, authentication_method="test",
                        trust_level="authenticated")


def payload(revision, **changes):
    return {"topic": "deposit", "title": " 新资料 ", "text": " 新正文 ",
            "source": " 来源 ", "role": " 方法参考 ", "url": "", "date": "",
            "enabled": True, "revision": revision, **changes}


def test_list_keeps_legacy_defaults_and_does_not_rewrite_file(environment):
    client, path, _ = environment
    before = path.read_bytes()
    response = client.get(URL)
    assert response.status_code == 200
    data = response.json()
    assert data["revision"] == hashlib.sha256(before).hexdigest()
    assert set(data) == {"items", "revision"}
    assert data["items"][0]["enabled"] is True
    assert data["items"][0]["updated_at"] is None
    assert data["items"][0]["metric_codes"] == []
    assert path.read_bytes() == before


@pytest.fixture
def metric_catalog(environment, monkeypatch, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from ask_metric.infrastructure.db import session as database_session
    from ask_metric.infrastructure.db import unit_of_work
    from ask_metric.infrastructure.db.models import MetricSynonym, MetricTerm

    engine = create_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    MetricTerm.__table__.create(engine)
    MetricSynonym.__table__.create(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        session.add_all([
            MetricTerm(metric_code="ORG_A", metric_name="测试指标甲"),
            MetricTerm(metric_code="ORG_B", metric_name="测试指标乙", enabled=False),
        ])
        session.commit()
    monkeypatch.setattr(database_session, "get_app_session_factory", lambda: factory)
    monkeypatch.setattr(unit_of_work, "get_app_session_factory", lambda: factory)
    environment[2].state.settings.jwt_secret = "test-only-knowledge-binding-secret"
    semantics_path = tmp_path / "analysis-semantics.json"
    semantics_path.write_text('{"relations": []}', encoding="utf-8")
    environment[2].state.settings.analysis_semantics_path = semantics_path
    yield environment
    engine.dispose()


def test_metric_links_round_trip_preserve_legacy_and_allow_clear(metric_catalog):
    client, _, _ = metric_catalog
    initial = client.get(URL).json()
    linked = client.put(URL + "/legacy", json={
        "title": "关联知识", "text": "正文适用条件。", "revision": initial["revision"],
        "metric_codes": [" ORG_A ", "ORG_A", "ORG_B"],
    })
    assert linked.status_code == 200
    data = linked.json()
    assert data["item"]["metric_codes"] == ["ORG_A", "ORG_B"]
    assert data["item"]["source"] == "测试来源"
    edited = client.put(URL + "/legacy", json={
        "title": "修改标题", "text": "修改正文。", "revision": data["revision"],
    })
    assert edited.status_code == 200
    assert edited.json()["item"]["metric_codes"] == ["ORG_A", "ORG_B"]
    filtered = client.get(URL, params={"metric_code": "ORG_A"}).json()
    assert [item["id"] for item in filtered["items"]] == ["legacy"]
    assert filtered["revision"] == edited.json()["revision"]
    assert client.get(URL, params={"metric_code": "OTHER"}).json()["items"] == []
    cleared = client.put(URL + "/legacy", json={
        "title": "修改标题", "text": "修改正文。", "revision": edited.json()["revision"],
        "metric_codes": [],
    })
    assert cleared.status_code == 200
    assert cleared.json()["item"]["metric_codes"] == []
    assert client.get(URL, params={"metric_code": "ORG_A"}).json()["items"] == []


def test_unknown_metric_link_never_writes_knowledge(metric_catalog):
    client, path, _ = metric_catalog
    before = path.read_bytes()
    revision = client.get(URL).json()["revision"]
    for method, suffix in [("post", ""), ("put", "/legacy")]:
        response = getattr(client, method)(URL + suffix, json={
            "title": "关联知识", "text": "知识正文。", "revision": revision,
            "metric_codes": ["ORG_A", "UNKNOWN"],
        })
        assert response.status_code == 422
        assert response.json()["code"] == "BUSINESS_KNOWLEDGE_METRIC_NOT_FOUND"
        assert path.read_bytes() == before


def test_create_metric_links_keeps_revision_conflict_protection(metric_catalog):
    client, path, _ = metric_catalog
    revision = client.get(URL).json()["revision"]
    created = client.post(URL, json={
        "title": "新关联知识", "text": "知识正文。", "revision": revision,
        "metric_codes": ["ORG_A"],
    })
    assert created.status_code == 201
    item = created.json()["item"]
    assert item["metric_codes"] == ["ORG_A"]
    after = path.read_bytes()
    conflict = client.put(URL + "/" + item["id"], json={
        "title": "旧版本修改", "text": "不能覆盖新版本。", "revision": revision,
        "metric_codes": ["ORG_B"],
    })
    assert conflict.status_code == 409
    assert path.read_bytes() == after


@pytest.mark.parametrize("context_term", ["ORG_A", "ORG_A 测试指标", "org_a 测试指标"])
def test_explicit_metric_context_recalls_links_without_filtering_other_knowledge(
    metric_catalog, context_term,
):
    client, path, _ = metric_catalog
    path.write_text(json.dumps({"entries": [
        {"id": "general", "title": "存款变化", "text": "分析存款要先对齐统计时点。"},
        {"id": "linked", "title": "相关说明", "text": "仅用于比较同一时点的占比。",
         "metric_codes": ["ORG_A"]},
        {"id": "prefix", "title": "其他说明", "text": "不能混用统计范围。",
         "metric_codes": ["ORG_A_EXT"]},
        {"id": "disabled", "title": "停用说明", "text": "已停用。",
         "metric_codes": ["ORG_A"], "enabled": False},
    ]}, ensure_ascii=False), encoding="utf-8")
    result = client.post("/api/v1/business-knowledge/search", json={
        "query": "存款变化", "context_terms": [context_term],
    }).json()
    assert {item["id"] for item in result["entries"]} == {"linked", "general"}
    assert result["entries"][0]["id"] == "linked"
    plain = client.post("/api/v1/business-knowledge/search", json={"query": "存款变化"})
    assert [item["id"] for item in plain.json()["entries"]] == ["general"]


def test_runtime_links_supply_only_formal_enabled_candidates(metric_catalog, monkeypatch):
    from ask_metric.application.metric_semantics import MetricSemantics
    from ask_metric.domain.semantics import MetricCatalogItem
    from ask_metric.infrastructure.semantic.catalogs import SqlAlchemyMetricCatalogRepository

    client, path, app = metric_catalog
    monkeypatch.setattr(SqlAlchemyMetricCatalogRepository, "list_enabled",
                        lambda *args, **kwargs: pytest.fail("关联目录不能全量读取"))
    path.write_text(json.dumps({"entries": [{
        "id": "linked", "title": "存款分析", "text": "先核对余额口径。",
        "metric_codes": ["ORG_A", "ORG_B", "MISSING"],
    }]}), encoding="utf-8")
    data = client.post("/api/v1/business-knowledge/search", json={"query": "存款"}).json()
    assert data["entries"][0]["metric_codes"] == ["ORG_A", "ORG_B", "MISSING"]
    catalog = data["linked_catalog"]
    assert [item["code"] for item in catalog["items"]] == ["ORG_A"]
    assert catalog["items"][0]["name"] == "测试指标甲"
    assert catalog["items"][0]["binding_ref"].startswith("m1.")
    assert catalog["items"][0]["methods"] == ["observe", "compare", "trend", "ranking"]
    assert catalog["unavailable_codes"] == ["ORG_B", "MISSING"]
    assert catalog["total"] == 3
    assert catalog["has_more"] is False
    semantics = MetricSemantics(
        [MetricCatalogItem(code="ORG_A", name="测试指标甲")],
        secret=app.state.settings.jwt_secret, actor_id="test-user",
    )
    assert semantics.resolve(catalog["items"][0]["binding_ref"])["code"] == "ORG_A"
    other_actor = MetricSemantics(
        list(semantics.items.values()), secret=app.state.settings.jwt_secret, actor_id="other-user",
    )
    with pytest.raises(ApplicationError, match="不属于当前用户"):
        other_actor.resolve(catalog["items"][0]["binding_ref"])


def test_runtime_linked_catalog_is_bounded_and_preserves_remaining_codes(metric_catalog):
    from ask_metric.infrastructure.db.models import MetricTerm
    from ask_metric.infrastructure.db.session import get_app_session_factory

    client, path, _ = metric_catalog
    codes = [f"LINKED_{index}" for index in range(35)]
    with get_app_session_factory()() as session:
        session.add_all([MetricTerm(metric_code=code, metric_name=f"关联指标{index}")
                         for index, code in enumerate(codes)])
        session.commit()
    path.write_text(json.dumps({"entries": [{
        "id": "linked", "title": "存款分析", "text": "仅按问题选择相关指标。",
        "metric_codes": codes,
    }]}), encoding="utf-8")
    data = client.post("/api/v1/business-knowledge/search", json={"query": "存款"}).json()
    assert data["entries"][0]["metric_codes"] == codes
    assert len(data["linked_catalog"]["items"]) == 30
    assert data["linked_catalog"]["total"] == 35
    assert data["linked_catalog"]["has_more"] is True


def test_minimal_create_and_edit_preserve_legacy_metadata(environment):
    client, _, _ = environment
    snapshot = client.get(URL).json()
    legacy = snapshot["items"][0]
    created = client.post(URL, json={
        "title": " 通用知识 ", "text": " 适用范围和使用边界写在正文中。 ",
        "enabled": True, "revision": snapshot["revision"],
    })
    assert created.status_code == 201
    created = created.json()
    assert created["item"]["topic"] is None
    assert created["item"]["title"] == "通用知识"
    assert created["item"]["text"] == "适用范围和使用边界写在正文中。"
    updated = client.put(URL + "/legacy", json={
        "title": "修订标题", "text": "正文与使用边界合并维护。",
        "enabled": True, "revision": created["revision"],
    })
    assert updated.status_code == 200
    item = updated.json()["item"]
    assert item["id"] == legacy["id"] and item["title"] == "修订标题"
    assert item["text"] == "正文与使用边界合并维护。"
    assert {key: item[key] for key in ("topic", "source", "role", "url", "date")} == {
        key: legacy[key] for key in ("topic", "source", "role", "url", "date")
    }
    assert item["updated_at"].endswith("Z")
    assert updated.json()["revision"] != created["revision"]


def test_runtime_topics_share_all_enabled_knowledge_including_no_topic(environment):
    client, path, _ = environment
    created = client.post(URL, json={
        "title": "通用知识", "text": "正文注明适用性。", "enabled": True,
        "revision": client.get(URL).json()["revision"],
    })
    assert created.status_code == 201
    entry_id = created.json()["item"]["id"]
    loan = client.get("/api/v1/business-topics/loan/knowledge").json()
    deposit = client.get("/api/v1/business-topics/deposit/knowledge").json()
    assert loan["entries"] == deposit["entries"]
    assert [item["id"] for item in loan["entries"]] == ["legacy", entry_id]
    assert loan["revision"] == deposit["revision"] == created.json()["revision"]
    assert business_overview.read_knowledge("loan", path) == loan["entries"]
    assert business_overview.read_knowledge("deposit", path) == loan["entries"]


def test_runtime_search_uses_question_and_context_without_requiring_admin(environment):
    client, path, app = environment
    path.write_text(json.dumps({"entries": [
        {"id": "deposit", "title": "存款余额", "text": "按机构查看存款规模。"},
        {"id": "profit", "title": "收益分析", "text": "利润变化先核对收入和成本。"},
        {"id": "rate", "title": "变化比较", "text": "应比较相同统计范围。",
         "role": "适用于贷款余额"},
        {"id": "disabled", "title": "收益分析", "text": "收益的停用说明。",
         "enabled": False},
    ]}, ensure_ascii=False), encoding="utf-8")
    before = path.read_bytes()
    app.dependency_overrides[require_actor] = lambda: actor("USER")
    response = client.post("/api/v1/business-knowledge/search", json={
        "query": "收益为什么下降", "context_terms": ["贷款余额"],
    })
    assert response.status_code == 200
    data = response.json()
    assert data["entries"][0]["id"] == "profit"
    assert "rate" in {entry["id"] for entry in data["entries"]}
    assert "disabled" not in {entry["id"] for entry in data["entries"]}
    assert data["revision"] == hashlib.sha256(before).hexdigest()
    assert path.read_bytes() == before


@pytest.mark.parametrize("query,context_terms,expected_id", [
    ("各家农商行近期哪个机构的收益不好?为什么？", [], "profit-performance-analysis"),
    ("紫金最近的经营状况", [], "profit-performance-analysis"),
    ("对比江南的呢？", ["净利润"], "profit-performance-analysis"),
    ("各家农商行收益不好，为什么？", ["各项存款余额当日数"], "profit-performance-analysis"),
    ("对比江南的呢？", ["各项存款余额当日数", "个人存款余额当日数"],
     "1d47e496-d2d5-4a12-a9e5-18810bc98022"),
])
def test_configured_methods_are_retrievable(query, context_terms, expected_id):
    from ask_metric.application.business_knowledge import BusinessKnowledgeStore

    path = Path(__file__).resolve().parents[1] / "config/business-knowledge.json"
    before = path.read_bytes()
    entries = BusinessKnowledgeStore(path).search(query, context_terms)["entries"]
    assert expected_id in {entry["id"] for entry in entries}
    assert path.read_bytes() == before


def test_runtime_search_is_bounded_and_does_not_cut_usage_boundaries(environment):
    client, path, _ = environment
    text = "存款" + "甲" * 2700 + "。仅作背景，不作为归因证据。"
    path.write_text(json.dumps({"entries": [
        {"id": str(index), "title": "存款分析", "text": text} for index in range(5)
    ]}, ensure_ascii=False), encoding="utf-8")
    response = client.post("/api/v1/business-knowledge/search", json={"query": "存款"})
    assert response.status_code == 200
    entries = response.json()["entries"]
    assert 0 < len(entries) <= 3
    assert sum(len(entry["text"]) for entry in entries) <= 8000
    assert all(entry["text"] == text for entry in entries)
    assert client.post("/api/v1/business-knowledge/search", json={
        "query": "未涉及的交通运输业务",
    }).json()["entries"] == []
    path.write_text(json.dumps({"entries": [
        {"id": str(index), "title": "存款分析", "text": "仅作存款背景。"}
        for index in range(5)
    ]}, ensure_ascii=False), encoding="utf-8")
    short = client.post("/api/v1/business-knowledge/search", json={"query": "存款"}).json()
    assert len(short["entries"]) == 3


def test_runtime_search_observes_edits_and_disabled_entries_immediately(environment):
    client, _, _ = environment
    created = client.post(URL, json=payload(
        client.get(URL).json()["revision"], title="存款分析", text="原分析范围",
    )).json()
    entry_id = created["item"]["id"]
    updated = client.put(URL + "/" + entry_id, json={
        "title": "存款分析", "text": "修订后的存款使用边界", "revision": created["revision"],
    }).json()
    result = client.post("/api/v1/business-knowledge/search", json={"query": "存款"}).json()
    assert result["entries"][0]["text"] == "修订后的存款使用边界"
    assert result["revision"] == updated["revision"]
    client.patch(URL + "/" + entry_id + "/enabled", json={
        "enabled": False, "revision": updated["revision"],
    })
    result = client.post("/api/v1/business-knowledge/search", json={"query": "存款"}).json()
    assert result["entries"] == []


def test_runtime_search_rejects_anonymous_and_oversized_input(environment):
    client, _, app = environment
    response = client.post("/api/v1/business-knowledge/search", json={"query": "x" * 2001})
    assert response.status_code == 422
    assert client.post("/api/v1/business-knowledge/search", json={
        "query": "存款", "context_terms": ["贷款"] * 9,
    }).status_code == 422
    assert client.post("/api/v1/business-knowledge/search", json={
        "query": "存款", "context_terms": ["长" * 201],
    }).status_code == 422
    app.dependency_overrides.clear()
    response = client.post("/api/v1/business-knowledge/search", json={"query": "存款"})
    assert response.status_code == 401


def test_create_edit_toggle_and_runtime_read_share_path(environment):
    client, _, _ = environment
    revision = client.get(URL).json()["revision"]
    created = client.post(URL, json=payload(revision)).json()
    item, revision = created["item"], created["revision"]
    assert item["id"] and item["id"] != "legacy"
    assert item["title"] == "新资料" and item["text"] == "新正文"
    assert item["url"] is None and item["date"] is None
    assert item["updated_at"].endswith("Z")
    updated = client.put(f"{URL}/{item['id']}", json=payload(
        revision, text="修订后的正文", date="2026-10-25", url="https://example.com/reference",
    )).json()
    runtime = client.get("/api/v1/business-topics/deposit/knowledge").json()
    assert runtime["entries"][-1]["text"] == "修订后的正文"
    assert runtime["revision"] == updated["revision"]
    toggled = client.patch(f"{URL}/{item['id']}/enabled", json={
        "enabled": False, "revision": updated["revision"],
    }).json()
    assert toggled["item"]["text"] == "修订后的正文"
    assert [entry["id"] for entry in client.get(
        "/api/v1/business-topics/deposit/knowledge",
    ).json()["entries"]] == ["legacy"]
    client.patch(f"{URL}/{item['id']}/enabled", json={
        "enabled": True, "revision": toggled["revision"],
    })
    assert len(client.get("/api/v1/business-topics/deposit/knowledge").json()["entries"]) == 2


@pytest.mark.parametrize("method,path", [("get", ""), ("post", ""), ("put", "/legacy"),
                                         ("patch", "/legacy/enabled")])
def test_management_requires_admin_and_authentication(environment, method, path):
    client, _, app = environment
    revision = client.get(URL).json()["revision"]
    body = {"enabled": False, "revision": revision} if method == "patch" else payload(revision)
    kwargs = {} if method == "get" else {"json": body}
    app.dependency_overrides[require_actor] = lambda: actor("USER")
    assert getattr(client, method)(URL + path, **kwargs).status_code == 403
    assert client.get("/api/v1/business-topics/loan/knowledge").status_code == 200
    app.dependency_overrides.clear()
    assert getattr(client, method)(URL + path, **kwargs).status_code == 401
    assert client.get("/api/v1/business-topics/loan/knowledge").status_code == 401


@pytest.mark.parametrize("changes", [
    {"topic": "unknown"}, {"title": "  "}, {"title": "x" * 201}, {"text": " "},
    {"text": "x" * 8001}, {"source": "x" * 301}, {"role": "x" * 501},
    {"url": "javascript:alert(1)"}, {"url": "https://example.com/" + "x" * 2000},
    {"date": "2026-02-30"}, {"date": "20261025"}, {"enabled": "false"},
    {"metric_codes": [""]}, {"metric_codes": ["  "]}, {"metric_codes": [123]},
    {"metric_codes": ["a" * 151]}, {"metric_codes": [str(i) for i in range(101)]},
    {"id": "chosen-by-client"}, {"updated_at": "2026-10-25T00:00:00Z"},
])
def test_invalid_input_never_changes_file(environment, changes):
    client, path, _ = environment
    before = path.read_bytes()
    response = client.post(URL, json=payload(client.get(URL).json()["revision"], **changes))
    assert response.status_code == 422
    assert path.read_bytes() == before


def test_stale_revision_and_missing_entry(environment):
    client, path, _ = environment
    revision = client.get(URL).json()["revision"]
    first = client.post(URL, json=payload(revision))
    assert first.status_code == 201
    after = path.read_bytes()
    for method, suffix, body in [
        ("post", "", payload(revision)), ("put", "/legacy", payload(revision)),
        ("patch", "/legacy/enabled", {"revision": revision, "enabled": False}),
    ]:
        assert getattr(client, method)(URL + suffix, json=body).status_code == 409
    assert path.read_bytes() == after
    current = first.json()["revision"]
    assert client.put(URL + "/missing", json=payload(current)).status_code == 404


def test_parallel_writes_with_same_revision_allow_only_one(environment):
    from ask_metric.application.business_knowledge import BusinessKnowledgeStore, KnowledgeFields

    client, path, _ = environment
    revision = client.get(URL).json()["revision"]
    def save(title):
        try:
            return BusinessKnowledgeStore(path).create(
                KnowledgeFields(topic="loan", title=title, text="测试"), revision,
            )["item"]["title"]
        except ApplicationError as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(save, ["甲", "乙"]))
    assert outcomes.count(409) == 1
    assert len(client.get(URL).json()["items"]) == 3


def test_failed_atomic_replace_keeps_original_and_cleans_temp(environment, monkeypatch):
    from ask_metric.application import business_knowledge

    client, path, _ = environment
    before = path.read_bytes()
    def fail_replace(*_args):
        raise OSError("isolated write failure")
    monkeypatch.setattr(business_knowledge.os, "replace", fail_replace)
    response = client.post(URL, json=payload(client.get(URL).json()["revision"]))
    assert response.status_code == 503
    assert path.read_bytes() == before
    assert list(path.parent.glob("*.tmp")) == []


def test_read_knowledge_preserves_config_dir_override_and_only_enabled(environment, monkeypatch):
    _, path, _ = environment
    monkeypatch.setattr(business_overview, "CONFIG_DIR", path.parent)
    assert [item["id"] for item in business_overview.read_knowledge("loan")] == ["legacy"]
    assert [item["id"] for item in business_overview.read_knowledge("deposit")] == ["legacy"]


def test_invalid_file_is_reported_and_never_replaced(environment):
    client, path, _ = environment
    revision = client.get(URL).json()["revision"]
    path.write_text("{broken", encoding="utf-8")
    assert client.get(URL).status_code == 503
    assert client.post(URL, json=payload(revision)).status_code == 503
    assert path.read_text() == "{broken"


def test_runtime_edit_is_visible_to_overview_reader(environment):
    client, path, _ = environment
    revision = client.get(URL).json()["revision"]
    result = client.put(URL + "/legacy", json=payload(
        revision, topic="loan", text="运行读取更新后的正文",
    ))
    assert result.status_code == 200
    assert business_overview.read_knowledge("loan", path)[0]["text"] == "运行读取更新后的正文"


def test_deploy_initialization_preserves_runtime_knowledge_and_custom_path(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[2] / "deploy/package/intranet_deploy.py"
    spec = importlib.util.spec_from_file_location("knowledge_deploy_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    bundle = tmp_path / "bundle"
    source = bundle / "backend/runtime/config"
    source.mkdir(parents=True)
    for name in ("model-config.json", "prompts.json", "business-knowledge.json",
                 "analysis-semantics.json"):
        (source / name).write_text('{"seed": true}', encoding="utf-8")
    config = tmp_path / "config"
    config.mkdir()
    env = config / "backend.env"
    env.write_text("EXISTING=value\n", encoding="utf-8")
    monkeypatch.setattr(module, "BUNDLE_ROOT", bundle)
    args = argparse.Namespace(config_root=config, state_root=tmp_path / "state", backend_port=8010)
    module.init_config(args)
    target = args.state_root / "runtime-config/business-knowledge.json"
    assert target.read_text() == '{"seed": true}'
    assert f"BUSINESS_KNOWLEDGE_PATH={target}" in env.read_text()
    target.write_text('{"admin": true}', encoding="utf-8")
    env.write_text("EXISTING=value\nBUSINESS_KNOWLEDGE_PATH=/custom/knowledge.json\n")
    module.init_config(args)
    assert target.read_text() == '{"admin": true}'
    assert env.read_text().count("BUSINESS_KNOWLEDGE_PATH=") == 1
    assert "/custom/knowledge.json" in env.read_text()
