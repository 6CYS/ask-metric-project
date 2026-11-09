"""目录读取契约与取数开销；SQLite 样本仅用于隔离验证。"""

from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.application.result_enrichment import CatalogResultEnricher
from ask_metric.application.result_processing import process_query_result
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import QueryExecutionPlan
from ask_metric.domain.value_presentation import display_number
from ask_metric.infrastructure.db.models import MetricSynonym, MetricTerm
from ask_metric.infrastructure.semantic.catalogs import SqlAlchemyMetricCatalogRepository


@pytest.fixture(params=[False, True], ids=["legacy", "source-columns"])
def catalog_database(tmp_path, request):
    engine = create_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    MetricTerm.__table__.create(engine)
    MetricSynonym.__table__.create(engine)
    source_columns = request.param
    with engine.begin() as connection:
        if not source_columns:
            for column in ("source_metric_code", "base_name", "value_basis"):
                connection.exec_driver_sql(f"ALTER TABLE metric_terms DROP COLUMN {column}")
        connection.execute(text(
            "INSERT INTO metric_terms (metric_code, metric_name, description, unit, "
            "metric_explanation, enabled, created_at, updated_at) VALUES "
            "(:code, :name, :description, :unit, :explanation, :enabled, "
            "'2026-11-02 10:00:00', '2026-11-02 10:00:00')"
        ), [
            {"code": "b", "name": "乙指标", "description": "", "unit": None,
             "explanation": "", "enabled": True},
            {"code": "a", "name": "甲余额", "description": "人工维护口径", "unit": "元",
             "explanation": "源表指标定义", "enabled": True},
            {"code": "disabled", "name": "停用指标", "description": "", "unit": "元",
             "explanation": "", "enabled": False},
        ])
        if source_columns:
            connection.execute(text(
                "UPDATE metric_terms SET source_metric_code='source-a', "
                "base_name='甲指标', value_basis='余额' WHERE metric_code='a'"
            ))
        connection.execute(text(
            "INSERT INTO metric_synonyms (metric_code, synonym, weight, enabled, "
            "created_at, updated_at) VALUES (:code, :synonym, :weight, :enabled, "
            "'2026-11-02 10:00:00', '2026-11-02 10:00:00')"
        ), [
            {"code": "a", "synonym": "b-alias", "weight": 2, "enabled": True},
            {"code": "a", "synonym": "c-alias", "weight": 3, "enabled": True},
            {"code": "a", "synonym": "a-alias", "weight": 2, "enabled": True},
            {"code": "a", "synonym": "c-alias", "weight": 1, "enabled": True},
            {"code": "a", "synonym": "disabled-alias", "weight": 9, "enabled": False},
            {"code": "disabled", "synonym": "停用指标别名", "weight": 9, "enabled": True},
        ])
    yield engine, source_columns
    engine.dispose()


def expected_catalog(source_columns):
    return [
        {"code": "a", "name": "甲余额", "unit": "元", "value_policy": "catalog_units_v1",
         "description": "人工维护口径",
         "explanation": "源表指标定义", "aliases": ["c-alias", "a-alias", "b-alias"],
         "source_metric_code": "source-a" if source_columns else None,
         "base_name": "甲指标" if source_columns else None,
         "value_basis": "余额" if source_columns else None},
        {"code": "b", "name": "乙指标", "unit": None, "value_policy": "catalog_units_v1",
         "description": "", "explanation": "",
         "aliases": [], "source_metric_code": None, "base_name": None, "value_basis": None},
    ]


