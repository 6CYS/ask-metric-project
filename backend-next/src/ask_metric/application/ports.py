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
    ) -> None:
        self.organization_scope_provider = organization_scope_provider
        self.allow_unscoped_development = allow_unscoped_development

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
        requested = list(logical_dsl.get("orgs") or [])
        authorized = dict(logical_dsl)
        if requested and any(value not in allowed for value in requested):
            options = logical_dsl.get("options") or {}
            if options.get("organization_scope") != "synchronized_catalog":
                raise PermissionDeniedError("无权查询所属机构之外的数据")
            requested = [value for value in requested if value in allowed]
            if not requested:
                raise PermissionDeniedError("请求的机构范围与用户权限没有交集")
        # An omitted organization always defaults to the user's own organization.
        authorized["orgs"] = requested or [actor.org_id]
        return authorized
