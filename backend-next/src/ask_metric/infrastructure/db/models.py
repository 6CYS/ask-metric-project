from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ask_metric.infrastructure.db.base import Base, TimestampMixin

JSON_DOCUMENT = JSON()


class AnalysisThread(Base):
    __tablename__ = "analysis_threads"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("query_tasks.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    lease_token: Mapped[str | None] = mapped_column(String(64))
    lease_until: Mapped[float] = mapped_column(Float(53), nullable=False, default=0)
    cancelled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    progress: Mapped[list] = mapped_column(JSON_DOCUMENT, nullable=False, default=list)
    usage: Mapped[dict] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)


class AnalysisCheckpoint(Base):
    __tablename__ = "analysis_checkpoints"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    thread_id: Mapped[str] = mapped_column(
        ForeignKey("analysis_threads.id", ondelete="CASCADE"), nullable=False, index=True
    )
    namespace: Mapped[str] = mapped_column(String(255), nullable=False)
    checkpoint_id: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON_DOCUMENT, nullable=False)
    writes: Mapped[dict] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


def _initial_task_state() -> dict[str, Any]:
    return {
        "slots": {},
        "query_spec": None,
        "clarification": None,
        "missing_slots": [],
        "schema_version": 1,
    }


class MetricValue(Base, TimestampMixin):
    __tablename__ = "metric_values"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_name: Mapped[str] = mapped_column(String(255), nullable=False)
    metric_code: Mapped[str] = mapped_column(String(128), nullable=False)
    metric_name: Mapped[str] = mapped_column(String(255), nullable=False)
    metric_value: Mapped[Decimal] = mapped_column(Numeric(24, 6), nullable=False)
    stat_date: Mapped[date] = mapped_column(Date, nullable=False)
    source_batch_id: Mapped[str | None] = mapped_column(String(128))

    __table_args__ = (
        Index("ix_metric_values_org_name", "org_name"),
        Index("ix_metric_values_metric_code", "metric_code"),
        Index("ix_metric_values_metric_name", "metric_name"),
        Index("ix_metric_values_stat_date", "stat_date"),
    )


class MetricTerm(Base, TimestampMixin):
    __tablename__ = "metric_terms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    metric_code: Mapped[str] = mapped_column(String(128), nullable=False)
    metric_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    unit: Mapped[str | None] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    metric_explanation: Mapped[str] = mapped_column(
        Text, nullable=False, default=""
    )

    __table_args__ = (
        UniqueConstraint("metric_code", name="metric_terms_metric_code_key"),
        Index("ix_metric_terms_metric_name", "metric_name"),
    )


class MetricSynonym(Base, TimestampMixin):
    __tablename__ = "metric_synonyms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    metric_code: Mapped[str] = mapped_column(String(128), nullable=False)
    synonym: Mapped[str] = mapped_column(String(255), nullable=False)
    weight: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    __table_args__ = (
        Index("ix_metric_synonyms_metric_code", "metric_code"),
        Index("ix_metric_synonyms_synonym", "synonym"),
    )


class OrgTerm(Base, TimestampMixin):
    __tablename__ = "org_terms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_code: Mapped[str] = mapped_column(String(128), nullable=False)
    org_name: Mapped[str] = mapped_column(String(255), nullable=False)
    aliases: Mapped[list[str]] = mapped_column(
        JSON_DOCUMENT, nullable=False, default=list
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    __table_args__ = (
        UniqueConstraint("org_code", name="org_terms_org_code_key"),
        Index("ix_org_terms_org_name", "org_name"),
    )


class AppUser(Base, TimestampMixin):
    __tablename__ = "app_users"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    org_code: Mapped[str] = mapped_column(
        ForeignKey("org_terms.org_code", name="app_users_org_code_fkey"), nullable=False
    )
    role_code: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'USER'")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    session_version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("session_version >= 0", name="app_users_session_version_check"),
        Index("uq_app_users_username", "username", unique=True),
        Index("ix_app_users_org_code", "org_code"),
        Index("ix_app_users_enabled", "enabled"),
    )


class Dataset(Base, TimestampMixin):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    datasource_type: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'mysql'")
    )
    schema_name: Mapped[str] = mapped_column(
        String(128), nullable=False, server_default=text("''")
    )
    table_name: Mapped[str] = mapped_column(String(128), nullable=False)
    dialect: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'mysql'")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    __table_args__ = (UniqueConstraint("name", name="datasets_name_key"),)


class DatasetField(Base, TimestampMixin):
    __tablename__ = "dataset_fields"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[int] = mapped_column(
        ForeignKey("datasets.id", name="dataset_fields_dataset_id_fkey"), nullable=False
    )
    field_name: Mapped[str] = mapped_column(String(128), nullable=False)
    semantic_role: Mapped[str] = mapped_column(String(64), nullable=False)
    data_type: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        Index("ix_dataset_fields_dataset_id", "dataset_id"),
        Index("ix_dataset_fields_semantic_role", "semantic_role"),
    )


