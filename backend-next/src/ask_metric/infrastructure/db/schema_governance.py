import re

from sqlalchemy.engine import make_url

VERSION_TABLE = "backend_next_alembic_version"

MANAGED_TABLES = frozenset(
    {
        "chat_conversations",
        "chat_messages",
        "query_tasks",
        "query_runs",
        "analysis_threads",
        "analysis_checkpoints",
        "metric_values",
        "metric_terms",
        "metric_synonyms",
        "metric_search_index",
        "org_terms",
        "datasets",
        "dataset_fields",
        "app_users",
    }
)
OPTIONAL_VECTOR_TABLES = frozenset({"metric_search_index"})
CORE_MANAGED_TABLES = MANAGED_TABLES - OPTIONAL_VECTOR_TABLES

MANAGED_SEQUENCES = frozenset(
    {
        "metric_values_id_seq",
        "metric_terms_id_seq",
        "metric_synonyms_id_seq",
        "org_terms_id_seq",
        "datasets_id_seq",
        "dataset_fields_id_seq",
        "query_runs_id_seq",
    }
)

MANAGED_FUNCTIONS = frozenset({"fn_query_tasks_set_updated_at", "fn_metric_search_mark_pending"})
MANAGED_TRIGGERS = frozenset(
    {
        ("query_tasks", "trg_query_tasks_set_updated_at"),
        ("metric_terms", "trg_metric_terms_search_pending"),
        ("metric_synonyms", "trg_metric_synonyms_search_pending"),
    }
)
PRESERVED_UNMANAGED_TABLES = frozenset({"alembic_version"})
EXTERNAL_OBJECTS = frozenset({"extension:plpgsql", "extension:vector"})

_SAFE_TEST_DATABASE_PATTERN = re.compile(r"^ask_metric_backend_next_test_[a-z0-9_]+$")
_PROTECTED_DATABASES = frozenset({"ask_metric", "postgres", "template0", "template1"})


class UnsafeDatabaseOperation(RuntimeError):
    pass


def database_name_from_url(database_url: str) -> str:
    return make_url(database_url).database or ""


def is_disposable_test_database(database_url: str) -> bool:
    database_name = database_name_from_url(database_url)
    return bool(_SAFE_TEST_DATABASE_PATTERN.fullmatch(database_name))


def assert_disposable_test_database(database_url: str) -> None:
    database_name = database_name_from_url(database_url)
    if database_name in _PROTECTED_DATABASES or not is_disposable_test_database(database_url):
        raise UnsafeDatabaseOperation(
            "DDL test refused: database name must match "
            "ask_metric_backend_next_test_[a-z0-9_]+"
        )


def assert_schema_change_allowed(
    database_url: str,
    *,
    allow_schema_changes: bool,
    allow_non_test_database: bool,
) -> None:
    if not allow_schema_changes:
        raise UnsafeDatabaseOperation(
            "Schema-changing command refused; set BACKEND_NEXT_ALLOW_SCHEMA_CHANGES=true"
        )
    if is_disposable_test_database(database_url):
        return
    if not allow_non_test_database:
        raise UnsafeDatabaseOperation(
            "Non-test database schema change refused; explicit non-test approval is required"
        )


def include_name(name: str | None, type_: str, parent_names: dict[str, str | None]) -> bool:
    if type_ == "schema":
        return name in (None, "public")
    if type_ == "table":
        return bool(name in MANAGED_TABLES or name == VERSION_TABLE)
    table_name = parent_names.get("table_name")
    return table_name is None or table_name in MANAGED_TABLES


def include_object(object_, name: str | None, type_: str, reflected: bool, compare_to) -> bool:
    if type_ == "table":
        return bool(name in MANAGED_TABLES or name == VERSION_TABLE)
    table = getattr(object_, "table", None)
    table_name = getattr(table, "name", None)
    if table_name is not None and table_name not in MANAGED_TABLES:
        return False
    if reflected and compare_to is None and table_name not in MANAGED_TABLES:
        return False
    return True
