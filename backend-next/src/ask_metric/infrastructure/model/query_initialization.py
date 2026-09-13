"""后台预热状态：供健康接口、问数门禁和前端读取，不包含模型或数据库敏感信息。"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass
from threading import Event, Lock
from typing import Literal

logger = logging.getLogger(__name__)


class InitializationStopped(Exception):
    """用于结束预热的内部信号，与需要自动重试的初始化失败区分。"""


@dataclass(frozen=True)
class InitializationStatus:
    # dataclass 自动生成构造方法；frozen 禁止修改字段，每次进度变化替换整个状态。
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
        # 后台线程写状态，HTTP 线程读状态；加锁并复制，避免外部修改内部对象。
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
        """调用无参初始化函数；成功才设为 ready，失败后等待并重试，停止信号优先。"""
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
                # 此处兜底捕获异常是为了更新失败状态并重试，不是静默忽略错误。
                # 只记录异常类型，避免模型正文、凭据或数据库原始异常泄漏到日志/前端。
                logger.warning("query_initialization_failed exception_type=%s", type(exc).__name__)
                with self._lock:
                    self._status = InitializationStatus(
                        status="failed",
                        message="问数系统指标检索功能初始化失败，系统将自动重试；请联系管理员检查模型和指标目录配置。",
                        completed=self._status.completed, total=self._status.total,
                    )
                # Event.wait 等待期间可被 stop() 唤醒，比固定 sleep 更适合应用关闭。
                if self._stop.wait(retry_seconds):
                    return
