import logging
from dataclasses import dataclass, replace

import httpx

from ask_metric.application.integration_identity import (
    ExternalUserProfile,
    IntegrationIdentityService,
)
from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.core.gm_crypto import (
    GmCryptoError,
    decrypt_sm4_key_hex,
    load_sm2_keypair,
    sm4_decrypt_cbc_text,
)
from ask_metric.core.request_context import outbound_subtransaction
from ask_metric.core.security import (
    create_access_token,
    hash_password,
    needs_password_rehash,
    verify_password,
)
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

logger = logging.getLogger(__name__)


class LoginFailedError(ApplicationError):
    def __init__(self) -> None:
        super().__init__("AUTH_LOGIN_FAILED", "用户名或密码错误", status_code=401)


class UserDisabledError(ApplicationError):
    def __init__(self) -> None:
        super().__init__("AUTH_USER_DISABLED", "账号已被禁用，请联系管理员", status_code=401)


class SsoDisabledError(ApplicationError):
    def __init__(self) -> None:
        super().__init__("AUTH_SSO_DISABLED", "单点登录未启用，请联系系统管理员", status_code=401)


class SsoUpstreamError(ApplicationError):
    def __init__(self, message: str = "统一认证服务暂不可用，请稍后重试") -> None:
        super().__init__("AUTH_SSO_UPSTREAM_ERROR", message, status_code=502)


class SsoTokenInvalidError(ApplicationError):
    def __init__(self) -> None:
        super().__init__("AUTH_SSO_TOKEN_INVALID", "单点登录凭证无效或已过期", status_code=401)


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    username: str
    display_name: str
    org_code: str
    org_name: str
    role_code: str
    session_version: int


class AuthenticationService:
    def __init__(self, settings: Settings, uow_factory=SqlAlchemyUnitOfWork) -> None:
        self.settings = settings
        self.uow_factory = uow_factory

    def sm2_public_key(self) -> str:
        keypair = load_sm2_keypair(
            self.settings.sm2_private_key,
            allow_ephemeral=self.settings.app_env.lower() in {"development", "test"},
        )
        return keypair.public_key_with_prefix

    def decrypt_login_password(self, encrypted_key: str, iv: str, cipher: str) -> str:
        """SM2 解出一次性 SM4 密钥，再 SM4-CBC 解出明文密码。

        解密失败统一映射为登录失败，避免向客户端泄露解密细节。
        """
        try:
            keypair = load_sm2_keypair(
                self.settings.sm2_private_key,
                allow_ephemeral=self.settings.app_env.lower() in {"development", "test"},
            )
            sm4_key = decrypt_sm4_key_hex(keypair, encrypted_key)
            password = sm4_decrypt_cbc_text(sm4_key, iv, cipher)
        except GmCryptoError as exc:
            raise LoginFailedError() from exc
        if not password:
            raise LoginFailedError()
        return password

    def login(self, username: str, password: str) -> tuple[str, int, AuthenticatedUser]:
        if not self.settings.allows_password_login:
            raise ApplicationError(
                "AUTH_PASSWORD_LOGIN_DISABLED", "密码登录未启用，请使用平台入口", status_code=403,
            )
        with self.uow_factory() as uow:
            user_with_org = uow.users.get_by_username_with_org(username)
            user, org_name = user_with_org if user_with_org else (None, username)
            if user is None or not verify_password(password, user.password_hash):
                raise LoginFailedError()
            if not user.enabled:
                raise UserDisabledError()
            legacy_rehash = (
                hash_password(password) if needs_password_rehash(user.password_hash) else None
            )
            user = uow.users.increment_session_version(user.id, login=True)
            if user is None:
                raise LoginFailedError()
            if legacy_rehash is not None:
                # 存量 argon2 账号登录成功后透明迁移为 SM3 哈希。
                # 注意：session 关闭 autoflush，必须在 increment 的 populate_existing
                # 刷新之后再赋值，才能随 commit 落库。
                user.password_hash = legacy_rehash
            uow.commit()
        authenticated = _authenticated_user(user, org_name)
        token, expires_in = create_access_token(
            settings=self.settings,
            claims={
                "sub": user.id,
                "username": user.username,
                "org_code": user.org_code,
                "role_code": user.role_code,
                "session_version": user.session_version,
                "auth_method": "password",
            },
        )
        return token, expires_in, authenticated

    def login_sso(self, token: str) -> tuple[str, int, AuthenticatedUser]:
        """Validate a Digital Rural Commercial Bank token and create a local session."""
        if not self.settings.sso_enabled:
            raise SsoDisabledError()
        if not token.strip():
            raise LoginFailedError()
        url = self.settings.sso_user_info_url.strip()
        if not url:
            raise SsoUpstreamError("统一认证服务地址未配置")

        try:
            with outbound_subtransaction("sso_user_info", invoke_sys="SSO") as transaction:
                with httpx.Client(timeout=self.settings.sso_timeout_seconds) as client:
                    response = client.get(
                        url,
                        headers={
                            "Accept": "application/json",
                            "Authorization": f"Bearer {token}",
                            **transaction.headers(),
                        },
                    )
                    transaction.set_response(response.status_code)
                    response.raise_for_status()
                    payload = response.json()
        except httpx.TimeoutException as exc:
            logger.error(
                "sso_upstream_failed category=timeout exception_type=%s",
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={"trans_api": "sso_user_info", "exception_type": type(exc).__name__},
            )
            failure = SsoUpstreamError("统一认证服务请求超时")
            _mark_alert_logged(failure)
            raise failure from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in {401, 403}:
                raise SsoTokenInvalidError() from exc
            logger.error(
                "sso_upstream_failed category=http_status status=%s exception_type=%s",
                exc.response.status_code,
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={"trans_api": "sso_user_info", "exception_type": type(exc).__name__},
            )
            failure = SsoUpstreamError("统一认证服务拒绝了登录凭证")
            _mark_alert_logged(failure)
            raise failure from exc
        except (httpx.HTTPError, ValueError) as exc:
            logger.error(
                "sso_upstream_failed category=response exception_type=%s",
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={"trans_api": "sso_user_info", "exception_type": type(exc).__name__},
            )
            failure = SsoUpstreamError()
            _mark_alert_logged(failure)
            raise failure from exc

        profile = _parse_sso_profile(payload, source_system=self.settings.sso_source_system)
        # 映射仅来自部署配置；未知编码仍交由正式目录校验并拒绝。
        profile = replace(profile, org_code=self.settings.sso_org_code_mapping.get(
            profile.org_code, profile.org_code,
        ))
        actor = IntegrationIdentityService(self.uow_factory).resolve(profile)
        if not actor.user_id:
            raise SsoUpstreamError("统一认证服务未返回有效用户")
        return self._create_session(actor.user_id)

    def _create_session(self, user_id: str) -> tuple[str, int, AuthenticatedUser]:
        with self.uow_factory() as uow:
            user = uow.users.get(user_id)
            if user is None:
                raise LoginFailedError()
            if not user.enabled:
                raise UserDisabledError()
            user = uow.users.increment_session_version(user.id, login=True)
            if user is None:
                raise LoginFailedError()
            org_name = _org_name(uow, user.org_code)
            uow.commit()
        authenticated = _authenticated_user(user, org_name)
        token, expires_in = create_access_token(
            settings=self.settings,
            claims={
                "sub": user.id,
                "username": user.username,
                "org_code": user.org_code,
                "role_code": user.role_code,
                "session_version": user.session_version,
                "auth_method": "sso",
            },
        )
        return token, expires_in, authenticated

    def get_user(self, user_id: str) -> AuthenticatedUser | None:
        with self.uow_factory() as uow:
            user = uow.users.get(user_id)
            if user is None:
                return None
            return _authenticated_user(user, _org_name(uow, user.org_code))

    def logout(self, user_id: str) -> None:
        with self.uow_factory() as uow:
            uow.users.increment_session_version(user_id)
            uow.commit()


