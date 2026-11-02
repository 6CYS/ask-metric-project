import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select

from ask_metric.api.dependencies import get_query_execution_service, require_actor
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.api.routes.catalogs import get_uow
from ask_metric.application.data_availability import AvailabilityRequest, execute_availability
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.infrastructure.db.models import MetricTerm, OrgTerm
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

router = APIRouter(prefix="/api/v1", tags=["data-availability"])
logger = logging.getLogger(__name__)


@router.post("/data-availability", dependencies=[Depends(require_query_ready)])
def data_availability(
    spec: AvailabilityRequest,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    execution: Annotated[QueryExecutionApplicationService, Depends(get_query_execution_service)],
):
    with uow:
        metrics = dict(
            uow.session.execute(
                select(MetricTerm.metric_code, MetricTerm.metric_name).where(
                    MetricTerm.enabled.is_(True)
                )
            ).all()
        )
        orgs = dict(
            uow.session.execute(
                select(OrgTerm.org_code, OrgTerm.org_name).where(OrgTerm.enabled.is_(True))
            ).all()
        )
    try:
        return execute_availability(
            spec, actor, execution, request.app.state.settings.query_database_dialect, metrics, orgs
        )
    except PermissionDeniedError as error:
        raise HTTPException(403, "无权查看所选机构的数据覆盖情况") from error
    except (KeyError, FileNotFoundError) as error:
        raise HTTPException(503, "数据覆盖模板尚未部署，请联系管理员") from error
    except ValueError as error:
        raise HTTPException(422, "请确认机构、指标及日期范围有效") from error
    except Exception as error:
        logger.warning("availability_failed exception_type=%s", type(error).__name__)
        raise HTTPException(503, "覆盖查询未完成，请缩小机构、指标或日期范围后重试") from error
