from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from logging.handlers import BaseRotatingHandler
from pathlib import Path
from threading import RLock
from typing import Any

from ask_metric.core.request_context import get_log_context, get_request_id

SUMMARY_LOGGER_NAME = "ask_metric.summary"
DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024
DEFAULT_LOG_MAX_LINE_BYTES = 200 * 1024


def _redact_sensitive(message: str) -> str:
    """日志落盘前统一脱敏，异常链中的连接地址也使用同一规则。"""

    message = re.sub(
        r'''(?i)(authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer\s+)?[^\s,;}]+)''',
        r"\1[REDACTED]", message,
    )
    message = re.sub(
        r'''(?i)((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|'''
        r'''private[_-]?key|client[_-]?secret|jwt[_-]?secret)["']?\s*[:=]\s*)'''
        r'''(?:"[^"]*"|'[^']*'|[^\s,;}]+)''',
        r"\1[REDACTED]", message,
    )
    message = re.sub(r"(\w+://)[^/\s@]+@", r"\1[REDACTED]@", message)
    return message


def _safe_message(record: logging.LogRecord) -> str:
    message = record.getMessage()
    # 保留异常链的定位帧，不输出异常正文、源码行或局部变量；这些内容可能含业务数据。
    if record.exc_info and record.exc_info[0]:
        error = record.exc_info[1]
        traceback = record.exc_info[2]
        seen: set[int] = set()
        while error is not None and id(error) not in seen:
            seen.add(id(error))
            message += f" | exception_type={type(error).__name__}"
            while traceback is not None:
                code = traceback.tb_frame.f_code
                message += f" | File {code.co_filename}:{traceback.tb_lineno} in {code.co_name}"
                traceback = traceback.tb_next
            error = error.__cause__ or (
                error.__context__ if not error.__suppress_context__ else None
            )
            traceback = error.__traceback__ if error is not None else None
    return _redact_sensitive(message)


@dataclass(frozen=True, slots=True)
class LoggingConfig:
    level: str
    application_name: str
    data_center_id: str = "-"
    zone_id: str = "-"
    directory: Path = Path("/home/appuser/log")
    file_enabled: bool = False
    console_enabled: bool = True
    max_bytes: int = DEFAULT_LOG_MAX_BYTES
    retention_days: int = 3
    max_line_bytes: int = DEFAULT_LOG_MAX_LINE_BYTES


def _clean_field(value: Any) -> str:
    text = "-" if value is None or value == "" else str(value)
    normalized = " ".join(text.replace("\x00", "").splitlines()) or "-"
    return normalized.replace("[", "\\[").replace("]", "\\]")


def _timestamp() -> str:
    # The bank pattern requires millisecond precision without a timezone suffix.
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S:%f")[:-3]


def _limit_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    suffix = " ...[truncated]"
    budget = max(0, max_bytes - len(suffix.encode("utf-8")))
    return encoded[:budget].decode("utf-8", errors="ignore") + suffix


class BankApplicationFormatter(logging.Formatter):
    def __init__(self, config: LoggingConfig) -> None:
        super().__init__()
        self.config = config

    def format(self, record: logging.LogRecord) -> str:
        context = get_log_context()
        message = _safe_message(record)
        values = (
            _timestamp(),
            f"{record.levelname:<5}",
            self.config.data_center_id,
            self.config.zone_id,
            self.config.application_name,
            context.global_business_track_no,
            context.service_call_seq_no,
            context.service_code,
            context.trace_id,
            context.segment_id,
            context.span_id,
            record.process,
            record.threadName,
            f"{record.name}:{record.lineno}",
            message,
        )
        line = " ".join(f"[{_clean_field(value)}]" for value in values)
        return _limit_utf8(line, self.config.max_line_bytes)


