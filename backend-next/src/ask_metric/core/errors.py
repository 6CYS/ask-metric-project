import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ask_metric.core.request_context import get_request_id

logger = logging.getLogger(__name__)

# 校验错误 details 允许透传的约束白名单；input 等含原始值的键永不外泄
_SAFE_CONSTRAINT_KEYS = frozenset({
    "pattern", "min_length", "max_length", "ge", "gt", "le", "lt",
    "min_items", "max_items", "max_digits", "decimal_places",
})


class ErrorResponse(BaseModel):
    code: str
    message: str
    request_id: str
    details: Any | None = None


class ApplicationError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        details: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(request: Request, exc: RequestValidationError):
        # 校验错误与领域错误共用同一信封，调用方只需一种解析路径。
        # 脱敏边界：只暴露字段路径与约束白名单，绝不回显输入值（含登录/SSO 秘密）。
        fields = []
        for error in exc.errors():
            loc = [str(part) for part in error.get("loc", ()) if part != "body"]
            ctx = error.get("ctx") or {}
            expected = {key: value for key, value in ctx.items() if key in _SAFE_CONSTRAINT_KEYS}
            fields.append({
                "path": ".".join(loc) or "root",
                "rule": str(error.get("type", "")),
                **({"expected": expected} if expected else {}),
            })
        body = ErrorResponse(
            code="REQUEST_INVALID",
            message="请求参数未通过校验。",
            request_id=get_request_id(),
            details={"fields": fields},
        )
        return JSONResponse(status_code=422, content=body.model_dump())

    @app.exception_handler(ApplicationError)
    async def handle_application_error(request: Request, exc: ApplicationError) -> JSONResponse:
        request.state.summary_res_code = (
            "999999" if _contains_timeout(exc) else f"{exc.status_code:06d}"[-6:]
        )
        request.state.summary_res_des = exc.message
        if not getattr(exc, "_ask_metric_alert_logged", False):
            logger.warning(
                "application_error code=%s exception_type=%s",
                exc.code,
                type(exc).__name__,
                extra={
                    "error_code": exc.code,
                    "exception_type": type(exc).__name__,
                    "trans_api": request.url.path,
                },
            )
        body = ErrorResponse(
            code=exc.code,
            message=exc.message,
            request_id=get_request_id(),
            details=exc.details,
        )
        return JSONResponse(status_code=exc.status_code, content=body.model_dump())

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        request.state.summary_res_code = "999999" if _contains_timeout(exc) else "999998"
        request.state.summary_res_des = (
            "Timeout" if _contains_timeout(exc) else "Internal server error"
        )
        if not getattr(exc, "_ask_metric_alert_logged", False):
            logger.error(
                "unexpected_error exception_type=%s",
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={
                    "error_code": "INTERNAL_SERVER_ERROR",
                    "exception_type": type(exc).__name__,
                    "trans_api": request.url.path,
                },
            )
        body = ErrorResponse(
            code="INTERNAL_SERVER_ERROR",
            message="Internal server error",
            request_id=get_request_id(),
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=body.model_dump(),
        )


def _contains_timeout(exc: BaseException) -> bool:
    cursor: BaseException | None = exc
    while cursor is not None:
        if "timeout" in type(cursor).__name__.lower():
            return True
        cursor = cursor.__cause__ or cursor.__context__
    return False
