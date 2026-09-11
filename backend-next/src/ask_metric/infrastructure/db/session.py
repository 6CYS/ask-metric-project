from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.core.config import get_settings


@lru_cache(maxsize=1)
def get_app_engine() -> Engine:
    settings = get_settings()
    return create_engine(
        settings.app_database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout=settings.database_pool_timeout,
        pool_pre_ping=True,
        pool_recycle=settings.database_pool_recycle,
        echo=settings.sql_echo,
    )


@lru_cache(maxsize=1)
def get_query_engine() -> Engine:
    settings = get_settings()
    return create_engine(
        settings.query_database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout=settings.database_pool_timeout,
        pool_pre_ping=True,
        pool_recycle=settings.database_pool_recycle,
        echo=settings.sql_echo,
    )


@lru_cache(maxsize=1)
def get_metric_catalog_engine() -> Engine:
    settings = get_settings()
    return _create_source_engine(
        settings.metric_catalog_database_url or settings.query_database_url
    )


@lru_cache(maxsize=1)
def get_org_catalog_engine() -> Engine:
    settings = get_settings()
    return _create_source_engine(settings.org_catalog_database_url or settings.query_database_url)


def _create_source_engine(url: str) -> Engine:
    settings = get_settings()
    return create_engine(
        url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout=settings.database_pool_timeout,
        pool_pre_ping=True,
        pool_recycle=settings.database_pool_recycle,
        echo=settings.sql_echo,
    )


@lru_cache(maxsize=1)
def get_app_session_factory() -> sessionmaker[Session]:
    return sessionmaker(
        bind=get_app_engine(),
        autoflush=False,
        expire_on_commit=False,
    )


def reset_database_runtime() -> None:
    get_app_session_factory.cache_clear()
    for engine_getter in (
        get_app_engine,
        get_query_engine,
        get_metric_catalog_engine,
        get_org_catalog_engine,
    ):
        engine = engine_getter.cache_info()
        if engine.currsize:
            engine_getter().dispose()
        engine_getter.cache_clear()
