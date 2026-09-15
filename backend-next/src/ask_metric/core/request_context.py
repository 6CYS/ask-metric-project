from __future__ import annotations

import logging
import os
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace
from datetime import datetime
from re import compile as compile_pattern
from time import perf_counter, time_ns
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
_GLOBAL_TRACK_PATTERN = compile_pattern(r"^G\d{14}[A-Za-z0-9]{7}\d{18}$")
_SPAN_ID_PATTERN = compile_pattern(r"^R\d{14}[A-Za-z0-9]{7}\d{18}$")
_SERVICE_CALL_PATTERN = compile_pattern(r"^[A-Za-z0-9._:-]{1,32}$")
_APM_ID_PATTERN = compile_pattern(r"^[A-Za-z0-9._:-]{1,128}$")
_SERVICE_CODE_PATTERN = compile_pattern(r"^[A-Za-z0-9._:-]{1,16}$")

_request_id: ContextVar[str] = ContextVar("request_id", default="-")


@dataclass(frozen=True, slots=True)
class FlowIdConfig:
    """行内40位流水号所需的节点字段；缺省值来自流水号规范。"""

    app_node_code: str = "8888888"
    app_idc: str = "888"
    app_unit: str = "8"
    instance_ip: str = ""


class FlowIdGenerator:
    """生成 G/R + 时间 + 节点 + 机器 + 实例 + 微秒的40位流水号。"""

    def __init__(self, config: FlowIdConfig) -> None:
        self._app_node_code = config.app_node_code
        self._machine_code = f"{config.app_idc}{config.app_unit}{_ip_suffix(config.instance_ip)}"
        self._lock = threading.Lock()
        self._last_epoch_microsecond = 0

    def generate(self, prefix: str) -> str:
        if prefix not in {"G", "R"}:
            raise ValueError("Flow ID prefix must be G or R")
        # 同一进程内强制微秒单调递增，避免高并发时生成相同流水号。
        with self._lock:
            current = time_ns() // 1_000
            current = max(current, self._last_epoch_microsecond + 1)
            self._last_epoch_microsecond = current
        epoch_seconds, microsecond = divmod(current, 1_000_000)
        timestamp = datetime.fromtimestamp(epoch_seconds).astimezone().replace(
            microsecond=microsecond
        )
        instance_number = getattr(threading, "get_native_id", os.getpid)()
        return (
            f"{prefix}{timestamp:%Y%m%d%H%M%S}{self._app_node_code}{self._machine_code}"
            f"{instance_number % 100_000:05d}{timestamp.microsecond:06d}"
        )


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
_flow_id_generator: ContextVar[FlowIdGenerator | None] = ContextVar(
    "flow_id_generator", default=None
)


def get_request_id() -> str:
    return _request_id.get()


def get_log_context() -> LogContext:
    return _log_context.get() or LogContext()


def normalize_request_id(value: str | None) -> str:
    candidate = (value or "").strip()
    if candidate and _REQUEST_ID_PATTERN.fullmatch(candidate):
        return candidate
    return str(uuid4())


def _normalize_global_track(value: str | None, generator: FlowIdGenerator) -> str:
    candidate = (value or "").strip()
    return candidate if _GLOBAL_TRACK_PATTERN.fullmatch(candidate) else generator.generate("G")


def _normalize_span_id(value: str | None, generator: FlowIdGenerator) -> str:
    candidate = (value or "").strip()
    return candidate if _SPAN_ID_PATTERN.fullmatch(candidate) else generator.generate("R")


