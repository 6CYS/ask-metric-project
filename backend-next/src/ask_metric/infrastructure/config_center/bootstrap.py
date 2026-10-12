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
    QUERY_TEMPLATES_DATA_ID,
    RUNTIME_DATA_ID,
    SECURITY_DATA_ID,
    SEMANTIC_DATA_ID,
    SQL_DATA_IDS,
    ConfigCenterError,
    DocumentSnapshot,
    NacosConfigStore,
)

# 节点身份、监听和本地状态路径是启动引导项；业务参数只从 Nacos 读取。
NODE_FIELDS = {
    "tz",
    "host", "port", "app_node_code", "app_idc", "app_unit", "log_directory",
    "config_history_dir", "test_center_data_dir", "test_center_baseline_path",
    "backend_next_allow_schema_changes", "backend_next_allow_non_test_database",
}
FILE_FIELDS = {
    "model_config_path", "prompt_config_path", "semantic_config_path",
    "query_template_config_path", "sql_resource_dir", "model_secret_env_path",
}


class BootstrapSettings(BaseSettings):
    nacos_config_enabled: bool = False
    nacos_config_group: str = "ASK_METRIC_CONFIG"
    nacos_config_refresh_interval_seconds: float = Field(default=5, gt=0, le=60)
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
        env_file=PROJECT_DIR / ".env", env_file_encoding="utf-8", extra="ignore",
    )


class CenterSettings(Settings):
    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings,
                                   dotenv_settings, file_secret_settings):
        # 旧环境中的业务参数不得覆盖或补齐配置中心，避免检查与运行不一致。
        return (init_settings,)


def load_settings() -> Settings:
    bootstrap = BootstrapSettings()
    if not bootstrap.nacos_config_enabled:
        return Settings()
    key = (
        load_config_sm4_key(environ={}, key_file=bootstrap.ask_metric_config_sm4_key_file)
        if bootstrap.ask_metric_config_sm4_key_file else None
    )
    bootstrap.nacos_password = decrypt_config_value(bootstrap.nacos_password, key)
    store = NacosConfigStore(bootstrap)
    try:
        return _load_center_settings(bootstrap, store)
    except BaseException:
        # 应用尚未建立生命周期，启动校验失败需在这里释放配置连接。
        store.close()
        raise


def _load_center_settings(bootstrap: BootstrapSettings, store: NacosConfigStore) -> Settings:
    from ask_metric.infrastructure.model.configuration import ModelConfigRepository

    model = ModelConfigRepository(Path("unused"), store=store).load()
    merged = merge_business_documents(store, model)
    local = {
        k.lower(): v for k, v in dotenv_values(PROJECT_DIR / ".env", interpolate=False).items()
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
            if callable(errors) else []
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
        for role in ("chat", "embedding", "rerank") for suffix in ("api_key", "base_url")
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
    for name in ("app_database_url", "query_database_url"):
        if not merged.get(name):
            raise ConfigCenterError(f"配置中心缺少必填字段：{name}")
    return merged


def validate_resources(settings: Settings) -> None:
    from ask_metric.infrastructure.model.configuration import (
        ModelConfigRepository,
        PromptConfigRepository,
    )
    from ask_metric.infrastructure.query.templates import QueryTemplateRepository
    from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

    remote = settings._config_center
    store = DocumentSnapshot({
        name: remote.read_json(name) for name in (
            MODEL_DATA_ID, PROMPTS_DATA_ID, SEMANTIC_DATA_ID,
            QUERY_TEMPLATES_DATA_ID, *SQL_DATA_IDS.values(),
        )
    })
    try:
        ModelConfigRepository(settings.model_config_path, store=store).load()
        PromptConfigRepository(settings.prompt_config_path, store=store).load()
        SemanticConfigRepository(settings.semantic_config_path, store=store).load()
        templates = QueryTemplateRepository(
            settings.query_template_config_path, settings.sql_resource_dir, store=store,
        )
        for template in templates.list_templates():
            templates.validate_template(template.sql)
    except (ValueError, KeyError, OSError):
        raise ConfigCenterError("Nacos 模型、提示词、语义或 SQL 配置校验失败") from None
