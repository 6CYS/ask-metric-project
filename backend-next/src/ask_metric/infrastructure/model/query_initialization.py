"""Background startup warmup with a thread-safe, public query readiness state."""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass
from threading import Event, Lock
from typing import Literal

logger = logging.getLogger(__name__)


class InitializationStopped(Exception):
    pass


@dataclass(frozen=True)
class InitializationStatus:
    status: Literal["initializing", "ready", "failed"] = "initializing"
    message: str = "问数系统指标检索功能正在初始化，完成后即可提问。"
    completed: int = 0
    total: int = 0


class QueryInitialization:
    def __init__(self, *, enabled: bool = True) -> None:
        self._lock = Lock()
        self._stop = Event()
        self._status = InitializationStatus() if enabled else InitializationStatus(
            status="ready", message="问数系统已就绪。",
        )

    def snapshot(self) -> dict:
        with self._lock:
            return asdict(self._status)

    def progress(self, completed: int, total: int) -> None:
        if self._stop.is_set():
            raise InitializationStopped
        with self._lock:
            self._status = InitializationStatus(completed=completed, total=total)

    def stop(self) -> None:
        self._stop.set()

    def run(self, initialize: Callable[[], None], *, retry_seconds: float = 30) -> None:
        while not self._stop.is_set():
            try:
                initialize()
                if self._stop.is_set():
                    return
                with self._lock:
                    self._status = InitializationStatus(
                        status="ready", message="问数系统已就绪。",
                        completed=self._status.completed, total=self._status.total,
                    )
                logger.info("query_initialization_ready")
                return
            except InitializationStopped:
                return
            except Exception as exc:
                # Never expose model bodies, credentials or database exception text.
                logger.warning("query_initialization_failed exception_type=%s", type(exc).__name__)
                with self._lock:
                    self._status = InitializationStatus(
                        status="failed",
                        message="问数系统指标检索功能初始化失败，系统将自动重试；请联系管理员检查模型和指标目录配置。",
                        completed=self._status.completed, total=self._status.total,
                    )
                if self._stop.wait(retry_seconds):
                    return
