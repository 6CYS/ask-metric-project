from types import TracebackType

from sqlalchemy.orm import Session, sessionmaker

from ask_metric.infrastructure.db.repositories import (
    SqlAlchemyAppUserRepository,
    SqlAlchemyChatMessageRepository,
    SqlAlchemyConversationRepository,
    SqlAlchemyQueryRunRepository,
    SqlAlchemyQueryTaskRepository,
)
from ask_metric.infrastructure.db.session import get_app_session_factory
from ask_metric.infrastructure.semantic.catalogs import (
    SqlAlchemyMetricCatalogRepository,
    SqlAlchemyOrganizationCatalogRepository,
)


class SqlAlchemyUnitOfWork:
    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self.session_factory = session_factory or get_app_session_factory()
        self.session: Session | None = None

    def __enter__(self) -> "SqlAlchemyUnitOfWork":
        self.session = self.session_factory()
        self.conversations = SqlAlchemyConversationRepository(self.session)
        self.users = SqlAlchemyAppUserRepository(self.session)
        self.messages = SqlAlchemyChatMessageRepository(self.session)
        self.tasks = SqlAlchemyQueryTaskRepository(self.session)
        self.runs = SqlAlchemyQueryRunRepository(self.session)
        self.metric_catalog = SqlAlchemyMetricCatalogRepository(self.session)
        self.organization_catalog = SqlAlchemyOrganizationCatalogRepository(self.session)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self.session is None:
            return
        try:
            if exc_type is not None:
                self.session.rollback()
        finally:
            self.session.close()

    def commit(self) -> None:
        if self.session is None:
            raise RuntimeError("UnitOfWork has not been entered")
        self.session.commit()

    def flush(self) -> None:
        if self.session is None:
            raise RuntimeError("UnitOfWork has not been entered")
        self.session.flush()

    def rollback(self) -> None:
        if self.session is None:
            raise RuntimeError("UnitOfWork has not been entered")
        self.session.rollback()
