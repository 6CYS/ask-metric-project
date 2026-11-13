"""共享配置的当前版本与不可变历史；正文使用文本列，兼容 GoldenDB。"""

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGTEXT

from ask_metric.infrastructure.db.base import Base

_text = sa.Text().with_variant(LONGTEXT(), "mysql")

config_resources = sa.Table(
    "app_config_resources",
    Base.metadata,
    sa.Column("resource_key", sa.String(190), primary_key=True),
    sa.Column("resource_type", sa.String(64), nullable=False),
    sa.Column("current_version_id", sa.String(36), nullable=False),
    sa.Column("default_version_id", sa.String(36), nullable=False),
    sa.Column("version_number", sa.BigInteger, nullable=False),
    sa.Column("revision", sa.String(64), nullable=False),
    mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_bin",
)
config_versions = sa.Table(
    "app_config_versions",
    Base.metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("resource_key", sa.String(190), nullable=False),
    sa.Column("version_number", sa.BigInteger, nullable=False),
    sa.Column("format_version", sa.Integer, nullable=False),
    sa.Column("revision", sa.String(64), nullable=False),
    sa.Column("content", _text, nullable=False),
    sa.Column("created_ms", sa.BigInteger, nullable=False),
    sa.Column("created_by", sa.String(128), nullable=False),
    sa.Column("action", sa.String(32), nullable=False),
    sa.Column("source_version_id", sa.String(36)),
    sa.UniqueConstraint("resource_key", "version_number", name="uq_config_resource_version"),
    mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_bin",
)

TABLES = (config_resources, config_versions)