def test_enabled_catalog_preserves_fields_order_and_avoids_unused_entity_columns(catalog_database):
    engine, source_columns = catalog_database
    statements = []

    def record_sql(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", record_sql)
    try:
        with Session(engine) as session:
            repository = SqlAlchemyMetricCatalogRepository(session)
            result = repository.list_enabled(refresh=True)
            assert [item.model_dump() for item in result] == expected_catalog(source_columns)
            reads = [statement for statement in statements
                     if statement.startswith("select") and "max(" not in statement]
            assert len(reads) == 2
            assert all("created_at" not in statement and "updated_at" not in statement
                       for statement in reads)
            statements.clear()
            assert repository.list_enabled() == result
            assert all("max(" in statement for statement in statements
                       if statement.startswith("select"))
            assert repository.list_disabled()[0].unit == "元"
    finally:
        event.remove(engine, "before_cursor_execute", record_sql)


def test_refresh_observes_same_second_definition_and_alias_changes(catalog_database):
    engine, _source_columns = catalog_database
    with Session(engine) as session:
        before = SqlAlchemyMetricCatalogRepository(session).list_enabled(refresh=True)
    old_semantics = MetricSemantics(before, secret="test-secret", actor_id="test-user")
    binding = old_semantics.search("a")["items"][0]["binding_ref"]
    with engine.begin() as connection:
        connection.execute(text(
            "UPDATE metric_terms SET description='最新人工口径', unit='万元', "
            "updated_at='2026-11-02 10:00:00' WHERE metric_code='a'"
        ))
        connection.execute(text(
            "UPDATE metric_synonyms SET synonym='new-alias', updated_at='2026-11-02 10:00:00' "
            "WHERE metric_code='a' AND synonym='a-alias'"
        ))
    with Session(engine) as session:
        repository = SqlAlchemyMetricCatalogRepository(session)
        after = repository.list_enabled(refresh=True)
        assert after[0].description == "最新人工口径"
        assert after[0].unit == "万元"
        assert after[0].aliases == ["c-alias", "b-alias", "new-alias"]
        assert repository.list_enabled() == after
    current_semantics = MetricSemantics(after, secret="test-secret", actor_id="test-user")
    with pytest.raises(ApplicationError) as caught:
        current_semantics.resolve(binding)
    assert caught.value.code == "ANALYSIS_METADATA_CHANGED"


def test_matching_keeps_all_name_and_alias_competitors_without_semantic_filtering(catalog_database):
    engine, source_columns = catalog_database
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO metric_terms (metric_code, metric_name, description, unit, "
            "metric_explanation, enabled, created_at, updated_at) VALUES "
            "(:code, :name, '', :unit, '', 1, '2026-11-02 10:00:00', '2026-11-02 10:00:00')"
        ), [
            {"code": "c", "name": "另一候选", "unit": "%"},
            {"code": "d", "name": "c-alias", "unit": "元"},
            {"code": "e", "name": "未匹配指标", "unit": "元"},
        ])
        connection.execute(text(
            "INSERT INTO metric_synonyms (metric_code, synonym, weight, enabled, "
            "created_at, updated_at) VALUES (:code, 'c-alias', 1, :enabled, "
            "'2026-11-02 10:00:00', '2026-11-02 10:00:00')"
        ), [{"code": "c", "enabled": True}, {"code": "e", "enabled": False},
            {"code": "disabled", "enabled": True}])
        if source_columns:
            connection.execute(text(
                "UPDATE metric_terms SET value_basis='日均' WHERE metric_code='d'"
            ))
    with Session(engine) as session:
        repository = SqlAlchemyMetricCatalogRepository(session)
        result = repository.list_enabled_matching(codes={"b"}, names={"c-alias"})
        assert [item.code for item in result] == ["a", "b", "c", "d"]
        assert [item.model_dump() for item in result[:2]] == expected_catalog(source_columns)
        assert result[2].unit == "%"
        assert result[2].aliases == ["c-alias"]
        assert result[3].value_basis == ("日均" if source_columns else None)


def test_approved_ratio_keeps_display_and_legacy_binding(catalog_database, tmp_path):
    engine, _source_columns = catalog_database
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO metric_terms (metric_code, metric_name, description, unit, "
            "metric_explanation, enabled, created_at, updated_at) VALUES "
            "('ratio', '测试比率', '', '%', '', 1, '2026-11-02', '2026-11-02')"
        ))
    path = tmp_path / "semantics.json"
    path.write_text(
        '{"metrics":{"ratio":{"status":"approved","source":"隔离测试口径","value_encoding":"ratio"}}}',
        encoding="utf-8",
    )
    with Session(engine) as session:
        items = SqlAlchemyMetricCatalogRepository(session).list_enabled_matching(
            codes={"ratio"}, names=set(),
        )
    semantics = MetricSemantics(
        items, secret="test-secret", actor_id="test-user", topics={}, semantics_path=path,
    )
    assert display_number("1.6797", semantics.descriptor("ratio")) == "167.97%"
    # 同一正式指标和审核口径在切换前签发的测试引用。
    legacy = "m1.cmF0aW8.2531bc61a9059acf0d9e8c44.355516b75daa1a25fc662f93740bf125"
    assert semantics.resolve(legacy)["code"] == "ratio"


