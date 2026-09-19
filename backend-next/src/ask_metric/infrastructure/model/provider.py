from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from collections import defaultdict, deque
from collections.abc import Callable
from pathlib import Path
from threading import BoundedSemaphore, Semaphore
from time import perf_counter
from typing import Any, Literal

import httpx
from dotenv import dotenv_values

from ask_metric.core.config_crypto import (
    CONFIG_SM4_KEY_FILE_ENV,
    decrypt_config_value,
    load_config_sm4_key,
)
from ask_metric.core.request_context import get_log_context, get_request_id, outbound_subtransaction
from ask_metric.infrastructure.model.configuration import (
    ModelConfigRepository,
    ModelEndpointConfig,
    PromptConfigRepository,
)


def model_failure_category(value: object) -> str:
    """Only public diagnostic codes may leave the provider boundary."""
    if isinstance(value, str) and value in {
        "unavailable", "configuration", "concurrency", "timeout", "http_status", "connection",
    }:
        return value
    return "unavailable"


class ModelServiceUnavailable(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        category: str = "unavailable",
        endpoint: str | None = None,
        status_code: int | None = None,
        duration_ms: int | None = None,
    ) -> None:
        super().__init__(message)
        self.category = model_failure_category(category)
        self.endpoint = endpoint
        self.status_code = status_code
        self.duration_ms = duration_ms


