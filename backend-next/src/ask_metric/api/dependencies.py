"""依赖装配入口：将配置、模型、权限及数据库实现交给各业务服务。

路由中的 Depends(get_xxx) 由 FastAPI 调用；这里主要创建服务，不执行用户查询。
身份来自认证依赖，模型连接和目录缓存则复用 app.state 中的进程级资源。
"""

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ask_metric.application.actor_provider import ActorProvider, ContextActorProvider
from ask_metric.application.auth_service import AuthenticationService
from ask_metric.application.channel_service import ChannelClarificationService
from ask_metric.application.continuation_tokens import ContinuationTokenCodec
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.result_enrichment import CatalogResultEnricher
from ask_metric.application.semantic_task_service import SemanticTaskApplicationService
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.config import PROJECT_DIR, Settings
from ask_metric.core.security import AuthenticationError, decode_access_token
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantic_engine import SemanticEngine
from ask_metric.infrastructure.db.organization_scope import SqlAlchemyOrganizationScopeProvider
from ask_metric.infrastructure.db.session import get_app_session_factory, get_query_engine
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.model.catalog_vectors import catalog_embedding_texts
from ask_metric.infrastructure.model.configuration import (
    ModelConfigRepository,
    PromptConfigRepository,
    resolve_config_path,
)
from ask_metric.infrastructure.model.provider import (
    ConfigurableModelService,
    credential_resolver_from_env_file,
)
from ask_metric.infrastructure.query.factory import create_data_source_adapter
from ask_metric.infrastructure.query.templates import QueryTemplateRepository
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

bearer_scheme = HTTPBearer(auto_error=False)


def initialize_query_catalog(request: Request) -> None:
    """复用在线问数的模型配置、目录文本与缓存，避免预热和实际检索使用不同输入。"""
    initialization = request.app.state.query_initialization
    initialization.progress(0, 0)
    model = get_model_service(request)
    if not model.is_enabled("embedding"):
        return
    settings = request.app.state.settings
    config = SemanticConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.semantic_config_path),
    ).load().metric_matching
    with SqlAlchemyUnitOfWork() as uow:
        corpus = catalog_embedding_texts(uow.metric_catalog.list_enabled())
    # 先读目录再释放数据库会话；后面的分批模型请求不占用此处的数据库连接。
    if not corpus:
        raise ValueError("Enabled metric catalog is empty")
    request.app.state.catalog_vector_cache.warmup(
        # 传入绑定方法作为回调，缓存每完成一批便调用它更新公共初始化状态。
        model, corpus, batch_size=config.embedding_batch_size,
        wait_seconds=config.embedding_cache_wait_seconds, progress=initialization.progress,
    )


def get_authentication_service(request: Request) -> AuthenticationService:
    return AuthenticationService(request.app.state.settings)


def require_actor(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> ActorContext:
    """验证令牌后再核对当前账号，防止停用账号或旧登录凭证继续访问。"""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AuthenticationError("AUTH_TOKEN_INVALID", "请先登录")
    return authenticate_access_token(request, credentials.credentials)


def authenticate_access_token(request: Request, token: str) -> ActorContext:
    """在线请求与刷新恢复共用账号校验；Cookie 不会成为业务接口的备用认证方式。"""
    settings: Settings = request.app.state.settings
    claims = decode_access_token(token, settings)
    user_id = str(claims.get("sub") or "")
    with SqlAlchemyUnitOfWork() as uow:
        user = uow.users.get(user_id)
        if user is None:
            raise AuthenticationError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录")
        if not user.enabled:
            raise AuthenticationError("AUTH_USER_DISABLED", "账号已被禁用，请联系管理员")
        if user.session_version != claims.get("session_version"):
            raise AuthenticationError(
                "AUTH_SESSION_REPLACED", "账号已在其他位置重新登录，请重新认证"
            )
        if any(
            claims.get(key) != value
            for key, value in {
                "username": user.username,
                "org_code": user.org_code,
                "role_code": user.role_code,
            }.items()
        ):
            raise AuthenticationError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录")
    return ActorContext(
        subject=user.username,
        user_id=user.id,
        org_id=user.org_code,
        role_code=user.role_code,
        authentication_method="local_jwt",
        trust_level="authenticated",
    )


def get_actor_provider(actor: Annotated[ActorContext, Depends(require_actor)]) -> ActorProvider:
    # Annotated 的第一个参数是类型，Depends 告诉框架如何取得已验证的身份。
    return ContextActorProvider(actor)


def get_query_task_service(request: Request) -> QueryTaskApplicationService:
    settings: Settings = request.app.state.settings
    return QueryTaskApplicationService(
        max_conversations_per_user=settings.max_conversations_per_user,
        continuation_token_codec=ContinuationTokenCodec(
            settings.continuation_token_secret,
            ttl_seconds=settings.continuation_token_ttl_seconds,
        ),
        semantic_config_repository=SemanticConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.semantic_config_path)
        ),
        candidate_permission_service=ScopedOrganizationPermissionService(
            organization_scope_provider=SqlAlchemyOrganizationScopeProvider(),
            allow_unscoped_development=settings.app_env.lower() in {"development", "test"},
        ),
    )


