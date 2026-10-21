"""配置中心真实调用边界回归；HTTP 使用桩，不访问行内服务。"""

import json
from pathlib import Path

import httpx
import pytest

from ask_metric.core.config_crypto import decrypt_config_value, encrypt_config_value
from ask_metric.infrastructure.config_center import bootstrap
from ask_metric.infrastructure.config_center.bootstrap import (
    BootstrapSettings,
    merge_business_documents,
)
from ask_metric.infrastructure.config_center.nacos import (
    AGENT_RUNTIME_DATA_ID,
    AGENT_SECURITY_DATA_ID,
    DATASOURCE_DATA_ID,
    MODEL_DATA_ID,
    PROMPTS_DATA_ID,
    RUNTIME_DATA_ID,
    SECURITY_DATA_ID,
    SEMANTIC_DATA_ID,
    ConfigCenterError,
    DocumentSnapshot,
    NacosConfigStore,
    decode_document,
)
from ask_metric.infrastructure.model.configuration import ModelRuntimeConfig
from ask_metric.infrastructure.model.provider import credential_resolver_from_env_file

RESOURCES = Path(__file__).resolve().parents[1] / "config"
SYNTHETIC_ORG_SCOPE = {
    "sit_org_corporation_code_max": "134",
    "sit_org_excluded_corporation_code": "086",
    "sit_org_head_office_corporation_code": "000",
    "sit_org_legal_entity_hier_code": "3",
    "sit_org_head_office_hier_code": "1",
    "sit_org_expected_count": 61,
}


def test_export_preserves_bank_chat_contract_and_encrypted_credentials(tmp_path):
    from ask_metric.infrastructure.config_center.exporter import export_configs

    key = bytes(range(16))
    key_file = tmp_path / "master.key"
    key_file.write_text(key.hex(), encoding="ascii")
    model = json.loads((RESOURCES / "model-config.json").read_text(encoding="utf-8"))
    model["models"]["chat"].update(
        base_url="http://model.example:18094",
        base_url_env="",
        model="bank-chat",
        path="/v1/chat/completions",
        api_key_env="MODEL_CHAT_API_KEY",
        authentication={"type": "header", "header": "accessKey", "prefix": ""},
        timeout_seconds=60,
        max_tokens=1024,
        user_message_suffix="\n/no_think",
        send_enable_thinking=False,
        send_response_format=False,
        chat_template_kwargs={"enable_thinking": False},
        extra_body={},
    )
    model_file = tmp_path / "model.json"
    model_file.write_text(json.dumps(model), encoding="utf-8")
    env_file = tmp_path / "backend.env"
    env_file.write_text(
        "\n".join(
            [
                f"ASK_METRIC_CONFIG_SM4_KEY_FILE='{key_file.as_posix()}'",
                f"MODEL_CONFIG_PATH='{model_file.as_posix()}'",
                "APP_ENV=uat",
                "APP_DATABASE_URL=sqlite:///app.db",
                "QUERY_DATABASE_URL=sqlite:///query.db",
                "JWT_SECRET=synthetic-only",
                "SM2_PRIVATE_KEY=synthetic-only",
                *(f"{name.upper()}={value}" for name, value in SYNTHETIC_ORG_SCOPE.items()),
                f"MODEL_CHAT_API_KEY='{encrypt_config_value('synthetic-model-key', key)}'",
            ]
        ),
        encoding="utf-8",
    )
    output = tmp_path / "exported"
    export_configs(env_file, RESOURCES, output)
    runtime = decode_document((output / AGENT_RUNTIME_DATA_ID).read_text(), AGENT_RUNTIME_DATA_ID)
    security = decode_document(
        (output / AGENT_SECURITY_DATA_ID).read_text(), AGENT_SECURITY_DATA_ID
    )
    assert runtime["AGENT_MODEL_BASE_URL"] == "http://model.example:18094/v1"
    assert runtime["AGENT_MODEL_AUTH_HEADER"] == "accessKey"
    assert runtime["AGENT_MODEL_AUTH_PREFIX"] == ""
    assert runtime["AGENT_MODEL_USER_SUFFIX"] == "\n/no_think"
    assert runtime["AGENT_MODEL_TIMEOUT_MS"] == 60000
    assert runtime["AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS"] == 60000
    assert runtime["AGENT_MODEL_MAX_TOKENS"] == 1024
    assert runtime["AGENT_MODEL_EXTRA_BODY"] == {"chat_template_kwargs": {"enable_thinking": False}}
    assert security["AGENT_MODEL_API_KEY"].startswith("ENC[SM4:v1:")
    assert decrypt_config_value(security["AGENT_MODEL_API_KEY"], key) == "synthetic-model-key"