class InvalidModelResponse(ValueError):
    def __init__(
        self,
        message: str,
        *,
        endpoint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.endpoint = endpoint


logger = logging.getLogger(__name__)
ModelRole = Literal["chat", "embedding", "reranker"]


def credential_resolver_from_env_file(path: Path) -> Callable[[str], str | None]:
    """Resolve secrets from the process first, then the configured external env file."""

    def resolve(name: str) -> str | None:
        process_value = os.getenv(name)
        if process_value:
            return decrypt_config_value(process_value)
        file_values = dotenv_values(path)
        file_value = file_values.get(name)
        if not file_value:
            return None
        key_file = file_values.get(CONFIG_SM4_KEY_FILE_ENV)
        key = load_config_sm4_key(environ={}, key_file=Path(str(key_file))) if key_file else None
        return decrypt_config_value(str(file_value), key)

    return resolve


class ConfigurableModelService:
    """OpenAI-compatible model client with independently configured model roles."""

    def __init__(
        self,
        *,
        model_config_repository: ModelConfigRepository,
        prompt_config_repository: PromptConfigRepository,
        credential_resolver: Callable[[str], str | None] = os.getenv,
        client: httpx.Client | None = None,
        max_concurrency: int = 8,
        concurrency_wait_seconds: float = 30,
        semaphore: Semaphore | None = None,
    ) -> None:
        self.model_configs = model_config_repository
        self.prompts = prompt_config_repository
        self._credential_resolver = credential_resolver
        self._client = client
        self._semaphore = semaphore or BoundedSemaphore(max_concurrency)
        self._concurrency_wait_seconds = concurrency_wait_seconds

    def is_enabled(self, role: ModelRole) -> bool:
        return bool(getattr(self.model_configs.load().models, role).enabled)

    def embedding_cache_key(self) -> str:
        """Fingerprint effective embedding configuration without retaining raw secrets."""
        endpoint = self.model_configs.load().models.embedding
        config = endpoint.model_dump(mode="json")
        if endpoint.base_url_env:
            config["base_url"] = (
                self._credential_resolver(endpoint.base_url_env) or endpoint.base_url
            ).rstrip("/")
        config["authentication_headers"] = self._authentication_headers(endpoint)
        return hashlib.sha256(
            json.dumps(config, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()

    def analyze(self, *, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        chat = self.model_configs.load().models.chat
        self._require_enabled("chat", chat)
        messages = self.prompts.render(prompt, context)
        if chat.user_message_suffix:
            messages = [dict(message) for message in messages]
            user_message = next(
                (message for message in reversed(messages) if message.get("role") == "user"),
                None,
            )
            if user_message is None:
                raise InvalidModelResponse(
                    "Chat prompt does not contain a user message",
                    endpoint=chat.path,
                )
            user_message["content"] = f"{user_message.get('content', '')}{chat.user_message_suffix}"
        payload: dict[str, Any] = {
            "messages": messages,
            "stream": False,
        }
        if chat.send_model:
            payload["model"] = chat.model
        if chat.temperature is not None:
            payload["temperature"] = chat.temperature
        if chat.max_tokens is not None:
            payload["max_tokens"] = chat.max_tokens
        if chat.response_format == "json_object" and chat.send_response_format:
            payload["response_format"] = {"type": "json_object"}
        if chat.send_enable_thinking:
            payload["enable_thinking"] = self.prompts.thinking_enabled(
                prompt, default=chat.enable_thinking
            )
        if chat.chat_template_kwargs:
            payload["chat_template_kwargs"] = chat.chat_template_kwargs
        payload.update(chat.extra_body)
        started = perf_counter()
        try:
            response = self._post(chat, payload)
        except Exception as exc:
            _log_model_usage(prompt, chat.model, payload, None, started, type(exc).__name__)
            raise
        _log_model_usage(prompt, chat.model, payload, response, started)
        try:
            content = response["choices"][0]["message"]["content"]
            if chat.response_format == "json_object":
                return json.loads(content)
            return {"text": content}
        except (IndexError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise InvalidModelResponse(
                "Chat model returned an invalid response",
                endpoint=chat.path,
            ) from exc

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        embedding = self.model_configs.load().models.embedding
        self._require_enabled("embedding", embedding)
        payload: dict[str, Any] = {"input": texts}
        if embedding.send_model:
            payload["model"] = embedding.model
        if embedding.dimensions is not None:
            payload["dimensions"] = embedding.dimensions
        if embedding.encoding_format is not None:
            payload["encoding_format"] = embedding.encoding_format
        if embedding.user:
            payload["user"] = embedding.user
        payload.update(embedding.extra_body)
        response = self._post(embedding, payload)
        try:
            # lambda 取每条结果的 index 作为排序键：按输入次序还原向量，不能假定
            # 模型响应数组天然有序，否则目录名称可能对应到别的指标向量。
            ordered = sorted(response["data"], key=lambda item: item["index"])
            if (any(type(item["index"]) is not int for item in ordered)
                    or [item["index"] for item in ordered] != list(range(len(texts)))):
                raise ValueError("Embedding response indices do not match request")
            return [item["embedding"] for item in ordered]
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidModelResponse(
                "Embedding model returned an invalid response",
                endpoint=embedding.path,
            ) from exc

    def rerank(
        self,
        *,
        query: str,
        documents: list[str],
        top_n: int | None = None,
    ) -> list[dict[str, Any]]:
        if not documents:
            return []
        reranker = self.model_configs.load().models.reranker
        self._require_enabled("reranker", reranker)
        payload: dict[str, Any] = {
            "query": query,
            reranker.documents_field: documents,
        }
        if reranker.send_model:
            payload["model"] = reranker.model
        if reranker.send_top_n:
            payload["top_n"] = min(top_n or reranker.top_n, len(documents))
        if reranker.send_return_documents:
            payload["return_documents"] = reranker.return_documents
        payload.update(reranker.extra_body)
        response = self._post(reranker, payload)
        return _normalize_rerank_response(response, documents, endpoint=reranker.path)

    def _require_enabled(self, role: ModelRole, endpoint: ModelEndpointConfig) -> None:
        if not endpoint.enabled:
            raise ModelServiceUnavailable(
                f"The {role} model role is disabled",
                category="configuration",
                endpoint=endpoint.path,
            )

    def _post(
        self,
        endpoint: ModelEndpointConfig,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """统一模型 HTTP 边界：取配置、限制并发、设置超时并归类失败原因。"""
        headers = self._authentication_headers(endpoint)
        base_url = endpoint.base_url
        if endpoint.base_url_env:
            configured_base_url = self._credential_resolver(endpoint.base_url_env)
            if configured_base_url:
                base_url = configured_base_url.rstrip("/")
        if not base_url or not base_url.startswith(("http://", "https://")):
            raise ModelServiceUnavailable(
                "Model endpoint URL is not configured",
                category="configuration",
                endpoint=endpoint.path,
            )
        url = f"{base_url}{endpoint.path}"
        started = perf_counter()
        acquired = self._semaphore.acquire(timeout=self._concurrency_wait_seconds)
        if not acquired:
            raise ModelServiceUnavailable(
                "Model concurrency limit reached; please retry later",
                category="concurrency",
                endpoint=endpoint.path,
            )
        try:
            with outbound_subtransaction(endpoint.path, invoke_sys="MODEL_PROVIDER") as transaction:
                request_headers = {**headers, **transaction.headers()}
                client = self._client or httpx.Client()
                try:
                    response = client.post(
                        url,
                        json=payload,
                        headers=request_headers,
                        timeout=endpoint.timeout_seconds,
                    )
                    transaction.set_response(response.status_code)
                finally:
                    # 只关闭本次临时创建的客户端；共享客户端由应用关闭流程统一释放。
                    if self._client is None:
                        client.close()
                response.raise_for_status()
                try:
                    value = response.json()
                except json.JSONDecodeError as exc:
                    raise InvalidModelResponse(
                        "Model provider returned invalid JSON",
                        endpoint=endpoint.path,
                    ) from exc
                if not isinstance(value, dict):
                    raise InvalidModelResponse(
                        "Model provider returned a non-object response",
                        endpoint=endpoint.path,
                    )
        except httpx.TimeoutException as exc:
            duration_ms = _duration_ms(started)
            _log_model_request(
                endpoint.path, duration_ms=duration_ms, error="timeout", exception=exc
            )
            failure = ModelServiceUnavailable(
                f"Model provider request {endpoint.path} timed out after "
                f"{endpoint.timeout_seconds:g} seconds",
                category="timeout",
                endpoint=endpoint.path,
                duration_ms=duration_ms,
            )
            _mark_alert_logged(failure)
            raise failure from exc
        except httpx.HTTPStatusError as exc:
            duration_ms = _duration_ms(started)
            _log_model_request(
                endpoint.path,
                duration_ms=duration_ms,
                status_code=exc.response.status_code,
                error="http_status",
                exception=exc,
            )
            failure = ModelServiceUnavailable(
                f"Model provider request {endpoint.path} failed with HTTP "
                f"{exc.response.status_code}",
                category="http_status",
                endpoint=endpoint.path,
                status_code=exc.response.status_code,
                duration_ms=duration_ms,
            )
            _mark_alert_logged(failure)
            raise failure from exc
        except httpx.RequestError as exc:
            duration_ms = _duration_ms(started)
            _log_model_request(
                endpoint.path, duration_ms=duration_ms, error="connection", exception=exc
            )
            failure = ModelServiceUnavailable(
                f"Model provider request {endpoint.path} could not connect",
                category="connection",
                endpoint=endpoint.path,
                duration_ms=duration_ms,
            )
            _mark_alert_logged(failure)
            raise failure from exc
        finally:
            # finally 无论成功还是异常都会运行，避免失败请求永久占用并发名额。
            self._semaphore.release()
        duration_ms = _duration_ms(started)
        _log_model_request(
            endpoint.path,
            duration_ms=duration_ms,
            status_code=response.status_code,
        )
        return value

    def _authentication_headers(self, endpoint: ModelEndpointConfig) -> dict[str, str]:
        authentication = endpoint.authentication
        if authentication.type == "none":
            return {}
        secret = self._credential_resolver(endpoint.api_key_env) if endpoint.api_key_env else None
        if not secret:
            raise ModelServiceUnavailable(
                "Model credential is not configured",
                category="configuration",
                endpoint=endpoint.path,
            )
        return {authentication.header: f"{authentication.prefix}{secret}"}


def _log_model_usage(
    step: str, model: str, payload: dict[str, Any], response: dict[str, Any] | None,
    started: float, error: str | None = None,
) -> None:
    """只记供应商用量及关联标识；缺失字段保留 null，不输出提示词或响应正文。"""
    usage = (response or {}).get("usage")
    usage = usage if isinstance(usage, dict) else {}

    def count(value: Any) -> int | None:
        return value if type(value) is int and value >= 0 else None

    input_tokens = count(usage.get("prompt_tokens"))
    output_tokens = count(usage.get("completion_tokens"))
    total_tokens = count(usage.get("total_tokens"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    logger.info("model_usage %s", json.dumps({
        "event": "model_usage", "layer": "backend", "step": step, "model": model,
        "request_id": get_request_id(), "trace_id": get_log_context().trace_id,
        "usage_known": input_tokens is not None and output_tokens is not None,
        "input_tokens": input_tokens, "output_tokens": output_tokens,
        "total_tokens": total_tokens, "error": error,
        "payload_bytes": len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
        "duration_ms": _duration_ms(started),
    }, ensure_ascii=False))


def _normalize_rerank_response(
    response: dict[str, Any], documents: list[str], *, endpoint: str
) -> list[dict[str, Any]]:
    """Normalize the indexed and bank parallel-array response contracts."""
    if "results" in response:
        results = response["results"]
        if isinstance(results, list):
            return results
        raise InvalidModelResponse("Reranker returned an invalid response", endpoint=endpoint)
    scores = response.get("scores")
    texts = response.get("texts")
    if (
        isinstance(scores, list)
        and len(scores) == len(documents)
        and isinstance(texts, list)
        and len(texts) == len(documents)
    ):
        # Bank responses may be sorted by relevance. Each score belongs to
        # its returned text, not to the candidate at that response position.
        # Keep occurrences separate so duplicate texts cannot reuse an index.
        indices: dict[str, deque[int]] = defaultdict(deque)
        for index, document in enumerate(documents):
            indices[document].append(index)
        normalized: list[dict[str, Any]] = []
        for text, score in zip(texts, scores, strict=True):
            if not isinstance(text, str) or not indices.get(text):
                break
            try:
                valid = (
                    isinstance(score, (int, float))
                    and not isinstance(score, bool)
                    and math.isfinite(score)
                )
            except OverflowError:
                valid = False
            if not valid:
                break
            normalized.append({"index": indices[text].popleft(), "relevance_score": score})
        else:
            return normalized
    raise InvalidModelResponse("Reranker returned an invalid response", endpoint=endpoint)


def _log_model_request(
    path: str,
    *,
    duration_ms: int,
    status_code: int | None = None,
    error: str | None = None,
    exception: Exception | None = None,
) -> None:
    safe_path = path if path in {
        "/v1/chat/completions", "/v1/embeddings", "/v1/rerank",
    } else "custom"
    safe_error = model_failure_category(error) if error else "-"
    log_method = logger.error if error else logger.info
    log_method(
        "model_api endpoint=%s status=%s duration_ms=%s error=%s",
        safe_path,
        status_code or "-",
        duration_ms,
        safe_error,
        exc_info=(type(exception), exception, exception.__traceback__) if exception else None,
        extra={"trans_api": safe_path, "exception_type": "ModelServiceError" if error else "-"},
    )


def _mark_alert_logged(exc: Exception) -> None:
    try:
        exc._ask_metric_alert_logged = True  # type: ignore[attr-defined]
    except Exception:
        pass


def _duration_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))
