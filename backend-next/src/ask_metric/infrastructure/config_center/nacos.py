"""Nacos 3.x / 2.x 配置 OpenAPI；同步入口兼容 FastAPI 线程池与部署命令。

不使用本地配置快照或磁盘回退。通信异常只报告操作和 Data ID，避免返回凭据。
"""

from __future__ import annotations

import hashlib
import json
import logging
from threading import RLock
from typing import Any
from urllib.parse import urlsplit

import httpx
import yaml

MODEL_DATA_ID = "sznsznws_backend_model.json"
PROMPTS_DATA_ID = "sznsznws_backend_prompts.json"
QUERY_ONLY_DATA_ID = "sznsznws_backend_prompts_query_only.json"
SEMANTIC_DATA_ID = "sznsznws_backend_semantic.json"
RUNTIME_DATA_ID = "sznsznws_backend_runtime.yaml"
DATASOURCE_DATA_ID = "sznsznws_backend_datasource.yaml"
SECURITY_DATA_ID = "sznsznws_backend_security.yaml"
AGENT_RUNTIME_DATA_ID = "sznsznws_agent_runtime.json"
AGENT_SECURITY_DATA_ID = "sznsznws_agent_security.json"
DATA_IDS = (
    RUNTIME_DATA_ID,
    DATASOURCE_DATA_ID,
    SECURITY_DATA_ID,
    MODEL_DATA_ID,
    PROMPTS_DATA_ID,
    SEMANTIC_DATA_ID,
    AGENT_RUNTIME_DATA_ID,
    AGENT_SECURITY_DATA_ID,
)


class _ConfigRequestLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # httpx 的默认 INFO 请求日志会带 accessToken 查询参数；配置请求不输出 URL。
        return "/cs/config" not in record.getMessage()


logging.getLogger("httpx").addFilter(_ConfigRequestLogFilter())


class ConfigCenterError(RuntimeError):
    """错误信息只包含固定提示和配置名。"""


class DocumentSnapshot:
    """一次校验共用同一批内容，避免启动校验重复请求 Nacos。"""

    def __init__(self, documents: dict[str, dict]) -> None:
        self.documents = documents

    def read_json(self, data_id: str) -> dict:
        return self.documents[data_id]


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
            yaml.load(content, Loader=_UniqueLoader)
            if data_id.endswith(".yaml")
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
        self._transport = transport
        self._servers = []
        for address in settings.nacos_server_addr.split(","):
            address = address.strip().rstrip("/")
            if not address:
                continue
            if "://" not in address:
                address = "http://" + address
            parsed = urlsplit(address)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ConfigCenterError("NACOS_SERVER_ADDR 格式无效")
            self._servers.append(address if parsed.path.rstrip("/") else address + "/nacos")
        if not self._servers or not self.group.strip():
            raise ConfigCenterError("必须填写 Nacos 地址及配置分组")

    @staticmethod
    def _envelope(response: httpx.Response) -> dict:
        try:
            value = response.json()
        except ValueError:
            return {}
        return value if isinstance(value, dict) else {}

    def _params(self, data_id: str, version: str, token: str) -> dict:
        selected_id = self.settings.nacos_prompt_data_id if data_id == PROMPTS_DATA_ID else data_id
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
            if method != "GET":
                raise ConfigCenterError(f"Nacos 发布接口返回配置不存在（20004）：{data_id}")
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
        # GET 探测并记住每个节点的 API 版本；POST 不进行接口探测或失败重发。
        servers = list(self._servers)
        read_server = self._read_servers.get(data_id)
        if method != "GET" and read_server in servers:
            servers.remove(read_server)
            servers.insert(0, read_server)
        failure = "连接失败或请求超时"
        for server in servers:
            phase = "鉴权"
            try:
                with httpx.Client(
                    timeout=self.settings.nacos_request_timeout_ms / 1000,
                    transport=self._transport,
                    trust_env=False,
                ) as client:
                    token = ""
                    if self.settings.nacos_username:
                        login = client.post(
                            server + "/v1/auth/users/login",
                            data={
                                "username": self.settings.nacos_username,
                                "password": self.settings.nacos_password,
                            },
                        )
                        login.raise_for_status()
                        token = self._envelope(login).get("accessToken")
                        if not isinstance(token, str) or not token:
                            raise ConfigCenterError("Nacos 鉴权响应无效")
                    phase = "配置读取" if method == "GET" else "配置发布"
                    version = self._api_versions.get(server, "v3")
                    params = self._params(data_id, version, token)
                    if method == "GET":
                        path = "/v3/client/cs/config" if version == "v3" else "/v1/cs/configs"
                        response = client.get(server + path, params=params)
                        # 仅未识别版本且 v3 路由不存在时探测旧接口；配置确实缺失不回退。
                        if (
                            server not in self._api_versions
                            and response.status_code == 404
                            and "code" not in self._envelope(response)
                        ):
                            version = "v1"
                            response = client.get(
                                server + "/v1/cs/configs",
                                params=self._params(data_id, version, token),
                            )
                    else:
                        path = "/v3/admin/cs/config" if version == "v3" else "/v1/cs/configs"
                        payload = {
                            **params,
                            "content": content,
                            "type": "yaml" if data_id.endswith(".yaml") else "json",
                        }
                        # Nacos 2.x 和 3.x 均从 HTTP header 读取 casMd5。
                        headers = (
                            {"casMd5": self._versions[data_id]}
                            if data_id in self._versions
                            else {}
                        )
                        response = client.post(server + path, data=payload, headers=headers)
                    self._api_versions[server] = version
                    result = self._content(response, version, method, data_id)
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

    def read_json(self, data_id: str) -> dict[str, Any]:
        with self._lock:
            content = self._request("GET", data_id)
            value = decode_document(content, data_id)
            self._versions[data_id] = hashlib.md5(content.encode("utf-8")).hexdigest()
            return value

    def publish_json(self, data_id: str, value: dict[str, Any]) -> None:
        content = encode_document(value, data_id)
        with self._lock:
            if data_id not in self._versions:
                self.read_json(data_id)
            self._request("POST", data_id, content)
            self._versions[data_id] = hashlib.md5(content.encode("utf-8")).hexdigest()
