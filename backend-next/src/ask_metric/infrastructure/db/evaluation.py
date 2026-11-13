"""测评问题集、不可变输入快照和独立人工复核；有序案例保存在受限文档中。"""

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGTEXT

from ask_metric.infrastructure.db.base import Base

_text = sa.Text().with_variant(LONGTEXT(), "mysql")
evaluation_datasets = sa.Table(
    "evaluation_datasets", Base.metadata,
    sa.Column("owner_user_id", sa.String(128), primary_key=True),
    sa.Column("id", sa.String(128), primary_key=True),
    sa.Column("version", sa.BigInteger, nullable=False),
    sa.Column("updated_at", sa.String(50), nullable=False),
    sa.Column("content_json", _text, nullable=False),
    sa.Column("deleted", sa.Integer, nullable=False),
    mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_bin",
)
evaluation_runs = sa.Table(
    "evaluation_runs", Base.metadata,
    sa.Column("owner_user_id", sa.String(128), primary_key=True),
    sa.Column("id", sa.String(128), primary_key=True),
    sa.Column("revision", sa.BigInteger, nullable=False),
    sa.Column("status", sa.String(20), nullable=False),
    sa.Column("created_at", sa.String(50), nullable=False),
    sa.Column("content_json", _text, nullable=False),
    sa.Column("deleted", sa.Integer, nullable=False),
    sa.Index("ix_evaluation_runs_owner_created", "owner_user_id", "deleted", "created_at"),
    mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_bin",
)
evaluation_reviews = sa.Table(
    "evaluation_reviews", Base.metadata,
    sa.Column("owner_user_id", sa.String(128), primary_key=True),
    sa.Column("run_id", sa.String(128), primary_key=True),
    sa.Column("turn_id", sa.String(128), primary_key=True),
    sa.Column("content_json", _text, nullable=False),
    mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_bin",
)
TABLES = (evaluation_datasets, evaluation_runs, evaluation_reviews)
