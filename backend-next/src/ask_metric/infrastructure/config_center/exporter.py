"""离线分类导出和整批加密；不连接 Nacos、数据库或模型。"""
from __future__ import annotations

import hmac
import json
import os
from pathlib import Path

from dotenv import dotenv_values

from ask_metric.core.config_crypto import (
    decrypt_config_value,
    encrypt_config_value,
    is_encrypted_config_value,
)
from ask_metric.infrastructure.config_center.bootstrap import FILE_FIELDS, NODE_FIELDS
from ask_metric.infrastructure.config_center.nacos import (
    DATA_IDS,
    DATASOURCE_DATA_ID,
    MODEL_DATA_ID,
    PROMPTS_DATA_ID,
    QUERY_ONLY_DATA_ID,
    QUERY_TEMPLATES_DATA_ID,
    RUNTIME_DATA_ID,
    SECURITY_DATA_ID,
    SEMANTIC_DATA_ID,
    SQL_DATA_IDS,
    ConfigCenterError,
    DocumentSnapshot,
    decode_document,
    encode_document,
)

BOOTSTRAP_FILE = "sznsznws_backend_bootstrap.env"
SENSITIVE_FIELDS = {
    "app_database_url", "query_database_url", "metric_catalog_database_url",
    "org_catalog_database_url", "nacos_password", "continuation_token_secret",
    "jwt_secret", "sm2_private_key", "model_admin_token", "trusted_proxy_token",
    "model_chat_api_key", "model_embedding_api_key", "model_rerank_api_key",
}


def _dotenv(path: Path) -> dict[str, str]:
    return {
        k.lower(): v for k, v in dotenv_values(path, interpolate=False).items() if v is not None
    }


def _env_text(values: dict) -> str:
    if any("\n" in str(v) or "\r" in str(v) or "'" in str(v) for v in values.values()):
        raise ConfigCenterError("引导配置不能包含多行值或单引号")
    return "".join(f"{k.upper()}='{v}'\n" for k, v in values.items())


def _write_new_directory(output: Path, contents: dict[str, str]) -> list[Path]:
    # 整批验证完成后才创建新目录，禁止覆盖任何已有明文/密文目录。
    output = output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    paths = []
    for name, content in contents.items():
        path = output / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
        paths.append(path)
    return paths


