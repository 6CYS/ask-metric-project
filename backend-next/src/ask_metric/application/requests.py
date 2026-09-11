from typing import Any, Literal

from pydantic import BaseModel, Field

QUESTION_MAX_LENGTH = 1000


class UntrustedIdentityClaims(BaseModel):
    """Identity values asserted by a channel; never an authorization context."""

    tenant_id: str | None = None
    user_id: str | None = None
    org_id: str | None = None


class IncomingRequest(BaseModel):
    request_id: str
    idempotency_key: str | None = None
    channel: str
    external_user_id: str | None = None
    external_session_id: str | None = None
    external_message_id: str | None = None
    reply_to_external_message_id: str | None = None
    reply_to_task_id: str | None = Field(default=None, min_length=1, max_length=128)
    conversation_id: str | None = None
    text: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    identity_claims: UntrustedIdentityClaims | None = None
    business_context: dict[str, Any] = Field(default_factory=dict)
    channel_context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    debug: bool = False


class IncomingClarificationRequest(BaseModel):
    request_id: str
    idempotency_key: str | None = None
    channel: str
    answers: Any
    task_id: str | None = None
    expected_version: int | None = Field(default=None, ge=0)
    clarification_id: str | None = None
    continuation_token: str | None = None
    external_user_id: str | None = None
    external_session_id: str | None = None
    external_message_id: str | None = None
    reply_to_external_message_id: str | None = None
    conversation_id: str | None = None
    identity_claims: UntrustedIdentityClaims | None = None
    channel_context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ActorContext(BaseModel):
    """Trusted identity produced by authentication or a channel adapter."""

    subject: str
    tenant_id: str | None = None
    user_id: str | None = None
    org_id: str | None = None
    role_code: str = "USER"
    authentication_method: str
    trust_level: Literal["anonymous", "development", "authenticated"]
