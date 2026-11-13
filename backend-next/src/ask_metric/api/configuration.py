"""配置读写共用应用库；测试可注入专属仓库，不改变正式数据库连接设置。"""

from typing import TYPE_CHECKING

from fastapi import Request

if TYPE_CHECKING:
    from ask_metric.infrastructure.model.configuration import (
        ModelConfigRepository,
        PromptConfigRepository,
    )

from ask_metric.infrastructure.configuration_repository import DatabaseConfigRepository
from ask_metric.infrastructure.db.session import get_app_engine


def shared_configuration(request: Request) -> DatabaseConfigRepository:
    repository = getattr(request.app.state, "shared_configuration_repository", None)
    return repository if repository is not None else DatabaseConfigRepository(get_app_engine())


def metric_semantics_document(request: Request) -> dict | None:
    from ask_metric.application.database_metric_semantics import read_metric_semantics

    if getattr(request.app.state.settings, "business_configuration_storage", "file") == "database":
        return read_metric_semantics(shared_configuration(request))[0]
    return None


def business_topics_document(request: Request) -> dict | None:
    from ask_metric.application.database_runtime_configuration import read_business_topics

    if getattr(request.app.state.settings, "business_configuration_storage", "file") == "database":
        return read_business_topics(shared_configuration(request))
    return None


def semantic_repository(request: Request):
    from ask_metric.application.database_runtime_configuration import (
        DatabaseSemanticConfigRepository,
    )
    from ask_metric.core.config import PROJECT_DIR
    from ask_metric.infrastructure.model.configuration import resolve_config_path
    from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

    settings = request.app.state.settings
    if getattr(settings, "business_configuration_storage", "file") == "database":
        return DatabaseSemanticConfigRepository(shared_configuration(request))
    return SemanticConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.semantic_config_path),
        store=settings._config_center,
    )


def model_repositories(
    request: Request,
    *,
    actor: str = "runtime",
) -> tuple["ModelConfigRepository", "PromptConfigRepository"]:
    from ask_metric.application.database_model_configuration import (
        DatabaseModelConfigRepository,
        DatabasePromptConfigRepository,
    )
    from ask_metric.core.config import PROJECT_DIR
    from ask_metric.infrastructure.model.configuration import (
        ModelConfigRepository,
        PromptConfigRepository,
        resolve_config_path,
    )

    settings = request.app.state.settings
    if getattr(settings, "business_configuration_storage", "file") == "database":
        repository = shared_configuration(request)
        return (
            DatabaseModelConfigRepository(repository, actor=actor),
            DatabasePromptConfigRepository(repository),
        )
    return (
        ModelConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.model_config_path),
            store=settings._config_center,
        ),
        PromptConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.prompt_config_path),
            store=settings._config_center,
        ),
    )