def export_builtin_configs(
    project_dir: Path, output_dir: Path, *, env_file: Path | None = None
) -> list[Path]:
    """现场迁移显式指定旧环境文件，读取它引用的实际持久配置。"""
    values = _dotenv(env_file or project_dir / ".env.example")
    source = project_dir / "config"

    def path(name: str, default: Path) -> Path:
        selected = Path(values[name]) if values.get(name) else default.resolve()
        return selected if selected.is_absolute() else project_dir / selected

    paths = {
        MODEL_DATA_ID: path("model_config_path", source / "model-config.json"),
        PROMPTS_DATA_ID: path("prompt_config_path", source / "prompts.json"),
        SEMANTIC_DATA_ID: path("semantic_config_path", source / "semantic-config.json"),
        QUERY_TEMPLATES_DATA_ID: path(
            "query_template_config_path", source / "query-templates.json"
        ),
    }
    docs = {name: decode_document(p.read_text(encoding="utf-8-sig"), name)
            for name, p in paths.items()}
    model_secret_fields = {
        endpoint["api_key_env"].lower()
        for endpoint in docs[MODEL_DATA_ID]["models"].values()
        if endpoint.get("api_key_env")
    }
    # 现场可能把模型凭据单独保存；仅显式迁移时读取，示例导出不接触本机 .env。
    if env_file is not None and values.get("model_secret_env_path"):
        secret_path = path("model_secret_env_path", project_dir / ".env")
        if not secret_path.is_file():
            raise ConfigCenterError("MODEL_SECRET_ENV_PATH 指向的凭据文件不存在")
        secret_values = _dotenv(secret_path)
        model_reference_fields = model_secret_fields | {
            endpoint["base_url_env"].lower()
            for endpoint in docs[MODEL_DATA_ID]["models"].values()
            if endpoint.get("base_url_env")
        }
        for name in model_reference_fields:
            if not values.get(name) and secret_values.get(name):
                values[name] = secret_values[name]
    # 兼容 Data ID 与实际选定的提示词一致，不能用仓库副本覆盖现场内容。
    docs[QUERY_ONLY_DATA_ID] = docs[PROMPTS_DATA_ID]
    sql_root = path("sql_resource_dir", project_dir / "resources" / "sql").resolve()
    for dialect, data_id in SQL_DATA_IDS.items():
        docs[data_id] = {}
        registrations = docs[QUERY_TEMPLATES_DATA_ID]["dialects"].get(dialect, {})
        for name, registration in registrations.items():
            relative = registration if isinstance(registration, str) else registration["path"]
            sql_path = (sql_root / relative).resolve()
            if not sql_path.is_relative_to(sql_root):
                raise ConfigCenterError("SQL 模板路径越界")
            docs[data_id][name] = sql_path.read_text(encoding="utf-8-sig")
    docs.update({RUNTIME_DATA_ID: {}, DATASOURCE_DATA_ID: {}, SECURITY_DATA_ID: {}})
    bootstrap = {}
    for name, value in values.items():
        if name == "ask_metric_config_sm4_key":
            raise ConfigCenterError("先将 SM4 主密钥改为独立受保护文件引用")
        if name in FILE_FIELDS:
            continue
        if (name.startswith("nacos_") or name in NODE_FIELDS
                or name == "ask_metric_config_sm4_key_file"):
            bootstrap[name] = value
            continue
        if name in {"province_query_org_codes", "sso_org_code_mapping"}:
            try:
                value = json.loads(value)
            except ValueError:
                raise ConfigCenterError(f"配置必须填写合法 JSON：{name}") from None
        if name.startswith(("app_database", "query_database", "database_", "sit_")) or name in {
            "metric_catalog_database_url", "org_catalog_database_url",
            "query_session_init_statements",
        }:
            data_id = DATASOURCE_DATA_ID
        elif (name in SENSITIVE_FIELDS | model_secret_fields
              or name.startswith(("sso_", "jwt_", "sm2_"))) or name in {
            "password_login_enabled", "province_query_org_codes",
        } or (name.startswith("model_") and name.endswith("_api_key")):
            data_id = SECURITY_DATA_ID
        else:
            data_id = RUNTIME_DATA_ID
        docs[data_id][name] = value
    if paths[PROMPTS_DATA_ID].name == "prompts.query-only.json":
        bootstrap["nacos_prompt_data_id"] = QUERY_ONLY_DATA_ID
    bootstrap["nacos_config_enabled"] = "true"
    bootstrap.setdefault("nacos_config_group", "ASK_METRIC_CONFIG")
    contents = {name: encode_document(doc, name) for name, doc in docs.items()}
    contents[BOOTSTRAP_FILE] = _env_text(bootstrap)
    return _write_new_directory(output_dir, contents)


