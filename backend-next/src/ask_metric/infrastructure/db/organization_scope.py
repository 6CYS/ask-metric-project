from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.infrastructure.db.models import OrgTerm
from ask_metric.infrastructure.db.session import get_app_session_factory


class SqlAlchemyOrganizationScopeProvider:
    """Validate that a user's own organization exists and is enabled.

    层级扩展（迁移 0004 起）：org_terms 存在非空 parent_org_code 数据时，
    用户可见机构 = 自身 ∪ 其全部已启用下级（按 parent_org_code 递归）；
    无层级数据（未启用支行层级扩展）时行为不变，仅自身机构可见。
    """

    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self.session_factory = session_factory

    def allowed_org_codes(self, org_code: str) -> set[str]:
        session_factory = self.session_factory or get_app_session_factory()
        with session_factory() as session:
            rows = session.execute(
                select(OrgTerm.org_code, OrgTerm.parent_org_code).where(
                    OrgTerm.enabled.is_(True)
                )
            ).all()
        enabled = {code for code, _ in rows}
        if org_code not in enabled:
            return set()
        parents = {code: (parent or "").strip() for code, parent in rows}
        if not any(parents.values()):
            return {org_code}
        # 有层级数据：沿 parent_org_code 向下收集全部启用下级（数据湖仅两级，
        # 仍按多轮展开以防中间层；enabled 集合有限，循环必然终止）。
        allowed = {org_code}
        frontier = {org_code}
        while frontier:
            children = {code for code, parent in parents.items() if parent in frontier}
            children -= allowed
            if not children:
                break
            allowed |= children
            frontier = children
        return allowed

    def all_org_codes(self) -> set[str]:
        session_factory = self.session_factory or get_app_session_factory()
        with session_factory() as session:
            return set(session.scalars(
                select(OrgTerm.org_code).where(OrgTerm.enabled.is_(True))
            ))
