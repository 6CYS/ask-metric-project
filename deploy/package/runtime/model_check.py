"""现场模型协议检查：只发送合成文本，不输出凭据、响应正文或业务数据。"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx
from ask_metric.core.config_crypto import decrypt_config_value, load_config_sm4_key
from ask_metric.infrastructure.model.configuration import ModelRuntimeConfig
from ask_metric.infrastructure.model.provider import _normalize_rerank_response
from dotenv import dotenv_values


class ProbeError(ValueError):
    pass


def stream_reply(client, url, headers, body, timeout):
    calls = {}
    content = ""
    finished = False
    started = time.monotonic()
    with client.stream(
        "POST", url, headers=headers, json=body, timeout=timeout
    ) as response:
        response.raise_for_status()
        if "text/event-stream" not in response.headers.get("content-type", "").lower():
            raise ProbeError("需要 SSE，服务没有返回 text/event-stream")
        size = 0
        for line in response.iter_lines():
            size += len(line)
            if size > 1_000_000 or time.monotonic() - started > timeout:
                raise ProbeError("响应超过检查大小或总时限")
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            chunk = json.loads(data)
            if "error" in chunk:
                raise ProbeError("模型在 SSE 内返回错误；未显示原始错误正文")
            for choice in chunk.get("choices", []):
                delta = choice.get("delta") or {}
                content += delta.get("content") or ""
                finished |= choice.get("finish_reason") is not None
                for call in delta.get("tool_calls", []):
                    item = calls.setdefault(
                        call["index"], {"id": "", "name": "", "arguments": ""}
                    )
                    item["id"] += call.get("id") or ""
                    item["name"] += (call.get("function") or {}).get("name") or ""
                    item["arguments"] += (call.get("function") or {}).get(
                        "arguments"
                    ) or ""
    if not finished:
        raise ProbeError("SSE 缺少结束标记 finish_reason")
    return calls, content


def check_chat(client, endpoint, url, headers):
    function = {
        "name": "deployment_echo",
        "description": "Deployment test: echo synthetic text.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    }
    messages = [
        {
            "role": "user",
            "content": 'Call deployment_echo with text="ok".'
            + endpoint.user_message_suffix,
        }
    ]
    body = {
        "model": endpoint.model,
        "messages": messages,
        "stream": True,
        "temperature": endpoint.temperature,
        "max_tokens": min(endpoint.max_tokens or 1024, 256),
        "tools": [{"type": "function", "function": function}],
        "tool_choice": "auto",
    }
    # 与新版 Agent 一样，使用工具协议而非强制 JSON 内容模式。
    body.update(endpoint.extra_body)
    if endpoint.send_enable_thinking:
        body["enable_thinking"] = endpoint.enable_thinking
    if endpoint.chat_template_kwargs:
        body["chat_template_kwargs"] = endpoint.chat_template_kwargs
    calls, _ = stream_reply(client, url, headers, body, endpoint.timeout_seconds)
    if len(calls) != 1:
        raise ProbeError(
            "本次没有得到一个工具调用；可能不支持 tools，也可能模型未按指令调用"
        )
    call = next(iter(calls.values()))
    if (
        not call["id"]
        or call["name"] != "deployment_echo"
        or json.loads(call["arguments"]) != {"text": "ok"}
    ):
        raise ProbeError("tool_calls 的名称、ID 或 JSON 参数不符合检查要求")
    messages.extend(
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {
                            "name": call["name"],
                            "arguments": call["arguments"],
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": call["id"], "content": '{"text":"ok"}'},
        ]
    )
    # 工具结果回送后关闭继续调用，验证完整的一轮工具协议。
    body["tool_choice"] = "none"
    calls, content = stream_reply(client, url, headers, body, endpoint.timeout_seconds)
    if calls or not content.strip():
        raise ProbeError("工具结果回送后未收到有效文本回答")
    return "SSE + tool_calls + 工具结果回送通过（仅合成样例）"


def check_json(client, role, endpoint, url, headers):
    payload = (
        {"input": ["deployment check"], "encoding_format": endpoint.encoding_format}
        if role == "embedding"
        else {
            "query": "deployment check",
            endpoint.documents_field: ["deployment check", "other sample"],
        }
    )
    if endpoint.send_model:
        payload["model"] = endpoint.model
    if role == "embedding":
        if endpoint.dimensions is not None:
            payload["dimensions"] = endpoint.dimensions
        if endpoint.user:
            payload["user"] = endpoint.user
    else:
        if endpoint.send_top_n:
            payload["top_n"] = 2
        if endpoint.send_return_documents:
            payload["return_documents"] = endpoint.return_documents
    payload.update(endpoint.extra_body)
    response = client.post(
        url, headers=headers, json=payload, timeout=endpoint.timeout_seconds
    )
    response.raise_for_status()
    result = response.json()
    if role == "embedding":
        vector = result["data"][0]["embedding"]
        if (
            not isinstance(vector, list)
            or not vector
            or not all(type(v) in (int, float) for v in vector)
        ):
            raise ProbeError("embedding 响应不是 data[].embedding 数值数组")
        return f"data[].embedding 通过；维度 {len(vector)}"
    rows = _normalize_rerank_response(
        result, payload[endpoint.documents_field], endpoint=endpoint.path
    )
    if not rows or not all(
        type(row.get("index")) is int
        and 0 <= row["index"] < 2
        and type(row.get("relevance_score")) in (int, float)
        for row in rows
    ):
        raise ProbeError("rerank 索引或分数格式不符合应用要求")
    return "results 或 scores/texts 响应通过"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--old-env",
        type=Path,
        default=Path("/home/appuser/ask-metric-config-uat/backend.env"),
    )
    args = parser.parse_args()
    try:
        values = dict(dotenv_values(args.old_env, interpolate=False))
        if values.get("MODEL_SECRET_ENV_PATH"):
            values = {
                **dotenv_values(values["MODEL_SECRET_ENV_PATH"], interpolate=False),
                **values,
            }
        key_file = values.get("ASK_METRIC_CONFIG_SM4_KEY_FILE")
        key = (
            load_config_sm4_key(environ={}, key_file=Path(key_file))
            if key_file
            else None
        )
        model_file = Path(values["MODEL_CONFIG_PATH"])
        config = ModelRuntimeConfig.model_validate_json(
            model_file.read_text(encoding="utf-8-sig")
        )
        print(f"配置来源：{model_file}", flush=True)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(
            f"配置读取失败：{type(exc).__name__}；检查 --old-env 及资源/密钥文件权限。"
        )
        return 1
    failed = False
    with httpx.Client(trust_env=False) as client:
        for role in ("chat", "embedding", "reranker"):
            endpoint = getattr(config.models, role)
            if not endpoint.enabled:
                print(f"{role}: SKIP（现场配置关闭）", flush=True)
                continue
            try:
                base = values.get(endpoint.base_url_env) or endpoint.base_url
                base = decrypt_config_value(base, key).rstrip("/")
                url = base + endpoint.path
                headers = {}
                if endpoint.authentication.type != "none":
                    secret = values.get(endpoint.api_key_env)
                    if not secret:
                        raise ProbeError("配置中缺少模型凭据引用")
                    headers[endpoint.authentication.header] = (
                        endpoint.authentication.prefix
                        + decrypt_config_value(secret, key)
                    )
                print(f"{role}: {url} | model={endpoint.model}", flush=True)
                result = (
                    check_chat(client, endpoint, url, headers)
                    if role == "chat"
                    else check_json(client, role, endpoint, url, headers)
                )
                print(f"{role}: PASS；{result}", flush=True)
            except httpx.HTTPStatusError as exc:
                print(
                    f"{role}: FAIL；HTTP {exc.response.status_code}（未输出响应正文或凭据）",
                    flush=True,
                )
                failed = True
            except ProbeError as exc:
                print(f"{role}: FAIL；{exc}", flush=True)
                failed = True
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                AttributeError,
                httpx.HTTPError,
            ) as exc:
                print(
                    f"{role}: FAIL；{type(exc).__name__}（未输出响应正文或凭据）",
                    flush=True,
                )
                failed = True
    print(
        "上下文窗口：仍需模型管理员确认；输出上限 max_tokens 不是上下文窗口。",
        flush=True,
    )
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
