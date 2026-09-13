"""Process-local, single-flight catalog embeddings; no external vector database."""
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
    """Use exactly the same input for startup warmup and online retrieval."""
    return [f"{item.name} {' '.join(item.aliases)} {item.description}" for item in metrics]


class CatalogVectorCache:
    """Keep only the current model/catalog; never retain query vectors or credentials."""

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
        # Query calls can run concurrently once the catalog is ready.
        self._ensure_current(model, key)
        query = self._validate(model.embed([question]), 1, dimensions)
        self._ensure_current(model, key)
        return [query[0], *catalog]

    def warmup(
        self, model: ModelService, corpus: list[str], *, batch_size: int = 16,
        wait_seconds: float = 60, progress: Callable[[int, int], None] | None = None,
    ) -> None:
        """Populate only catalog vectors; do not send a synthetic user question."""
        self._load(model, corpus, batch_size=batch_size, wait_seconds=wait_seconds,
                   progress=progress)

    def _load(
        self, model: ModelService, corpus: list[str], *, batch_size: int,
        wait_seconds: float, progress: Callable[[int, int], None] | None = None,
    ) -> tuple[object, int | None, list[memoryview]]:
        if batch_size < 1:
            raise ValueError("Catalog embedding batch size must be positive")
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
            documents = list(dict.fromkeys(corpus))
            if set(documents) != self._documents:
                # Allocate a new generation: in-flight readers retain their old, read-only
                # buffer. Never resize a buffer after exporting memoryview rows.
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
                # Successful batches survive a later failure; incomplete catalogs are
                # never returned to retrieval. The next request retries missing batches.
                for text, vector in zip(batch, vectors, strict=True):
                    row = len(self._vectors)
                    start = row * self._dimensions
                    self._matrix[start:start + self._dimensions] = vector
                    self._vectors[text] = row
                if progress:
                    progress(len(self._vectors), len(documents))
            self._ensure_current(model, key)
            dimensions = self._dimensions
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