def _mark_alert_logged(exc: Exception) -> None:
    try:
        exc._ask_metric_alert_logged = True  # type: ignore[attr-defined]
    except Exception:
        pass


def _org_name(uow: SqlAlchemyUnitOfWork, org_code: str) -> str:
    for org in uow.organization_catalog.list_enabled():
        if org.code == org_code:
            return org.name
    return org_code


def _authenticated_user(user, org_name: str) -> AuthenticatedUser:
    return AuthenticatedUser(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        org_code=user.org_code,
        org_name=org_name,
        role_code=user.role_code,
        session_version=user.session_version,
    )


def _parse_sso_profile(payload: object, *, source_system: str) -> ExternalUserProfile:
    if not isinstance(payload, dict):
        raise SsoUpstreamError("统一认证服务返回了无效的登录结果")
    if str(payload.get("code")) != "0":
        raise SsoTokenInvalidError()
    data = payload.get("data")
    if not isinstance(data, dict):
        raise SsoUpstreamError("统一认证服务未返回用户信息")

    org = data.get("org") if isinstance(data.get("org"), dict) else {}
    instu_org = data.get("instuOrg") if isinstance(data.get("instuOrg"), dict) else {}
    department = data.get("dpt") if isinstance(data.get("dpt"), dict) else {}
    user_code = _first_text(data, "userCode", "loginCode")
    login_code = _first_text(data, "loginCode")
    user_name = _first_text(data, "userName", "userCode", "loginCode")
    org_code = _first_text(org, "code", "id") or _first_text(data, "orgCode")
    if not user_code or not user_name or not org_code:
        raise SsoUpstreamError("统一认证服务返回的用户或机构信息不完整")
    return ExternalUserProfile(
        source_system=source_system,
        user_code=user_code,
        login_code=login_code,
        user_name=user_name,
        org_code=org_code,
        org_name=_first_text(org, "name"),
        corpo_code=_first_text(instu_org, "code", "id") or _first_text(data, "corpoId"),
        corpo_name=_first_text(instu_org, "name"),
        dept_code=_first_text(department, "code", "id"),
        dept_name=_first_text(department, "name"),
    )


def _first_text(value: object, *keys: str) -> str | None:
    if not isinstance(value, dict):
        return None
    for key in keys:
        item = value.get(key)
        if item is not None and str(item).strip():
            return str(item).strip()
    return None
