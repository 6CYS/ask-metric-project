"""org_terms 增加机构层级列；metric_values 补 org_code 列（修齐基线与运行库差异）。

- metric_values.org_code：0001 基线未建，运行库已手工补列，本次纳入迁移链统一管理；
- org_terms.parent_org_code / hierarchy_level：机构层级（法人-支行）数据载体，
  由目录同步在启用支行层级扩展（SIT_ORG_INCLUDE_BRANCH_LEVEL）后写入。

离线 SQL 由 scripts/run_goldendb_migration.py --sql 生成，交 DBA 审核后执行。
在线执行时按列存在性跳过已补齐的列（本地 dev 库已手工加过 metric_values.org_code），
保证重复执行幂等；离线模式无连接可查，直接输出全部 ALTER 供审核。
"""

import sqlalchemy as sa
from alembic import context, op

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

revision = "0004_org_hierarchy_and_org_code"
down_revision = "0003_analysis_checkpoints"
branch_labels = None
depends_on = None

# (表名, 列定义) 按依赖顺序排列，upgrade 正序、downgrade 逆序。
_COLUMNS = (
    ("metric_values", sa.Column("org_code", sa.String(128), nullable=True)),
    ("org_terms", sa.Column("parent_org_code", sa.String(128), nullable=True)),
    ("org_terms", sa.Column("hierarchy_level", sa.String(8), nullable=True)),
)


def _guard() -> None:
    settings = get_settings()
    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=settings.backend_next_allow_schema_changes,
        allow_non_test_database=settings.backend_next_allow_non_test_database,
    )


def _existing_columns(table: str) -> set[str]:
    # 仅在线模式可检查；离线生成 SQL 时由调用方先按 is_offline_mode 分支。
    inspector = sa.inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns(table)}


def upgrade() -> None:
    _guard()
    offline = context.is_offline_mode()
    existing_cache: dict[str, set[str]] = {}
    for table, column in _COLUMNS:
        if not offline:
            existing = existing_cache.setdefault(table, _existing_columns(table))
            if column.name in existing:
                continue  # 运行库已补齐（如手工补列的 dev 库），跳过保持幂等。
        op.add_column(table, column)


def downgrade() -> None:
    _guard()
    offline = context.is_offline_mode()
    existing_cache: dict[str, set[str]] = {}
    for table, column in reversed(_COLUMNS):
        if not offline:
            existing = existing_cache.setdefault(table, _existing_columns(table))
            if column.name not in existing:
                continue
        op.drop_column(table, column.name)
