"""集群测评单执行槽，保留原产品一次一批的容量语义。"""

import sqlalchemy as sa

from ask_metric.infrastructure.db.base import Base

evaluation_execution_slots = sa.Table(
    "evaluation_execution_slots", Base.metadata,
    sa.Column("slot_key", sa.String(32), primary_key=True),
    sa.Column("owner_user_id", sa.String(128)),
    sa.Column("run_id", sa.String(128)),
    sa.Column("lease_owner", sa.String(128)),
    sa.Column("lease_token", sa.BigInteger, nullable=False),
    sa.Column("lease_until_ms", sa.BigInteger, nullable=False),
    sa.Column("cancel_requested", sa.Integer, nullable=False),
    sa.Column("cancel_confirmed", sa.Integer, nullable=False),
    mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_bin",
)
