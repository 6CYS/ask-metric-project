"""进程内目录向量缓存：连续 float32 存储，并发请求共用一次目录加载。"""
from __future__ import annotations

import logging
import math
from array import array
from collections.abc import Callable, Sequence
from threading import Lock
from time import perf_counter

from ask_metric.application.ports import ModelService
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.model.provider import InvalidModelResponse, ModelServiceUnavailable

logger = logging.getLogger(__name__)


def catalog_embedding_texts(metrics: Sequence[MetricCatalogItem]) -> list[str]:
    """启动预热与在线检索共用相同文本，名称、别名和说明均参与指标表示。"""
    return [f"{item.name} {' '.join(item.aliases)} {item.description}" for item in metrics]


class CatalogVectorCache:
    """只保留当前模型/目录的向量，不长期保存用户问题向量或模型凭据。

    _matrix 按行连续存储浮点数，_vectors 将目录文本映射到行号。第 r 行从
    r * dimensions 开始；一万行、1024 维的数值区为 40,960,000 字节。
    这不包含文本、索引、临时 HTTP 响应和其他 Python 对象的内存。
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._model_key: object = None
        self._vectors: dict[str, int] = {}
        self._matrix = array("f")
        if self._matrix.itemsize != 4:
            raise RuntimeError("Catalog vectors require 32-bit floats")
        self._documents: set[str] = set()
        self._dimensions: int | None = None

    @staticmethod
    def _key(model: ModelService) -> object:
        fingerprint = getattr(model, "embedding_cache_key", None)
        # Non-configurable adapters may reuse only their own instance's vectors.
        return fingerprint() if callable(fingerprint) else model

    def embed(
        self, model: ModelService, question: str, corpus: list[str], *,
        batch_size: int = 16, wait_seconds: float = 60,
    ) -> list[Sequence[float]]:
        key, dimensions, catalog = self._load(
            model, corpus, batch_size=batch_size, wait_seconds=wait_seconds,
        )
        # 目录锁已释放，多个用户可以并行生成各自的问题向量。
        self._ensure_current(model, key)
        query = self._validate(model.embed([question]), 1, dimensions)
        self._ensure_current(model, key)
        return [query[0], *catalog]

    def warmup(
        self, model: ModelService, corpus: list[str], *, batch_size: int = 16,
        wait_seconds: float = 60, progress: Callable[[int, int], None] | None = None,
    ) -> None:
        """仅预热目录；progress(completed, total) 是逐批回报进度的可选回调。"""
        self._load(model, corpus, batch_size=batch_size, wait_seconds=wait_seconds,
                   progress=progress)

    def _load(
        self, model: ModelService, corpus: list[str], *, batch_size: int,
        wait_seconds: float, progress: Callable[[int, int], None] | None = None,
    ) -> tuple[object, int | None, list[memoryview]]:
        if batch_size < 1:
            raise ValueError("Catalog embedding batch size must be positive")
        # 锁覆盖“检查缺失 → 调用模型 → 写入矩阵”，防止并发请求重复初始化目录。
        if not self._lock.acquire(timeout=wait_seconds):
            raise ModelServiceUnavailable(
                "Catalog vectors are still loading", category="concurrency",
                endpoint="/v1/embeddings",
            )
        try:
            key = self._key(model)
            if key != self._model_key:
                self._vectors = {}
                self._matrix = array("f")
                self._documents = set()
                self._dimensions = None
                self._model_key = key
            # dict.fromkeys 按文本去重并保留首次顺序；最终仍按原 corpus 顺序返回向量。
            documents = list(dict.fromkeys(corpus))
            if set(documents) != self._documents:
                # 目录变动时另建矩阵，正在检索的读者继续使用旧缓冲区。
                # 已导出 memoryview 的数组不能原地改变长度，否则会破坏视图有效性。
                retained = [text for text in documents if text in self._vectors]
                dimensions = self._dimensions or 0
                matrix = array("f", [0]) * (len(documents) * dimensions) if retained else array("f")
                for row, text in enumerate(retained):
                    old = self._vectors[text] * dimensions
                    matrix[row * dimensions:(row + 1) * dimensions] = (
                        self._matrix[old:old + dimensions]
                    )
                self._matrix = matrix
                self._vectors = {text: row for row, text in enumerate(retained)}
                self._documents = set(documents)
                if not retained:
                    self._dimensions = None
            missing = [text for text in documents if text not in self._vectors]
            started = perf_counter()
            if progress:
                progress(len(self._vectors), len(documents))
            for offset in range(0, len(missing), batch_size):
                batch = missing[offset:offset + batch_size]
                vectors = self._validate(model.embed(batch), len(batch), self._dimensions)
                self._ensure_current(model, key)
                self._dimensions = len(vectors[0])
                if not self._matrix:
                    self._matrix = array("f", [0]) * (len(documents) * self._dimensions)
                # 每批验证成功后才登记行号；后续批失败保留已有进度，重试只补缺失项。
                # 整个目录加载成功前不会返回给检索，也不会报告系统已就绪。
                for text, vector in zip(batch, vectors, strict=True):
                    row = len(self._vectors)
                    start = row * self._dimensions
                    self._matrix[start:start + self._dimensions] = vector
                    self._vectors[text] = row
                if progress:
                    progress(len(self._vectors), len(documents))
            self._ensure_current(model, key)
            dimensions = self._dimensions
            # memoryview 是原数组的只读窗口，切出一行不会复制 1024 个浮点数。
            view = memoryview(self._matrix).toreadonly()
            width = dimensions or 0
            catalog = [view[self._vectors[text] * width:(self._vectors[text] + 1) * width]
                       for text in corpus]
            logger.info(
                "catalog_vectors documents=%s embedded=%s reused=%s duration_ms=%s",
                len(documents), len(missing), len(documents) - len(missing),
                round((perf_counter() - started) * 1000),
            )
        finally:
            self._lock.release()
        return key, dimensions, catalog

    def _ensure_current(self, model: ModelService, key: object) -> None:
        if self._key(model) != key:
            raise ModelServiceUnavailable(
                "Embedding configuration changed during catalog lookup; retry",
                category="configuration", endpoint="/v1/embeddings",
            )

    @staticmethod
    def _validate(
        vectors: object, count: int, dimensions: int | None,
    ) -> list[array]:
        # 外部模型结果不可信：校验条数、维度及有限非零数值后才转为 float32。
        # 转换后再查一次溢出/全零，防止原本有限的高精度数在 float32 中失效。
        try:
            if not isinstance(vectors, list) or len(vectors) != count:
                raise ValueError
            result = []
            for vector in vectors:
                if not isinstance(vector, (list, tuple)) or not vector:
                    raise ValueError
                if any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) for value in vector):
                    raise ValueError
                normalized = array("f", vector)
                dimensions = dimensions or len(normalized)
                if (len(normalized) != dimensions or not any(normalized)
                        or any(not math.isfinite(value) for value in normalized)):
                    raise ValueError
                result.append(normalized)
            return result
        except (ValueError, TypeError, OverflowError) as exc:
            raise InvalidModelResponse(
                "Embedding vectors have invalid count, dimensions or numeric values",
                endpoint="/v1/embeddings",
            ) from exc
