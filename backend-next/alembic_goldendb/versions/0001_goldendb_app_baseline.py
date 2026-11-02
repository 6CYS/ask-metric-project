"""GoldenDB/MySQL application schema baseline.

Revision ID: 0001_goldendb_app_baseline
Revises: None
"""

import sqlalchemy as sa

from alembic import op
from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

revision = "0001_goldendb_app_baseline"
down_revision = None
branch_labels = None
depends_on = None


def _guard() -> None:
    settings = get_settings()
    if settings.app_database_dialect != "mysql":
        raise RuntimeError("GoldenDB baseline requires APP_DATABASE_DIALECT=mysql")
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    ]


def upgrade() -> None:
    _guard()
    op.create_table(
        "metric_values",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("org_name", sa.String(255), nullable=False),
        sa.Column("metric_code", sa.String(128), nullable=False),
        sa.Column("metric_name", sa.String(255), nullable=False),
        sa.Column("metric_value", sa.Numeric(24, 6), nullable=False),
        sa.Column("stat_date", sa.Date(), nullable=False),
        sa.Column("source_batch_id", sa.String(128)),
        *_timestamps(),
    )
    for name, column in (
        ("ix_metric_values_org_name", "org_name"),
        ("ix_metric_values_metric_code", "metric_code"),
        ("ix_metric_values_metric_name", "metric_name"),
        ("ix_metric_values_stat_date", "stat_date"),
    ):
        op.create_index(name, "metric_values", [column])

    op.create_table(
        "metric_terms",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("metric_code", sa.String(128), nullable=False),
        sa.Column("metric_name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("unit", sa.String(64)),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("metric_explanation", sa.Text(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("metric_code", name="metric_terms_metric_code_key"),
    )
    op.create_index("ix_metric_terms_metric_name", "metric_terms", ["metric_name"])

    op.create_table(
        "metric_synonyms",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("metric_code", sa.String(128), nullable=False),
        sa.Column("synonym", sa.String(255), nullable=False),
        sa.Column("weight", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        *_timestamps(),
    )
    op.create_index("ix_metric_synonyms_metric_code", "metric_synonyms", ["metric_code"])
    op.create_index("ix_metric_synonyms_synonym", "metric_synonyms", ["synonym"])

    op.create_table(
        "org_terms",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("org_code", sa.String(128), nullable=False),
        sa.Column("org_name", sa.String(255), nullable=False),
        sa.Column("aliases", sa.JSON(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        *_timestamps(),
        sa.UniqueConstraint("org_code", name="org_terms_org_code_key"),
    )
    op.create_index("ix_org_terms_org_name", "org_terms", ["org_name"])

    op.create_table(
        "app_users",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(128), nullable=False),
        sa.Column("org_code", sa.String(128), nullable=False),
        sa.Column("role_code", sa.String(32), nullable=False, server_default="USER"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("session_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        *_timestamps(),
        sa.CheckConstraint("session_version >= 0", name="app_users_session_version_check"),
        sa.ForeignKeyConstraint(
            ["org_code"],
            ["org_terms.org_code"],
            name="app_users_org_code_fkey",
        ),
    )
    op.create_index("uq_app_users_username", "app_users", ["username"], unique=True)
    op.create_index("ix_app_users_org_code", "app_users", ["org_code"])
    op.create_index("ix_app_users_enabled", "app_users", ["enabled"])

    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("datasource_type", sa.String(64), nullable=False, server_default="mysql"),
        sa.Column("schema_name", sa.String(128), nullable=False, server_default=""),
        sa.Column("table_name", sa.String(128), nullable=False),
        sa.Column("dialect", sa.String(64), nullable=False, server_default="mysql"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        *_timestamps(),
        sa.UniqueConstraint("name", name="datasets_name_key"),
    )

    op.create_table(
        "dataset_fields",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("dataset_id", sa.Integer(), nullable=False),
        sa.Column("field_name", sa.String(128), nullable=False),
        sa.Column("semantic_role", sa.String(64), nullable=False),
        sa.Column("data_type", sa.String(64), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["dataset_id"],
            ["datasets.id"],
            name="dataset_fields_dataset_id_fkey",
        ),
    )
    op.create_index("ix_dataset_fields_dataset_id", "dataset_fields", ["dataset_id"])
    op.create_index("ix_dataset_fields_semantic_role", "dataset_fields", ["semantic_role"])

    op.create_table(
        "chat_conversations",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("preview", sa.Text(), nullable=False),
        sa.Column("owner_user_id", sa.String(128)),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            ["app_users.id"],
            name="chat_conversations_owner_user_id_fkey",
        ),
    )
    op.create_index(
        "ix_chat_conversations_owner_updated_at",
        "chat_conversations",
        ["owner_user_id", "updated_at"],
    )

    op.create_table(
        "query_tasks",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("conversation_id", sa.String(128), nullable=False),
        sa.Column("original_question", sa.Text(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="RUNNING"),
        sa.Column(
            "current_stage",
            sa.String(64),
            nullable=False,
            server_default="INTENT_ROUTING",
        ),
        sa.Column("intent", sa.String(64)),
        sa.Column("query_shape", sa.String(64)),
        sa.Column("state_json", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("error_code", sa.String(128)),
        sa.Column("error_message", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        *_timestamps(),
        sa.CheckConstraint("version >= 0", name="query_tasks_version_check"),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["chat_conversations.id"],
            name="query_tasks_conversation_id_fkey",
            ondelete="CASCADE",
        ),
        comment="问数任务表：保存一个业务问题从创建、澄清、规划、执行到完成的可恢复状态",
    )
    op.create_index("ix_query_tasks_conversation_id", "query_tasks", ["conversation_id"])
    op.create_index("ix_query_tasks_intent", "query_tasks", ["intent"])
    op.create_index("ix_query_tasks_status_updated_at", "query_tasks", ["status", "updated_at"])
    op.create_index(
        "ix_query_tasks_conversation_updated_at",
        "query_tasks",
        ["conversation_id", sa.text("updated_at DESC")],
    )
    op.create_index(
        "uq_query_tasks_conversation_idempotency",
        "query_tasks",
        ["conversation_id", "idempotency_key"],
        unique=True,
    )

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("conversation_id", sa.String(128), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("payload", sa.JSON()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("task_id", sa.String(128)),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["chat_conversations.id"],
            name="chat_messages_conversation_id_fkey",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["query_tasks.id"],
            name="chat_messages_task_id_fkey",
            ondelete="SET NULL",
        ),
    )
    op.create_index("ix_chat_messages_conversation_id", "chat_messages", ["conversation_id"])
    op.create_index("ix_chat_messages_role", "chat_messages", ["role"])
    op.create_index(
        "ix_chat_messages_task_created_at",
        "chat_messages",
        ["task_id", "created_at"],
    )

    op.create_table(
        "query_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("conversation_id", sa.String(128)),
        sa.Column("user_message", sa.Text(), nullable=False),
        sa.Column("intent", sa.String(64), nullable=False),
        sa.Column("query_shape", sa.String(64)),
        sa.Column("query_plan", sa.JSON()),
        sa.Column("sql_text", sa.Text()),
        sa.Column("sql_params", sa.JSON()),
        sa.Column("row_count", sa.Integer()),
        sa.Column("latency_ms", sa.Integer()),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(64), nullable=False, server_default="pending"),
        sa.Column("failed_node", sa.String(128)),
        sa.Column("error_type", sa.String(128)),
        sa.Column("error_message", sa.Text()),
        sa.Column("user_feedback", sa.String(64)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("raw_org_text", sa.String(255)),
        sa.Column("matched_text", sa.String(255)),
        sa.Column("matched_org_name", sa.String(255)),
        sa.Column("org_match_type", sa.String(64)),
        sa.Column("task_id", sa.String(128)),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["query_tasks.id"],
            name="query_runs_task_id_fkey",
            ondelete="SET NULL",
        ),
    )
    for name, columns in (
        ("ix_query_runs_conversation_id", ["conversation_id"]),
        ("ix_query_runs_intent", ["intent"]),
        ("ix_query_runs_query_shape", ["query_shape"]),
        ("ix_query_runs_status", ["status"]),
        ("ix_query_runs_raw_org_text", ["raw_org_text"]),
        ("ix_query_runs_matched_text", ["matched_text"]),
        ("ix_query_runs_matched_org_name", ["matched_org_name"]),
        ("ix_query_runs_org_match_type", ["org_match_type"]),
        ("ix_query_runs_task_created_at", ["task_id", "created_at"]),
    ):
        op.create_index(name, "query_runs", columns)


def downgrade() -> None:
    _guard()
    for table in (
        "query_runs",
        "chat_messages",
        "query_tasks",
        "chat_conversations",
        "dataset_fields",
        "datasets",
        "app_users",
        "org_terms",
        "metric_synonyms",
        "metric_terms",
        "metric_values",
    ):
        op.drop_table(table)
