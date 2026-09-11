from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime
from time import perf_counter
from typing import Any

from sqlalchemy import Engine, bindparam, text

from ask_metric.infrastructure.query.sql_safety import validate_readonly_sql

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MySqlExecution:
    rows: list[dict[str, Any]]
    latency_ms: int


class MySqlDataSourceAdapter:
    """Execute governed queries through the MySQL protocol used by GoldenDB.

    The database account must still be provisioned as read-only.  Session-level
    read-only mode and MAX_EXECUTION_TIME are additional defense-in-depth controls.
    """

    def __init__(self, engine: Engine, *, statement_timeout_ms: int = 30_000) -> None:
        self.engine = engine
        self.statement_timeout_ms = statement_timeout_ms

    def execute_readonly(
        self, *, sql: str, parameters: dict[str, Any]
    ) -> MySqlExecution:
        validate_readonly_sql(sql)
        prepared_parameters = _prepare_parameters(parameters)
        statement = text(sql)
        expanding_names = [
            name
            for name, value in prepared_parameters.items()
            if isinstance(value, (list, tuple)) and name in statement._bindparams
        ]
        if expanding_names:
            statement = statement.bindparams(
                *(bindparam(name, expanding=True) for name in expanding_names)
            )

        started = perf_counter()
        with self.engine.connect() as connection:
            connection.exec_driver_sql("SET SESSION TRANSACTION READ ONLY")
            connection.exec_driver_sql(
                "SET SESSION MAX_EXECUTION_TIME = %s",
                (self.statement_timeout_ms,),
            )
            connection.commit()
            try:
                with connection.begin():
                    result = connection.execute(statement, prepared_parameters)
                    rows = [dict(row) for row in result.mappings().all()]
            finally:
                connection.rollback()
                try:
                    connection.exec_driver_sql("SET SESSION MAX_EXECUTION_TIME = 0")
                    connection.commit()
                except Exception as exc:
                    connection.invalidate()
                    logger.warning(
                        "query_session_reset_failed exception_type=%s; connection invalidated",
                        type(exc).__name__,
                    )
        return MySqlExecution(
            rows=rows,
            latency_ms=max(0, round((perf_counter() - started) * 1000)),
        )


def _prepare_parameters(parameters: dict[str, Any]) -> dict[str, Any]:
    prepared = dict(parameters)
    period_starts = prepared.get("period_starts")
    period_ends = prepared.get("period_ends")
    if period_starts is not None or period_ends is not None:
        starts = list(period_starts or [])
        ends = list(period_ends or [])
        if len(starts) != len(ends):
            raise ValueError("period_starts and period_ends must have the same length")
        prepared["periods_json"] = json.dumps(
            [
                {"start": _json_date(start), "end": _json_date(end)}
                for start, end in zip(starts, ends, strict=True)
            ],
            ensure_ascii=False,
        )
        prepared.pop("period_starts", None)
        prepared.pop("period_ends", None)
    return prepared


def _json_date(value: Any) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value)
