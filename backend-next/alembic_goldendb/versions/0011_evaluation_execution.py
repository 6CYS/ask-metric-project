"""测评集群执行租约和持久停止信号。"""

from alembic import op

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.evaluation_execution import evaluation_execution_slots
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

revision = "0011_evaluation_execution"
down_revision = "0010_evaluation_persistence"
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
    bind = op.get_bind()
    evaluation_execution_slots.create(bind)
    bind.execute(evaluation_execution_slots.insert().values(
        slot_key="batch", lease_token=0, lease_until_ms=0, cancel_requested=0, cancel_confirmed=0,
    ))


def downgrade() -> None:
    _guard()
    evaluation_execution_slots.drop(op.get_bind())
