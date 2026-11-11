"""报告按已授权来源读取口径；SQLite 与业务配置均为隔离样本。"""

import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, insert, update
from sqlalchemy.orm import Session

from ask_metric.application import metric_semantics
from ask_metric.application.analysis_execution import GeneralAnalysisService
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.models import MetricSynonym, MetricTerm
from ask_metric.infrastructure.semantic.catalogs import SqlAlchemyMetricCatalogRepository


@pytest.fixture
def scoped_service(tmp_path, monkeypatch):
    topics = {"sample": {
        "name": "测试主题", "default_sections": ["scale"], "relationships": [],
        "comparison_suffixes": {"mom": {
            "difference": {"suffix": "_mom", "value_basis": "较上月"},
            "rate": {"suffix": "_mom_rate", "value_basis": "较上月增幅"},
        }},
        "metrics": [
            {"id": "total", "code": "balance", "names": ["余额"], "units": ["元"],
             "value_basis": "当日数", "section": "scale"},
            {"id": "rate", "names": ["收益率"], "units": ["%"],
             "value_basis": "当日数", "section": "scale", "value_encoding": "ratio"},
            {"id": "retired", "code": "noise", "names": ["无关指标"], "units": ["元"],
             "value_basis": "当日数", "section": "scale", "disabled_reason": "未启用映射"},
        ],
    }}
    for definition in topics["sample"]["metrics"]:
        definition["label"] = definition["id"]
    config = tmp_path / "business-topics.json"
    config.write_text(json.dumps({"topics": topics}), encoding="utf-8")
    monkeypatch.setattr(metric_semantics, "CONFIG_DIR", tmp_path)
    engine = create_engine(f"sqlite:///{tmp_path / 'scoped.db'}")
    MetricTerm.__table__.create(engine)
    MetricSynonym.__table__.create(engine)
    with engine.begin() as connection:
        connection.execute(insert(MetricTerm), [
            {"metric_code": code, "metric_name": name, "unit": unit, "value_basis": basis}
            for code, name, unit, basis in [
                ("balance", "余额当日数", "元", "当日数"),
                ("balance_mom", "余额较上月", "元", "较上月"),
                ("balance_mom_rate", "余额较上月增幅", "%", "较上月增幅"),
                ("special_comparison", "余额较上月", "元", "较上月"),
                ("rate", "正式收益率", "%", "当日数"),
                ("noise", "无关指标", "元", "当日数"),
            ]
        ])
        connection.execute(insert(MetricSynonym), [
            {"metric_code": "rate", "synonym": "收益率", "enabled": True},
            {"metric_code": "noise", "synonym": "收益率", "enabled": False},
        ])

    @contextmanager
    def uow():
        with Session(engine) as session:
            yield SimpleNamespace(metric_catalog=SqlAlchemyMetricCatalogRepository(session))

    service = GeneralAnalysisService(SimpleNamespace(uow_factory=uow), None, None, secret="test")
    actor = SimpleNamespace(user_id="test-user", subject="test-user")
    yield service, actor, engine, config, topics
    engine.dispose()


@pytest.mark.parametrize("comparison", ["balance_mom", "special_comparison", "balance_mom_rate"])
def test_scoped_descriptors_equal_full_catalog_without_loading_unrelated_metrics(
    scoped_service, comparison,
):
    service, actor, _engine, config, topics = scoped_service
    if comparison == "special_comparison":
        topics["sample"]["metrics"][0]["comparison_codes"] = {"mom": {"difference": comparison}}
        config.write_text(json.dumps({"topics": topics}), encoding="utf-8")
    full = service.semantics(actor)
    codes = {comparison, "rate"}
    with patch.object(SqlAlchemyMetricCatalogRepository, "list_enabled",
                      side_effect=AssertionError("报告不能加载全量目录")):
        scoped = service.semantics(actor, metric_codes=codes)
    assert set(scoped.items) == {comparison, "rate", "balance"}
    for code in codes:
        descriptor = full.descriptor(code)
        assert scoped.descriptor(code) == descriptor
        binding = full.binding(descriptor, "测试检索")
        assert scoped.resolve(binding) == full.resolve(binding)
    assert scoped.descriptor("rate")["value_encoding"] == "ratio"
    assert scoped.descriptor(comparison)["analysis_hint"]["comparison"] == "mom"
    assert scoped.descriptor(comparison)["value_encoding"] == (
        "ratio" if comparison == "balance_mom_rate" else None
    )


