"""分析线程与 LangGraph 检查点；沿用受控 GoldenDB/MySQL 迁移链。"""

import sqlalchemy as sa
from alembic import op

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

revision = "0003_analysis_checkpoints"
down_revision = "0002_organization_hierarchy"
branch_labels = None
depends_on = None


def upgrade():
    settings = get_settings()
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )
    op.create_table(
        "analysis_threads",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "task_id",
            sa.String(128),
            sa.ForeignKey("query_tasks.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("lease_token", sa.String(64)),
        sa.Column("lease_until", sa.Float(53), nullable=False),
        sa.Column("cancelled", sa.Boolean(), nullable=False),
        sa.Column("progress", sa.JSON(), nullable=False),
        sa.Column("usage", sa.JSON(), nullable=False),
    )
    op.create_table(
        "analysis_checkpoints",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "thread_id",
            sa.String(64),
            sa.ForeignKey("analysis_threads.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("namespace", sa.String(255), nullable=False),
        sa.Column("checkpoint_id", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("writes", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_index("ix_analysis_checkpoints_thread_id", "analysis_checkpoints", ["thread_id"])


def downgrade():
    settings = get_settings()
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )
    op.drop_table("analysis_checkpoints")
    op.drop_table("analysis_threads")