class ChatConversation(Base, TimestampMixin):
    __tablename__ = "chat_conversations"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    preview: Mapped[str] = mapped_column(Text, nullable=False, default="")
    owner_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("app_users.id", name="chat_conversations_owner_user_id_fkey"),
        nullable=True,
    )

    __table_args__ = (
        Index("ix_chat_conversations_owner_updated_at", "owner_user_id", "updated_at"),
    )


class QueryTask(Base):
    __tablename__ = "query_tasks"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey(
            "chat_conversations.id",
            name="query_tasks_conversation_id_fkey",
            ondelete="CASCADE",
        ),
        nullable=False,
    )
    original_question: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        server_default=text("'RUNNING'"),
        comment="任务生命周期状态：RUNNING、WAITING_USER、SUCCEEDED、FAILED、CANCELLED、EXPIRED",
    )
    current_stage: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        server_default=text("'INTENT_ROUTING'"),
        comment="当前业务阶段：意图路由、槽位提取、澄清、QuerySpec、规划、执行、结果解释等",
    )
    intent: Mapped[str | None] = mapped_column(
        String(64), comment="轻量业务意图，例如 METRIC_QUERY、ATTRIBUTION_ANALYSIS"
    )
    query_shape: Mapped[str | None] = mapped_column(String(64))
    state_json: Mapped[dict[str, Any]] = mapped_column(
        JSON_DOCUMENT,
        nullable=False,
        default=_initial_task_state,
        comment="任务恢复状态，保存槽位、缺失槽位、澄清信息和 QuerySpec，不保存大型结果集",
    )
    version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default=text("0"),
        comment="乐观锁版本号，每次成功推进任务后加一",
    )
    idempotency_key: Mapped[str | None] = mapped_column(
        String(128), comment="客户端请求幂等键，防止重复提交创建重复任务"
    )
    error_code: Mapped[str | None] = mapped_column(String(128))
    error_message: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        CheckConstraint("version >= 0", name="query_tasks_version_check"),
        Index("ix_query_tasks_conversation_id", "conversation_id"),
        Index("ix_query_tasks_intent", "intent"),
        Index("ix_query_tasks_status_updated_at", "status", "updated_at"),
        Index("ix_query_tasks_conversation_updated_at", "conversation_id", updated_at.desc()),
        Index(
            "uq_query_tasks_conversation_idempotency",
            "conversation_id",
            "idempotency_key",
            unique=True,
        ),
        {"comment": "问数任务表：保存一个业务问题从创建、澄清、规划、执行到完成的可恢复状态"},
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey(
            "chat_conversations.id",
            name="chat_messages_conversation_id_fkey",
            ondelete="CASCADE",
        ),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON_DOCUMENT)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    task_id: Mapped[str | None] = mapped_column(
        ForeignKey("query_tasks.id", name="chat_messages_task_id_fkey", ondelete="SET NULL"),
        comment="该消息所属的问数任务；普通系统消息或历史消息可以为空",
    )

    __table_args__ = (
        Index("ix_chat_messages_conversation_id", "conversation_id"),
        Index("ix_chat_messages_role", "role"),
        Index(
            "ix_chat_messages_task_created_at",
            "task_id",
            "created_at",
        ),
    )


class QueryRun(Base):
    __tablename__ = "query_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[str | None] = mapped_column(String(128))
    user_message: Mapped[str] = mapped_column(Text, nullable=False)
    intent: Mapped[str] = mapped_column(String(64), nullable=False)
    query_shape: Mapped[str | None] = mapped_column(String(64))
    query_plan: Mapped[dict[str, Any] | None] = mapped_column(JSON_DOCUMENT)
    sql_text: Mapped[str | None] = mapped_column(Text)
    sql_params: Mapped[dict[str, Any] | None] = mapped_column(JSON_DOCUMENT)
    row_count: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    status: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'pending'")
    )
    failed_node: Mapped[str | None] = mapped_column(String(128))
    error_type: Mapped[str | None] = mapped_column(String(128))
    error_message: Mapped[str | None] = mapped_column(Text)
    user_feedback: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    raw_org_text: Mapped[str | None] = mapped_column(String(255))
    matched_text: Mapped[str | None] = mapped_column(String(255))
    matched_org_name: Mapped[str | None] = mapped_column(String(255))
    org_match_type: Mapped[str | None] = mapped_column(String(64))
    task_id: Mapped[str | None] = mapped_column(
        ForeignKey("query_tasks.id", name="query_runs_task_id_fkey", ondelete="SET NULL"),
        comment="本次 SQL 生成或执行所属的问数任务",
    )

    __table_args__ = (
        Index("ix_query_runs_conversation_id", "conversation_id"),
        Index("ix_query_runs_intent", "intent"),
        Index("ix_query_runs_query_shape", "query_shape"),
        Index("ix_query_runs_status", "status"),
        Index("ix_query_runs_raw_org_text", "raw_org_text"),
        Index("ix_query_runs_matched_text", "matched_text"),
        Index("ix_query_runs_matched_org_name", "matched_org_name"),
        Index("ix_query_runs_org_match_type", "org_match_type"),
        Index(
            "ix_query_runs_task_created_at",
            "task_id",
            "created_at",
        ),
    )
