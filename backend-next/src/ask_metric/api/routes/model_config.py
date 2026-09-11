from __future__ import annotations

import hmac
import logging
import os
from time import perf_counter
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, Field
from sqlalchemy import text

from ask_metric.api.dependencies import get_model_service, require_actor
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import PROJECT_DIR, Settings
from ask_metric.core.config_crypto import (
    encrypt_config_value,
    load_config_sm4_key,
)
from ask_metric.core.env_file import update_env_file
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import QueryTemplateId
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.model.configuration import (
    ConfigHistoryRepository,
    ConfigVersion,
    ModelConfigRepository,
    ModelRuntimeConfig,
    PromptConfigRepository,
    PromptRuntimeConfig,
    PromptTemplate,
    resolve_config_path,
)
from ask_metric.infrastructure.model.provider import (
    ConfigurableModelService,
    InvalidModelResponse,
    ModelServiceUnavailable,
    credential_resolver_from_env_file,
)
from ask_metric.infrastructure.query.templates import (
    QueryTemplateRead,
    QueryTemplateRepository,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/model-config", tags=["model-config"], dependencies=[Depends(require_actor)]
)


class ModelConfigResponse(BaseModel):
    config: ModelRuntimeConfig
    prompts: PromptRuntimeConfig
    api_key_configured: dict[str, bool]
    write_enabled: bool
    write_token_required: bool


class ModelConfigUpdate(BaseModel):
    config: ModelRuntimeConfig
    prompts: PromptRuntimeConfig
    api_keys: dict[Literal["chat", "embedding", "reranker"], str] = Field(
        default_factory=dict
    )


class ModelOnlyUpdate(BaseModel):
    config: ModelRuntimeConfig
    api_keys: dict[Literal["chat", "embedding", "reranker"], str] = Field(
        default_factory=dict
    )


def _credential_status(settings: Settings, config: ModelRuntimeConfig) -> dict[str, bool]:
    resolve_credential = credential_resolver_from_env_file(
        resolve_config_path(PROJECT_DIR, settings.model_secret_env_path)
    )
    return {
        role: endpoint.authentication.type == "none"
        or bool(endpoint.api_key_env and resolve_credential(endpoint.api_key_env))
        for role, endpoint in {
            "chat": config.models.chat,
            "embedding": config.models.embedding,
            "reranker": config.models.reranker,
        }.items()
    }


def _update_model_credentials(
    settings: Settings,
    config: ModelRuntimeConfig,
    api_keys: dict[str, str],
) -> None:
    endpoints = {
        "chat": config.models.chat,
        "embedding": config.models.embedding,
        "reranker": config.models.reranker,
    }
    updates: dict[str, str] = {}
    for role, raw_secret in api_keys.items():
        secret = raw_secret.strip()
        if not secret:
            continue
        endpoint = endpoints[role]
        if endpoint.authentication.type == "none" or not endpoint.api_key_env:
            raise ApplicationError(
                "MODEL_CREDENTIAL_NOT_EXPECTED",
                f"The {role} endpoint does not use a configured credential",
                status_code=422,
            )
        previous = updates.get(endpoint.api_key_env)
        if previous is not None and previous != secret:
            raise ApplicationError(
                "MODEL_CREDENTIAL_CONFLICT",
                f"Multiple model roles use {endpoint.api_key_env} with different values",
                status_code=422,
            )
        updates[endpoint.api_key_env] = secret
    if not updates:
        return
    key = (
        load_config_sm4_key(
            environ={}, key_file=settings.ask_metric_config_sm4_key_file
        )
        if settings.ask_metric_config_sm4_key_file
        else load_config_sm4_key(required=False)
    )
    if key is None and settings.app_env.lower() not in {"development", "test"}:
        raise ApplicationError(
            "CONFIG_ENCRYPTION_KEY_REQUIRED",
            "SM4 configuration key is required before saving model credentials",
            status_code=503,
        )
    stored_updates = {
        name: encrypt_config_value(secret, key) if key is not None else secret
        for name, secret in updates.items()
    }
    update_env_file(
        resolve_config_path(PROJECT_DIR, settings.model_secret_env_path), stored_updates
    )
    os.environ.update(updates)