def options(**kwargs):
    return BootstrapSettings(
        _env_file=None,
        nacos_server_addr="first:8848,second:8848",
        nacos_config_enabled=True,
        **kwargs,
    )


@pytest.mark.parametrize("api", ["v3", "v1"])
def test_api_auth_namespace_and_cas(api):
    calls = []

    def handler(request):
        calls.append(request)
        if "/auth/" in request.url.path:
            return httpx.Response(200, json={"accessToken": "synthetic-token"})
        if api == "v1" and "/v3/" in request.url.path:
            return httpx.Response(404, text="route missing")
        if request.method == "GET":
            return (
                httpx.Response(200, json={"code": 0, "data": {"content": '{"value":1}'}})
                if api == "v3"
                else httpx.Response(200, text='{"value":1}')
            )
        assert request.headers["casMd5"]
        return (
            httpx.Response(200, json={"code": 0, "data": True})
            if api == "v3"
            else httpx.Response(200, text="true")
        )

    store = NacosConfigStore(
        options(nacos_username="test", nacos_password="test", nacos_namespace="uat"),
        transport=httpx.MockTransport(handler),
    )
    assert store.read_json(MODEL_DATA_ID) == {"value": 1}
    store.publish_json(MODEL_DATA_ID, {"value": 2})
    gets = [c for c in calls if c.method == "GET"]
    assert gets[-1].url.params.get("namespaceId" if api == "v3" else "tenant") == "uat"
    assert gets[-1].url.params.get("accessToken") == "synthetic-token"


def test_failover_and_no_local_fallback():
    def handler(request):
        if request.url.host == "first":
            raise httpx.ConnectError("secret address", request=request)
        return httpx.Response(200, json={"code": 0, "data": {"content": '{"remote":true}'}})

    store = NacosConfigStore(options(), transport=httpx.MockTransport(handler))
    assert store.read_json(MODEL_DATA_ID)["remote"]
    store = NacosConfigStore(
        options(), transport=httpx.MockTransport(lambda r: httpx.Response(503, text="secret"))
    )
    with pytest.raises(ConfigCenterError) as exc:
        store.read_json(MODEL_DATA_ID)
    assert "secret" not in str(exc.value)


def test_v3_missing_and_conflict_do_not_retry_or_fallback():
    calls = []

    def missing(r):
        calls.append(r)
        return httpx.Response(200, json={"code": 20004, "message": "secret"})

    with pytest.raises(ConfigCenterError, match="缺少配置"):
        NacosConfigStore(options(), transport=httpx.MockTransport(missing)).read_json(MODEL_DATA_ID)
    assert len(calls) == 1
    calls.clear()

    def conflict(r):
        calls.append(r)
        if r.method == "GET":
            return httpx.Response(200, json={"code": 0, "data": {"content": "{}"}})
        return httpx.Response(200, json={"code": 20005})

    store = NacosConfigStore(options(), transport=httpx.MockTransport(conflict))
    store.read_json(MODEL_DATA_ID)
    with pytest.raises(ConfigCenterError, match="其他发布修改"):
        store.publish_json(MODEL_DATA_ID, {})
    assert len(calls) == 2


