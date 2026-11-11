"""浏览器会话恢复边界：Cookie 只送到认证接口，业务接口仍要求 Bearer。"""

from fastapi import Request, Response

from ask_metric.core.errors import ApplicationError

SESSION_HEADER = "X-Ask-Metric-Session"
COOKIE_PATH = "/api/v1/auth"


def cookie_secure(request: Request) -> bool:
    settings = request.app.state.settings
    secure = settings.browser_session_cookie_secure
    if secure is None:
        # 未显式配置时，生产环境即使位于 TLS 代理后也保持 Secure。
        secure = settings.app_env.lower() not in {"development", "test"}
    return secure or request.url.scheme == "https"


def session_cookie_name(request: Request) -> str:
    if cookie_secure(request):
        return "__Secure-ask_metric_session"
    if request.app.state.settings.app_env.lower() in {"development", "test"}:
        return "ask_metric_session_dev"
    return "ask_metric_session"


def require_browser_session_request(request: Request) -> None:
    """自定义头阻止跨站表单；来源校验及 Strict Cookie 提供额外限制。"""
    origin = request.headers.get("origin")
    allowed_origins = {
        str(request.base_url).rstrip("/"),
        *request.app.state.settings.cors_origins,
    }
    valid_origin = not origin or (
        origin.startswith(("http://", "https://")) and origin in allowed_origins
    )
    if (
        request.headers.get(SESSION_HEADER) != "1"
        or request.headers.get("sec-fetch-site", "same-origin") != "same-origin"
        or not valid_origin
    ):
        raise ApplicationError(
            "AUTH_SESSION_ORIGIN_INVALID", "会话请求来源无效", status_code=403,
        )


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def set_session_cookie(request: Request, response: Response, token: str, expires_in: int) -> None:
    no_store(response)
    # 原有 API 客户端继续取得 Bearer；只有浏览器显式申请时才创建 Cookie。
    if request.headers.get(SESSION_HEADER) != "1":
        return
    response.set_cookie(
        session_cookie_name(request), token, max_age=expires_in,
        path=COOKIE_PATH, secure=cookie_secure(request), httponly=True, samesite="strict",
    )


def clear_session_cookie(request: Request, response: Response) -> None:
    no_store(response)
    response.delete_cookie(
        session_cookie_name(request), path=COOKIE_PATH,
        secure=cookie_secure(request), httponly=True, samesite="strict",
    )


def check_session_opt_in(request: Request) -> None:
    if SESSION_HEADER.lower() in request.headers:
        require_browser_session_request(request)
