from fastapi import APIRouter

from ask_metric.api.routes.analysis import router as analysis_router
from ask_metric.api.routes.auth import router as auth_router
from ask_metric.api.routes.availability import router as availability_router
from ask_metric.api.routes.business_context import router as business_context_router
from ask_metric.api.routes.business_knowledge import router as business_knowledge_router
from ask_metric.api.routes.business_overview import router as business_overview_router
from ask_metric.api.routes.catalogs import router as catalogs_router
from ask_metric.api.routes.health import router as health_router
from ask_metric.api.routes.logging_admin import router as logging_router
from ask_metric.api.routes.model_config import router as model_config_router
from ask_metric.api.routes.tasks import router as tasks_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(analysis_router)
api_router.include_router(business_context_router)
api_router.include_router(business_knowledge_router)
api_router.include_router(business_overview_router)
api_router.include_router(availability_router)
api_router.include_router(catalogs_router)
api_router.include_router(tasks_router)
api_router.include_router(logging_router)
api_router.include_router(model_config_router)
