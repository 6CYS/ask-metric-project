"""指标识别索引预热：启动时建好、目录变化后后台重建；使用合成目录与桩，不连接数据库或模型。"""

import time
from types import SimpleNamespace

from fastapi import Request
from fastapi.testclient import TestClient

from ask_metric import main
from ask_metric.api import dependencies
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.model.query_initialization import QueryInitialization

ITEMS = [MetricCatalogItem(code="A", name="合成余额当日数", source_metric_code="S",
                           base_name="合成余额", value_basis="当日数", aliases=["合余当日值"])]


class FakeUow:
    def __init__(self):
        self.metric_catalog = SimpleNamespace(list_enabled=lambda: ITEMS)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_initialization_builds_metric_index_even_without_embedding(monkeypatch):
    built = []
    monkeypatch.setattr(dependencies, "SqlAlchemyUnitOfWork", FakeUow)
    monkeypatch.setattr(dependencies, "metric_candidate_index", built.append)
    monkeypatch.setattr(dependencies, "get_model_service",
                        lambda request: SimpleNamespace(is_enabled=lambda capability: False))
    app = SimpleNamespace(state=SimpleNamespace(query_initialization=QueryInitialization()))
    dependencies.initialize_query_catalog(Request({"type": "http", "app": app}))
    assert built == [ITEMS]


def test_startup_warms_index_and_background_refresh_stops_with_app(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "METRIC_INDEX_REFRESH_SECONDS", 0.01)
    monkeypatch.setattr(dependencies, "initialize_query_catalog",
                        lambda request: calls.append("startup"))
    monkeypatch.setattr(dependencies, "warm_metric_index", lambda: calls.append("refresh"))
    with TestClient(main.create_app(initialize_catalog_on_startup=True)):
        deadline = time.monotonic() + 2
        while calls.count("refresh") < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
    assert "startup" in calls
    assert calls.count("refresh") >= 2
    stopped = len(calls)
    time.sleep(0.05)
    # 应用关闭后后台刷新线程随之退出，不再访问目录。
    assert len(calls) == stopped
