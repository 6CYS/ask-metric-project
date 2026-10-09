"""Nacos 3.x / 2.x 配置 OpenAPI；同步入口兼容 FastAPI 线程池与部署命令。

模型配置使用短期内存快照，不使用磁盘回退。通信异常只报告操作和 Data ID。
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
from collections.abc import Callable
from copy import deepcopy
from threading import RLock
from time import monotonic, perf_counter
from typing import Any
from urllib.parse import urlsplit

import httpx
import yaml

logger = logging.getLogger(__name__)

MODEL_DATA_ID = "sznsznws_backend_model.json"
PROMPTS_DATA_ID = "sznsznws_backend_prompts.json"
QUERY_ONLY_DATA_ID = "sznsznws_backend_prompts_query_only.json"
SEMANTIC_DATA_ID = "sznsznws_backend_semantic.json"
QUERY_TEMPLATES_DATA_ID = "sznsznws_backend_query_templates.json"
RUNTIME_DATA_ID = "sznsznws_backend_runtime.yaml"
DATASOURCE_DATA_ID = "sznsznws_backend_datasource.yaml"
SECURITY_DATA_ID = "sznsznws_backend_security.yaml"
SQL_DATA_IDS = {
    "mysql": "sznsznws_backend_sql_mysql.json",
    "inceptor": "sznsznws_backend_sql_inceptor.json",
}
DATA_IDS = (
    RUNTIME_DATA_ID, DATASOURCE_DATA_ID, SECURITY_DATA_ID, MODEL_DATA_ID,
    PROMPTS_DATA_ID, SEMANTIC_DATA_ID, QUERY_TEMPLATES_DATA_ID, *SQL_DATA_IDS.values(),
)


class _ConfigRequestLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # httpx 的默认 INFO 请求日志会带 accessToken 查询参数；配置请求不输出 URL。
        return "/cs/config" not in record.getMessage()


logging.getLogger("httpx").addFilter(_ConfigRequestLogFilter())


class ConfigCenterError(RuntimeError):
    """错误信息只包含固定提示和配置名。"""


class DocumentSnapshot:
    """一次校验共用同一批内容，避免每个 SQL 模板再次请求 Nacos。"""

    def __init__(self, documents: dict[str, dict], *, settings: Any = None) -> None:
        self._documents = deepcopy(documents)
        self.settings = settings

    def read_json(self, data_id: str) -> dict:
        # 调用方不能修改已发布给其他线程的快照。
        return deepcopy(self._documents[data_id])


def _unique_pairs(pairs) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate configuration key")
        value[key] = item
    return value


class _UniqueLoader(yaml.SafeLoader):
    pass


def _yaml_mapping(loader, node):
    return _unique_pairs(loader.construct_pairs(node, deep=True))


_UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _yaml_mapping)


def decode_document(content: str, data_id: str) -> dict[str, Any]:
    try:
        value = (
            yaml.load(content, Loader=_UniqueLoader) if data_id.endswith(".yaml")
            else json.loads(content, object_pairs_hook=_unique_pairs)
        )
    except (ValueError, TypeError, yaml.YAMLError):
        raise ConfigCenterError(f"配置格式无效：{data_id}") from None
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        raise ConfigCenterError(f"配置必须为键值对象：{data_id}")
    return value


def encode_document(value: dict[str, Any], data_id: str) -> str:
    if data_id.endswith(".yaml"):
        return yaml.safe_dump(value, allow_unicode=True, sort_keys=False)
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


class NacosConfigStore:
    def __init__(self, settings: Any, *, transport: httpx.BaseTransport | None = None) -> None:
        self.settings = settings
        self.group = settings.nacos_config_group
        self._lock = RLock()
        self._versions: dict[str, str] = {}
        self._api_versions: dict[str, str] = {}
        self._read_servers: dict[str, str] = {}
        self._tokens: dict[str, tuple[str, float]] = {}
        self._snapshots: dict[tuple[str, ...], tuple[DocumentSnapshot, float]] = {}
        self._servers = []
        for address in settings.nacos_server_addr.split(","):
            address = address.strip().rstrip("/")
            if not address:
                continue
            if "://" not in address:
                address = "http://" + address
            parsed = urlsplit(address)
            if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                    or parsed.username or parsed.password or parsed.query or parsed.fragment):
                raise ConfigCenterError("NACOS_SERVER_ADDR 格式无效")
            self._servers.append(address if parsed.path.rstrip("/") else address + "/nacos")
        if not self._servers or not self.group.strip():
            raise ConfigCenterError("必须填写 Nacos 地址及配置分组")
        self._client = httpx.Client(
            timeout=settings.nacos_request_timeout_ms / 1000,
            transport=transport, trust_env=False,
        )

    def close(self) -> None:
        with self._lock:
            self._snapshots.clear()
            self._tokens.clear()
            self._client.close()

    def _token(self, server: str) -> str:
        if not self.settings.nacos_username:
            return ""
        cached = self._tokens.get(server)
        if cached is not None and monotonic() < cached[1]:
            return cached[0]
        login = self._client.post(server + "/v1/auth/users/login", data={
            "username": self.settings.nacos_username,
            "password": self.settings.nacos_password,
        })
        login.raise_for_status()
        envelope = self._envelope(login)
        token = envelope.get("accessToken")
        if not isinstance(token, str) or not token:
            raise ConfigCenterError("Nacos 鉴权响应无效")
        # 无有效 TTL 时只使用本次令牌；不猜有效期，也不永久缓存。
        ttl = envelope.get("tokenTtl")
        if type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0:
            margin = min(30, ttl * 0.1)
            self._tokens[server] = (token, monotonic() + ttl - margin)
        else:
            self._tokens.pop(server, None)
        return token

    def _unauthorized(self, response: httpx.Response) -> bool:
        return (response.status_code in {401, 403}
                or self._envelope(response).get("code") == 10001)

    @staticmethod
    def _envelope(response: httpx.Response) -> dict:
        try:
            value = response.json()
        except ValueError:
            return {}
        return value if isinstance(value, dict) else {}

    def _params(self, data_id: str, version: str, token: str) -> dict:
        selected_id = (
            self.settings.nacos_prompt_data_id if data_id == PROMPTS_DATA_ID else data_id
        )
        params = {"dataId": selected_id}
        namespace = self.settings.nacos_namespace
        if version == "v3":
            params.update(groupName=self.group, namespaceId=namespace or "public")
        else:
            params["group"] = self.group
            if namespace and namespace != "public":
                params["tenant"] = namespace
        if token:
            params["accessToken"] = token
        return params

    def _content(self, response: httpx.Response, version: str, method: str, data_id: str) -> str:
        envelope = self._envelope(response) if version == "v3" else {}
        code = envelope.get("code")
        if code == 20004:
            raise ConfigCenterError(f"Nacos 缺少配置：{data_id}")
        if code == 20005 or response.status_code == 409:
            raise ConfigCenterError(f"配置已被其他发布修改，请刷新后重试：{data_id}")
        if code == 10001 or response.status_code in {401, 403}:
            raise ConfigCenterError(f"Nacos 配置访问被拒绝，请核对账号权限：{data_id}")
        if response.status_code == 404:
            # HTTP 路由 404 与 v3 的资源不存在业务码不同，不能统称为配置缺失。
            raise ConfigCenterError(f"Nacos 配置或接口不存在（HTTP 404，{version}）：{data_id}")
        response.raise_for_status()
        if version == "v3":
            if type(code) is not int or code != 0:
                safe_code = code if type(code) is int else "invalid_response"
                raise ConfigCenterError(f"Nacos 配置接口返回错误（{safe_code}）：{data_id}")
            value = envelope.get("data")
            if method == "GET":
                value = value.get("content") if isinstance(value, dict) else None
                if not isinstance(value, str) or not value.strip():
                    raise ConfigCenterError(f"Nacos 配置内容为空或响应格式无效：{data_id}")
                return value
            success = value is True
        else:
            if method == "GET":
                if not response.text.strip():
                    raise ConfigCenterError(f"Nacos 配置为空：{data_id}")
                return response.text
            success = response.text.strip().lower() == "true"
        if not success:
            raise ConfigCenterError(f"Nacos 未确认发布成功：{data_id}")
        return "true"

    def _request(self, method: str, data_id: str, content: str | None = None) -> str:
        # 调用方持有 _lock：令牌、API 版本和连接在进程内共用。
        # 发布沿用 CAS，绝不自动重发；只有读取允许重新鉴权一次。
        servers = list(self._servers)
        read_server = self._read_servers.get(data_id)
        if read_server in servers:
            servers.remove(read_server)
            servers.insert(0, read_server)
        failure = "连接失败或请求超时"
        for server in servers:
            phase = "鉴权"
            try:
                token = self._token(server)
                phase = "配置读取" if method == "GET" else "配置发布"
                version = self._api_versions.get(server, "v3")
                if method == "GET":
                    for attempt in range(2):
                        path = "/v3/client/cs/config" if version == "v3" else "/v1/cs/configs"
                        response = self._client.get(
                            server + path, params=self._params(data_id, version, token),
                        )
                        # v3 路由不存在才探测旧接口；业务配置缺失不回退。
                        if (server not in self._api_versions and response.status_code == 404
                                and "code" not in self._envelope(response)):
                            version = "v1"
                            response = self._client.get(
                                server + "/v1/cs/configs",
                                params=self._params(data_id, version, token),
                            )
                        if not self._unauthorized(response):
                            break
                        self._tokens.pop(server, None)
                        if attempt == 1 or not self.settings.nacos_username:
                            break
                        phase = "鉴权"
                        token = self._token(server)
                        phase = "配置读取"
                else:
                    path = "/v3/admin/cs/config" if version == "v3" else "/v1/cs/configs"
                    payload = {**self._params(data_id, version, token), "content": content,
                               "type": "yaml" if data_id.endswith(".yaml") else "json"}
                    response = self._client.post(
                        server + path, data=payload,
                        headers={"casMd5": self._versions[data_id]},
                    )
                    if self._unauthorized(response):
                        self._tokens.pop(server, None)
                result = self._content(response, version, method, data_id)
                self._api_versions[server] = version
                if method == "GET":
                    self._read_servers[data_id] = server
                return result
            except httpx.HTTPStatusError as exc:
                failure = f"{phase} HTTP {exc.response.status_code}"
                if method != "GET":
                    raise ConfigCenterError(
                        f"Nacos 发布未完成（{failure}），请核对中心状态：{data_id}"
                    ) from None
            except httpx.RequestError:
                failure = f"{phase}连接失败或请求超时"
                if method != "GET":
                    raise ConfigCenterError(
                        f"配置发布结果未确认，请核对 Nacos：{data_id}"
                    ) from None
        raise ConfigCenterError(f"无法从 Nacos 读取配置（{failure}）：{data_id}")

    def read_snapshot(
        self, data_ids: tuple[str, ...], *, force: bool = False,
        validate: Callable[[DocumentSnapshot], None],
    ) -> DocumentSnapshot:
        """按组刷新并校验，成功后一次替换；失败不返回过期或半组配置。

        这是进程内短期缓存，不提供磁盘兜底。多个 Data ID 的服务端发布仍需
        运维协调；本地按组交换不意味着 Nacos 支持跨文档事务。
        """
        with self._lock:
            cached = self._snapshots.get(data_ids)
            if not force and cached is not None and monotonic() < cached[1]:
                return cached[0]
            # 强制校验失败后也不能继续命中尚未过期的旧快照。
            self._snapshots.pop(data_ids, None)
            started = perf_counter()
            documents = {
                name: decode_document(self._request("GET", name), name) for name in data_ids
            }
            snapshot = DocumentSnapshot(documents, settings=self.settings)
            validate(snapshot)
            interval = self.settings.nacos_config_refresh_interval_seconds
            self._snapshots[data_ids] = (snapshot, monotonic() + interval)
            logger.info(
                "nacos_snapshot_refreshed documents=%s duration_ms=%s forced=%s",
                len(data_ids), round((perf_counter() - started) * 1000), force,
            )
            # 快照读取不推进显式编辑读取的 CAS 基线。
            return snapshot

    def read_json(self, data_id: str) -> dict[str, Any]:
        with self._lock:
            content = self._request("GET", data_id)
            value = decode_document(content, data_id)
            self._versions[data_id] = hashlib.md5(content.encode("utf-8")).hexdigest()
            return value

    def publish_json(self, data_id: str, value: dict[str, Any]) -> None:
        content = encode_document(value, data_id)
        with self._lock:
            # 包括结果未确认的发布：下一次模型调用都必须重新核对中心。
            for group in list(self._snapshots):
                if data_id in group:
                    self._snapshots.pop(group, None)
            if data_id not in self._versions:
                self.read_json(data_id)
            self._request("POST", data_id, content)
            self._versions[data_id] = hashlib.md5(content.encode("utf-8")).hexdigest()
