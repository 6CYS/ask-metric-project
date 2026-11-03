"""发布目录只读时，维护与分析共同使用可跨版本保留的隔离配置。"""

import argparse
import importlib.util
import json
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes import analysis, business_overview, metric_relationships
from ask_metric.application import metric_semantics
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError, install_exception_handlers
from ask_metric.domain.semantics import MetricCatalogItem

URL = "/api/v1/catalog/metric-relationships"


def test_read_only_release_uses_external_config_for_maintenance_and_analysis(tmp_path, monkeypatch):
    release = tmp_path / "release/config"
    release.mkdir(parents=True)
    original = '{"relations": []}'
    (release / "analysis-semantics.json").write_text(original)
    (release / "business-topics.json").write_text('{"topics": {}}')
    runtime = tmp_path / "state/analysis-semantics.json"
    runtime.parent.mkdir()
    runtime.write_text(original)
    knowledge = tmp_path / "knowledge.json"
    knowledge.write_text(json.dumps({"entries": [{
        "id": "known", "title": "余额", "text": "测试说明", "metric_codes": ["A"],
    }]}))
    monkeypatch.setattr(metric_relationships, "CONFIG_DIR", release)
    monkeypatch.setattr(metric_semantics, "CONFIG_DIR", release)
    catalog = [MetricCatalogItem(code=code, name=code, unit="元") for code in ("A", "B")]
    repository = SimpleNamespace(
        list_enabled=lambda **kwargs: catalog,
        list_enabled_matching=lambda **kwargs: catalog,
    )
    def uow():
        return nullcontext(SimpleNamespace(metric_catalog=repository))

    monkeypatch.setattr(business_overview, "SqlAlchemyUnitOfWork", uow)
    actor = ActorContext(subject="review", role_code="SYSTEM_ADMIN",
                         authentication_method="test", trust_level="authenticated")
    app = FastAPI()
    app.state.settings = SimpleNamespace(
        analysis_semantics_path=runtime, business_knowledge_path=knowledge, jwt_secret="test",
    )
    app.include_router(metric_relationships.router)
    app.include_router(business_overview.router)
    install_exception_handlers(app)
    app.dependency_overrides[require_actor] = lambda: actor
    app.dependency_overrides[metric_relationships.relationship_catalog] = lambda: catalog
    client = TestClient(app)
    release.chmod(0o555)
    try:
        revision = client.get(URL).json()["revision"]
        response = client.post(URL, json={
            "revision": revision, "parent": "A", "children": ["B"],
            "kind": "classification", "status": "approved", "source": "隔离依据",
        })
        assert response.status_code == 201, response.text
        relation_id = response.json()["item"]["id"]
        assert json.loads(runtime.read_text())["relations"][0]["id"] == relation_id
        assert (release / "analysis-semantics.json").read_text() == original
        request = Request({"type": "http", "app": app})
        services = SimpleNamespace(uow_factory=uow)
        service = analysis.get_analysis_service(request, services, services)
        discovered = service.semantics(actor).search("A")
        assert discovered["relations"][0]["id"] == relation_id
        linked = client.post("/api/v1/business-knowledge/search", json={"query": "余额"})
        reference = linked.json()["linked_catalog"]["items"][0]["binding_ref"]
        assert service.semantics(actor, metric_codes={"A"}).resolve(reference)["code"] == "A"
        updated = client.put(f"{URL}/{relation_id}", json={
            "revision": response.json()["revision"], "parent": "A", "children": ["B"],
            "kind": "classification", "status": "approved", "source": "更新后的隔离依据",
        })
        assert updated.status_code == 200
        with pytest.raises(ApplicationError) as error:
            service.semantics(actor, metric_codes={"A"}).resolve(reference)
        assert error.value.code == "ANALYSIS_METADATA_CHANGED"
    finally:
        release.chmod(0o755)


@pytest.mark.parametrize("custom_path", [False, True])
@pytest.mark.parametrize("legacy_source", ["explicit", "semantic_path", "new_install"])
def test_deploy_migrates_previous_release_once_and_preserves_config(
    tmp_path, monkeypatch, custom_path, legacy_source,
):
    script = Path(__file__).resolve().parents[2] / "deploy/package/intranet_deploy.py"
    spec = importlib.util.spec_from_file_location("relationship_deploy_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    bundle = tmp_path / "bundle"
    source = bundle / "backend/runtime/config"
    source.mkdir(parents=True)
    for name in ("model-config.json", "prompts.json", "business-knowledge.json",
                 "analysis-semantics.json"):
        (source / name).write_text('{"relations": []}')
    previous = tmp_path / "previous/config/analysis-semantics.json"
    previous.parent.mkdir(parents=True)
    previous.write_text('{"relations": [{"id": "existing-admin-change"}]}')
    config = tmp_path / "config"
    config.mkdir()
    env = config / "backend.env"
    explicit = tmp_path / "custom/analysis-semantics.json"
    existing = f"ANALYSIS_SEMANTICS_PATH={explicit}\n" if custom_path else "EXISTING=value\n"
    if legacy_source == "semantic_path":
        existing += f"SEMANTIC_CONFIG_PATH={previous.with_name('semantic-config.json')}\n"
    env.write_text(existing)
    monkeypatch.setattr(module, "BUNDLE_ROOT", bundle)
    args = argparse.Namespace(config_root=config, state_root=tmp_path / "state", backend_port=8010,
                              legacy_analysis_semantics=previous if legacy_source == "explicit"
                              else None)
    module.init_config(args)
    target = args.state_root / "runtime-config/analysis-semantics.json"
    assert target.read_text() == (previous.read_text() if legacy_source != "new_install"
                                  else '{"relations": []}')
    assert f"ANALYSIS_SEMANTICS_PATH={explicit if custom_path else target}" in env.read_text()
    target.write_text('{"relations": [{"id": "new-admin-change"}]}')
    previous.unlink()
    module.init_config(args)
    assert json.loads(target.read_text())["relations"][0]["id"] == "new-admin-change"
    assert env.read_text().count("ANALYSIS_SEMANTICS_PATH=") == 1