@pytest.mark.parametrize("change", ["definition", "alias_conflict", "disabled", "configuration"])
def test_new_preview_rechecks_definition_alias_conflicts_and_configuration(scoped_service, change):
    service, actor, engine, config, topics = scoped_service
    before = service.semantics(actor)
    binding = before.binding(before.descriptor("rate"), "收益率")
    if change == "configuration":
        topics["sample"]["metrics"][1]["value_encoding"] = "percent"
        config.write_text(json.dumps({"topics": topics}), encoding="utf-8")
    else:
        with engine.begin() as connection:
            if change == "definition":
                connection.execute(
                    update(MetricTerm).where(MetricTerm.metric_code == "rate")
                    .values(description="最新口径", updated_at=MetricTerm.updated_at),
                )
            elif change == "disabled":
                connection.execute(update(MetricTerm).where(MetricTerm.metric_code == "rate")
                                   .values(enabled=False, updated_at=MetricTerm.updated_at))
            else:
                connection.execute(insert(MetricTerm).values(
                    metric_code="competitor", metric_name="同名竞争者",
                    unit="%", value_basis="当日数",
                ))
                connection.execute(insert(MetricSynonym).values(
                    metric_code="competitor", synonym="收益率", enabled=True,
                ))
    scoped = service.semantics(actor, metric_codes={"rate"})
    full = service.semantics(actor)
    if change != "disabled":
        assert scoped.descriptor("rate") == full.descriptor("rate")
    for semantics in (scoped, full):
        with pytest.raises(ApplicationError) as caught:
            semantics.resolve(binding)
        assert caught.value.code == (
            "ANALYSIS_BINDING_INVALID" if change == "disabled" else "ANALYSIS_METADATA_CHANGED"
        )


def test_topic_candidates_keep_unit_basis_and_exact_name_rules(scoped_service):
    service, actor, engine, _config, _topics = scoped_service
    with engine.begin() as connection:
        connection.execute(insert(MetricTerm), [
            {"metric_code": code, "metric_name": "收益率", "unit": unit, "value_basis": basis}
            for code, unit, basis in [
                ("wrong-unit", "元", "当日数"), ("wrong-basis", "%", "较同期"),
            ]
        ])
    scoped = service.semantics(actor, metric_codes={"rate"})
    assert {"wrong-unit", "wrong-basis"} <= scoped.items.keys()
    assert scoped.descriptor("rate") == service.semantics(actor).descriptor("rate")
    assert scoped.descriptor("rate")["value_encoding"] == "ratio"


def test_source_descriptor_cannot_borrow_another_users_binding(scoped_service):
    service, actor, _engine, _config, _topics = scoped_service
    before = service.semantics(actor)
    binding = before.binding(before.descriptor("rate"), "收益率")
    other = SimpleNamespace(user_id="other-user", subject="other-user")
    with pytest.raises(ApplicationError) as caught:
        service.semantics(other, metric_codes={"rate"}).resolve(binding)
    assert caught.value.code == "ANALYSIS_BINDING_INVALID"


@pytest.mark.parametrize("change", [{"enabled": False}, {"value_basis": "其他口径"}])
def test_comparison_binding_observes_base_metric_changes(scoped_service, change):
    service, actor, engine, _config, _topics = scoped_service
    full = service.semantics(actor)
    binding = full.binding(full.descriptor("balance_mom"), "比较指标")
    with engine.begin() as connection:
        connection.execute(update(MetricTerm).where(MetricTerm.metric_code == "balance")
                           .values(**change, updated_at=MetricTerm.updated_at))
    scoped = service.semantics(actor, metric_codes={"balance_mom"})
    assert scoped.descriptor("balance_mom") == service.semantics(actor).descriptor("balance_mom")
    with pytest.raises(ApplicationError) as caught:
        scoped.resolve(binding)
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"


def test_empty_topic_snapshot_is_not_reloaded_during_scoped_construction(scoped_service):
    service, actor, _engine, config, _topics = scoped_service
    config.write_text('{"topics": {}}', encoding="utf-8")
    with patch.object(metric_semantics, "load_business_topics",
                      side_effect=AssertionError("构造器不能重新加载本次已读取的配置")):
        scoped = service.semantics(actor, metric_codes={"rate"})
    assert set(scoped.items) == {"rate"}
    assert scoped.descriptor("rate")["value_encoding"] is None
