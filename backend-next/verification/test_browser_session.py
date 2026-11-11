"""浏览器会话 Cookie 配置契约；仅使用隔离请求，不访问业务库或模型。"""

from http.cookies import SimpleCookie

import pytest
from fastapi import Depends, FastAPI, Request, Response
from fastapi.testclient import TestClient

from ask_metric.api.browser_session import (
    COOKIE_PATH,
    check_session_opt_in,
    clear_session_cookie,
    require_browser_session_request,
    session_cookie_name,
    set_session_cookie,
)
from ask_metric.core.config import Settings
from ask_metric.core.errors import install_exception_handlers


def session_app(monkeypatch, environment, configured_secure):
    if configured_secure is None:
        monkeypatch.delenv("BROWSER_SESSION_COOKIE_SECURE", raising=False)
    else:
        monkeypatch.setenv("BROWSER_SESSION_COOKIE_SECURE", configured_secure)
    app = FastAPI()
    app.state.settings = Settings(
        _env_file=None,
        app_env=environment,
        jwt_secret="isolated-browser-session-signing-key",
        sm2_private_key="1" * 64,
        log_file_enabled=True,
        log_directory="/tmp/isolated-browser-session-logs",
        model_admin_write_enabled=False,
        model_admin_token_required=True,
        cors_origins=[],
    )
    install_exception_handlers(app)

    @app.post(f"{COOKIE_PATH}/issue", dependencies=[Depends(check_session_opt_in)])
    def issue(request: Request, response: Response):
        set_session_cookie(request, response, "isolated-session-token", 480)
        return {"issued": True}

    @app.post(f"{COOKIE_PATH}/restore", dependencies=[Depends(require_browser_session_request)])
    def restore(request: Request):
        return {
            "restored": request.cookies.get(session_cookie_name(request))
            == "isolated-session-token"
        }

    @app.post(f"{COOKIE_PATH}/clear", dependencies=[Depends(check_session_opt_in)])
    def clear(request: Request, response: Response):
        clear_session_cookie(request, response)
        return {"cleared": True}

    return app


@pytest.mark.parametrize(
    "environment,configured_secure,scheme,name,secure,restored",
    [
        ("production", None, "http", "__Secure-ask_metric_session", True, False),
        ("production", "false", "http", "ask_metric_session", False, True),
        ("production", "false", "https", "__Secure-ask_metric_session", True, True),
        ("production", "true", "http", "__Secure-ask_metric_session", True, False),
        ("development", None, "http", "ask_metric_session_dev", False, True),
        ("test", None, "http", "ask_metric_session_dev", False, True),
        ("development", "false", "https", "__Secure-ask_metric_session", True, True),
        ("test", "true", "http", "__Secure-ask_metric_session", True, False),
    ],
)
def test_session_cookie_transport_and_clear(
    monkeypatch,
    environment,
    configured_secure,
    scheme,
    name,
    secure,
    restored,
):
    app = session_app(monkeypatch, environment, configured_secure)
    origin = f"{scheme}://session.example:8000"
    headers = {"X-Ask-Metric-Session": "1", "Origin": origin, "Sec-Fetch-Site": "same-origin"}
    with TestClient(app, base_url=origin) as client:
        response = client.post(f"{COOKIE_PATH}/issue", headers=headers)
        assert response.status_code == 200
        cookie = SimpleCookie(response.headers["set-cookie"])[name]
        assert cookie.value == "isolated-session-token"
        assert bool(cookie["secure"]) is secure
        assert cookie["httponly"]
        assert cookie["samesite"] == "strict"
        assert cookie["path"] == "/api/v1/auth"
        assert not cookie["domain"]
        assert cookie["max-age"] == "480"
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["pragma"] == "no-cache"
        assert client.post(f"{COOKIE_PATH}/restore", headers=headers).json() == {
            "restored": restored,
        }

        cleared = client.post(f"{COOKIE_PATH}/clear", headers=headers)
        deleted_cookie = SimpleCookie(cleared.headers["set-cookie"])[name]
        assert deleted_cookie["max-age"] == "0"
        assert deleted_cookie["path"] == "/api/v1/auth"
        assert bool(deleted_cookie["secure"]) is secure
        assert deleted_cookie["httponly"]
        assert deleted_cookie["samesite"] == "strict"
        assert client.post(f"{COOKIE_PATH}/restore", headers=headers).json() == {
            "restored": False,
        }


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Ask-Metric-Session": "0"},
        {"X-Ask-Metric-Session": "1", "Origin": "http://other.example:8000"},
        {"X-Ask-Metric-Session": "1", "Origin": "null"},
        {"X-Ask-Metric-Session": "1", "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_production_http_opt_in_keeps_browser_origin_checks(monkeypatch, headers):
    app = session_app(monkeypatch, "production", "false")
    with TestClient(app, base_url="http://session.example:8000") as client:
        response = client.post(f"{COOKIE_PATH}/restore", headers=headers)
        assert response.status_code == 403
        assert response.json()["code"] == "AUTH_SESSION_ORIGIN_INVALID"


def test_api_client_without_browser_opt_in_does_not_receive_cookie(monkeypatch):
    app = session_app(monkeypatch, "production", "false")
    response = TestClient(app).post(f"{COOKIE_PATH}/issue")
    assert response.status_code == 200
    assert "set-cookie" not in response.headers
