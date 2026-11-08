from typing import Protocol

from sqlalchemy import Engine, inspect
from sqlalchemy.exc import SQLAlchemyError

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
    "app_users", "metric_terms", "metric_synonyms", "org_terms", "datasets", "dataset_fields",
)

REQUIRED_READY_COLUMNS = {
    model.__tablename__: set(model.__table__.columns.keys())
    for model in (AppUser, ChatConversation, ChatMessage, Dataset, DatasetField,
                  MetricSynonym, MetricTerm, OrgTerm, QueryRun, QueryTask)
}


class DatabaseReadiness(Protocol):
    def is_ready(self) -> bool: ...


class SqlAlchemyDatabaseReadiness:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def is_ready(self) -> bool:
        try:
            inspector = inspect(self.engine)
            return all(
                inspector.has_table(table)
                and REQUIRED_READY_COLUMNS[table] <= {
                    column["name"] for column in inspector.get_columns(table)
                }
                for table in REQUIRED_READY_TABLES
            )
        except SQLAlchemyError:
            return False


def get_database_readiness() -> DatabaseReadiness:
    return SqlAlchemyDatabaseReadiness(get_app_engine())
