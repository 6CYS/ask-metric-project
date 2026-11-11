from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.model_config import router
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import install_exception_handlers


@pytest.mark.parametrize(
    "role,enabled,required,token,status",
    [
        ("USER", True, False, "", 403),
        ("SYSTEM_ADMIN", False, False, "", 403),
        ("SYSTEM_ADMIN", True, True, "", 401),
        ("SYSTEM_ADMIN", True, True, "wrong", 401),
        ("SYSTEM_ADMIN", True, True, "isolated-token", 200),
        ("SYSTEM_ADMIN", True, False, "", 200),
    ],
)
def test_skill_write_uses_existing_config_authorization(role, enabled, required, token, status):
    app = FastAPI()
    app.state.settings = SimpleNamespace(
        model_admin_write_enabled=enabled,
        model_admin_token_required=required,
        model_admin_token="isolated-token",
    )
    app.include_router(router)
    install_exception_handlers(app)
    actor = ActorContext(
        subject="isolated",
        role_code=role,
        authentication_method="test",
        trust_level="authenticated",
    )
    app.dependency_overrides[require_actor] = lambda: actor
    response = TestClient(app).post(
        "/api/v1/model-config/authorize-write", headers={"X-Model-Admin-Token": token}
    )
    assert response.status_code == status
    if status == 200:
        assert response.json() == {"authorized": True}
