"""机构层级只读实现。

新查询仅调用 strict_snapshot：目录同步始终写入正式 parent_org_code/hierarchy_level，
完整校验唯一根、层级及父链，配置不全时拒绝集合查询。

children_of/root_code 仍供在用渠道的旧语义链路调用，保留历史名称回退规则；
它们不参与新查询的集合解析或授权。待渠道迁移后才能删除这些兼容方法。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
)
from ask_metric.infrastructure.db.models import OrgTerm

# v1 层级判定规则：省级汇总节点名称中的固定字样；机构名来自受治理目录，非用户输入。
_SUMMARY_NODE_MARKER = "全省汇总"


class SqlAlchemyOrgHierarchyProvider:
    def __init__(
        self, session_factory: sessionmaker[Session] | None = None, *,
        root_level: str = "1", cohort_level: str = "3",
    ) -> None:
        self.session_factory = session_factory
        self.root_level = root_level
        self.cohort_level = cohort_level

    def strict_snapshot(self) -> OrganizationHierarchySnapshot:
        """新集合查询仅采用完整正式层级；旧入口的回退逻辑不参与此调用。"""
        session_factory = self.session_factory or _default_session_factory()
        with session_factory() as session:
            rows = session.execute(select(
                OrgTerm.org_code, OrgTerm.org_name, OrgTerm.parent_org_code,
                OrgTerm.hierarchy_level,
            ).where(OrgTerm.enabled.is_(True))).all()
        snapshot = OrganizationHierarchySnapshot(
            nodes=tuple(OrganizationHierarchyNode(
                code=code, name=name, parent_code=(parent or "").strip() or None,
                hierarchy_level=(level or "").strip() or None,
            ) for code, name, parent, level in rows),
            root_level=self.root_level, cohort_level=self.cohort_level,
        )
        snapshot.validated_root()
        return snapshot

    def children_of(self, org_code: str) -> list[str]:
        rows = self._enabled_rows()
        names = {code: name for code, name, _ in rows}
        if org_code not in names:
            return []
        parents = {code: (parent or "").strip() for code, _, parent in rows}
        if _hierarchy_mode(parents):
            # 层级模式：直接下级 = parent_org_code 指向本机构的启用机构；自环不算下级。
            return sorted(
                code
                for code, parent in parents.items()
                if parent == org_code and code != org_code
            )
        # v1 回退：无完整层级数据，仅省级汇总节点有下级（全部启用机构）。
        if _SUMMARY_NODE_MARKER not in names[org_code]:
            return []
        return sorted(code for code in names if code != org_code)

    def root_code(self) -> str | None:
        rows = self._enabled_rows()
        parents = {code: (parent or "").strip() for code, _, parent in rows}
        if _hierarchy_mode(parents):
            # 层级模式：唯一根 = 唯一无上级节点；无下级时由上层按“无下级”澄清。
            return next(code for code, parent in parents.items() if not parent)
        # v1 回退：取名称含“全省汇总”的唯一省级汇总节点；多个视为数据异常，
        # 返回 None 交上层澄清，不再随意取字典序第一个。
        names = {code: name for code, name, _ in rows}
        summaries = sorted(code for code, name in names.items() if _SUMMARY_NODE_MARKER in name)
        return summaries[0] if len(summaries) == 1 else None

    def _enabled_rows(self) -> list[tuple[str, str, str | None]]:
        session_factory = self.session_factory or _default_session_factory()
        with session_factory() as session:
            return list(
                session.execute(
                    select(
                        OrgTerm.org_code, OrgTerm.org_name, OrgTerm.parent_org_code
                    ).where(OrgTerm.enabled.is_(True))
                ).all()
            )


def _hierarchy_mode(parents: dict[str, str]) -> bool:
    """恰好一个启用机构无上级（唯一根）才认定层级数据完整可用。"""
    return sum(1 for parent in parents.values() if not parent) == 1


def _default_session_factory() -> sessionmaker[Session]:
    # 惰性导入：默认工厂依赖应用 settings，离线脚本注入自有 factory 时无需加载。
    from ask_metric.infrastructure.db.session import get_app_session_factory

    return get_app_session_factory()
