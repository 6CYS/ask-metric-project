from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.infrastructure.db.models import OrgTerm
from ask_metric.infrastructure.db.session import get_app_session_factory


class SqlAlchemyOrganizationScopeProvider:
    """先校验所属机构，再按服务端机构授权决定可读取的机构范围。"""

    def __init__(
        self, session_factory: sessionmaker[Session] | None = None,
        *, province_query_org_codes: list[str] | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.province_query_org_codes = frozenset(province_query_org_codes or [])

    def allowed_org_codes(self, org_code: str) -> set[str]:
        session_factory = self.session_factory or get_app_session_factory()
        with session_factory() as session:
            existing = session.execute(
                select(OrgTerm.org_code).where(
                    OrgTerm.org_code == org_code,
                    OrgTerm.enabled.is_(True),
                )
            ).scalar_one_or_none()
            if existing is None:
                return set()
            # 只使用认证后映射的正式机构编码，不能凭名称或请求参数扩大权限。
            if org_code in self.province_query_org_codes:
                return set(session.scalars(
                    select(OrgTerm.org_code).where(OrgTerm.enabled.is_(True)),
                ))
        return {org_code}
