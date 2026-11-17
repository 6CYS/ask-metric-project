from typing import Protocol

from sqlalchemy import Engine, inspect
from sqlalchemy.exc import SQLAlchemyError

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.models import (
    AppUser,
    ChatConversation,
    ChatMessage,
    Dataset,
    DatasetField,
    MetricSynonym,
    MetricTerm,
    OrgTerm,
    QueryRun,
    QueryTask,
)
from ask_metric.infrastructure.db.session import get_app_engine

REQUIRED_READY_TABLES = (
    "chat_conversations",
    "chat_messages",
    "query_tasks",
    "query_runs",
    "app_users",
    "metric_terms",
    "metric_synonyms",
    "org_terms",
    "datasets",
    "dataset_fields",
)

REQUIRED_READY_COLUMNS = {
    model.__tablename__: set(model.__table__.columns.keys())
    for model in (
        AppUser,
        ChatConversation,
        ChatMessage,
        Dataset,
        DatasetField,
        MetricSynonym,
        MetricTerm,
        OrgTerm,
        QueryRun,
        QueryTask,
    )
}


class DatabaseReadiness(Protocol):
    def is_ready(self) -> bool: ...


class SqlAlchemyDatabaseReadiness:
    def __init__(self, engine: Engine, *, database_configuration: bool = False) -> None:
        self.engine = engine
        self.database_configuration = database_configuration

    def is_ready(self) -> bool:
        try:
            inspector = inspect(self.engine)
            required = dict(REQUIRED_READY_COLUMNS)
            if self.database_configuration:
                from ask_metric.infrastructure.db.business_knowledge import (
                    TABLES as KNOWLEDGE_TABLES,
                )
                from ask_metric.infrastructure.db.configuration import TABLES

                required.update(
                    {
                        table.name: set(table.columns.keys())
                        for table in (*TABLES, *KNOWLEDGE_TABLES)
                    }
                )
            return all(
                inspector.has_table(table)
                and columns <= {column["name"] for column in inspector.get_columns(table)}
                for table, columns in required.items()
            )
        except SQLAlchemyError:
            return False


def get_database_readiness() -> DatabaseReadiness:
    return SqlAlchemyDatabaseReadiness(
        get_app_engine(),
        database_configuration=get_settings().business_configuration_storage == "database",
    )
