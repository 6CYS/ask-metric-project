import logging
from contextvars import ContextVar, Token
from dataclasses import dataclass
from datetime import datetime
from re import compile as compile_pattern
from time import perf_counter
from uuid import uuid4

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

REQUEST_ID_HEADER = "X-Request-ID"
GLOBAL_TRACK_HEADER = "X-Global-Business-Track-No"
SERVICE_CALL_HEADER = "X-Service-Call-Seq-No"
SERVICE_CODE_HEADER = "X-Service-Code"
TRACE_ID_HEADER = "X-Trace-ID"
SEGMENT_ID_HEADER = "X-Segment-ID"
SPAN_ID_HEADER = "X-Span-ID"
PARENT_SPAN_ID_HEADER = "X-Parent-Span-ID"
_REQUEST_ID_PATTERN = compile_pattern(r"^[A-Za-z0-9._:-]{1,128}$")
_TRACK_ID_PATTERN = compile_pattern(r"^[A-Za-z0-9._:-]{1,32}$")
_SERVICE_CODE_PATTERN = compile_pattern(r"^[A-Za-z0-9._:-]{1,16}$")
_request_id: ContextVar[str] = ContextVar("request_id", default="-")


@dataclass(frozen=True, slots=True)
class LogContext:
    global_business_track_no: str = "-"
    service_call_seq_no: str = "-"
    service_code: str = "-"
    trace_id: str = "-"
    segment_id: str = "-"
    span_id: str = "-"
    parent_span_id: str = "-"


_log_context: ContextVar[LogContext | None] = ContextVar("log_context", default=None)


def get_request_id() -> str:
    return _request_id.get()


def get_log_context() -> LogContext:
    return _log_context.get() or LogContext()


def normalize_request_id(value: str | None) -> str:
    candidate = (value or "").strip()
    if candidate and _REQUEST_ID_PATTERN.fullmatch(candidate):
        return candidate
    return str(uuid4())


def _normalize_track_id(value: str | None, *, fallback: str | None = None) -> str:
    candidate = (value or "").strip()
    if candidate and _TRACK_ID_PATTERN.fullmatch(candidate):
        return candidate
    return fallback or uuid4().hex


def _normalize_service_code(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if _SERVICE_CODE_PATTERN.fullmatch(candidate) else "-"


def _local_timestamp() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S:%f")[:-3]


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = normalize_request_id(request.headers.get(REQUEST_ID_HEADER))
        global_track = _normalize_track_id(request.headers.get(GLOBAL_TRACK_HEADER))
        service_call = _normalize_track_id(request.headers.get(SERVICE_CALL_HEADER))
        trace_id = _normalize_track_id(request.headers.get(TRACE_ID_HEADER), fallback=global_track)
        segment_id = _normalize_track_id(request.headers.get(SEGMENT_ID_HEADER))
        span_id = _normalize_track_id(request.headers.get(SPAN_ID_HEADER))
        parent_span_id = _normalize_track_id(
            request.headers.get(PARENT_SPAN_ID_HEADER), fallback="-"
        )
        context = LogContext(
            global_business_track_no=global_track,
            service_call_seq_no=service_call,
            service_code=_normalize_service_code(request.headers.get(SERVICE_CODE_HEADER)),
            trace_id=trace_id,
            segment_id=segment_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
        )
        request_token: Token[str] = _request_id.set(request_id)
        context_token: Token[LogContext | None] = _log_context.set(context)
        request.state.request_id = request_id
        request.state.log_context = context
        trans_api = request.url.path
        started_at = _local_timestamp()
        started = perf_counter()
        summary_logger = logging.getLogger("ask_metric.summary")
        summary_logger.info(
            "transaction_start",
            extra={
                "label": "START",
                "parent_span_id": parent_span_id,
                "trans_api": trans_api,
                "starttime": started_at,
                "other": {"method": request.method, "request_id": request_id},
            },
        )
        try:
            response = await call_next(request)
            response.headers[REQUEST_ID_HEADER] = request_id
            response.headers[GLOBAL_TRACK_HEADER] = global_track
            response.headers[SERVICE_CALL_HEADER] = service_call
            response.headers[TRACE_ID_HEADER] = trace_id
            response.headers[SEGMENT_ID_HEADER] = segment_id
            response.headers[SPAN_ID_HEADER] = span_id
            status_code = response.status_code
            summary_logger.info(
                "transaction_end",
                extra={
                    "label": "END",
                    "parent_span_id": parent_span_id,
                    "trans_api": trans_api,
                    "starttime": started_at,
                    "endtime": _local_timestamp(),
                    "rescode": "000000" if status_code < 400 else f"{status_code:06d}",
                    "resdes": "Success" if status_code < 400 else f"HTTP {status_code}",
                    "usetime": f"{round((perf_counter() - started) * 1000)}ms",
                    "other": {
                        "method": request.method,
                        "request_id": request_id,
                        "http_status": status_code,
                    },
                },
            )
            return response
        except Exception as exc:
            logging.getLogger("ask_metric.alert").error(
                "http_request_failed method=%s path=%s exception_type=%s",
                request.method,
                trans_api,
                type(exc).__name__,
                extra={"trans_api": trans_api, "exception_type": type(exc).__name__},
            )
            try:
                exc._ask_metric_alert_logged = True  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover - defensive for immutable exception types
                pass
            summary_logger.info(
                "transaction_end",
                extra={
                    "label": "END",
                    "parent_span_id": parent_span_id,
                    "trans_api": trans_api,
                    "starttime": started_at,
                    "endtime": _local_timestamp(),
                    "rescode": "999998",
                    "resdes": "Unhandled server error",
                    "usetime": f"{round((perf_counter() - started) * 1000)}ms",
                    "other": {"method": request.method, "request_id": request_id},
                },
            )
            raise
        finally:
            _log_context.reset(context_token)
            _request_id.reset(request_token)
