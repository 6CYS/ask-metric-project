from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.infrastructure.db.models import OrgTerm
from ask_metric.infrastructure.db.session import get_app_session_factory


class SqlAlchemyOrganizationScopeProvider:
    """Validate that a user's own organization exists and is enabled."""

    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self.session_factory = session_factory

    def allowed_org_codes(self, org_code: str) -> set[str]:
        session_factory = self.session_factory or get_app_session_factory()
        with session_factory() as session:
            existing = session.execute(
                select(OrgTerm.org_code).where(
                    OrgTerm.org_code == org_code,
                    OrgTerm.enabled.is_(True),
                )
            ).scalar_one_or_none()
        return {org_code} if existing is not None else set()

    def all_org_codes(self) -> set[str]:
        session_factory = self.session_factory or get_app_session_factory()
        with session_factory() as session:
            return set(session.scalars(
                select(OrgTerm.org_code).where(OrgTerm.enabled.is_(True))
            ))
