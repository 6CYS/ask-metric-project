"""Agent 的共享持久化表；Pi 原生记录按其公共存储契约保存。"""

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGTEXT

from ask_metric.infrastructure.db.base import Base

_text = sa.Text().with_variant(LONGTEXT(), "mysql")
_table_options = {
    "mysql_engine": "InnoDB",
    "mysql_charset": "utf8mb4",
    "mysql_collate": "utf8mb4_bin",
}

agent_sessions = sa.Table(
    "agent_sessions",
    Base.metadata,
    sa.Column("session_id", sa.String(128), primary_key=True),
    sa.Column("owner_user_id", sa.String(128), nullable=False),
    sa.Column("created_ms", sa.BigInteger, nullable=False),
    sa.Column("modified_ms", sa.BigInteger, nullable=False),
    sa.Column("next_seq", sa.BigInteger, nullable=False),
    sa.Column("stats_json", _text, nullable=False),
    sa.Column("title", sa.String(255)),
    sa.Column("current_operation_id", sa.String(128)),
    sa.Column("deleted", sa.Integer, nullable=False),
    sa.Column("lease_owner", sa.String(128)),
    sa.Column("lease_token", sa.BigInteger, nullable=False),
    sa.Column("lease_until_ms", sa.BigInteger, nullable=False),
    sa.Column("event_seq", sa.BigInteger, nullable=False),
    sa.Index("ix_agent_sessions_owner_created", "owner_user_id", "deleted", "created_ms"),
    **_table_options,
)
agent_session_records = sa.Table(
    "agent_session_records",
    Base.metadata,
    sa.Column("session_id", sa.String(128), primary_key=True),
    sa.Column("record_id", sa.String(255), primary_key=True),
    sa.Column("kind", sa.String(16), nullable=False),
    sa.Column("seq", sa.BigInteger, nullable=False),
    sa.Column("address_hash", sa.String(64)),
    sa.Column("namespace_name", sa.String(255)),
    sa.Column("address_key", _text),
    sa.Column("data_json", _text, nullable=False),
    sa.Index("ix_agent_records_sequence", "session_id", "kind", "seq"),
    sa.Index("ix_agent_records_address", "session_id", "kind", "address_hash", "seq"),
    **_table_options,
)
agent_session_events = sa.Table(
    "agent_session_events",
    Base.metadata,
    sa.Column("session_id", sa.String(128), primary_key=True),
    sa.Column("seq", sa.BigInteger, primary_key=True),
    sa.Column("operation_id", sa.String(128), nullable=False),
    sa.Column("event_type", sa.String(64), nullable=False),
    sa.Column("data_json", _text, nullable=False),
    sa.Index("ix_agent_events_operation", "session_id", "operation_id", "seq"),
    **_table_options,
)
agent_session_cancellations = sa.Table(
    "agent_session_cancellations",
    Base.metadata,
    sa.Column("session_id", sa.String(128), primary_key=True),
    sa.Column("target_kind", sa.String(16), primary_key=True),
    sa.Column("target_id", sa.String(128), primary_key=True),
    **_table_options,
)

TABLES = (agent_sessions, agent_session_records, agent_session_events, agent_session_cancellations)
