"""可执行机构范围及已校验的启用目录快照。"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ask_metric.core.errors import ApplicationError

# 集合原文必须完整表达量词或授权范围；不能只凭“农商行”后缀扩大具体机构。
_COHORT_BANK = r"(?:农村商业银行|农商银行|农商行|银行|行)"
_COHORT_QUANTIFIER = r"(?:各家|各个|各|所有|全部|每家|每个)"
_COHORT_AREA = r"(?:全省|省内)"
_COHORT_ACCESS = (
    r"(?:(?:我|当前|本)?(?:账号|账户|用户)?"
    r"(?:有权限查看|有权查看|权限范围内|权限内|可查看|能查看|可见)的?)"
)
_COHORT_SOURCE = re.compile(
    rf"(?:在)?(?:"
    rf"{_COHORT_ACCESS}(?:{_COHORT_AREA})?(?:的)?(?:{_COHORT_QUANTIFIER})?"
    rf"|{_COHORT_AREA}(?:的)?(?:{_COHORT_QUANTIFIER})?"
    rf"|{_COHORT_QUANTIFIER}"
    rf"){_COHORT_BANK}(?:范围内)?"
)


def is_authorized_cohort_source(cohort: str, source_text: str) -> bool:
    """正式集合的受控原文语法；业务接口与验收桩共享同一判定。"""
    normalized = re.sub(r"\s+", "", unicodedata.normalize("NFKC", source_text))
    return cohort == "rural_commercial_banks" and _COHORT_SOURCE.fullmatch(normalized) is not None


class AuthorizedCohortScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["authorized_cohort"]
    cohort: Literal["rural_commercial_banks"]


class ChildrenOfScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["children_of"]
    parent_code: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)
    ]


OrganizationScopeSpec = Annotated[
    AuthorizedCohortScope | ChildrenOfScope, Field(discriminator="kind")
]


class OrganizationScopeError(ApplicationError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(
            code, message,
            status_code=403 if code in {"PERMISSION_DENIED", "EMPTY_AUTHORIZED_SCOPE"} else 409,
        )


@dataclass(frozen=True)
class OrganizationHierarchyNode:
    code: str
    name: str
    parent_code: str | None
    hierarchy_level: str | None


@dataclass(frozen=True)
class OrganizationHierarchySnapshot:
    """同一读取得到的目录与授权层级；新查询不使用旧的名称推断回退。"""

    nodes: tuple[OrganizationHierarchyNode, ...]
    root_level: str = "1"
    cohort_level: str = "3"

    def validated_root(self) -> str:
        def invalid() -> None:
            raise OrganizationScopeError(
                "CONFIGURATION_ERROR", "机构层级配置不完整或不一致，暂时无法确定查询范围"
            )

        by_code = {node.code: node for node in self.nodes}
        if not by_code or len(by_code) != len(self.nodes):
            invalid()
        if self.root_level == self.cohort_level:
            invalid()
        if any(not node.code or not node.name or not node.hierarchy_level for node in self.nodes):
            invalid()
        roots = [node.code for node in self.nodes if not node.parent_code]
        if len(roots) != 1:
            invalid()
        root = roots[0]
        if by_code[root].hierarchy_level != self.root_level:
            invalid()
        for node in self.nodes:
            if node.code != root and node.hierarchy_level == self.root_level:
                invalid()
            if node.code != root and node.parent_code not in by_code:
                invalid()
            # 法人行集合必须与省级根的直接下级一致，禁止支行混排或中间层猜测。
            if (node.parent_code == root) != (node.hierarchy_level == self.cohort_level):
                invalid()
            seen: set[str] = set()
            current = node.code
            while current != root:
                if current in seen or current not in by_code:
                    invalid()
                seen.add(current)
                current = by_code[current].parent_code or ""
        return root

    def descendants_including(self, org_code: str) -> set[str]:
        enabled = {node.code for node in self.nodes}
        if org_code not in enabled:
            return set()
        allowed = {org_code}
        frontier = {org_code}
        while frontier:
            frontier = {
                node.code for node in self.nodes if node.parent_code in frontier
            } - allowed
            allowed.update(frontier)
        return allowed
