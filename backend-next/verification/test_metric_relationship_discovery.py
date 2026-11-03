"""维护关系进入正式目录发现，但不把比例公式当成余额分项。"""

import json

import pytest
from sqlalchemy import create_engine, insert
from sqlalchemy.orm import Session

from ask_metric.application import metric_semantics
from ask_metric.application.metric_semantics import MetricSemantics, SemanticExtensions, digest
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.db.models import MetricSynonym, MetricTerm
from ask_metric.infrastructure.semantic.catalogs import SqlAlchemyMetricCatalogRepository


@pytest.fixture
def semantics_factory(tmp_path, monkeypatch):
    monkeypatch.setattr(metric_semantics, "CONFIG_DIR", tmp_path)

    def build(relations, codes=("total", "personal", "company", "share")):
        (tmp_path / "analysis-semantics.json").write_text(
            json.dumps({"relations": relations}), encoding="utf-8",
        )
        return MetricSemantics(
            [MetricCatalogItem(code=code, name=code, unit="元") for code in codes],
            secret="test-secret", actor_id="test-user", topics={},
        )

    return build


def relationship(**changes):
    return {
        "id": "customers", "status": "approved", "parent": "total",
        "children": ["personal", "company"], "source": "已确认客户分类",
        **changes,
    }


def test_legacy_relation_stays_readable_and_keeps_existing_metadata_digest(semantics_factory):
    legacy = relationship()
    semantics = semantics_factory([legacy])
    descriptor = semantics.descriptor("total")
    metric = {key: value for key, value in descriptor.items() if key != "metadata_version"}
    previous_version = digest({
        "metric": metric, "method": metric_semantics.METHOD_VERSION, "relations": [legacy],
    })[:24]
    assert descriptor["metadata_version"] == previous_version
    result = semantics.search("total")
    assert result["relations"][0]["kind"] == "classification"
    assert [item["code"] for item in result["related_metrics"]] == ["personal", "company"]


def test_classification_exposes_signed_formal_neighbors_without_changing_matches(semantics_factory):
    semantics = semantics_factory([relationship(kind="classification")])
    result = semantics.search("total", page_size=1)
    assert [item["code"] for item in result["items"]] == ["total"]
    assert result["relations"][0]["source"] == "已确认客户分类"
    for item in result["related_metrics"]:
        assert semantics.resolve(item["binding_ref"])["code"] == item["code"]
    reverse = semantics.search("personal", page_size=1)
    assert [item["code"] for item in reverse["related_metrics"]] == ["total", "company"]


def test_ratio_dependencies_are_discoverable_but_cannot_be_structure_components(semantics_factory):
    ratio = relationship(
        id="personal-share", kind="ratio", parent="share", children=["personal", "total"],
    )
    semantics = semantics_factory([ratio])
    result = semantics.search("share", page_size=1)
    assert [item["code"] for item in result["related_metrics"]] == ["personal", "total"]
    assert result["relations"][0]["numerator"] == "personal"
    assert result["relations"][0]["denominator"] == "total"
    assert semantics.relations([semantics.descriptor("share")]) == []


@pytest.mark.parametrize("kind", ["classification", "composition"])
def test_structure_keeps_existing_share_contract_for_confirmed_groups(semantics_factory, kind):
    semantics = semantics_factory([relationship(kind=kind)])
    assert semantics.relations([semantics.descriptor("total")])[0]["id"] == "customers"


def test_drafts_retired_and_members_absent_from_enabled_catalog_do_not_issue_references(
    semantics_factory,
):
    relations = [
        relationship(id="draft", kind="classification", status="draft"),
        relationship(id="retired", kind="classification", status="retired"),
        relationship(id="unavailable-member", kind="classification"),
    ]
    semantics = semantics_factory(relations, codes=("total", "personal"))
    result = semantics.search("total")
    assert result["related_metrics"] == []
    assert result["relations"] == []


def test_discovery_is_bounded_and_reports_omitted_relations(semantics_factory):
    relations = [relationship(id=f"r-{index}", kind="classification", children=[f"p-{index}"])
                 for index in range(30)]
    semantics = semantics_factory(relations, codes=("total", *(f"p-{i}" for i in range(30))))
    result = semantics.search("total", page_size=1)
    assert 0 < len(result["related_metrics"]) <= 24
    assert len(result["relations"]) <= 8
    assert result["has_more_relations"] is True


def test_disabled_catalog_member_is_not_reintroduced_through_approved_relation(
    semantics_factory, tmp_path,
):
    semantics_factory([relationship(kind="classification")])
    engine = create_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    try:
        MetricTerm.__table__.create(engine)
        MetricSynonym.__table__.create(engine)
        with engine.begin() as connection:
            connection.execute(insert(MetricTerm), [
                {"metric_code": code, "metric_name": code, "enabled": code != "company"}
                for code in ("total", "personal", "company")
            ])
        with Session(engine) as session:
            catalog = SqlAlchemyMetricCatalogRepository(session).list_enabled(refresh=True)
        semantics = MetricSemantics(catalog, secret="test", actor_id="user", topics={})
        result = semantics.search("total", page_size=1)
        assert "company" not in semantics.items
        assert result["related_metrics"] == []
        assert result["relations"] == []
    finally:
        engine.dispose()


def test_relation_validation_and_changed_definitions_still_reject_invalid_references(
    semantics_factory,
):
    with pytest.raises(ValueError):
        SemanticExtensions.model_validate({"relations": [relationship(source=" ")]})
    semantics = semantics_factory([relationship(kind="classification")])
    reference = semantics.search("total")["items"][0]["binding_ref"]
    changed = semantics_factory([relationship(kind="classification", source="修订分类依据")])
    with pytest.raises(ApplicationError, match="已更新"):
        changed.resolve(reference)