class BankSummaryFormatter(logging.Formatter):
    def __init__(self, config: LoggingConfig) -> None:
        super().__init__()
        self.config = config

    def format(self, record: logging.LogRecord) -> str:
        context = get_log_context()
        label = getattr(record, "label", "-")
        payload: dict[str, Any] = {
            "TimeStamp": _timestamp(),
            "Label": label,
            "TraceID": context.global_business_track_no,
            "ParentSpanID": getattr(record, "parent_span_id", "-"),
            "SpanID": context.span_id,
            "TransID": get_request_id(),
            "TransAPI": getattr(record, "trans_api", context.service_code),
        }
        if label in {"END", "SUBEND"}:
            for key, default in (
                ("StartTime", "-"),
                ("EndTime", "-"),
                ("ResCode", "-"),
                ("ResDes", "-"),
                ("UseTime", "-"),
                ("InvokeSys", self.config.application_name),
                ("Amount", "-"),
                ("OrgID", "-"),
                ("ChnlID", "HTTP"),
                ("TellerID", "-"),
            ):
                payload[key] = getattr(record, key.lower(), default)
            payload.update({
                "trace_id": context.trace_id,
                "segment_id": context.segment_id,
                "span_id": context.span_id,
                "Other": getattr(record, "other", {}),
            })
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
        if len(line.encode("utf-8")) > self.config.max_line_bytes:
            if "Other" in payload:
                payload["Other"] = {"truncated": True}
            if "ResDes" in payload:
                payload["ResDes"] = _limit_utf8(str(payload["ResDes"]), 4096)
            line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
        return _limit_utf8(line, self.config.max_line_bytes)


class BankAlertFormatter(logging.Formatter):
    def __init__(self, config: LoggingConfig) -> None:
        super().__init__()
        self.config = config

    def format(self, record: logging.LogRecord) -> str:
        context = get_log_context()
        message = _safe_message(record)
        values = (
            _timestamp(),
            f"{record.levelname:<5}",
            context.global_business_track_no,
            get_request_id(),
            getattr(record, "trans_api", context.service_code),
            message,
        )
        line = " ".join(f"[{_clean_field(value)}]" for value in values)
        return _limit_utf8(line, self.config.max_line_bytes)


class DailySizeRotatingFileHandler(BaseRotatingHandler):
    """Roll a UTF-8 log by size or day into a physical date directory."""

    def __init__(
        self,
        filename: Path,
        *,
        max_bytes: int,
        retention_days: int,
    ) -> None:
        cursor = filename.parent
        while cursor != cursor.parent:
            if cursor.exists() and cursor.is_symlink():
                raise ValueError(f"Log directory must not use symbolic links: {cursor}")
            cursor = cursor.parent
        filename.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        super().__init__(str(filename), mode="a", encoding="utf-8", delay=False)
        self.max_bytes = max_bytes
        self.retention_days = retention_days
        active = Path(self.baseFilename)
        self._opened_on = (
            datetime.fromtimestamp(active.stat().st_mtime).date()
            if active.exists()
            else date.today()
        )
        self._rollover_lock = RLock()

    def shouldRollover(self, record: logging.LogRecord) -> bool:  # noqa: N802
        if date.today() != self._opened_on:
            return True
        if self.max_bytes <= 0:
            return False
        if self.stream is None:
            self.stream = self._open()
        rendered = f"{self.format(record)}{self.terminator}".encode()
        self.stream.flush()
        current_size = Path(self.baseFilename).stat().st_size
        return current_size + len(rendered) > self.max_bytes

    def doRollover(self) -> None:  # noqa: N802
        with self._rollover_lock:
            if self.stream:
                self.stream.close()
                self.stream = None
            active = Path(self.baseFilename)
            if active.exists() and active.stat().st_size:
                archive_date = self._opened_on.isoformat()
                archive_dir = active.parent / archive_date
                archive_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
                index = 1
                target = archive_dir / f"{active.name}_{archive_date}_{index}"
                while target.exists():
                    index += 1
                    target = archive_dir / f"{active.name}_{archive_date}_{index}"
                os.replace(active, target)
            self._opened_on = date.today()
            self._remove_expired_archives()

    def _remove_expired_archives(self) -> None:
        cutoff = date.today() - timedelta(days=max(0, self.retention_days - 1))
        root = Path(self.baseFilename).parent
        for candidate in root.iterdir():
            if not candidate.is_dir():
                continue
            try:
                archive_date = date.fromisoformat(candidate.name)
            except ValueError:
                continue
            if archive_date >= cutoff:
                continue
            for child in candidate.iterdir():
                if child.is_file() and child.name.startswith(
                    ("app.log_", "summary.log_", "alert.log_")
                ):
                    child.unlink()
            try:
                candidate.rmdir()
            except OSError:
                pass

    def _open(self):  # type: ignore[no-untyped-def]
        stream = super()._open()
        if os.name == "posix":
            try:
                os.chmod(self.baseFilename, 0o640)
            except OSError:
                pass
        return stream


