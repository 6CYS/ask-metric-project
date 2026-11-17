"""显式初始化管理入口所需资源；不建表、不导入现场参数、不覆盖已有版本。"""

from collections.abc import Callable

from ask_metric.application.agent_runtime_configuration import import_agent_runtime
from ask_metric.application.database_model_configuration import (
    import_model_configuration,
    import_prompt_configuration,
)
from ask_metric.core.errors import ApplicationError
from ask_metric.core.runtime_resources import runtime_config_dir
from ask_metric.infrastructure.configuration_repository import (
    DatabaseConfigRepository,
    serialize_document,
)
from ask_metric.infrastructure.model.configuration import PromptRuntimeConfig

MANAGED_RESOURCES = (
    "backend-models",
    "backend-prompt-index",
    "agent-runtime",
    "business-skills",
    "business-knowledge",
    "analysis-semantics",
    "business-topics",
    "semantic-runtime",
    "inquiry-topics",
)


def missing_resources(repository: DatabaseConfigRepository) -> list[str]:
    missing = []
    for key in MANAGED_RESOURCES:
        try:
            repository.read(key)
        except ApplicationError as error:
            if error.code != "CONFIG_NOT_INITIALIZED":
                raise
            missing.append(key)
    return missing


def initialize_management_configuration(
    repository: DatabaseConfigRepository,
    *,
    actor: str,
) -> list[str]:
    created: list[str] = []

    def ensure(key: str, initialize: Callable[[], object]) -> None:
        try:
            repository.read(key)
            return
        except ApplicationError as error:
            if error.code != "CONFIG_NOT_INITIALIZED":
                raise
        # initialize 自带唯一键与版本冲突保护；并发管理员初始化不会覆盖对方发布。
        initialize()
        created.append(key)

    ensure(
        "backend-models",
        lambda: import_model_configuration(
            repository,
            serialize_document(
                {
                    "schema_version": 2,
                    "provider": "openai_compatible",
                    "models": {
                        "chat": {
                            "enabled": False,
                            "base_url": "",
                            "model": "",
                            "path": "/v1/chat/completions",
                            "api_key_env": "MODEL_CHAT_API_KEY",
                        },
                    },
                }
            ),
            actor=actor,
        ),
    )
    ensure(
        "agent-runtime",
        lambda: import_agent_runtime(
            repository,
            serialize_document(
                {
                    "schema_version": 1,
                    "model": {
                        "baseUrl": "",
                        "name": "",
                        "apiKeyEnv": "AGENT_MODEL_API_KEY",
                        "authHeader": "Authorization",
                        "authPrefix": "Bearer",
                        "userMessageSuffix": "",
                        "extraBody": {},
                        "contextWindow": 128000,
                        "maxTokens": 8192,
                    },
                    "modelRetry": {"enabled": True, "maxRetries": 1, "baseDelayMs": 1000},
                    "modelStreamIdleTimeoutMs": 30000,
                    "modelFirstResponseTimeoutMs": 30000,
                    "answerStreaming": False,
                    "topicQueryEnabled": False,
                    "compaction": {
                        "enabled": True,
                        "reserveTokens": 16384,
                        "keepRecentTokens": 20000,
                    },
                }
            ),
            actor=actor,
        ),
    )

    def initialize_prompts() -> None:
        # 仅首次显式初始化读取随程序提供的标准模板；后续运行仍只读取数据库。
        try:
            content = (runtime_config_dir() / "prompts.json").read_text(encoding="utf-8")
            PromptRuntimeConfig.model_validate_json(content)
        except (OSError, ValueError) as error:
            raise ApplicationError(
                "CONFIG_SETUP_TEMPLATE_UNAVAILABLE",
                "标准提示词模板不可用，请核对部署资源。",
                status_code=503,
            ) from error
        import_prompt_configuration(repository, content, actor=actor)

    ensure("backend-prompt-index", initialize_prompts)
    return created
