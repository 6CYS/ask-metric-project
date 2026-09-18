"""机构层级只读实现（v2：真实父子关系 + v1 汇总规则回退）。

数据前提（两种模式由 org_terms 数据自动切换，调用方契约不变）：
- 层级模式：迁移 0004 后目录同步在启用支行层级扩展
  （SIT_ORG_INCLUDE_BRANCH_LEVEL）时写入 parent_org_code/hierarchy_level。
  恰好只有一个启用机构 parent_org_code 为空（唯一根）才认定层级数据完整，
  进入层级模式：children_of 返回该机构在已启用机构中的直接下级
  （parent_org_code = 本机构，自环除外）。半同步窗口（多个或零个无上级
  节点）行为不稳，一律回退 v1。缺上级数据的机构不会出现在任何下级列表中。
- v1 回退：层级列全空或数据不完整时保持原规则——只识别名称含
  “全省汇总”的省级汇总节点，其直接下级视为全部启用机构（除自身）；
  普通法人机构返回空列表，由上层转为澄清。

root_code 供排名缺机构时定位缺省范围：层级模式取唯一根节点；v1 回退取
名称含“全省汇总”的唯一节点，存在多个时不随意取其一，与多根一样返回
None 交上层澄清。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ask_metric.infrastructure.db.models import OrgTerm

# v1 层级判定规则：省级汇总节点名称中的固定字样；机构名来自受治理目录，非用户输入。
_SUMMARY_NODE_MARKER = "全省汇总"


class SqlAlchemyOrgHierarchyProvider:
    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self.session_factory = session_factory

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
