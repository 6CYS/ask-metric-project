from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from time import perf_counter
from typing import Any

from sqlalchemy import Engine, bindparam, text

from ask_metric.infrastructure.query.sql_safety import validate_readonly_sql

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class InceptorExecution:
    rows: list[dict[str, Any]]
    latency_ms: int


class InceptorDataSourceAdapter:
    """Read-only adapter for an Inceptor endpoint exposed through SQLAlchemy.

    Unlike the MySQL adapter, it does not issue MySQL-specific SET statements.
    Optional initialization statements are deployment-controlled and must themselves
    be read-only session statements.
    """

    def __init__(self, engine: Engine, *, session_init_statements: list[str] | None = None) -> None:
        self.engine = engine
        self.session_init_statements = tuple(session_init_statements or ())

    def execute_readonly(self, *, sql: str, parameters: dict[str, Any]) -> InceptorExecution:
        # 模板仍要校验只读并绑定参数；数据库账号的只读权限须由部署配置保证。
        # 此适配器未接入 QUERY_STATEMENT_TIMEOUT_MS，现场超时须核对驱动/服务端配置。
        validate_readonly_sql(sql)
        execution_parameters = _normalize_optional_expanding_parameters(parameters)
        _reject_empty_expanding_parameters(sql, execution_parameters)
        statement = text(sql)
        expanding = [
            bindparam(name, expanding=True)
            for name, value in execution_parameters.items()
            if isinstance(value, (list, tuple)) and name in statement._bindparams
        ]
        if expanding:
            statement = statement.bindparams(*expanding)
        started = perf_counter()
        try:
            with self.engine.connect() as connection:
                for init_sql in self.session_init_statements:
                    _validate_session_statement(init_sql)
                    connection.exec_driver_sql(init_sql)
                if self.session_init_statements:
                    connection.commit()
                with connection.begin():
                    result = connection.execute(statement, execution_parameters)
                    rows = [dict(row) for row in result.mappings().all()]
                connection.rollback()
        except Exception as exc:
            raise RuntimeError(sanitize_database_error(exc)) from exc
        return InceptorExecution(
            rows=rows, latency_ms=max(0, round((perf_counter() - started) * 1000))
        )


def _normalize_optional_expanding_parameters(parameters: dict[str, Any]) -> dict[str, Any]:
    """Keep an unfiltered organization scope valid for expanding IN parameters.

    Inceptor drivers cannot render an empty expanding list.  The SQL templates guard
    the organization predicate with ``filter_orgs``; when that flag is false, a single
    NULL placeholder is semantically inert while still producing valid ``IN (...)`` SQL.
    """
    normalized = dict(parameters)
    if (
        normalized.get("filter_orgs") is False
        and "org_codes" in normalized
        and not normalized["org_codes"]
    ):
        normalized["org_codes"] = [None]
    return normalized


def _reject_empty_expanding_parameters(sql: str, parameters: dict[str, Any]) -> None:
    for name, value in parameters.items():
        if (
            isinstance(value, (list, tuple))
            and not value
            and re.search(rf":{re.escape(name)}\b", sql)
        ):
            raise ValueError(f"List parameter {name} cannot be empty")


def _validate_session_statement(sql: str) -> None:
    normalized = sql.strip().rstrip(";")
    if ";" in normalized or not re.match(r"^(set|use)\s+", normalized, re.IGNORECASE):
        raise ValueError("Only one deployment-controlled SET or USE session statement is allowed")


def sanitize_database_error(exc: Exception) -> str:
    value = str(exc)
    value = re.sub(r"([a-z][a-z0-9+.-]*://[^:/\s]+:)[^@\s]+@", r"\1***@", value, flags=re.I)
    return value[:2000]
