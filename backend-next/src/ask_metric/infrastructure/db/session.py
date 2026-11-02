import math
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from functools import lru_cache

from sqlalchemy import Engine, create_engine, make_url
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
        connect_args=query_socket_timeouts(
            settings.query_database_url, settings.query_statement_timeout_ms
        ),
    )


def query_socket_timeouts(url: str, statement_timeout_ms: int) -> dict[str, int]:
    """业务查询连接的客户端读写超时，保证慢查询不会无限占用请求线程。

    MySQL 由会话级 MAX_EXECUTION_TIME 在服务端先中止，这里多留 5 秒兜底；
    Inceptor 不支持该参数，只能靠客户端超时断开连接（服务端任务未必随之取消）。
    目录同步使用独立引擎，不受此限制。
    """
    if make_url(url).get_driver_name() not in {"pymysql", "mysqldb"}:
        return {}
    seconds = math.ceil(statement_timeout_ms / 1000) + 5
    return {"read_timeout": seconds, "write_timeout": seconds}


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


# 当前工作单元的 Session。同步路由在各自线程的上下文副本中运行，互不可见。
_active_app_session: ContextVar[Session | None] = ContextVar(
    "ask_metric_active_app_session", default=None
)


def bind_active_app_session(session: Session | None) -> Token[Session | None]:
    return _active_app_session.set(session)


def reset_active_app_session(token: Token[Session | None]) -> None:
    _active_app_session.reset(token)


@contextmanager
def app_read_session(
    session_factory: sessionmaker[Session] | None = None,
) -> Iterator[Session]:
    """应用库只读辅助查询的 Session。

    工作单元内调用时复用其 Session：执行链会先持有任务行锁再读机构层级和权限，
    另取连接会让并发请求各占一个连接等第二个，连接池耗尽时互相等到超时。
    复用还让同一事务内的目录与层级读数一致。显式传入工厂（测试或独立场景）时仍单独开启。
    """
    active = _active_app_session.get()
    if session_factory is None and active is not None:
        yield active
        return
    with (session_factory or get_app_session_factory())() as session:
        yield session


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
