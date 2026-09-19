"""业务所需的接口约定及机构权限边界。

Protocol 中的 ... 表示只声明方法签名，不是待补的运行逻辑；实际实现由
api/dependencies.py 装配。这样固定响应测试可以替换模型和数据库而不联网。
"""

from typing import Any, Protocol

from ask_metric.application.requests import ActorContext


class ModelService(Protocol):
    def analyze(self, *, prompt: str, context: dict[str, Any]) -> dict[str, Any]: ...

    def embed(self, texts: list[str]) -> list[list[float]]: ...

    def rerank(
        self, *, query: str, documents: list[str], top_n: int | None = None
    ) -> list[dict[str, Any]]: ...


class MetricCatalog(Protocol):
    def search(self, text: str, *, limit: int = 20) -> list[dict[str, Any]]: ...

    def get_metadata_version(self) -> str: ...


class DataSourceAdapter(Protocol):
    def execute_readonly(
        self, *, sql: str, parameters: dict[str, Any]
    ) -> "DataSourceExecution": ...


class DataSourceExecution(Protocol):
    rows: list[dict[str, Any]]
    latency_ms: int


class QueryResultEnricher(Protocol):
    def enrich(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]: ...


class PermissionService(Protocol):
    def authorize_logical_dsl(
        self, *, actor: ActorContext, logical_dsl: dict[str, Any]
    ) -> dict[str, Any]: ...


class OrganizationScopeProvider(Protocol):
    def allowed_org_codes(self, org_code: str) -> set[str]: ...

    def all_org_codes(self) -> set[str]: ...


class OrgHierarchyProvider(Protocol):
    """机构层级只读接口。

    实现按 org_terms 数据自动切换：恰好一个启用机构无上级（唯一根）时按真实
    parent_org_code（迁移 0004 起由目录同步在启用支行层级扩展后写入）返回直接
    下级；层级数据缺失或不完整（半同步窗口）时回退 v1 规则——省级汇总节点的
    直接下级=org_terms 全部启用机构（除自身），普通法人暂无下级数据。
    调用方契约不变。
    """

    def children_of(self, org_code: str) -> list[str]: ...

    def root_code(self) -> str | None:
        """层级根节点编码：排名缺机构时的缺省范围；找不到返回 None 交澄清。"""
        ...


class ChannelAdapter(Protocol):
    channel: str

    def verify_request(self, headers: dict[str, str], body: bytes) -> None: ...

    def format_response(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class NoopPermissionService:
    """Development boundary only; production must inject a trusted implementation."""

    def authorize_logical_dsl(
        self, *, actor: ActorContext, logical_dsl: dict[str, Any]
    ) -> dict[str, Any]:
        return logical_dsl


class PermissionDeniedError(ValueError):
    code = "ORG_SCOPE_FORBIDDEN"


class ScopedOrganizationPermissionService:
    """Trusted organization boundary resolved by the configured scope provider."""

    def __init__(
        self,
        *,
        organization_scope_provider: OrganizationScopeProvider | None = None,
        allow_unscoped_development: bool = False,
        all_organization_org_codes: set[str] | None = None,
    ) -> None:
        self.organization_scope_provider = organization_scope_provider
        self.allow_unscoped_development = allow_unscoped_development
        self.all_organization_org_codes = all_organization_org_codes or set()

    def authorize_logical_dsl(
        self, *, actor: ActorContext, logical_dsl: dict[str, Any]
    ) -> dict[str, Any]:
        if actor.trust_level == "development" and self.allow_unscoped_development:
            return logical_dsl
        if actor.trust_level != "authenticated" or not actor.org_id:
            raise PermissionDeniedError("缺少可信的机构权限范围")
        if actor.role_code == "SYSTEM_ADMIN":
            return logical_dsl
        allowed = (
            self.organization_scope_provider.allowed_org_codes(actor.org_id)
            if self.organization_scope_provider is not None
            else {actor.org_id}
        )
        if not allowed or actor.org_id not in allowed:
            raise PermissionDeniedError("用户所属机构不存在或已停用")
        # 全行权限属于配置中的省级机构，不再为某个用户 ID 绕过机构边界。
        if actor.org_id in self.all_organization_org_codes and self.organization_scope_provider:
            allowed = self.organization_scope_provider.all_org_codes()
        requested = list(logical_dsl.get("orgs") or [])
        authorized = dict(logical_dsl)
        # 明确指定越权机构时拒绝；仅正式目录展开的全机构范围允许取权限交集。
        # 因此模型提出的机构集合不是最终授权结果，执行前仍须经过这里复核。
        if requested and any(value not in allowed for value in requested):
            options = logical_dsl.get("options") or {}
            if options.get("organization_scope") != "synchronized_catalog":
                raise PermissionDeniedError("无权查询所属机构之外的数据")
            requested = [value for value in requested if value in allowed]
            if not requested:
                raise PermissionDeniedError("请求的机构范围与用户权限没有交集")
        # 未指定机构时只默认到本人机构，不能把空条件解释成查询所有机构。
        authorized["orgs"] = requested or [actor.org_id]
        return authorized
