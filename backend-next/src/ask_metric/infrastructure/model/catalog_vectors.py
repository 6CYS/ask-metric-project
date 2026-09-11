"""Process-local, single-flight catalog embeddings; no external vector database."""
from __future__ import annotations

import logging
import math
from threading import Lock
from time import perf_counter

from ask_metric.application.ports import ModelService
from ask_metric.infrastructure.model.provider import InvalidModelResponse, ModelServiceUnavailable

logger = logging.getLogger(__name__)


class CatalogVectorCache:
    """Keep only the current model/catalog; never retain query vectors or credentials."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._model_key: object = None
        self._vectors: dict[str, tuple[float, ...]] = {}
        self._dimensions: int | None = None

    @staticmethod
    def _key(model: ModelService) -> object:
        fingerprint = getattr(model, "embedding_cache_key", None)
        # Non-configurable adapters may reuse only their own instance's vectors.
        return fingerprint() if callable(fingerprint) else model

    def embed(
        self, model: ModelService, question: str, corpus: list[str], *,
        batch_size: int = 16, wait_seconds: float = 60,
    ) -> list[tuple[float, ...]]:
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
                self._dimensions = None
                self._model_key = key
            documents = list(dict.fromkeys(corpus))
            # Prune removed/edited documents, but reuse unchanged text across catalog updates.
            self._vectors = {text: self._vectors[text] for text in documents
                             if text in self._vectors}
            if not self._vectors:
                self._dimensions = None
            missing = [text for text in documents if text not in self._vectors]
            started = perf_counter()
            for offset in range(0, len(missing), batch_size):
                batch = missing[offset:offset + batch_size]
                vectors = self._validate(model.embed(batch), len(batch), self._dimensions)
                self._ensure_current(model, key)
                self._dimensions = len(vectors[0])
                # Successful batches survive a later failure; incomplete catalogs are
                # never returned to retrieval. The next request retries missing batches.
                self._vectors.update(zip(batch, vectors, strict=True))
            catalog = [self._vectors[text] for text in corpus]
            dimensions = self._dimensions
            logger.info(
                "catalog_vectors documents=%s embedded=%s reused=%s duration_ms=%s",
                len(documents), len(missing), len(documents) - len(missing),
                round((perf_counter() - started) * 1000),
            )
        finally:
            self._lock.release()
        # Query calls can run concurrently once the catalog is ready.
        self._ensure_current(model, key)
        query = self._validate(model.embed([question]), 1, dimensions)
        self._ensure_current(model, key)
        return [query[0], *catalog]

    def _ensure_current(self, model: ModelService, key: object) -> None:
        if self._key(model) != key:
            raise ModelServiceUnavailable(
                "Embedding configuration changed during catalog lookup; retry",
                category="configuration", endpoint="/v1/embeddings",
            )

    @staticmethod
    def _validate(
        vectors: object, count: int, dimensions: int | None,
    ) -> list[tuple[float, ...]]:
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
                normalized = tuple(float(value) for value in vector)
                dimensions = dimensions or len(normalized)
                if len(normalized) != dimensions or not any(normalized):
                    raise ValueError
                result.append(normalized)
            return result
        except (ValueError, TypeError, OverflowError) as exc:
            raise InvalidModelResponse(
                "Embedding vectors have invalid count, dimensions or numeric values",
                endpoint="/v1/embeddings",
            ) from exc
