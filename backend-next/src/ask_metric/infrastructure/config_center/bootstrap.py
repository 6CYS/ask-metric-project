"""先读取最小引导参数，再加载并完整校验 Nacos 配置，最后创建业务资源。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from ask_metric.core.config import PROJECT_DIR, Settings
from ask_metric.core.config_crypto import decrypt_config_value, load_config_sm4_key
from ask_metric.infrastructure.config_center.nacos import (
    DATASOURCE_DATA_ID,
    MODEL_DATA_ID,
    PROMPTS_DATA_ID,
    RUNTIME_DATA_ID,
    SECURITY_DATA_ID,
    SEMANTIC_DATA_ID,
    ConfigCenterError,
    DocumentSnapshot,
    NacosConfigStore,
)

# 节点身份、监听和本地状态路径是启动引导项；业务参数只从 Nacos 读取。
NODE_FIELDS = {
    "tz",
    "host",
    "port",
    "app_node_code",
    "app_idc",
    "app_unit",
    "log_directory",
    "config_history_dir",
    "backend_next_allow_schema_changes",
    "backend_next_allow_non_test_database",
}
FILE_FIELDS = {
    "model_config_path",
    "prompt_config_path",
    "semantic_config_path",
    "model_secret_env_path",
}


class BootstrapSettings(BaseSettings):
    nacos_config_enabled: bool = False
    nacos_config_group: str = "ASK_METRIC_CONFIG"
    nacos_prompt_data_id: Literal[
        "sznsznws_backend_prompts.json", "sznsznws_backend_prompts_query_only.json"
    ] = "sznsznws_backend_prompts.json"
    nacos_server_addr: str = ""
    nacos_namespace: str = "public"
    nacos_username: str = ""
    nacos_password: str = Field(default="", repr=False)
    nacos_request_timeout_ms: int = Field(default=5000, gt=0)
    ask_metric_config_sm4_key_file: Path | None = None
    model_config = SettingsConfigDict(
        env_file=PROJECT_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


class CenterSettings(Settings):
    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
    ):
        # 旧环境中的业务参数不得覆盖或补齐配置中心，避免检查与运行不一致。
        return (init_settings,)


def load_settings() -> Settings:
    bootstrap = BootstrapSettings()
    if not bootstrap.nacos_config_enabled:
        return Settings()
    key = (
        load_config_sm4_key(environ={}, key_file=bootstrap.ask_metric_config_sm4_key_file)
        if bootstrap.ask_metric_config_sm4_key_file
        else None
    )
    bootstrap.nacos_password = decrypt_config_value(bootstrap.nacos_password, key)
    store = NacosConfigStore(bootstrap)
    from ask_metric.infrastructure.model.configuration import ModelConfigRepository

    try:
        model = ModelConfigRepository(Path("unused"), store=store).load()
    except ValueError:
        raise ConfigCenterError("Nacos 模型配置校验失败") from None
    merged = merge_business_documents(store, model)
    validate_sensitive_fields(merged, model, key)
    local = {
        k.lower(): v
        for k, v in dotenv_values(PROJECT_DIR / ".env", interpolate=False).items()
        if v is not None
    }
    local.update({k.lower(): v for k, v in os.environ.items()})
    for name in Settings.model_fields:
        if name.startswith("nacos_") or name in NODE_FIELDS:
            if name in local:
                merged[name] = local[name]
    merged.update(bootstrap.model_dump())
    # 模型地址/密钥由凭据解析器读取，Settings 不接收未知字段。
    values = {k: v for k, v in merged.items() if k in Settings.model_fields}
    try:
        result = CenterSettings(**values)
    except ValueError as exc:
        errors = getattr(exc, "errors", None)
        fields = (
            [".".join(map(str, e["loc"])) for e in errors(include_input=False)]
            if callable(errors)
            else []
        )
        raise ConfigCenterError("Nacos 运行配置校验失败：" + ", ".join(fields)) from None
    store.settings = result
    result._config_center = store
    validate_resources(result)
    return result


def merge_business_documents(store, model) -> dict:
    """启动和离线加密共用字段校验，阻止拼写错误及节点参数混入。"""
    model_reference_fields = {
        value.lower()
        for endpoint in (model.models.chat, model.models.embedding, model.models.reranker)
        for value in (endpoint.base_url_env, endpoint.api_key_env)
        if value
    }
    model_reference_fields.update(
        f"model_{role}_{suffix}"
        for role in ("chat", "embedding", "rerank")
        for suffix in ("api_key", "base_url")
    )
    merged = {}
    for data_id in (RUNTIME_DATA_ID, DATASOURCE_DATA_ID, SECURITY_DATA_ID):
        for name, value in store.read_json(data_id).items():
            name = name.lower()
            if name in merged:
                raise ConfigCenterError(f"配置字段重复：{name}")
            if name in FILE_FIELDS or name.startswith("ask_metric_config_sm4_key"):
                raise ConfigCenterError(f"配置中心不接受文件路径或主密钥：{name}")
            if name.startswith("nacos_") or name in NODE_FIELDS:
                raise ConfigCenterError(f"节点引导参数不能在配置中心设置：{name}")
            if name not in Settings.model_fields and name not in model_reference_fields:
                raise ConfigCenterError(f"未知配置字段：{name}")
            merged[name] = value
    # 数据库连接必须明确给出，不允许连接本地开发默认库。
    for name in ("app_env", "app_database_url", "query_database_url"):
        if not merged.get(name):
            raise ConfigCenterError(f"配置中心缺少必填字段：{name}")
    return merged


def validate_resources(settings: Settings) -> None:
    from ask_metric.infrastructure.model.configuration import (
        ModelConfigRepository,
        PromptConfigRepository,
    )
    from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

    remote = settings._config_center
    store = DocumentSnapshot(
        {
            name: remote.read_json(name)
            for name in (
                MODEL_DATA_ID,
                PROMPTS_DATA_ID,
                SEMANTIC_DATA_ID,
            )
        }
    )
    try:
        ModelConfigRepository(settings.model_config_path, store=store).load()
        PromptConfigRepository(settings.prompt_config_path, store=store).load()
        SemanticConfigRepository(settings.semantic_config_path, store=store).load()
    except (ValueError, KeyError, OSError):
        raise ConfigCenterError("Nacos 模型、提示词或语义配置校验失败") from None


def validate_sensitive_fields(values: dict, model, key) -> None:
    from ask_metric.core.config_crypto import is_encrypted_config_value

    sensitive = {
        "app_database_url",
        "query_database_url",
        "metric_catalog_database_url",
        "org_catalog_database_url",
        "jwt_secret",
        "sm2_private_key",
        "model_admin_token",
        "trusted_proxy_token",
        "model_chat_api_key",
        "model_embedding_api_key",
        "model_rerank_api_key",
    }
    sensitive.update(
        endpoint.api_key_env.lower()
        for endpoint in (model.models.chat, model.models.embedding, model.models.reranker)
        if endpoint.api_key_env
    )
    for name in sensitive:
        value = values.get(name)
        if value:
            if not is_encrypted_config_value(value):
                raise ConfigCenterError(f"Nacos 敏感配置必须使用 SM4 密文：{name}")
            try:
                decrypt_config_value(value, key)
            except ValueError:
                raise ConfigCenterError(f"Nacos 敏感配置解密失败：{name}") from None