class SqlTemplateUpdate(BaseModel):
    sql: str
    enabled: bool = True


class SqlTemplateValidation(BaseModel):
    sql: str


class SqlTemplateTrialRun(BaseModel):
    sql: str
    parameters: dict[str, object]


class ModelConnectionTestResponse(BaseModel):
    role: Literal["chat", "embedding", "reranker"]
    ok: bool
    duration_ms: int
    summary: str


class _InlineModelConfigRepository:
    """Expose an unsaved UI draft through the model-service repository contract."""

    def __init__(self, config: ModelRuntimeConfig) -> None:
        self.config = config

    def load(self) -> ModelRuntimeConfig:
        return self.config


def _draft_model_service(
    request: Request,
    settings: Settings,
    payload: ModelOnlyUpdate,
) -> ConfigurableModelService:
    endpoints = {
        "chat": payload.config.models.chat,
        "embedding": payload.config.models.embedding,
        "reranker": payload.config.models.reranker,
    }
    draft_credentials = {
        endpoints[role].api_key_env: secret.strip()
        for role, secret in payload.api_keys.items()
        if secret.strip() and endpoints[role].api_key_env
    }
    persisted_credential = credential_resolver_from_env_file(
        resolve_config_path(PROJECT_DIR, settings.model_secret_env_path)
    )

    def resolve_credential(name: str) -> str | None:
        return draft_credentials.get(name) or persisted_credential(name)

    return ConfigurableModelService(
        model_config_repository=_InlineModelConfigRepository(payload.config),  # type: ignore[arg-type]
        prompt_config_repository=PromptConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.prompt_config_path)
        ),
        credential_resolver=resolve_credential,
        client=request.app.state.model_http_client,
        max_concurrency=settings.model_max_concurrency,
        concurrency_wait_seconds=settings.model_concurrency_wait_seconds,
        semaphore=request.app.state.model_semaphore,
    )


def get_model_config_repositories(
    request: Request,
) -> tuple[ModelConfigRepository, PromptConfigRepository]:
    settings: Settings = request.app.state.settings
    return (
        ModelConfigRepository(resolve_config_path(PROJECT_DIR, settings.model_config_path)),
        PromptConfigRepository(resolve_config_path(PROJECT_DIR, settings.prompt_config_path)),
    )


def get_config_management_repositories(
    request: Request,
) -> tuple[QueryTemplateRepository, ConfigHistoryRepository]:
    settings: Settings = request.app.state.settings
    return (
        QueryTemplateRepository(
            resolve_config_path(PROJECT_DIR, settings.query_template_config_path),
            resolve_config_path(PROJECT_DIR, settings.sql_resource_dir),
        ),
        ConfigHistoryRepository(
            resolve_config_path(PROJECT_DIR, settings.config_history_dir)
        ),
    )


def get_uow() -> SqlAlchemyUnitOfWork:
    return SqlAlchemyUnitOfWork()


def _require_config_write(
    settings: Settings,
    actor: ActorContext,
    admin_token: str | None,
) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise ApplicationError(
            "CONFIG_ADMIN_REQUIRED",
            "System administrator permission is required",
            status_code=403,
        )
    if not settings.model_admin_write_enabled:
        raise ApplicationError(
            "MODEL_CONFIG_WRITE_DISABLED",
            "Runtime configuration updates are disabled",
            status_code=403,
        )
    if settings.model_admin_token_required and (
        not settings.model_admin_token
        or not admin_token
        or not hmac.compare_digest(settings.model_admin_token, admin_token)
    ):
        raise ApplicationError(
            "MODEL_CONFIG_UNAUTHORIZED",
            "A valid configuration administration token is required",
            status_code=401,
        )


