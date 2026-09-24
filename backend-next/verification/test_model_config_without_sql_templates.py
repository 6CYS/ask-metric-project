"""移除 SQL 模板管理后，使用隔离文件验证模型及提示词版本管理。"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.model_config import router
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import install_exception_handlers
from ask_metric.infrastructure.model.configuration import (
    ModelConfigRepository,
    ModelRuntimeConfig,
    PromptConfigRepository,
    PromptRuntimeConfig,
    PromptTemplate,
)

BASE = "/api/v1/model-config"


@pytest.fixture
def config_client(tmp_path):
    model_path = tmp_path / "model.json"
    prompt_path = tmp_path / "prompts.json"
    endpoint = {
        "base_url": "http://synthetic.invalid",
        "path": "/mock",
        "model": "synthetic",
        "authentication": {"type": "none"},
    }
    ModelConfigRepository(model_path).save(ModelRuntimeConfig.model_validate({
        "provider": "synthetic",
        "models": {role: endpoint for role in ("chat", "embedding", "reranker")},
    }))
    prompt = PromptTemplate(
        version="v1", system="固定约束", user_template="原始 {question}",
        editable_fields=["user_template"],
    )
    PromptConfigRepository(prompt_path).save(PromptRuntimeConfig(prompts={"test": prompt}))
    app = FastAPI()
    app.state.settings = SimpleNamespace(
        model_config_path=model_path,
        prompt_config_path=prompt_path,
        config_history_dir=tmp_path / "history",
        model_secret_env_path=tmp_path / "secrets.env",
        model_admin_write_enabled=True,
        model_admin_token_required=False,
    )
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="synthetic-admin", user_id="synthetic-admin", role_code="SYSTEM_ADMIN",
        authentication_method="local_jwt", trust_level="authenticated",
    )
    return TestClient(app), app, prompt.model_dump(mode="json")


def test_model_read_and_save_do_not_depend_on_sql_template_configuration(config_client):
    client, _, prompt = config_client
    response = client.get(BASE)
    assert response.status_code == 200
    loaded = response.json()
    assert loaded["prompts"]["prompts"]["test"] == prompt
    config = loaded["config"]
    config["models"]["chat"]["model"] = "synthetic-updated"
    saved = client.put(f"{BASE}/model", json={"config": config})
    assert saved.status_code == 200
    assert client.get(BASE).json()["config"]["models"]["chat"]["model"] == "synthetic-updated"
    assert client.get(BASE).json()["prompts"]["prompts"]["test"] == prompt


def test_prompt_publish_history_and_rollback_keep_baseline(config_client):
    client, _, original = config_client
    updated = {**original, "version": "v2", "user_template": "修改 {question}"}
    assert client.put(f"{BASE}/prompts/test", json=updated).status_code == 200
    versions = client.get(f"{BASE}/prompts/test/versions").json()
    assert len(versions) == 2
    baseline = next(version for version in versions if version["version_number"] == 1)
    assert baseline["snapshot"] == original
    response = client.post(f"{BASE}/prompts/test/versions/{baseline['id']}/rollback")
    assert response.status_code == 200
    assert response.json() == original
    assert client.get(BASE).json()["prompts"]["prompts"]["test"] == original
    history = client.get(f"{BASE}/prompts/test/versions").json()
    assert history[0]["action"] == "rollback"
    assert history[0]["source_version_id"] == baseline["id"]
    assert len(history) == 3


def test_prompt_configuration_still_requires_administrator(config_client):
    client, app, prompt = config_client
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="synthetic-user", role_code="USER",
        authentication_method="local_jwt", trust_level="authenticated",
    )
    assert client.get(BASE).status_code == 403
    assert client.get(f"{BASE}/prompts/test/versions").status_code == 403
    assert client.put(f"{BASE}/prompts/test", json=prompt).status_code == 403
    assert client.post(f"{BASE}/prompts/test/versions/missing/rollback").status_code == 403


@pytest.mark.parametrize("method,path", [
    ("GET", "/sql-templates"),
    ("POST", "/sql-templates/validate"),
    ("POST", "/sql-templates/trial-run"),
    ("PUT", "/sql-templates/mysql/value_exact"),
    ("GET", "/sql-templates/mysql/value_exact/versions"),
    ("POST", "/sql-templates/mysql/value_exact/versions/old/rollback"),
])
def test_retired_sql_template_routes_are_unavailable(config_client, method, path):
    client, _, _ = config_client
    assert client.request(method, BASE + path, json={"sql": "SELECT 1"}).status_code == 404
