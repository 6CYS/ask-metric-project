from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ask_metric.infrastructure.db.models import (
    AppUser,
    ChatConversation,
    ChatMessage,
    OrgTerm,
    QueryRun,
    QueryTask,
)


class QueryRunTaskRequiredError(ValueError):
    pass


class ConversationRepository(Protocol):
    def get(self, conversation_id: str) -> ChatConversation | None: ...
    def add(self, conversation: ChatConversation) -> None: ...
    def delete_old_owned(self, user_id: str, *, keep_latest: int) -> int: ...


class AppUserRepository(Protocol):
    def get(self, user_id: str) -> AppUser | None: ...
    def get_by_username(self, username: str) -> AppUser | None: ...
    def get_by_username_with_org(self, username: str) -> tuple[AppUser, str] | None: ...


class ChatMessageRepository(Protocol):
    def add(self, message: ChatMessage) -> None: ...
    def list_for_conversation(self, conversation_id: str) -> list[ChatMessage]: ...
    def find_by_external_message_id(
        self, channel: str, external_message_id: str
    ) -> ChatMessage | None: ...


class QueryTaskRepository(Protocol):
    def get(self, task_id: str) -> QueryTask | None: ...
    def get_for_update(self, task_id: str) -> QueryTask | None: ...
    def add(self, task: QueryTask) -> None: ...
    def list_for_conversation(self, conversation_id: str) -> list[QueryTask]: ...
    def list_owned(self, user_id: str) -> list[QueryTask]: ...
    def list_waiting_for_conversation(self, conversation_id: str) -> list[QueryTask]: ...


class QueryRunRepository(Protocol):
    def add(self, run: QueryRun) -> None: ...
    def get(self, run_id: int) -> QueryRun | None: ...


class SqlAlchemyConversationRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, conversation_id: str) -> ChatConversation | None:
        return self.session.get(ChatConversation, conversation_id)

    def add(self, conversation: ChatConversation) -> None:
        self.session.add(conversation)

    def get_owned(self, conversation_id: str, user_id: str) -> ChatConversation | None:
        statement = select(ChatConversation).where(
            ChatConversation.id == conversation_id,
            ChatConversation.owner_user_id == user_id,
        )
        return self.session.execute(statement).scalar_one_or_none()

    def list_owned(
        self, user_id: str, *, limit: int | None = None, offset: int = 0
    ) -> list[ChatConversation]:
        statement = (
            select(ChatConversation)
            .where(ChatConversation.owner_user_id == user_id)
            .order_by(ChatConversation.updated_at.desc(), ChatConversation.id)
            .offset(offset)
        )
        if limit is not None:
            statement = statement.limit(limit)
        return list(self.session.execute(statement).scalars())

    def count_owned(self, user_id: str) -> int:
        statement = select(func.count()).select_from(ChatConversation).where(
            ChatConversation.owner_user_id == user_id
        )
        return int(self.session.execute(statement).scalar_one())

    def rename_owned(
        self, conversation_id: str, user_id: str, title: str
    ) -> ChatConversation | None:
        conversation = self.get_owned(conversation_id, user_id)
        if conversation is None:
            return None
        conversation.title = title
        return conversation

    def delete_owned(self, conversation_id: str, user_id: str) -> bool:
        statement = delete(ChatConversation).where(
            ChatConversation.id == conversation_id,
            ChatConversation.owner_user_id == user_id,
        )
        return bool(self.session.execute(statement).rowcount)

    def delete_old_owned(self, user_id: str, *, keep_latest: int) -> int:
        older_ids_query = (
            select(ChatConversation.id)
            .where(ChatConversation.owner_user_id == user_id)
            .order_by(ChatConversation.updated_at.desc(), ChatConversation.id)
            .offset(keep_latest)
        )
        older_ids = older_ids_query.subquery("older_conversation_ids")
        has_active_task = (
            select(QueryTask.id)
            .where(
                QueryTask.conversation_id == ChatConversation.id,
                QueryTask.status.in_(("RUNNING", "WAITING_USER")),
            )
            .exists()
        )
        statement = delete(ChatConversation).where(
            ChatConversation.owner_user_id == user_id,
            ChatConversation.id.in_(select(older_ids.c.id)),
            ~has_active_task,
        )
        return int(self.session.execute(statement).rowcount or 0)


class SqlAlchemyAppUserRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, user_id: str) -> AppUser | None:
        return self.session.get(AppUser, user_id)

    def get_by_username(self, username: str) -> AppUser | None:
        statement = select(AppUser).where(AppUser.username == username)
        return self.session.execute(statement).scalar_one_or_none()

    def get_by_username_with_org(self, username: str) -> tuple[AppUser, str] | None:
        statement = (
            select(AppUser, OrgTerm.org_name)
            .join(OrgTerm, OrgTerm.org_code == AppUser.org_code)
            .where(AppUser.username == username)
        )
        row = self.session.execute(statement).one_or_none()
        return (row[0], row[1]) if row else None

    def increment_session_version(self, user_id: str, *, login: bool = False) -> AppUser | None:
        values: dict = {
            "session_version": AppUser.session_version + 1,
            "updated_at": datetime.now(UTC),
        }
        if login:
            values["last_login_at"] = datetime.now(UTC)
        statement = update(AppUser).where(AppUser.id == user_id).values(**values)
        result = self.session.execute(statement)
        if result.rowcount != 1:
            return None
        refreshed = (
            select(AppUser)
            .where(AppUser.id == user_id)
            .execution_options(populate_existing=True)
        )
        return self.session.execute(refreshed).scalar_one_or_none()


class SqlAlchemyChatMessageRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def add(self, message: ChatMessage) -> None:
        self.session.add(message)

    def list_for_conversation(self, conversation_id: str) -> list[ChatMessage]:
        statement = (
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conversation_id)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )
        return list(self.session.execute(statement).scalars())

    def find_by_external_message_id(
        self, channel: str, external_message_id: str
    ) -> ChatMessage | None:
        statement = (
            select(ChatMessage)
            .where(
                ChatMessage.payload["channel"].as_string() == channel,
                ChatMessage.payload["external_message_id"].as_string()
                == external_message_id,
            )
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .limit(1)
        )
        return self.session.execute(statement).scalar_one_or_none()


class SqlAlchemyQueryTaskRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, task_id: str) -> QueryTask | None:
        return self.session.get(QueryTask, task_id)

    def get_for_update(self, task_id: str) -> QueryTask | None:
        statement = select(QueryTask).where(QueryTask.id == task_id).with_for_update()
        return self.session.execute(statement).scalar_one_or_none()

    def get_owned(self, task_id: str, user_id: str) -> QueryTask | None:
        statement = (
            select(QueryTask)
            .join(ChatConversation, ChatConversation.id == QueryTask.conversation_id)
            .where(QueryTask.id == task_id, ChatConversation.owner_user_id == user_id)
        )
        return self.session.execute(statement).scalar_one_or_none()

    def get_owned_for_update(self, task_id: str, user_id: str) -> QueryTask | None:
        statement = (
            select(QueryTask)
            .join(ChatConversation, ChatConversation.id == QueryTask.conversation_id)
            .where(QueryTask.id == task_id, ChatConversation.owner_user_id == user_id)
            .with_for_update()
        )
        return self.session.execute(statement).scalar_one_or_none()

    def find_by_idempotency_key(
        self, conversation_id: str, idempotency_key: str
    ) -> QueryTask | None:
        statement = select(QueryTask).where(
            QueryTask.conversation_id == conversation_id,
            QueryTask.idempotency_key == idempotency_key,
        )
        return self.session.execute(statement).scalar_one_or_none()

    def add(self, task: QueryTask) -> None:
        self.session.add(task)

    def list_for_conversation(self, conversation_id: str) -> list[QueryTask]:
        statement = (
            select(QueryTask)
            .where(QueryTask.conversation_id == conversation_id)
            .order_by(QueryTask.created_at, QueryTask.id)
        )
        return list(self.session.execute(statement).scalars())

    def list_owned(self, user_id: str) -> list[QueryTask]:
        statement = (
            select(QueryTask)
            .join(
                ChatConversation,
                ChatConversation.id == QueryTask.conversation_id,
            )
            .where(ChatConversation.owner_user_id == user_id)
            .order_by(QueryTask.created_at, QueryTask.id)
        )
        return list(self.session.execute(statement).scalars())

    def list_waiting_for_conversation(self, conversation_id: str) -> list[QueryTask]:
        statement = (
            select(QueryTask)
            .where(
                QueryTask.conversation_id == conversation_id,
                QueryTask.status == "WAITING_USER",
                QueryTask.current_stage == "CLARIFICATION",
            )
            .order_by(QueryTask.updated_at.desc(), QueryTask.id)
        )
        return list(self.session.execute(statement).scalars())

    def update_optimistically(
        self,
        *,
        task_id: str,
        expected_version: int,
        status: str,
        current_stage: str,
        state_json: dict,
        intent: str | None = None,
        query_shape: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        completed_at: datetime | None = None,
    ) -> QueryTask | None:
        statement = (
            update(QueryTask)
            .where(QueryTask.id == task_id, QueryTask.version == expected_version)
            .values(
                status=status,
                current_stage=current_stage,
                state_json=state_json,
                intent=intent,
                query_shape=query_shape,
                error_code=error_code,
                error_message=error_message,
                completed_at=completed_at,
                version=expected_version + 1,
            )
        )
        result = self.session.execute(statement)
        if result.rowcount != 1:
            return None
        refreshed = (
            select(QueryTask)
            .where(QueryTask.id == task_id)
            .execution_options(populate_existing=True)
        )
        return self.session.execute(refreshed).scalar_one_or_none()


class SqlAlchemyQueryRunRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def add(self, run: QueryRun) -> None:
        if not run.task_id:
            raise QueryRunTaskRequiredError(
                "New query runs must be associated with a QueryTask; "
                "nullable task_id is legacy-only"
            )
        self.session.add(run)

    def get(self, run_id: int) -> QueryRun | None:
        return self.session.get(QueryRun, run_id)
