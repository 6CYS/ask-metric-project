"""知识条目与指标关联；版本发布时与配置历史在同一事务内更新。"""

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGTEXT

from ask_metric.infrastructure.db.base import Base

knowledge_entries = sa.Table(
    "business_knowledge_entries",
    Base.metadata,
    sa.Column("entry_id", sa.String(128), primary_key=True),
    sa.Column("version_id", sa.String(36), nullable=False),
    sa.Column("sort_order", sa.Integer, nullable=False),
    sa.Column("title", sa.String(200), nullable=False),
    sa.Column("enabled", sa.Boolean, nullable=False),
    sa.Column("content_json", sa.Text().with_variant(LONGTEXT(), "mysql"), nullable=False),
    sa.Index("ix_knowledge_version_order", "version_id", "sort_order"),
    mysql_engine="InnoDB",
    mysql_charset="utf8mb4",
    mysql_collate="utf8mb4_bin",
)
knowledge_metrics = sa.Table(
    "business_knowledge_metrics",
    Base.metadata,
    sa.Column("entry_id", sa.String(128), primary_key=True),
    sa.Column("metric_code", sa.String(150), primary_key=True),
    sa.Column("sort_order", sa.Integer, nullable=False),
    sa.Index("ix_knowledge_metric", "metric_code", "entry_id"),
    mysql_engine="InnoDB",
    mysql_charset="utf8mb4",
    mysql_collate="utf8mb4_bin",
)
TABLES = (knowledge_entries, knowledge_metrics)