def get_channel_clarification_service(request: Request) -> ChannelClarificationService:
    settings: Settings = request.app.state.settings
    return ChannelClarificationService(
        ContinuationTokenCodec(
            settings.continuation_token_secret,
            ttl_seconds=settings.continuation_token_ttl_seconds,
        )
    )


def get_model_service(request: Request) -> ConfigurableModelService:
    settings: Settings = request.app.state.settings
    return ConfigurableModelService(
        model_config_repository=ModelConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.model_config_path)
        ),
        prompt_config_repository=PromptConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.prompt_config_path)
        ),
        credential_resolver=credential_resolver_from_env_file(
            resolve_config_path(PROJECT_DIR, settings.model_secret_env_path)
        ),
        client=request.app.state.model_http_client,
        max_concurrency=settings.model_max_concurrency,
        concurrency_wait_seconds=settings.model_concurrency_wait_seconds,
        semaphore=request.app.state.model_semaphore,
    )


def get_semantic_task_service(request: Request) -> SemanticTaskApplicationService:
    settings: Settings = request.app.state.settings
    token_codec = ContinuationTokenCodec(
        settings.continuation_token_secret,
        ttl_seconds=settings.continuation_token_ttl_seconds,
    )
    model_service = get_model_service(request)
    return SemanticTaskApplicationService(
        semantic_engine=SemanticEngine(
            model_service, catalog_vector_cache=request.app.state.catalog_vector_cache,
        ),
        config_repository=SemanticConfigRepository(
            resolve_config_path(PROJECT_DIR, settings.semantic_config_path)
        ),
        continuation_token_codec=token_codec,
    )


def get_query_execution_service(request: Request) -> QueryExecutionApplicationService:
    settings: Settings = request.app.state.settings
    return QueryExecutionApplicationService(
        planner=QueryPlanner(
            dialect=settings.query_database_dialect,
            max_limit=settings.query_result_limit,
        ),
        templates=QueryTemplateRepository(
            resolve_config_path(PROJECT_DIR, settings.query_template_config_path),
            resolve_config_path(PROJECT_DIR, settings.sql_resource_dir),
            template_variables={
                "fact_table": settings.sit_fact_table,
                "fact_metric_code_field": settings.sit_fact_metric_code_field,
                "fact_org_code_field": settings.sit_fact_org_code_field,
                "fact_data_date_field": settings.sit_fact_data_date_field,
                "fact_value_field": settings.sit_fact_value_field,
                "fact_increment_field": settings.sit_fact_increment_field,
                "batch_order": "f." + settings.sit_batch_order.replace(", ", ", f."),
            },
        ),
        data_source=create_data_source_adapter(
            settings.query_database_dialect,
            get_query_engine(),
            statement_timeout_ms=settings.query_statement_timeout_ms,
            **(
                {"session_init_statements": settings.query_session_init_statements}
                if settings.query_database_dialect == "inceptor"
                else {}
            ),
        ),
        permission_service=ScopedOrganizationPermissionService(
            organization_scope_provider=SqlAlchemyOrganizationScopeProvider(),
            allow_unscoped_development=settings.app_env.lower() in {"development", "test"},
        ),
        model_service=get_model_service(request),
        result_enricher=(
            CatalogResultEnricher(get_app_session_factory())
            if settings.query_database_dialect == "inceptor"
            else None
        ),
    )
