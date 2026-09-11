from dataclasses import dataclass
from hashlib import sha256
from secrets import token_urlsafe
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select

from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.core.security import hash_password
from ask_metric.infrastructure.db.models import AppUser, OrgTerm
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork


@dataclass(frozen=True)
class ExternalUserProfile:
    source_system: str
    user_code: str
    user_name: str
    org_code: str
    login_code: str | None = None
    org_name: str | None = None
    corpo_code: str | None = None
    corpo_name: str | None = None
    dept_code: str | None = None
    dept_name: str | None = None


def external_user_id(source_system: str, user_code: str) -> str:
    """Return the stable local id shared by SSO and offline identity imports."""
    return str(
        uuid5(
            NAMESPACE_URL,
            f"ask-metric:external-user:{source_system.strip()}:{user_code.strip()}",
        )
    )


def external_shadow_username(source_system: str, user_code: str) -> str:
    """Return a collision-resistant username when an integration has no login code."""
    username_digest = sha256(
        f"{source_system.strip()}:{user_code.strip()}".encode()
    ).hexdigest()[:32]
    return f"external_{username_digest}"


class IntegrationIdentityService:
    """Map a trusted external profile to an auditable local shadow user."""

    def __init__(self, uow_factory=SqlAlchemyUnitOfWork) -> None:
        self.uow_factory = uow_factory

    def resolve(self, profile: ExternalUserProfile) -> ActorContext:
        source_system = profile.source_system.strip()
        user_code = profile.user_code.strip()
        login_code = profile.login_code.strip() if profile.login_code else None
        org_code = profile.org_code.strip()
        user_id = external_user_id(source_system, user_code)
        desired_username = login_code or external_shadow_username(source_system, user_code)
        if len(desired_username) > 64:
            raise ApplicationError(
                "IDENTITY_LOGIN_CODE_INVALID",
                "统一认证返回的登录账号超过本系统长度限制",
                status_code=400,
            )
        with self.uow_factory() as uow:
            organization = uow.session.execute(
                select(OrgTerm).where(
                    OrgTerm.org_code == org_code,
                    OrgTerm.enabled.is_(True),
                )
            ).scalar_one_or_none()
            if organization is None:
                raise ApplicationError(
                    "ORGANIZATION_NOT_FOUND",
                    f"机构 {org_code} 未在问数机构目录中登记或已停用",
                    status_code=400,
                )
            user = uow.users.get(user_id)
            if user is not None and login_code is None:
                desired_username = user.username
            username_owner = uow.users.get_by_username(desired_username)
            if username_owner is not None and username_owner.id != user_id:
                raise ApplicationError(
                    "IDENTITY_USERNAME_CONFLICT",
                    f"登录账号 {desired_username} 已关联到其他本地用户",
                    status_code=409,
                )
            if user is None:
                user = AppUser(
                    id=user_id,
                    username=desired_username,
                    # SSO users do not use a local password. Store a unique,
                    # unknowable password hash to satisfy the local schema.
                    password_hash=hash_password(token_urlsafe(48)),
                    display_name=profile.user_name,
                    org_code=org_code,
                    role_code="USER",
                    enabled=True,
                )
                uow.session.add(user)
            else:
                # Do not replace a pre-synchronized LOGIN_CODE with a generated
                # shadow name when the upstream profile omits loginCode.
                if login_code:
                    user.username = login_code
                user.display_name = profile.user_name
                user.org_code = org_code
                user.enabled = True
            uow.commit()

        return ActorContext(
            subject=f"{source_system}:{user_code}",
            tenant_id=profile.corpo_code or profile.source_system,
            user_id=user_id,
            org_id=org_code,
            role_code="USER",
            authentication_method="trusted_integration_user_info",
            trust_level="authenticated",
        )
