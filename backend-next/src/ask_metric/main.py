import logging
from contextlib import asynccontextmanager
from threading import BoundedSemaphore

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ask_metric.api.router import api_router
from ask_metric.core.config import Settings, get_settings
from ask_metric.core.errors import install_exception_handlers
from ask_metric.core.logging import LoggingConfig, configure_logging
from ask_metric.core.request_context import RequestIdMiddleware
from ask_metric.infrastructure.discovery.nacos_registry import NacosRegistry
from ask_metric.infrastructure.model.catalog_vectors import CatalogVectorCache

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
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
        logger.info("application_started")
        app.state.model_http_client = httpx.Client(
            limits=httpx.Limits(
                max_connections=resolved_settings.model_max_connections,
                max_keepalive_connections=resolved_settings.model_max_keepalive_connections,
            )
        )
        app.state.model_semaphore = BoundedSemaphore(resolved_settings.model_max_concurrency)
        app.state.catalog_vector_cache = CatalogVectorCache()
        nacos_registry = NacosRegistry(resolved_settings)
        app.state.nacos_registry = nacos_registry
        try:
            await nacos_registry.start()
            yield
        finally:
            logger.info("application_stopping")
            await nacos_registry.stop()
            app.state.model_http_client.close()

    app = FastAPI(title=resolved_settings.app_name, version="0.1.3", lifespan=lifespan)
    app.state.settings = resolved_settings
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
