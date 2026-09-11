from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from jwt import ExpiredSignatureError, InvalidTokenError
from pwdlib import PasswordHash
from pwdlib.exceptions import PwdlibError

from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.core.gm_crypto import (
    PASSWORD_SCHEME_SM3,
    hash_password_sm3,
    verify_password_sm3,
)

password_hash = PasswordHash.recommended()


class AuthenticationError(ApplicationError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, status_code=401)


def hash_password(password: str) -> str:
    """新密码一律使用国密 SM3 加盐哈希存储。"""
    return hash_password_sm3(password)


def verify_password(password: str, encoded: str) -> bool:
    # sm3$ 前缀为国密存储；其余按历史 argon2 哈希校验，用于存量账号透明迁移。
    if encoded.startswith(f"{PASSWORD_SCHEME_SM3}$"):
        return verify_password_sm3(password, encoded)
    try:
        return password_hash.verify(password, encoded)
    except (PwdlibError, ValueError, TypeError):
        # 库里哈希串损坏或格式未知时按校验失败处理，不应抛出 500。
        return False


def needs_password_rehash(encoded: str) -> bool:
    return not encoded.startswith(f"{PASSWORD_SCHEME_SM3}$")


def create_access_token(*, settings: Settings, claims: dict[str, Any]) -> tuple[str, int]:
    _require_signing_key(settings.jwt_secret)
    now = datetime.now(UTC)
    expires = now + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        **claims,
        "iat": now,
        "exp": expires,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, int((expires - now).total_seconds())


def decode_access_token(token: str, settings: Settings) -> dict[str, Any]:
    _require_signing_key(settings.jwt_secret)
    try:
        return jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            issuer=settings.jwt_issuer,
            audience=settings.jwt_audience,
            options={"require": ["sub", "exp", "iat", "iss", "aud", "session_version"]},
        )
    except ExpiredSignatureError as exc:
        raise AuthenticationError("AUTH_TOKEN_EXPIRED", "登录已过期，请重新登录") from exc
    except InvalidTokenError as exc:
        raise AuthenticationError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录") from exc


def _require_signing_key(key: str) -> None:
    if not isinstance(key, str) or not key.strip():
        raise ApplicationError("AUTH_CONFIGURATION_INVALID", "认证配置不可用", status_code=503)
