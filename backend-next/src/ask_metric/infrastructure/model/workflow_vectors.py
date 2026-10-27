"""标准任务向量索引；Milvus 只保存公开路线描述，不保存问题和业务事实。"""

import hashlib
import json
import math
import threading
import time

import httpx


class WorkflowRetrievalUnavailable(RuntimeError):
    pass


class MilvusWorkflowIndex:
    def __init__(self, *, uri, token, collection, client, dimension=1024, timeout=5):
        self.uri, self.token, self.collection = uri.rstrip("/"), token, collection
        self.client, self.dimension, self.timeout = client, dimension, timeout
        self._lock = threading.Lock()
        self._ready_version = None
        self._checked_at = 0.0

    def _post(self, path, body):
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        try:
            response = self.client.post(
                f"{self.uri}/v2/vectordb/{path}",
                json={"collectionName": self.collection, **body},
                headers=headers, timeout=self.timeout,
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict) or result.get("code") != 0:
                raise WorkflowRetrievalUnavailable("milvus_response")
            return result.get("data")
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            # 不向模型或日志带出服务端响应、地址和令牌。
            raise WorkflowRetrievalUnavailable("milvus_unavailable") from exc

    def _vectors(self, vectors, count):
        if len(vectors) != count or any(
            len(vector) != self.dimension or not any(vector)
            or any(isinstance(x, bool) or not isinstance(x, (float, int))
                   or not math.isfinite(x) for x in vector)
            for vector in vectors
        ):
            raise WorkflowRetrievalUnavailable("embedding_shape")
        return vectors

    def search(self, *, model, documents, version, query, limit=8):
        # 配置和目录变更使用新版本过滤，不能召回旧路线；从不删除共享集合。
        revision = hashlib.sha256(json.dumps(
            [version, documents, model.embedding_cache_key()],
            sort_keys=True, ensure_ascii=False,
        ).encode()).hexdigest()[:24]
        with self._lock:
            if self._ready_version != revision or time.monotonic() - self._checked_at > 300:
                exists = self._post("collections/has", {})
                if not isinstance(exists, dict) or not exists.get("has"):
                    self._post("collections/create", {
                        "dimension": self.dimension, "metricType": "COSINE",
                        "primaryFieldName": "id", "idType": "VarChar",
                        "autoId": False, "vectorFieldName": "vector",
                        "params": {"max_length": "128", "enableDynamicField": True},
                    })
                vectors = self._vectors(model.embed([d["text"] for d in documents]), len(documents))
                self._post("entities/upsert", {"data": [
                    {"id": f"{revision}:{d['id']}", "vector": vector,
                     "revision": revision, "document_id": d["id"]}
                    for d, vector in zip(documents, vectors, strict=True)
                ]})
                self._ready_version, self._checked_at = revision, time.monotonic()
        vector = self._vectors(model.embed([query]), 1)[0]
        rows = self._post("entities/search", {
            "data": [vector], "annsField": "vector", "limit": limit,
            "filter": f'revision == "{revision}"', "outputFields": ["document_id"],
            "consistencyLevel": "Strong",
        })
        if not isinstance(rows, list):
            raise WorkflowRetrievalUnavailable("milvus_search_shape")
        known = {d["id"]: d for d in documents}
        return [known[row["document_id"]] for row in rows
                if isinstance(row, dict) and row.get("document_id") in known]
