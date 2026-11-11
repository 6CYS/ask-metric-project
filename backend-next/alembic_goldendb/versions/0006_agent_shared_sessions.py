"""增加 Agent 多实例共享会话、执行租约与重连事件表。"""

from alembic import op

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.agent_sessions import TABLES
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

revision = "0006_agent_shared_sessions"
down_revision = "0005_metric_source_structure"
branch_labels = None
depends_on = None


def _guard() -> None:
    settings = get_settings()
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )


def upgrade() -> None:
    _guard()
    for table in TABLES:
        table.create(op.get_bind())


def downgrade() -> None:
    _guard()
    for table in reversed(TABLES):
        table.drop(op.get_bind())
