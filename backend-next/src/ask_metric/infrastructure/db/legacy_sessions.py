"""旧自建 JSON 会话的共享只读归档，不参与 Pi 原生操作恢复。"""

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGTEXT

from ask_metric.infrastructure.db.base import Base

agent_legacy_sessions = sa.Table(
    "agent_legacy_sessions",
    Base.metadata,
    sa.Column("session_id", sa.String(128), primary_key=True),
    sa.Column("owner_user_id", sa.String(128), nullable=False),
    sa.Column("content_sha256", sa.String(64), nullable=False),
    sa.Column("content_json", sa.Text().with_variant(LONGTEXT(), "mysql"), nullable=False),
    sa.Column("deleted", sa.Integer, nullable=False),
    sa.Index("ix_agent_legacy_sessions_owner", "owner_user_id", "deleted"),
    mysql_engine="InnoDB",
    mysql_charset="utf8mb4",
    mysql_collate="utf8mb4_bin",
)
TABLES = (agent_legacy_sessions,)