def test_query_result_keeps_catalog_unit_and_source_precision(catalog_database):
    engine, _source_columns = catalog_database
    rows = CatalogResultEnricher(lambda: Session(engine)).enrich([
        {"metric_code": "a", "metric_value": Decimal("123.45600"), "unit": "亿元"},
        {"metric_code": "b", "metric_value": Decimal("0.123400"), "unit": "元"},
    ])
    plan = QueryExecutionPlan(
        shape="metric_value", template="metric_value_latest", dialect="sqlite", dsl={},
    )
    results, _ = process_query_result(plan, rows)
    assert [(row["metric_value"], row["unit"]) for row in results] == [
        ("123.45600", "元"),
        ("0.123400", None),
    ]


def test_matching_reads_only_candidates_without_polluting_full_catalog_cache(catalog_database):
    engine, source_columns = catalog_database
    with Session(engine) as session:
        repository = SqlAlchemyMetricCatalogRepository(session)
        full = repository.list_enabled(refresh=True)
        statements = []

        def record_sql(_connection, _cursor, statement, _parameters, _context, _executemany):
            statements.append(statement.lower())

        event.listen(engine, "before_cursor_execute", record_sql)
        try:
            result = repository.list_enabled_matching(codes={"a"}, names=set())
            assert [item.model_dump() for item in result] == expected_catalog(source_columns)[:1]
            reads = [statement for statement in statements if statement.startswith("select")]
            assert len(reads) == 2
            assert all("max(" not in statement and "count(" not in statement for statement in reads)
            assert all("where" in statement and "metric_code in" in statement
                       for statement in reads)
            assert all("created_at" not in statement and "updated_at" not in statement
                       for statement in reads)
            assert repository.list_enabled() == full
            assert [item.code for item in full] == ["a", "b"]
        finally:
            event.remove(engine, "before_cursor_execute", record_sql)


def test_matching_empty_inputs_do_not_read_database(catalog_database):
    engine, _source_columns = catalog_database
    statements = []

    def record_sql(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record_sql)
    try:
        with Session(engine) as session:
            assert SqlAlchemyMetricCatalogRepository(session).list_enabled_matching(
                codes=set(), names=set(),
            ) == []
        assert statements == []
    finally:
        event.remove(engine, "before_cursor_execute", record_sql)


def test_matching_reloads_same_second_changes_and_disabled_candidates(catalog_database):
    engine, _source_columns = catalog_database
    with Session(engine) as session:
        repository = SqlAlchemyMetricCatalogRepository(session)
        repository.list_enabled(refresh=True)
        before = repository.list_enabled_matching(codes=set(), names={"a-alias"})
        assert [item.code for item in before] == ["a"]
    with engine.begin() as connection:
        connection.execute(text(
            "UPDATE metric_terms SET description='新口径', updated_at='2026-11-02 10:00:00' "
            "WHERE metric_code='a'"
        ))
        connection.execute(text(
            "UPDATE metric_synonyms SET synonym='new-alias', updated_at='2026-11-02 10:00:00' "
            "WHERE metric_code='a' AND synonym='a-alias'"
        ))
    with Session(engine) as session:
        repository = SqlAlchemyMetricCatalogRepository(session)
        assert repository.list_enabled_matching(codes=set(), names={"a-alias"}) == []
        after = repository.list_enabled_matching(codes=set(), names={"new-alias"})
        assert after[0].description == "新口径"
        assert after[0].aliases == ["c-alias", "b-alias", "new-alias"]
    with engine.begin() as connection:
        connection.execute(text(
            "UPDATE metric_terms SET enabled=0, updated_at='2026-11-02 10:00:00' "
            "WHERE metric_code='a'"
        ))
    with Session(engine) as session:
        assert SqlAlchemyMetricCatalogRepository(session).list_enabled_matching(
            codes={"a"}, names={"new-alias"},
        ) == []