class _ExcludeLoggerFilter(logging.Filter):
    def __init__(self, prefix: str) -> None:
        super().__init__()
        self.prefix = prefix

    def filter(self, record: logging.LogRecord) -> bool:
        return not (record.name == self.prefix or record.name.startswith(f"{self.prefix}."))


class _MinimumLevelFilter(logging.Filter):
    def __init__(self, level: int) -> None:
        super().__init__()
        self.level = level

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno >= self.level


def _file_handler(
    config: LoggingConfig,
    filename: str,
    formatter: logging.Formatter,
) -> DailySizeRotatingFileHandler:
    handler = DailySizeRotatingFileHandler(
        config.directory / filename,
        max_bytes=config.max_bytes,
        retention_days=config.retention_days,
    )
    handler.setFormatter(formatter)
    return handler


def _clear_handlers(logger: logging.Logger) -> None:
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()


def configure_logging(config: LoggingConfig) -> None:
    level = getattr(logging, config.level.upper(), logging.INFO)
    root = logging.getLogger()
    _clear_handlers(root)
    root.setLevel(level)

    app_formatter = BankApplicationFormatter(config)
    if config.console_enabled:
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(app_formatter)
        console_handler.addFilter(_ExcludeLoggerFilter(SUMMARY_LOGGER_NAME))
        root.addHandler(console_handler)

    summary_logger = logging.getLogger(SUMMARY_LOGGER_NAME)
    _clear_handlers(summary_logger)
    summary_logger.setLevel(logging.INFO)
    summary_logger.propagate = False

    if config.console_enabled:
        summary_console = logging.StreamHandler()
        summary_console.setFormatter(BankSummaryFormatter(config))
        summary_logger.addHandler(summary_console)

    if config.file_enabled:
        app_handler = _file_handler(config, "app.log", app_formatter)
        app_handler.addFilter(_ExcludeLoggerFilter(SUMMARY_LOGGER_NAME))
        root.addHandler(app_handler)
        summary_logger.addHandler(
            _file_handler(config, "summary.log", BankSummaryFormatter(config))
        )
        alert_handler = _file_handler(config, "alert.log", BankAlertFormatter(config))
        alert_handler.addFilter(_MinimumLevelFilter(logging.ERROR))
        root.addHandler(alert_handler)

    access_logger = logging.getLogger("uvicorn.access")
    _clear_handlers(access_logger)
    access_logger.propagate = False
    access_logger.disabled = True
    uvicorn_error = logging.getLogger("uvicorn.error")
    _clear_handlers(uvicorn_error)
    uvicorn_error.propagate = True
    uvicorn_error.disabled = False


def get_summary_logger() -> logging.Logger:
    return logging.getLogger(SUMMARY_LOGGER_NAME)


def set_log_level(level: str) -> str:
    normalized = level.strip().upper()
    if normalized == "WARN":
        normalized = "WARNING"
    supported = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
    if normalized not in supported:
        raise ValueError(f"Unsupported log level: {level}")
    logging.getLogger().setLevel(getattr(logging, normalized))
    return normalized
