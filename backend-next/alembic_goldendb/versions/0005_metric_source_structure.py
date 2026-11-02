"""保留指标目录源端的基础指标及取值口径；旧目录行保持可为空。"""

import sqlalchemy as sa
from alembic import context, op

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

revision = "0005_metric_source_structure"
down_revision = "0004_org_hierarchy_and_org_code"
branch_labels = None
depends_on = None

_COLUMNS = (
    sa.Column("source_metric_code", sa.String(128), nullable=True),
    sa.Column("base_name", sa.String(255), nullable=True),
    sa.Column("value_basis", sa.String(255), nullable=True),
)


def _guard() -> None:
    settings = get_settings()
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )


def upgrade() -> None:
    _guard()
    existing = set() if context.is_offline_mode() else {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("metric_terms")
    }
    for column in _COLUMNS:
        if column.name not in existing:
            op.add_column("metric_terms", column)


def downgrade() -> None:
    _guard()
    existing = set() if context.is_offline_mode() else {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("metric_terms")
    }
    for column in reversed(_COLUMNS):
        if context.is_offline_mode() or column.name in existing:
            op.drop_column("metric_terms", column.name)