def _normalize_parent_span_id(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if _SPAN_ID_PATTERN.fullmatch(candidate) else "-"


def _normalize_service_call(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if _SERVICE_CALL_PATTERN.fullmatch(candidate) else uuid4().hex


def _normalize_apm_id(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if _APM_ID_PATTERN.fullmatch(candidate) else "-"


def _normalize_service_code(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if _SERVICE_CODE_PATTERN.fullmatch(candidate) else "-"


def _local_timestamp() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S:%f")[:-3]


def _ip_suffix(configured_ip: str) -> str:
    candidates = [configured_ip]
    try:
        candidates.extend(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    for value in candidates:
        parts = value.strip().split(".")
        if len(parts) == 4 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts):
            return f"{int(parts[-1]):03d}"
    return "000"


def _summary_response_code(status_code: int | None, exc: BaseException | None = None) -> str:
    if _is_timeout(exc) or status_code in {408, 504}:
        return "999999"
    if exc is not None:
        return "999998"
    if status_code is None:
        return "999998"
    if status_code < 400:
        return "000000"
    return f"{status_code:06d}"[-6:]


def _is_timeout(exc: BaseException | None) -> bool:
    cursor = exc
    while cursor is not None:
        if "timeout" in type(cursor).__name__.lower():
            return True
        cursor = cursor.__cause__ or cursor.__context__
    return False


@dataclass(slots=True)
class OutboundTransaction:
    context: LogContext
    parent_span_id: str
    trans_api: str
    invoke_sys: str
    status_code: int | None = None

    def set_response(self, status_code: int) -> None:
        self.status_code = status_code

    def headers(self) -> dict[str, str]:
        values = {
            GLOBAL_TRACK_HEADER: self.context.global_business_track_no,
            SERVICE_CALL_HEADER: self.context.service_call_seq_no,
            SPAN_ID_HEADER: self.context.span_id,
            PARENT_SPAN_ID_HEADER: self.parent_span_id,
            SERVICE_CODE_HEADER: self.context.service_code,
            TRACE_ID_HEADER: self.context.trace_id,
            SEGMENT_ID_HEADER: self.context.segment_id,
        }
        return {name: value for name, value in values.items() if value != "-"}


@contextmanager
def outbound_subtransaction(trans_api: str, *, invoke_sys: str) -> Iterator[OutboundTransaction]:
    """为一次下游请求生成新SpanID，透传TraceID并成对打印子交易摘要。"""

    parent = get_log_context()
    generator = _flow_id_generator.get() or FlowIdGenerator(FlowIdConfig())
    parent_span_id = parent.span_id if _SPAN_ID_PATTERN.fullmatch(parent.span_id) else "-"
    global_track = (
        parent.global_business_track_no
        if _GLOBAL_TRACK_PATTERN.fullmatch(parent.global_business_track_no)
        else generator.generate("G")
    )
    context = replace(
        parent,
        global_business_track_no=global_track,
        service_call_seq_no=uuid4().hex,
        span_id=generator.generate("R"),
        parent_span_id=parent_span_id,
    )
    token = _log_context.set(context)
    transaction = OutboundTransaction(context, parent_span_id, trans_api, invoke_sys)
    started_at = _local_timestamp()
    started = perf_counter()
    summary_logger = logging.getLogger("ask_metric.summary")
    summary_logger.info(
        "subtransaction_start",
        extra={"label": "SUBSTART", "parent_span_id": parent_span_id, "trans_api": trans_api},
    )
    error: BaseException | None = None
    try:
        yield transaction
    except BaseException as exc:
        error = exc
        raise
    finally:
        rescode = _summary_response_code(transaction.status_code, error)
        summary_logger.info(
            "subtransaction_end",
            extra={
                "label": "SUBEND",
                "parent_span_id": parent_span_id,
                "trans_api": trans_api,
                "starttime": started_at,
                "endtime": _local_timestamp(),
                "rescode": rescode,
                "resdes": _summary_description(rescode, transaction.status_code, error),
                "usetime": f"{round((perf_counter() - started) * 1000)}ms",
                "invokesys": invoke_sys,
            },
        )
        _log_context.reset(token)


def _summary_description(
    rescode: str, status_code: int | None, exc: BaseException | None
) -> str:
    if rescode == "000000":
        return "Success"
    if rescode == "999999":
        return "Timeout"
    if status_code is not None:
        return f"HTTP {status_code}"
    return type(exc).__name__ if exc is not None else "Failed"


class RequestIdMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, flow_id_config: FlowIdConfig | None = None) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self._generator = FlowIdGenerator(flow_id_config or FlowIdConfig())

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = normalize_request_id(request.headers.get(REQUEST_ID_HEADER))
        global_track = _normalize_global_track(
            request.headers.get(GLOBAL_TRACK_HEADER), self._generator
        )
        service_call = _normalize_service_call(request.headers.get(SERVICE_CALL_HEADER))
        span_id = _normalize_span_id(request.headers.get(SPAN_ID_HEADER), self._generator)
        parent_span_id = _normalize_parent_span_id(request.headers.get(PARENT_SPAN_ID_HEADER))
        context = LogContext(
            global_business_track_no=global_track,
            service_call_seq_no=service_call,
            service_code=_normalize_service_code(request.headers.get(SERVICE_CODE_HEADER)),
            trace_id=_normalize_apm_id(request.headers.get(TRACE_ID_HEADER)),
            segment_id=_normalize_apm_id(request.headers.get(SEGMENT_ID_HEADER)),
            span_id=span_id,
            parent_span_id=parent_span_id,
        )
        request_token: Token[str] = _request_id.set(request_id)
        context_token: Token[LogContext | None] = _log_context.set(context)
        generator_token: Token[FlowIdGenerator | None] = _flow_id_generator.set(self._generator)
        request.state.request_id = request_id
        request.state.log_context = context
        trans_api = request.url.path
        started_at = _local_timestamp()
        started = perf_counter()
        summary_logger = logging.getLogger("ask_metric.summary")
        summary_logger.info(
            "transaction_start",
            extra={"label": "START", "parent_span_id": parent_span_id, "trans_api": trans_api},
        )
        try:
            response = await call_next(request)
            response.headers[REQUEST_ID_HEADER] = request_id
            response.headers[GLOBAL_TRACK_HEADER] = global_track
            response.headers[SERVICE_CALL_HEADER] = service_call
            response.headers[TRACE_ID_HEADER] = context.trace_id
            response.headers[SEGMENT_ID_HEADER] = context.segment_id
            response.headers[SPAN_ID_HEADER] = span_id
            status_code = response.status_code
            rescode = getattr(request.state, "summary_res_code", None) or _summary_response_code(
                status_code
            )
            resdes = getattr(request.state, "summary_res_des", None) or _summary_description(
                rescode, status_code, None
            )
            summary_logger.info(
                "transaction_end",
                extra={
                    "label": "END",
                    "parent_span_id": parent_span_id,
                    "trans_api": trans_api,
                    "starttime": started_at,
                    "endtime": _local_timestamp(),
                    "rescode": rescode,
                    "resdes": resdes,
                    "usetime": f"{round((perf_counter() - started) * 1000)}ms",
                },
            )
            return response
        except Exception as exc:
            logging.getLogger("ask_metric.alert").error(
                "http_request_failed method=%s path=%s exception_type=%s",
                request.method,
                trans_api,
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={"trans_api": trans_api, "exception_type": type(exc).__name__},
            )
            try:
                exc._ask_metric_alert_logged = True  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover - defensive for immutable exception types
                pass
            rescode = _summary_response_code(None, exc)
            summary_logger.info(
                "transaction_end",
                extra={
                    "label": "END",
                    "parent_span_id": parent_span_id,
                    "trans_api": trans_api,
                    "starttime": started_at,
                    "endtime": _local_timestamp(),
                    "rescode": rescode,
                    "resdes": _summary_description(rescode, None, exc),
                    "usetime": f"{round((perf_counter() - started) * 1000)}ms",
                },
            )
            raise
        finally:
            _flow_id_generator.reset(generator_token)
            _log_context.reset(context_token)
            _request_id.reset(request_token)
