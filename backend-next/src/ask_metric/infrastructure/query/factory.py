from sqlalchemy import Engine

from ask_metric.application.ports import DataSourceAdapter
from ask_metric.infrastructure.query.inceptor import InceptorDataSourceAdapter
from ask_metric.infrastructure.query.mysql import MySqlDataSourceAdapter


def create_data_source_adapter(
    dialect: str,
    engine: Engine,
    *,
    statement_timeout_ms: int = 30_000,
    session_init_statements: list[str] | None = None,
) -> DataSourceAdapter:
    if dialect == "mysql":
        return MySqlDataSourceAdapter(
            engine,
            statement_timeout_ms=statement_timeout_ms,
        )
    if dialect == "inceptor":
        return InceptorDataSourceAdapter(
            engine,
            session_init_statements=session_init_statements,
        )
    raise ValueError(f"Unsupported query database dialect: {dialect}")
