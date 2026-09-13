"""应用入口：装配 HTTP 服务，并管理模型连接、向量预热及关闭顺序。"""

import asyncio
import logging
from contextlib import asynccontextmanager
from threading import BoundedSemaphore

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from ask_metric.api.router import api_router
from ask_metric.core.config import Settings, get_settings
from ask_metric.core.errors import install_exception_handlers
from ask_metric.core.logging import LoggingConfig, configure_logging
from ask_metric.core.request_context import RequestIdMiddleware
from ask_metric.infrastructure.discovery.nacos_registry import NacosRegistry
from ask_metric.infrastructure.model.catalog_vectors import CatalogVectorCache
from ask_metric.infrastructure.model.query_initialization import QueryInitialization

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None, *, initialize_catalog_on_startup: bool | None = None,
) -> FastAPI:
    resolved_settings = settings or get_settings()
    # 隔离测试默认跳过真实数据库和模型；启动流程测试会显式开启预热并替换依赖。
    initialize_catalog = (
        resolved_settings.app_env.lower() != "test"
        if initialize_catalog_on_startup is None else initialize_catalog_on_startup
    )
    configure_logging(
        LoggingConfig(
            level=resolved_settings.log_level,
            application_name=resolved_settings.app_name,
            data_center_id=resolved_settings.log_data_center_id,
            zone_id=resolved_settings.log_zone_id,
            directory=resolved_settings.log_directory,
            file_enabled=bool(resolved_settings.log_file_enabled),
            console_enabled=bool(resolved_settings.log_console_enabled),
            max_bytes=resolved_settings.log_max_bytes,
            retention_days=resolved_settings.log_retention_days,
            max_line_bytes=resolved_settings.log_max_line_bytes,
        )
    )
    logger.info(
        "runtime_config app_env=%s app_database_dialect=%s query_database_dialect=%s",
        resolved_settings.app_env,
        resolved_settings.app_database_dialect,
        resolved_settings.query_database_dialect,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # lifespan 是异步上下文管理器：yield 前准备资源，yield 后在关闭时释放。
        # app.state 由当前服务进程共享；多 worker 部署时每个进程各有一份缓存。
        logger.info("application_started")
        app.state.model_http_client = httpx.Client(
            limits=httpx.Limits(
                max_connections=resolved_settings.model_max_connections,
                max_keepalive_connections=resolved_settings.model_max_keepalive_connections,
            )
        )
        # 信号量限制同时调用模型的请求数，与 HTTP 连接池大小是两个独立限制。
        app.state.model_semaphore = BoundedSemaphore(resolved_settings.model_max_concurrency)
        app.state.catalog_vector_cache = CatalogVectorCache()
        nacos_registry = NacosRegistry(resolved_settings)
        app.state.nacos_registry = nacos_registry
        from ask_metric.api.dependencies import initialize_query_catalog

        initialization = QueryInitialization(enabled=initialize_catalog)
        app.state.query_initialization = initialization

        def warm_catalog() -> None:
            # 只借用 Request 读取同一份应用配置和连接，不发送内部 HTTP 请求。
            initialize_query_catalog(Request({"type": "http", "app": app}))

        warmup = None
        if initialize_catalog:
            # 传函数名而非 warm_catalog()：让后台线程稍后调用，并在失败后重试。
            # to_thread 承接同步数据库/模型 I/O，主事件循环仍能响应初始化状态查询。
            warmup = asyncio.create_task(asyncio.to_thread(initialization.run, warm_catalog))
        try:
            await nacos_registry.start()
            yield
        finally:
            logger.info("application_stopping")
            initialization.stop()
            if warmup is not None:
                # 取消 asyncio 任务不会终止线程中的 HTTP 请求，因此先通知停止，
                # 等后台线程退出后再关闭它仍可能使用的共享客户端。
                await warmup
            await nacos_registry.stop()
            app.state.model_http_client.close()

    app = FastAPI(title=resolved_settings.app_name, version="0.1.3", lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.query_initialization = QueryInitialization(enabled=initialize_catalog)
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_exception_handlers(app)
    app.include_router(api_router)
    if resolved_settings.app_env.lower() == "test":
        from ask_metric.api.dependencies import get_actor_provider, require_actor
        from ask_metric.application.actor_provider import DevelopmentActorProvider
        from ask_metric.application.requests import ActorContext

        # lambda: ... 是无参小函数；每次依赖调用都创建测试身份，仅 test 环境启用。
        app.dependency_overrides[require_actor] = lambda: ActorContext(
            subject="developer",
            tenant_id="development",
            user_id="developer",
            org_id=None,
            role_code="USER",
            authentication_method="test_dependency_override",
            trust_level="authenticated",
        )
        app.dependency_overrides[get_actor_provider] = DevelopmentActorProvider
    return app


app = create_app()
