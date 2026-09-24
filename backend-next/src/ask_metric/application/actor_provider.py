from typing import Protocol

from ask_metric.application.requests import ActorContext, IncomingRequest

ActorRequest = IncomingRequest


class ActorProvider(Protocol):
    def resolve(self, request: ActorRequest) -> ActorContext: ...


class AnonymousActorProvider:
    """Stage-two provider that deliberately ignores untrusted identity claims."""

    def resolve(self, request: ActorRequest) -> ActorContext:
        subject = request.external_user_id or "anonymous"
        return ActorContext(
            subject=subject,
            authentication_method="anonymous",
            trust_level="anonymous",
        )


class DevelopmentActorProvider:
    """Fixed development actor; request claims cannot elevate its permissions."""

    def __init__(self, *, tenant_id: str = "development", user_id: str = "developer") -> None:
        self.tenant_id = tenant_id
        self.user_id = user_id

    def resolve(self, request: ActorRequest) -> ActorContext:
        return ActorContext(
            subject=request.external_user_id or self.user_id,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            authentication_method="development_fixed_actor",
            trust_level="development",
        )


class AuthenticatedActorProvider:
    """Identity already authenticated by a trusted reverse proxy or middleware."""

    def __init__(
        self,
        *,
        subject: str,
        tenant_id: str,
        user_id: str,
        org_id: str,
        role_code: str = "USER",
        authentication_method: str = "trusted_proxy_headers",
    ) -> None:
        self.actor = ActorContext(
            subject=subject,
            tenant_id=tenant_id,
            user_id=user_id,
            org_id=org_id,
            role_code=role_code,
            authentication_method=authentication_method,
            trust_level="authenticated",
        )

    def resolve(self, request: ActorRequest) -> ActorContext:
        return self.actor


class ContextActorProvider:
    def __init__(self, actor: ActorContext) -> None:
        self.actor = actor

    def resolve(self, request: ActorRequest) -> ActorContext:
        return self.actor