def encrypt_directory(source: Path, output: Path, key: bytes) -> list[dict]:
    source = source.resolve(strict=True)
    output = output.resolve()
    if output == source or output.is_relative_to(source) or source.is_relative_to(output):
        raise ConfigCenterError("明文和密文目录必须分开，不能互相包含")
    allowed = {*DATA_IDS, QUERY_ONLY_DATA_ID, BOOTSTRAP_FILE}
    docs = {}
    for path in sorted(source.iterdir()):
        if path.name not in allowed:
            raise ConfigCenterError(f"目录内包含非清单配置文件：{path.name}")
        docs[path.name] = (
            _dotenv(path) if path.name == BOOTSTRAP_FILE
            else decode_document(path.read_text(encoding="utf-8-sig"), path.name)
        )
    missing = set(DATA_IDS) - docs.keys()
    if missing:
        raise ConfigCenterError("缺少待发布配置：" + ", ".join(sorted(missing)))
    sensitive = set(SENSITIVE_FIELDS)
    for endpoint in docs[MODEL_DATA_ID]["models"].values():
        if endpoint.get("api_key_env"):
            sensitive.add(endpoint["api_key_env"].lower())
    # 加密前先用应用同一套模型校验配置。只在内存解密，不生成中间明文文件。
    _validate_filled_documents(docs, sensitive, key)
    contents, report = {}, []
    for name, document in docs.items():
        encrypted, existing = 0, 0
        if name in {RUNTIME_DATA_ID, SECURITY_DATA_ID, DATASOURCE_DATA_ID, BOOTSTRAP_FILE}:
            document = document.copy()
            for field, value in document.items():
                if field.lower() not in sensitive or value in ("", None):
                    continue
                if not isinstance(value, str):
                    raise ConfigCenterError(f"敏感配置必须为字符串：{name}/{field}")
                if is_encrypted_config_value(value):
                    decrypt_config_value(value, key)  # 校验原密文的主密钥和完整性。
                    existing += 1
                    continue
                if "<" in value or ">" in value or "@STATE_ROOT@" in value:
                    raise ConfigCenterError(f"配置尚未填写完成：{name}/{field}")
                result = encrypt_config_value(value, key)
                if not hmac.compare_digest(
                    decrypt_config_value(result, key).encode(), value.encode()
                ):
                    raise ConfigCenterError(f"加密回验失败：{name}/{field}")
                document[field] = result
                encrypted += 1
        contents[name] = (
            _env_text(document) if name == BOOTSTRAP_FILE else encode_document(document, name)
        )
        report.append({"file": name, "encrypted_fields": encrypted, "verified_existing": existing})
    _write_new_directory(output, contents)
    return report


def _validate_filled_documents(docs: dict, sensitive: set[str], key: bytes) -> None:
    from ask_metric.core.config import Settings
    from ask_metric.infrastructure.config_center.bootstrap import (
        CenterSettings,
        merge_business_documents,
        validate_resources,
    )
    from ask_metric.infrastructure.model.configuration import ModelConfigRepository

    snapshot = DocumentSnapshot(docs)
    model = ModelConfigRepository(Path("unused"), store=snapshot).load()
    merged = merge_business_documents(snapshot, model)
    for field, value in docs.get(BOOTSTRAP_FILE, {}).items():
        field = field.lower()
        if field not in NODE_FIELDS and field != "ask_metric_config_sm4_key_file" and not (
            field.startswith("nacos_") and field in Settings.model_fields
        ):
            raise ConfigCenterError(f"未知节点引导字段：{field}")
        merged[field] = value
    for field in sensitive:
        if merged.get(field):
            if not isinstance(merged[field], str):
                raise ConfigCenterError(f"敏感配置必须为字符串：{field}")
            merged[field] = decrypt_config_value(merged[field], key)
    # 文件路径属于目标节点，批量加密机器无需能访问目标服务器的主密钥路径。
    merged.pop("ask_metric_config_sm4_key_file", None)
    for field in ("app_database_url", "query_database_url"):
        if not merged.get(field):
            raise ConfigCenterError(f"缺少数据源配置：{field}")
    try:
        settings = CenterSettings(**{k: v for k, v in merged.items() if k in Settings.model_fields})
    except ValueError:
        raise ConfigCenterError(
            "填写的运行/数据源/安全配置未通过应用校验，请核对字段类型及必填值"
        ) from None
    selected = dict(docs)
    if settings.nacos_prompt_data_id != PROMPTS_DATA_ID:
        if settings.nacos_prompt_data_id not in docs:
            raise ConfigCenterError("缺少节点选定的提示词配置")
        selected[PROMPTS_DATA_ID] = docs[settings.nacos_prompt_data_id]
    settings._config_center = DocumentSnapshot(selected)
    validate_resources(settings)
