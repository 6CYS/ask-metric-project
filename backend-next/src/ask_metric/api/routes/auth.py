from time import time
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field

from ask_metric.api.browser_session import (
    check_session_opt_in,
    clear_session_cookie,
    no_store,
    require_browser_session_request,
    session_cookie_name,
    set_session_cookie,
)
from ask_metric.api.dependencies import (
    authenticate_access_token,
    get_authentication_service,
    require_actor,
)
from ask_metric.application.auth_service import AuthenticatedUser, AuthenticationService
from ask_metric.application.requests import ActorContext
from ask_metric.core.security import AuthenticationError, decode_access_token

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginRequest(BaseModel):
    """登录请求：密码链路使用国密加密。

    - ``encrypted_key``：SM2 公钥（C1C3C2）加密的一次性 SM4 密钥，hex；
    - ``iv``：SM4-CBC 初始向量，hex；
    - ``password``：SM4-CBC/PKCS7 加密后的密码密文，hex。
    """

    username: str = Field(min_length=1, max_length=64)
    encrypted_key: str = Field(
        default=...,
        strict=True,
        repr=False,
        min_length=256,
        max_length=256,
        pattern=r"^[0-9A-Fa-f]{256}$",
    )
    iv: str = Field(pattern=r"^[0-9A-Fa-f]{32}$")
    password: str = Field(
        default=...,
        strict=True,
        repr=False,
        min_length=32,
        max_length=4096,
        pattern=r"^(?:[0-9A-Fa-f]{32}){1,128}$",
    )


class Sm2PublicKeyResponse(BaseModel):
    public_key: str


class SsoLoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    org_code: str
    org_name: str
    role_code: str
    can_query_all_organizations: bool = False


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse


def _response(user: AuthenticatedUser) -> UserResponse:
    return UserResponse(**{key: getattr(user, key) for key in UserResponse.model_fields})


@router.get("/sm2-public-key", response_model=Sm2PublicKeyResponse)
def sm2_public_key(
    service: Annotated[AuthenticationService, Depends(get_authentication_service)],
) -> Sm2PublicKeyResponse:
    return Sm2PublicKeyResponse(public_key=service.sm2_public_key())


@router.post("/login", response_model=LoginResponse, dependencies=[Depends(check_session_opt_in)])
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    service: Annotated[AuthenticationService, Depends(get_authentication_service)],
) -> LoginResponse:
    password = service.decrypt_login_password(
        payload.encrypted_key, payload.iv, payload.password
    )
    token, expires_in, user = service.login(payload.username.strip(), password)
    set_session_cookie(request, response, token, expires_in)
    return LoginResponse(access_token=token, expires_in=expires_in, user=_response(user))


@router.post("/sso", response_model=LoginResponse, dependencies=[Depends(check_session_opt_in)])
def sso_login(
    payload: SsoLoginRequest,
    request: Request,
    response: Response,
    service: Annotated[AuthenticationService, Depends(get_authentication_service)],
) -> LoginResponse:
    token, expires_in, user = service.login_sso(payload.token.strip())
    set_session_cookie(request, response, token, expires_in)
    return LoginResponse(access_token=token, expires_in=expires_in, user=_response(user))


@router.post(
    "/session", response_model=LoginResponse,
    dependencies=[Depends(require_browser_session_request)],
)
def restore_session(
    request: Request,
    response: Response,
    service: Annotated[AuthenticationService, Depends(get_authentication_service)],
) -> LoginResponse:
    """恢复原令牌，不签发新令牌、不续期，也不改变单账号会话版本。"""
    token = request.cookies.get(session_cookie_name(request))
    if not token:
        raise AuthenticationError("AUTH_TOKEN_INVALID", "请先登录")
    actor = authenticate_access_token(request, token)
    claims = decode_access_token(token, request.app.state.settings)
    expires_in = int(claims["exp"] - time())
    if expires_in <= 0:
        raise AuthenticationError("AUTH_TOKEN_EXPIRED", "登录已过期，请重新登录")
    user = service.get_user(actor.user_id or "")
    if user is None:
        raise AuthenticationError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录")
    no_store(response)
    return LoginResponse(access_token=token, expires_in=expires_in, user=_response(user))


@router.get("/me", response_model=UserResponse)
def me(
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[AuthenticationService, Depends(get_authentication_service)],
) -> UserResponse:
    user = service.get_user(actor.user_id or "")
    if user is None:
        raise AuthenticationError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录")
    return _response(user)


@router.post(
    "/logout", status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(check_session_opt_in)],
)
def logout(
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    service: Annotated[AuthenticationService, Depends(get_authentication_service)],
) -> Response:
    service.logout(actor.user_id or "")
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookie(request, response)
    return response
