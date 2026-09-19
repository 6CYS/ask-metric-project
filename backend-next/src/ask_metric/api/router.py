from fastapi import APIRouter

from ask_metric.api.routes.auth import router as auth_router
from ask_metric.api.routes.availability import router as availability_router
from ask_metric.api.routes.catalogs import router as catalogs_router
from ask_metric.api.routes.health import router as health_router
from ask_metric.api.routes.integrations import router as integrations_router
from ask_metric.api.routes.logging_admin import router as logging_router
from ask_metric.api.routes.model_config import router as model_config_router
from ask_metric.api.routes.tasks import router as tasks_router
from ask_metric.api.routes.test_center import router as test_center_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(availability_router)
api_router.include_router(catalogs_router)
api_router.include_router(tasks_router)
api_router.include_router(integrations_router)
api_router.include_router(logging_router)
api_router.include_router(model_config_router)
api_router.include_router(test_center_router)
