"""从现场实际配置导出新版 Nacos 文档；不执行 dotenv，不连接外部服务。"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

from dotenv import dotenv_values

from ask_metric.core.config import Settings
from ask_metric.core.config_crypto import (
    decrypt_config_value,
    encrypt_config_value,
    load_config_sm4_key,
)
from ask_metric.infrastructure.config_center.bootstrap import FILE_FIELDS, NODE_FIELDS
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
    decode_document,
    encode_document,
)
from ask_metric.infrastructure.model.configuration import ModelRuntimeConfig, PromptRuntimeConfig
from ask_metric.infrastructure.semantic.configuration import SemanticConfig

SENSITIVE = {
    "app_database_url",
    "query_database_url",
    "metric_catalog_database_url",
    "org_catalog_database_url",
    "jwt_secret",
    "sm2_private_key",
    "model_admin_token",
    "trusted_proxy_token",
}
SECURITY = SENSITIVE | {
    "sso_enabled",
    "sso_user_info_url",
    "sso_timeout_seconds",
    "sso_source_system",
    "jwt_algorithm",
    "jwt_expire_minutes",
    "jwt_issuer",
    "jwt_audience",
    "model_admin_write_enabled",
    "model_admin_token_required",
    "all_organization_org_codes",
}


def export_configs(
    env_file: Path,
    resources: Path,
    output: Path,
    *,
    agent_base_url: str | None = None,
    agent_model: str | None = None,
    context_window: int = 128000,
) -> dict:
    values = {
        k.lower(): v for k, v in dotenv_values(env_file, interpolate=False).items() if v is not None
    }
    key_file = values.get("ask_metric_config_sm4_key_file")
    if not key_file:
        raise ConfigCenterError("原配置必须引用 ASK_METRIC_CONFIG_SM4_KEY_FILE，不生成新主密钥")
    key = load_config_sm4_key(environ={}, key_file=Path(key_file))
    if values.get("province_query_org_codes"):
        raise ConfigCenterError(
            "旧 PROVINCE_QUERY_ORG_CODES 需要核对新版机构权限，不能自动扩大权限"
        )
    if values.get("model_secret_env_path"):
        secrets = {
            k.lower(): v
            for k, v in dotenv_values(
                Path(values["model_secret_env_path"]), interpolate=False
            ).items()
            if v is not None
        }
        # 明确引用的凭据文件与运行文件分开时只取模型引用字段，随后按模型校验过滤。
        values = {**secrets, **values}

    docs = {}
    names = {
        MODEL_DATA_ID: "model-config",
        PROMPTS_DATA_ID: "prompts",
        SEMANTIC_DATA_ID: "semantic-config",
    }
    paths = {
        MODEL_DATA_ID: "model_config_path",
        PROMPTS_DATA_ID: "prompt_config_path",
        SEMANTIC_DATA_ID: "semantic_config_path",
    }
    for data_id, stem in names.items():
        path = (
            Path(values[paths[data_id]])
            if values.get(paths[data_id])
            else resources / f"{stem}.json"
        )
        if not path.is_absolute():
            raise ConfigCenterError(f"现场资源路径必须为绝对路径：{paths[data_id]}")
        docs[data_id] = decode_document(path.read_text(encoding="utf-8-sig"), data_id)
    model = ModelRuntimeConfig.model_validate(docs[MODEL_DATA_ID])
    docs[PROMPTS_DATA_ID].get("prompts", {}).pop("intent_routing", None)
    PromptRuntimeConfig.model_validate(docs[PROMPTS_DATA_ID])
    SemanticConfig.model_validate(docs[SEMANTIC_DATA_ID])
    refs = {
        v.lower()
        for endpoint in (model.models.chat, model.models.embedding, model.models.reranker)
        for v in (endpoint.base_url_env, endpoint.api_key_env)
        if v
    }
    secret_refs = {
        e.api_key_env.lower()
        for e in (model.models.chat, model.models.embedding, model.models.reranker)
        if e.api_key_env
    }
    for data_id in (RUNTIME_DATA_ID, DATASOURCE_DATA_ID, SECURITY_DATA_ID):
        docs[data_id] = {}
    retired = []
    for name, value in values.items():
        if (
            name.startswith("nacos_")
            or name.startswith("ask_metric_config_sm4_key")
            or name in FILE_FIELDS | NODE_FIELDS
        ):
            continue
        if name not in Settings.model_fields and name not in refs:
            retired.append(name)
            continue
        if name in SENSITIVE or name in secret_refs:
            value = encrypt_config_value(decrypt_config_value(value, key), key)
        target = (
            SECURITY_DATA_ID
            if name in SECURITY | refs
            else (
                DATASOURCE_DATA_ID
                if "database" in name or name.startswith(("sit_", "query_session_"))
                else RUNTIME_DATA_ID
            )
        )
        # BaseSettings 的复杂列表字段需要 JSON 数组，不能把 JSON 文本再当列表传入。
        if name in {"all_organization_org_codes", "catalog_overview_metric_codes"}:
            value = json.loads(value)
        docs[target][name] = value
    for name in (
        "app_env",
        "app_database_url",
        "query_database_url",
        "jwt_secret",
        "sm2_private_key",
    ):
        if not any(document.get(name) for document in docs.values()):
            raise ConfigCenterError(f"原 UAT 缺少必填配置：{name}")
    chat = model.models.chat
    raw_base = values.get((chat.base_url_env or "").lower()) or chat.base_url
    base = decrypt_config_value(str(raw_base or ""), key).rstrip("/")
    # Agent SDK 会追加 /chat/completions；非标准行内路径要求显式确认，不能静默猜测。
    if not agent_base_url and chat.path not in {"/chat/completions", "/v1/chat/completions"}:
        raise ConfigCenterError("Chat 非标准路径，请通过 --agent-base-url 明确 Agent 兼容入口")
    if not agent_base_url and chat.path == "/v1/chat/completions":
        base += "/v1"
    if not (agent_base_url or base) or not chat.model:
        raise ConfigCenterError("原 Chat 模型地址/名称不完整")
    api_key = values.get((chat.api_key_env or "").lower())
    if not api_key:
        raise ConfigCenterError("原 Chat 模型凭据缺失，需在现场配置中补齐")
    extra = dict(chat.extra_body)
    if getattr(chat, "send_enable_thinking", False):
        extra["enable_thinking"] = chat.enable_thinking
    if getattr(chat, "chat_template_kwargs", None):
        extra["chat_template_kwargs"] = chat.chat_template_kwargs
    docs[AGENT_RUNTIME_DATA_ID] = {
        "AGENT_MODEL_BASE_URL": agent_base_url or base,
        "AGENT_MODEL_NAME": agent_model or chat.model,
        "AGENT_MODEL_AUTH_HEADER": chat.authentication.header or "Authorization",
        "AGENT_MODEL_AUTH_PREFIX": chat.authentication.prefix.rstrip(),
        "AGENT_MODEL_EXTRA_BODY": extra,
        "AGENT_MODEL_USER_SUFFIX": chat.user_message_suffix,
        "AGENT_MODEL_CONTEXT_WINDOW": context_window,
        # 迁移保留现场输出限制与超时，避免未经确认放大服务请求。
        "AGENT_MODEL_MAX_TOKENS": min(chat.max_tokens or 8192, context_window // 4),
        "AGENT_COMPACTION_RESERVE_TOKENS": min(16384, context_window // 4),
        "AGENT_COMPACTION_KEEP_RECENT_TOKENS": min(20000, context_window // 4),
        "AGENT_MODEL_TIMEOUT_MS": math.ceil(chat.timeout_seconds * 1000),
        "AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS": math.ceil(chat.timeout_seconds * 1000),
        "AGENT_MODEL_RETRY_ENABLED": True,
        "AGENT_MODEL_MAX_RETRIES": 1,
        "AGENT_ANSWER_STREAMING": False,
    }
    docs[AGENT_SECURITY_DATA_ID] = {
        "AGENT_MODEL_API_KEY": encrypt_config_value(decrypt_config_value(api_key, key), key)
    }
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    for data_id, document in docs.items():
        fd = os.open(output / data_id, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(encode_document(document, data_id))
    report = {
        "data_ids": sorted(docs),
        "retired_fields": sorted(set(retired)),
        "agent_model_protocol_requires_validation": True,
        "context_window": context_window,
    }
    (output / "export-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report
