import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context
from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.base import Base
from ask_metric.infrastructure.db.models import (  # noqa: F401
    AppUser,
    ChatConversation,
    ChatMessage,
    Dataset,
    DatasetField,
    MetricSynonym,
    MetricTerm,
    MetricValue,
    OrgTerm,
    QueryRun,
    QueryTask,
)
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

GOLDENDB_VERSION_TABLE = "backend_next_goldendb_alembic_version"

config = context.config
settings = get_settings()
if settings.app_database_dialect != "mysql":
    raise RuntimeError("GoldenDB migrations require APP_DATABASE_DIALECT=mysql")
config.set_main_option("sqlalchemy.url", settings.app_database_url.replace("%", "%%"))

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _is_schema_write_command() -> bool:
    return any(command in sys.argv[1:] for command in ("upgrade", "downgrade", "stamp"))


def _guard_schema_write() -> None:
    if not _is_schema_write_command():
        return
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )


def _configure(connection=None, *, literal_binds: bool = False) -> None:
    context.configure(
        connection=connection,
        url=None if connection is not None else settings.app_database_url,
        target_metadata=target_metadata,
        literal_binds=literal_binds,
        dialect_opts={"paramstyle": "named"} if literal_binds else None,
        version_table=GOLDENDB_VERSION_TABLE,
        include_schemas=False,
        compare_type=True,
        compare_server_default=True,
        compare_comments=True,
    )


def run_migrations_offline() -> None:
    _guard_schema_write()
    _configure(literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    _guard_schema_write()
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        _configure(connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
