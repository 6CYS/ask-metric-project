"""旧目录表读取与新源字段读取的兼容回归，不连接实际应用库。"""

from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import Session

from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.infrastructure.db.models import MetricSynonym, MetricTerm
from ask_metric.infrastructure.semantic.catalogs import SqlAlchemyMetricCatalogRepository


def _engine(*, source_columns: bool):
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        suffix = (
            ", source_metric_code VARCHAR(128), base_name VARCHAR(255), value_basis VARCHAR(255)"
            if source_columns else ""
        )
        connection.exec_driver_sql(
            "CREATE TABLE metric_terms (id INTEGER PRIMARY KEY, metric_code VARCHAR(128), "
            "metric_name VARCHAR(255), description TEXT, unit VARCHAR(64), enabled BOOLEAN, "
            "metric_explanation TEXT, created_at DATETIME, updated_at DATETIME"
            f"{suffix})"
        )
        connection.exec_driver_sql(
            "INSERT INTO metric_terms (id, metric_code, metric_name, description, unit, enabled, "
            "metric_explanation, created_at, updated_at) VALUES "
            "(1, 'M1', '收单客户数量当日数', '', '户', 1, '', "
            "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), "
            "(2, 'M2', '个人贷记卡普通卡客户数量', '', '户', 1, '', "
            "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), "
            "(3, 'M3', '已停用指标', '', '户', 0, '', "
            "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        )
    MetricSynonym.__table__.create(engine)
    return engine


def test_legacy_metric_table_still_resolves_complete_names():
    engine = _engine(source_columns=False)
    with Session(engine) as session:
        repository = SqlAlchemyMetricCatalogRepository(session)
        items = repository.list_enabled()
        assert len(items) == 2
        assert all(item.source_metric_code is None for item in items)
        assert len(repository.list_disabled()) == 1
        mentions = metric_candidate_index(items).mentions(
            "紫金农商行4月末收单客户数量当日数、个人贷记卡普通卡客户数量是多少？"
        )
        assert [item["resolution"]["value"]["codes"] for item in mentions] == [
            ["M1"], ["M2"]
        ]
        rows = session.scalars(select(MetricTerm)).all()
        assert len(rows) == 3
        session.refresh(rows[0])
        assert rows[0].metric_name == "收单客户数量当日数"


def test_migrated_metric_table_loads_source_structure():
    engine = _engine(source_columns=True)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE metric_terms SET source_metric_code='SOURCE1', "
            "base_name='收单客户数量', value_basis='当日数' WHERE metric_code='M1'"
        )
    with Session(engine) as session:
        items = SqlAlchemyMetricCatalogRepository(session).list_enabled()
        metric = next(item for item in items if item.code == "M1")
        assert (metric.source_metric_code, metric.base_name, metric.value_basis) == (
            "SOURCE1", "收单客户数量", "当日数"
        )


def test_synonym_hard_delete_invalidates_catalog_cache(monkeypatch):
    # 类级缓存按连接地址与表版本记忆；隔离本用例，避免影响其他 sqlite:// 用例。
    monkeypatch.setattr(SqlAlchemyMetricCatalogRepository, "_source_structure_binds", set())
    monkeypatch.setattr(SqlAlchemyMetricCatalogRepository, "_cache_key", None)
    engine = _engine(source_columns=True)
    with Session(engine) as session:
        session.add(MetricSynonym(metric_code="M1", synonym="收单客户当日值"))
        session.commit()
        repository = SqlAlchemyMetricCatalogRepository(session)
        metric = next(item for item in repository.list_enabled() if item.code == "M1")
        assert metric.aliases == ["收单客户当日值"]
        # 硬删除不推进最新更新时间，缓存须按行数变化失效，推导的别名随之更新。
        session.execute(delete(MetricSynonym))
        session.commit()
        metric = next(item for item in repository.list_enabled() if item.code == "M1")
        assert metric.aliases == []
