"""部署模型检查：默认只检查配置；--live 才调用模型，始终不访问数据库。"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from deployment_common import load_environment


class ConfigurationIssue(ValueError):
    """只包含固定提示和字段名，可以安全显示给部署人员。"""


def configuration_path(name: str) -> Path:
    value = os.environ.get(name, "")
    if not value or not Path(value).is_absolute() or not Path(value).is_file():
        raise ConfigurationIssue(f"{name} 必须显式指向存在的绝对文件路径")
    return Path(value).resolve()


def validate_models(config_file: Path):
    from ask_metric.domain.intent_routing import RoutedIntent
    from ask_metric.infrastructure.model.configuration import (
        ModelConfigRepository,
        PromptConfigRepository,
    )
    from ask_metric.infrastructure.model.provider import (
        ConfigurableModelService,
        credential_resolver_from_env_file,
    )
    from ask_metric.infrastructure.semantic.configuration import (
        SemanticConfigRepository,
    )
    from dotenv import dotenv_values

    try:
        config_file = load_environment(config_file)
    except ValueError as exc:
        raise ConfigurationIssue(str(exc)) from None
    file_values = dotenv_values(config_file, interpolate=False)
    from ask_metric.core.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    store = settings._config_center
    if store is not None:
        model_path = settings.model_config_path
        prompt_path = settings.prompt_config_path
        semantic_path = settings.semantic_config_path
        secret_path = config_file
        repository = ModelConfigRepository(model_path, store=store)
    else:
        for name in ("MODEL_CONFIG_PATH", "PROMPT_CONFIG_PATH", "MODEL_SECRET_ENV_PATH",
                     "SEMANTIC_CONFIG_PATH"):
            if not file_values.get(name):
                raise ConfigurationIssue(f"{name} 必须显式填写在本次配置文件中")
        model_path = configuration_path("MODEL_CONFIG_PATH")
        prompt_path = configuration_path("PROMPT_CONFIG_PATH")
        secret_path = configuration_path("MODEL_SECRET_ENV_PATH")
        semantic_path = configuration_path("SEMANTIC_CONFIG_PATH")
        if secret_path != config_file:
            raise ConfigurationIssue("MODEL_SECRET_ENV_PATH 必须指向本次 --config 文件")
        # 提示词允许实体标签；只对模型文件检查地址、模型名占位符。
        if re.search(r"<[^>]+>|@[A-Z_]+@", model_path.read_text(encoding="utf-8")):
            raise ConfigurationIssue("MODEL_CONFIG_PATH 文件仍有未替换占位符")
        repository = ModelConfigRepository(model_path)
    config = repository.load()
    chat = config.models.chat
    # 内网允许不发送格式参数；本地仍须按 JSON 解析并在 --live 中校验意图。
    if not chat.enabled or chat.response_format != "json_object":
        raise ConfigurationIssue(
            "chat 必须 enabled=true、response_format=json_object"
        )
    if chat.chat_template_kwargs.get("enable_thinking") is not False:
        raise ConfigurationIssue("chat.chat_template_kwargs.enable_thinking 必须为 false")
    if chat.enable_thinking or chat.send_enable_thinking:
        raise ConfigurationIssue("chat.enable_thinking 和 send_enable_thinking 必须为 false")
    prompts = PromptConfigRepository(prompt_path, store=store)
    context = {"question": "查询本月存款余额", "allowed_intents_json": json.dumps(
        [intent.value for intent in RoutedIntent], ensure_ascii=False,
    )}
    prompts.render("intent_routing", context)
    semantic = SemanticConfigRepository(semantic_path, store=store).load()
    resolver = credential_resolver_from_env_file(secret_path, config_store=store)
    service = ConfigurableModelService(
        model_config_repository=repository, prompt_config_repository=prompts,
        credential_resolver=resolver,
    )
    sources = {}
    for role in ("chat", "embedding", "reranker"):
        endpoint = getattr(config.models, role)
        if not endpoint.enabled:
            sources[role] = "disabled"
            continue
        # 不接受仅在调用终端中存在的隐式地址/密钥，避免换节点或重启后丢失。
        for name in (endpoint.base_url_env, endpoint.api_key_env):
            if store is None and name and not file_values.get(name) and os.environ.get(name):
                raise ConfigurationIssue(f"{role}: {name} 仅在进程环境存在，须显式写入配置")
        address = resolver(endpoint.base_url_env) if endpoint.base_url_env else None
        sources[role] = endpoint.base_url_env if address else "model-config.json/base_url"
        address = address or endpoint.base_url
        try:
            parsed = urlsplit(address)
            port = parsed.port
            valid = (parsed.scheme in {"http", "https"} and parsed.hostname
                     and not parsed.username and not parsed.password
                     and not parsed.query and not parsed.fragment
                     and (port is None or port > 0) and not any(c.isspace() for c in address))
        except ValueError:
            valid = False
        if not valid:
            raise ConfigurationIssue(f"{role}: 模型地址为空或格式不正确")
        if re.search(r"<[^>]+>|@[A-Z_]+@", address):
            raise ConfigurationIssue(f"{role}: 模型地址仍有占位符")
        if address.rstrip("/").endswith(endpoint.path) or (
            parsed.path.rstrip("/").endswith("/v1") and endpoint.path.startswith("/v1/")
        ):
            raise ConfigurationIssue(f"{role}: base_url 与 path 重复包含接口路径")
        service._authentication_headers(endpoint)
    request_options = {"chat_template_kwargs": chat.chat_template_kwargs}
    if chat.send_response_format:
        request_options["response_format"] = {"type": "json_object"}
    print(json.dumps({
        "status": "PASS", "check": "configuration", "config": str(config_file),
        "model_config": "Nacos/sznsznws_backend_model.json" if store else str(model_path),
        "prompts": "Nacos/sznsznws_backend_prompts.json" if store else str(prompt_path),
        "address_sources": sources,
        "send_response_format": chat.send_response_format,
        "request": request_options,
    }, ensure_ascii=False))
    return service, context, semantic.metric_matching.embedding_batch_size


def check_live(service, context: dict, batch_size: int) -> None:
    from ask_metric.domain.intent_routing import (
        RoutedIntent,
        parse_intent_classification,
    )
    from ask_metric.infrastructure.model.catalog_vectors import CatalogVectorCache

    intent = parse_intent_classification(service.analyze(prompt="intent_routing", context=context))
    if intent.intent != RoutedIntent.METRIC_QUERY:
        raise ConfigurationIssue("Chat 返回合法分类，但未正确识别固定的指标查询问题")
    print("PASS: Chat 实际提示词、JSON 正文和意图字段校验")
    if service.is_enabled("embedding"):
        vectors = service.embed([f"部署检查指标{i}" for i in range(batch_size)])
        CatalogVectorCache._validate(vectors, batch_size, None)
        print(f"PASS: Embedding 实际批量 {batch_size} 条及向量数值校验")
    if service.is_enabled("reranker"):
        service.rerank(query="存款余额", documents=["存款余额", "其他指标"], top_n=2)
        print("PASS: Reranker 响应校验")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    stage = "configuration"
    try:
        service, context, batch_size = validate_models(args.config)
        if args.live:
            stage = "model_response"
            check_live(service, context, batch_size)
        return 0
    except ConfigurationIssue as exc:
        print(f"FAIL: {exc}")
    except Exception as exc:
        from ask_metric.infrastructure.config_center.nacos import ConfigCenterError

        if isinstance(exc, ConfigCenterError):
            print(f"FAIL: {exc}")
            return 2
        # 不输出异常输入/模型正文；只保留失败阶段、类型及已有安全诊断码。
        errors = getattr(exc, "errors", None)
        if callable(errors):
            errors = errors(include_url=False, include_context=False, include_input=False)
        fields = [{"field": item["loc"], "type": item["type"]}
                  for item in errors] if isinstance(errors, list) else []
        print(json.dumps({"status": "FAILED", "stage": stage,
                          "error_type": type(exc).__name__,
                          "cause_type": type(exc.__cause__).__name__,
                          "category": getattr(exc, "category", None),
                          "http_status": getattr(exc, "status_code", None),
                          "validation": fields}, ensure_ascii=False))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
