"""Nacos 确认写入后可能延迟可读；发布等待只执行读操作。"""

import importlib.util
from pathlib import Path

import pytest

from ask_metric.infrastructure.config_center.nacos import ConfigCenterError

spec = importlib.util.spec_from_file_location(
    "uat_publish", Path(__file__).resolve().parents[2] / "deploy/package/uat_deploy.py"
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ReadOnlyStore:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = 0

    def read_json(self, name):
        self.calls += 1
        result = next(self.responses)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def clock(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(deploy.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(deploy.time, "sleep", lambda seconds: now.__setitem__(0, now[0] + seconds))
    return now


def test_waits_for_missing_and_stale_node_cache_without_republishing(clock, capsys):
    expected = {"value": "new"}
    store = ReadOnlyStore(
        [ConfigCenterError("Nacos 缺少配置：synthetic.yaml"), {"value": "old"}, expected]
    )
    deploy.verify_published(store, "synthetic.yaml", expected)
    assert store.calls == 3
    assert clock[0] == 2
    assert capsys.readouterr().out.count("等待节点回读") == 1


def test_consistent_read_does_not_sleep(clock):
    store = ReadOnlyStore([{"value": 1}])
    deploy.verify_published(store, "synthetic.yaml", {"value": 1})
    assert clock[0] == 0


def test_missing_read_has_bounded_wait_and_safe_diagnostic(clock):
    store = ReadOnlyStore([ConfigCenterError("Nacos 缺少配置：synthetic.yaml")] * 3)
    with pytest.raises(ConfigCenterError, match="已确认写入.*2 秒内一致"):
        deploy.verify_published(
            store, "synthetic.yaml", {"value": "synthetic-secret"}, timeout_seconds=2
        )
    assert store.calls == 3
    assert clock[0] == 2


def test_permissions_are_not_treated_as_sync_delay(clock):
    store = ReadOnlyStore([ConfigCenterError("Nacos 配置访问被拒绝：synthetic.yaml")])
    with pytest.raises(ConfigCenterError, match="被拒绝"):
        deploy.verify_published(store, "synthetic.yaml", {})
    assert store.calls == 1
    assert clock[0] == 0