def _require_config_read(actor: ActorContext) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise ApplicationError(
            "CONFIG_ADMIN_REQUIRED",
            "System administrator permission is required",
            status_code=403,
        )


def _actor_name(actor: ActorContext) -> str:
    return actor.user_id or actor.subject


@router.get("", response_model=ModelConfigResponse)
def get_model_config(
    request: Request,
    repositories: Annotated[
        tuple[ModelConfigRepository, PromptConfigRepository],
        Depends(get_model_config_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> ModelConfigResponse:
    _require_config_read(actor)
    settings: Settings = request.app.state.settings
    model_repository, prompt_repository = repositories
    return ModelConfigResponse(
        config=model_repository.load(),
        prompts=prompt_repository.load(),
        api_key_configured=_credential_status(settings, model_repository.load()),
        write_enabled=bool(settings.model_admin_write_enabled),
        write_token_required=bool(settings.model_admin_token_required),
    )


@router.put("", response_model=ModelConfigResponse)
def update_model_config(
    payload: ModelConfigUpdate,
    request: Request,
    repositories: Annotated[
        tuple[ModelConfigRepository, PromptConfigRepository],
        Depends(get_model_config_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> ModelConfigResponse:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    model_repository, prompt_repository = repositories
    current_prompts = prompt_repository.load()
    prompt_repository.validate_update(payload.prompts)
    if payload.prompts != current_prompts:
        raise ApplicationError(
            "VERSIONED_PROMPT_UPDATE_REQUIRED",
            "Prompts must be published through the versioned prompt endpoint",
            status_code=409,
        )
    model_repository.save(payload.config)
    _update_model_credentials(settings, payload.config, payload.api_keys)
    return ModelConfigResponse(
        config=payload.config,
        prompts=current_prompts,
        api_key_configured=_credential_status(settings, payload.config),
        write_enabled=True,
        write_token_required=bool(settings.model_admin_token_required),
    )


@router.put("/model", response_model=ModelConfigResponse)
def update_model_only(
    payload: ModelOnlyUpdate,
    request: Request,
    repositories: Annotated[
        tuple[ModelConfigRepository, PromptConfigRepository],
        Depends(get_model_config_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> ModelConfigResponse:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    model_repository, prompt_repository = repositories
    model_repository.save(payload.config)
    _update_model_credentials(settings, payload.config, payload.api_keys)
    return ModelConfigResponse(
        config=payload.config,
        prompts=prompt_repository.load(),
        api_key_configured=_credential_status(settings, payload.config),
        write_enabled=True,
        write_token_required=bool(settings.model_admin_token_required),
    )


@router.post(
    "/model/test/{role}",
    response_model=ModelConnectionTestResponse,
)
def test_model_connection(
    role: Literal["chat", "embedding", "reranker"],
    request: Request,
    service: Annotated[ConfigurableModelService, Depends(get_model_service)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    payload: ModelOnlyUpdate | None = None,
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> ModelConnectionTestResponse:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    tested_service = _draft_model_service(request, settings, payload) if payload else service
    started = perf_counter()
    try:
        if role == "chat":
            result = tested_service.analyze(
                prompt="intent_routing",
                context={
                    "question": "查询本月指标值",
                    "allowed_intents_json": '["metric_query"]',
                },
            )
            summary = f"JSON fields: {', '.join(sorted(result)) or 'none'}"
        elif role == "embedding":
            vectors = tested_service.embed(["指标问数连接测试"])
            dimensions = len(vectors[0]) if vectors else 0
            summary = f"vectors={len(vectors)}, dimensions={dimensions}"
        else:
            results = tested_service.rerank(
                query="指标问数",
                documents=["指标查询", "无关文本"],
                top_n=1,
            )
            summary = f"results={len(results)}"
    except ModelServiceUnavailable as exc:
        error_reference = uuid4().hex
        logger.warning(
            "model_connection_test_failed role=%s category=%s error_reference=%s",
            role,
            exc.category,
            error_reference,
        )
        raise ApplicationError(
            "MODEL_CONNECTION_FAILED",
            f"{role} 模型连接失败，请检查服务端配置。",
            status_code=422 if exc.category == "configuration" else 502,
            details={
                "role": role,
                "category": exc.category,
                "error_reference": error_reference,
            },
        ) from exc
    except InvalidModelResponse as exc:
        error_reference = uuid4().hex
        logger.warning(
            "model_response_validation_failed role=%s error_reference=%s",
            role,
            error_reference,
        )
        raise ApplicationError(
            "MODEL_RESPONSE_INVALID",
            f"{role} 模型已响应，但返回格式无效。",
            status_code=502,
            details={"role": role, "error_reference": error_reference},
        ) from exc
    return ModelConnectionTestResponse(
        role=role,
        ok=True,
        duration_ms=max(0, round((perf_counter() - started) * 1000)),
        summary=summary,
    )


@router.put("/prompts/{prompt_name}", response_model=PromptTemplate)
def update_prompt(
    prompt_name: str,
    payload: PromptTemplate,
    request: Request,
    repositories: Annotated[
        tuple[ModelConfigRepository, PromptConfigRepository],
        Depends(get_model_config_repositories),
    ],
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> PromptTemplate:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    _, prompt_repository = repositories
    _, history = management
    config = prompt_repository.load()
    current = config.prompts.get(prompt_name)
    if current is None:
        raise ApplicationError("PROMPT_NOT_FOUND", "Prompt was not found", status_code=404)
    _ensure_baseline(
        history,
        resource_type="prompt",
        resource_key=prompt_name,
        snapshot=current.model_dump(mode="json"),
    )
    config.prompts[prompt_name] = payload
    prompt_repository.validate_update(config)
    prompt_repository.save(config)
    history.record(
        resource_type="prompt",
        resource_key=prompt_name,
        snapshot=payload.model_dump(mode="json"),
        created_by=_actor_name(actor),
    )
    return payload


@router.get("/prompts/{prompt_name}/versions", response_model=list[ConfigVersion])
def list_prompt_versions(
    prompt_name: str,
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> list[ConfigVersion]:
    _require_config_read(actor)
    return management[1].list(resource_type="prompt", resource_key=prompt_name)


@router.post("/prompts/{prompt_name}/versions/{version_id}/rollback", response_model=PromptTemplate)
def rollback_prompt(
    prompt_name: str,
    version_id: str,
    request: Request,
    repositories: Annotated[
        tuple[ModelConfigRepository, PromptConfigRepository],
        Depends(get_model_config_repositories),
    ],
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> PromptTemplate:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    _, prompt_repository = repositories
    _, history = management
    try:
        version = history.get(
            resource_type="prompt", resource_key=prompt_name, version_id=version_id
        )
    except KeyError as exc:
        raise ApplicationError("CONFIG_VERSION_NOT_FOUND", str(exc), status_code=404) from exc
    restored = PromptTemplate.model_validate(version.snapshot)
    config = prompt_repository.load()
    if prompt_name not in config.prompts:
        raise ApplicationError("PROMPT_NOT_FOUND", "Prompt was not found", status_code=404)
    config.prompts[prompt_name] = restored
    prompt_repository.validate_update(config)
    prompt_repository.save(config)
    history.record(
        resource_type="prompt",
        resource_key=prompt_name,
        snapshot=restored.model_dump(mode="json"),
        created_by=_actor_name(actor),
        action="rollback",
        source_version_id=version_id,
    )
    return restored


@router.get("/sql-templates", response_model=list[QueryTemplateRead])
def list_sql_templates(
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> list[QueryTemplateRead]:
    _require_config_read(actor)
    return management[0].list_templates()


@router.post("/sql-templates/validate")
def validate_sql_template(
    payload: SqlTemplateValidation,
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> dict[str, object]:
    _require_config_read(actor)
    return {"valid": True, "parameters": management[0].validate_template(payload.sql)}


@router.post("/sql-templates/trial-run")
def trial_run_sql_template(
    payload: SqlTemplateTrialRun,
    request: Request,
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> dict[str, object]:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    management[0].validate_template(payload.sql)
    sql = payload.sql.strip().rstrip(";")
    with uow:
        result = uow.session.execute(
            text(
                "SELECT /*+ MAX_EXECUTION_TIME(5000) */ * "
                f"FROM ({sql}) AS config_template_preview LIMIT 20"
            ),
            payload.parameters,
        )
        columns = list(result.keys())
        rows = [dict(row) for row in result.mappings().all()]
    return {"columns": columns, "rows": rows, "row_count": len(rows)}


@router.put("/sql-templates/{dialect}/{template}", response_model=QueryTemplateRead)
def update_sql_template(
    dialect: str,
    template: QueryTemplateId,
    payload: SqlTemplateUpdate,
    request: Request,
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> QueryTemplateRead:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    templates, history = management
    current = next(
        item
        for item in templates.list_templates()
        if item.dialect == dialect and item.template == template
    )
    resource_key = f"{dialect}.{template.value}"
    _ensure_baseline(
        history,
        resource_type="sql",
        resource_key=resource_key,
        snapshot={"sql": current.sql, "enabled": current.enabled},
    )
    updated = templates.save_template(
        dialect=dialect, template=template, sql=payload.sql, enabled=payload.enabled
    )
    history.record(
        resource_type="sql",
        resource_key=resource_key,
        snapshot={"sql": updated.sql, "enabled": updated.enabled},
        created_by=_actor_name(actor),
    )
    return updated


@router.get(
    "/sql-templates/{dialect}/{template}/versions", response_model=list[ConfigVersion]
)
def list_sql_template_versions(
    dialect: str,
    template: QueryTemplateId,
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> list[ConfigVersion]:
    _require_config_read(actor)
    return management[1].list(
        resource_type="sql", resource_key=f"{dialect}.{template.value}"
    )


@router.post(
    "/sql-templates/{dialect}/{template}/versions/{version_id}/rollback",
    response_model=QueryTemplateRead,
)
def rollback_sql_template(
    dialect: str,
    template: QueryTemplateId,
    version_id: str,
    request: Request,
    management: Annotated[
        tuple[QueryTemplateRepository, ConfigHistoryRepository],
        Depends(get_config_management_repositories),
    ],
    actor: Annotated[ActorContext, Depends(require_actor)],
    admin_token: Annotated[str | None, Header(alias="X-Model-Admin-Token")] = None,
) -> QueryTemplateRead:
    settings: Settings = request.app.state.settings
    _require_config_write(settings, actor, admin_token)
    templates, history = management
    resource_key = f"{dialect}.{template.value}"
    try:
        version = history.get(
            resource_type="sql", resource_key=resource_key, version_id=version_id
        )
    except KeyError as exc:
        raise ApplicationError("CONFIG_VERSION_NOT_FOUND", str(exc), status_code=404) from exc
    if not isinstance(version.snapshot, dict):
        raise ApplicationError("CONFIG_VERSION_INVALID", "SQL version is invalid", status_code=409)
    restored = templates.save_template(
        dialect=dialect,
        template=template,
        sql=str(version.snapshot["sql"]),
        enabled=bool(version.snapshot.get("enabled", True)),
    )
    history.record(
        resource_type="sql",
        resource_key=resource_key,
        snapshot={"sql": restored.sql, "enabled": restored.enabled},
        created_by=_actor_name(actor),
        action="rollback",
        source_version_id=version_id,
    )
    return restored


def _ensure_baseline(
    history: ConfigHistoryRepository,
    *,
    resource_type: str,
    resource_key: str,
    snapshot: dict[str, object],
) -> None:
    if history.list(resource_type=resource_type, resource_key=resource_key):
        return
    history.record(
        resource_type=resource_type,
        resource_key=resource_key,
        snapshot=snapshot,
        created_by="system-baseline",
    )