def test_first_creation_does_not_send_empty_cas_header():
    calls = []

    def handler(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"code": 20004})
        assert "casMd5" not in request.headers
        return httpx.Response(200, json={"code": 0, "data": True})

    store = NacosConfigStore(options(), transport=httpx.MockTransport(handler))
    with pytest.raises(ConfigCenterError, match="缺少配置"):
        store.read_json(RUNTIME_DATA_ID)
    assert store._request("POST", RUNTIME_DATA_ID, "app_env: test\n") == "true"
    assert len(calls) == 2


def test_missing_response_during_write_identifies_write_phase():
    store = NacosConfigStore(
        options(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"code": 20004})),
    )
    with pytest.raises(ConfigCenterError, match="发布接口返回配置不存在"):
        store._request("POST", RUNTIME_DATA_ID, "app_env: test\n")


@pytest.mark.parametrize(
    "content,name", [("a: 1\na: 2", RUNTIME_DATA_ID), ('{"a":1,"a":2}', MODEL_DATA_ID)]
)
def test_duplicate_document_keys_rejected(content, name):
    with pytest.raises(ConfigCenterError):
        decode_document(content, name)


def documents(key):
    docs = {
        MODEL_DATA_ID: json.loads((RESOURCES / "model-config.json").read_text(encoding="utf-8")),
        PROMPTS_DATA_ID: json.loads((RESOURCES / "prompts.json").read_text(encoding="utf-8")),
        SEMANTIC_DATA_ID: json.loads(
            (RESOURCES / "semantic-config.json").read_text(encoding="utf-8")
        ),
        RUNTIME_DATA_ID: {"app_env": "test", **SYNTHETIC_ORG_SCOPE},
        DATASOURCE_DATA_ID: {
            "app_database_url": encrypt_config_value("mysql+pymysql://u:p@database/app_test", key),
            "query_database_url": encrypt_config_value(
                "mysql+pymysql://u:p@database/lake_test", key
            ),
        },
        SECURITY_DATA_ID: {"model_chat_api_key": encrypt_config_value("remote-secret", key)},
    }
    return docs


def test_center_overrides_business_env_and_secret_resolver(tmp_path, monkeypatch):
    key = bytes.fromhex("00112233445566778899aabbccddeeff")
    key_file = tmp_path / "key"
    key_file.write_text(key.hex())
    docs = documents(key)
    store = DocumentSnapshot(docs)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_DATABASE_URL", "local-invalid")
    monkeypatch.setenv("MODEL_CHAT_API_KEY", "local-secret")
    monkeypatch.setattr(
        bootstrap, "BootstrapSettings", lambda: options(ask_metric_config_sm4_key_file=key_file)
    )
    monkeypatch.setattr(bootstrap, "NacosConfigStore", lambda _: store)
    settings = bootstrap.load_settings()
    assert settings.app_env == "test"
    assert "database/app_test" in settings.app_database_url
    assert settings._config_center is store
    assert (
        credential_resolver_from_env_file(tmp_path / "absent", store=store)("MODEL_CHAT_API_KEY")
        == "remote-secret"
    )


@pytest.mark.parametrize("bad", ["app_database_url", "host", "unknown_typo", "model_config_path"])
def test_merge_rejects_duplicate_node_unknown_or_file(bad):
    docs = documents(bytes(16))
    docs[RUNTIME_DATA_ID][bad] = "bad"
    model = ModelRuntimeConfig.model_validate(docs[MODEL_DATA_ID])
    with pytest.raises(ConfigCenterError):
        merge_business_documents(DocumentSnapshot(docs), model)


def test_plaintext_sensitive_config_rejected():
    docs = documents(bytes(16))
    docs[SECURITY_DATA_ID]["model_chat_api_key"] = "plaintext"
    model = ModelRuntimeConfig.model_validate(docs[MODEL_DATA_ID])
    values = merge_business_documents(DocumentSnapshot(docs), model)
    with pytest.raises(ConfigCenterError, match="必须使用 SM4"):
        bootstrap.validate_sensitive_fields(values, model, bytes(16))
