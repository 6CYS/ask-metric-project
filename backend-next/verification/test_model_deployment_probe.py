"""现场检查使用合成 SSE，验证分片工具调用与工具结果回送。"""

import importlib.util
import json
import sys
from pathlib import Path

import httpx
import pytest

from ask_metric.core.config_crypto import encrypt_config_value
from ask_metric.infrastructure.model.configuration import ChatModelConfig

spec = importlib.util.spec_from_file_location(
    "model_probe", Path(__file__).resolve().parents[2] / "deploy/package/runtime/model_check.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def event(delta, finish=None):
    return "data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": finish}]}) + "\n\n"


def test_fragmented_tools_and_result_round_trip():
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert request.headers["accessKey"] == "synthetic-only"
        assert body["messages"][0]["content"].endswith("\n/no_think")
        assert body["chat_template_kwargs"] == {"enable_thinking": False}
        assert "enable_thinking" not in body
        assert "response_format" not in body
        if len(calls) == 1:
            text = event(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-test",
                            "function": {"name": "deployment_echo", "arguments": '{"text":'},
                        }
                    ]
                }
            )
            text += event({"tool_calls": [{"index": 0, "function": {"arguments": '"ok"}'}}]})
            text += event({}, "tool_calls")
        else:
            assert body["tool_choice"] == "none"
            assert body["messages"][-1] == {
                "role": "tool",
                "tool_call_id": "call-test",
                "content": '{"text":"ok"}',
            }
            text = event({"content": "ok"}) + event({}, "stop")
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, text=text + "data: [DONE]\n\n"
        )

    endpoint = ChatModelConfig(
        base_url="http://model.example",
        path="/v1/chat/completions",
        model="bank-chat",
        api_key_env="MODEL_CHAT_API_KEY",
        authentication={"type": "header", "header": "accessKey", "prefix": ""},
        max_tokens=1024,
        user_message_suffix="\n/no_think",
        send_enable_thinking=False,
        send_response_format=False,
    )
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = probe.check_chat(
            client,
            endpoint,
            "http://model.example/v1/chat/completions",
            {"accessKey": "synthetic-only"},
        )
    assert "通过" in result
    assert len(calls) == 2


@pytest.mark.parametrize(
    "content_type,text,match",
    [
        ("application/json", '{"choices":[]}', "需要 SSE"),
        (
            "text/event-stream",
            'data: {"error":{"message":"synthetic-secret"}}\n\n',
            "SSE 内返回错误",
        ),
        ("text/event-stream", event({"content": "ok"}) + "data: [DONE]\n\n", "缺少结束标记"),
    ],
)
def test_invalid_stream_is_not_reported_as_success(content_type, text, match):
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, headers={"content-type": content_type}, text=text)
        )
    ) as client:
        with pytest.raises(probe.ProbeError, match=match) as exc:
            probe.stream_reply(client, "http://model.example", {}, {}, 60)
    assert "synthetic-secret" not in str(exc.value)


def test_command_reads_encrypted_credentials_and_checks_three_roles(tmp_path, monkeypatch, capsys):
    key = bytes(range(16))
    (tmp_path / "master.key").write_text(key.hex())
    model = json.loads(
        (Path(__file__).resolve().parents[1] / "config/model-config.json").read_text()
    )
    for role in ("chat", "embedding", "reranker"):
        model["models"][role].update(
            enabled=True,
            base_url="http://model.example",
            base_url_env="",
            api_key_env="",
            authentication={"type": "none"},
        )
    model["models"]["chat"].update(
        api_key_env="MODEL_CHAT_API_KEY",
        send_enable_thinking=False,
        authentication={"type": "header", "header": "accessKey", "prefix": ""},
    )
    (tmp_path / "model.json").write_text(json.dumps(model))
    env = tmp_path / "old.env"
    env.write_text(
        "\n".join(
            [
                f"MODEL_CONFIG_PATH='{(tmp_path / 'model.json').as_posix()}'",
                f"ASK_METRIC_CONFIG_SM4_KEY_FILE='{(tmp_path / 'master.key').as_posix()}'",
                "MODEL_CHAT_API_KEY=" + encrypt_config_value("synthetic-secret", key),
            ]
        )
    )
    calls = []

    def handler(request):
        calls.append(request)
        body = json.loads(request.content)
        if request.url.path.endswith("chat/completions"):
            assert request.headers["accessKey"] == "synthetic-secret"
            delta = (
                {"content": "ok"}
                if body["messages"][-1]["role"] == "tool"
                else {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-check",
                            "function": {"name": "deployment_echo", "arguments": '{"text":"ok"}'},
                        }
                    ]
                }
            )
            text = event(delta) + event({}, "stop" if "content" in delta else "tool_calls")
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=text)
        assert "accessKey" not in request.headers
        if request.url.path.endswith("embeddings"):
            return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2]}]})
        assert "model" not in body and "top_n" not in body and "return_documents" not in body
        return httpx.Response(200, json={"scores": [0.9, 0.1], "texts": body["texts"]})

    client_type = httpx.Client
    monkeypatch.setattr(
        probe.httpx, "Client", lambda **kwargs: client_type(transport=httpx.MockTransport(handler))
    )
    monkeypatch.setattr(sys, "argv", ["model_check.py", "--old-env", str(env)])
    assert probe.main() == 0
    output = capsys.readouterr().out
    assert len(calls) == 4
    assert output.count("PASS") == 3
    assert "synthetic-secret" not in output
    assert "ENC[SM4" not in output
