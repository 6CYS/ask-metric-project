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

    def build(relations, codes=("total", "personal", "company", "share"), *, topics=None):
        (tmp_path / "analysis-semantics.json").write_text(
            json.dumps({"relations": relations}), encoding="utf-8",
        )
        return MetricSemantics(
            [MetricCatalogItem(code=code, name=code, unit="元") for code in codes],
            secret="test-secret", actor_id="test-user", topics=topics or {},
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


@pytest.fixture
def topic():
    return {
        "name": "客户分类",
        "default_sections": ["scale", "structure"],
        "metrics": [
            {
                "id": code,
                "code": code,
                "label": code,
                "names": [code],
                "units": ["元"],
                "value_basis": "当日数",
                "section": "scale" if code == "total" else "structure",
            }
            for code in ("total", "personal", "company", "share")
        ],
        "relationships": [
            {
                "id": "customers",
                "type": "classification",
                "parent": "total",
                "children": ["personal", "company"],
                "note": "仅用于客户分类观察；未经完整组成确认不能认定增减贡献。",
            }
        ],
    }


@pytest.mark.parametrize(
    ("keyword", "expected_codes"),
    [
        ("total", ["personal", "company"]),
        ("personal", ["total", "company"]),
    ],
)
@pytest.mark.parametrize(
    ("relation_type", "kind"),
    [
        ("classification", "classification"),
        ("reconciliation", "composition"),
    ],
)
def test_bound_topic_is_navigation_without_approving_calculation(
    semantics_factory,
    topic,
    keyword,
    expected_codes,
    relation_type,
    kind,
):
    topic["relationships"][0]["type"] = relation_type
    semantics = semantics_factory([], topics={"customers": topic})

    result = semantics.search(keyword, page_size=1)

    assert [item["code"] for item in result["items"]] == [keyword]
    assert [item["code"] for item in result["related_metrics"]] == expected_codes
    (relation,) = result["relations"]
    assert relation["id"] == "topic:customers:customers"
    assert (relation["status"], relation["origin"], relation["kind"]) == ("draft", "topic", kind)
    assert relation["source"] == topic["relationships"][0]["note"]
    assert relation["usage"] == "navigation_only"
    assert relation["notice"]
    for item in result["related_metrics"]:
        assert semantics.resolve(item["binding_ref"])["code"] == item["code"]
    assert semantics.relations([semantics.descriptor("total")]) == []


@pytest.mark.parametrize("change", ["missing", "disabled", "unit", "unsupported"])
def test_topic_navigation_does_not_bypass_binding_or_supported_type(
    semantics_factory,
    topic,
    change,
):
    if change == "missing":
        topic["metrics"][2]["code"] = "unavailable"
    elif change == "disabled":
        topic["metrics"][2]["disabled_reason"] = "业务口径待核对"
    elif change == "unit":
        topic["metrics"][2]["units"] = ["户"]
    else:
        topic["relationships"][0]["type"] = "unknown"
    semantics = semantics_factory([], topics={"customers": topic})

    result = semantics.search("total", page_size=1)

    assert result["relations"] == []
    assert result["related_metrics"] == []


def test_topic_navigation_expands_only_selected_candidates_one_hop(semantics_factory, topic):
    topic["relationships"].append(
        {
            "id": "subgroup",
            "type": "classification",
            "parent": "personal",
            "children": ["share"],
            "note": "二级分类",
        }
    )
    semantics = semantics_factory([], topics={"customers": topic})

    result = semantics.search("total", page_size=1)

    assert [item["id"] for item in result["relations"]] == ["topic:customers:customers"]
    assert [item["code"] for item in result["related_metrics"]] == ["personal", "company"]


@pytest.mark.parametrize(
    ("status", "expected_ids"),
    [
        ("approved", ["customers"]),
        ("retired", []),
        ("draft", ["topic:customers:customers"]),
    ],
)
def test_managed_review_state_controls_equivalent_topic_fallback(
    semantics_factory,
    topic,
    status,
    expected_ids,
):
    managed = relationship(kind="classification", status=status, children=["company", "personal"])
    semantics = semantics_factory([managed], topics={"customers": topic})

    result = semantics.search("total", page_size=1)

    assert [item["id"] for item in result["relations"]] == expected_ids
    if status == "approved":
        assert result["relations"][0]["source"] == "已确认客户分类"
        assert result["relations"][0]["status"] == "approved"
    elif status == "retired":
        assert result["related_metrics"] == []
    else:
        assert result["relations"][0]["usage"] == "navigation_only"


def test_equivalent_managed_relations_do_not_duplicate_navigation(semantics_factory):
    semantics = semantics_factory(
        [
            relationship(id="first", kind="classification"),
            relationship(id="second", kind="classification", children=["company", "personal"]),
        ]
    )

    result = semantics.search("total", page_size=1)

    assert [item["id"] for item in result["relations"]] == ["first"]
    assert [item["code"] for item in result["related_metrics"]] == ["personal", "company"]


def test_managed_override_does_not_hide_other_topic_groups(semantics_factory, topic):
    managed = relationship(kind="classification", status="retired", children=["personal"])
    semantics = semantics_factory([managed], topics={"customers": topic})

    result = semantics.search("total", page_size=1)

    assert [item["id"] for item in result["relations"]] == ["topic:customers:customers"]


@pytest.mark.parametrize(
    "managed",
    [
        relationship(),
        relationship(kind="composition"),
    ],
)
def test_legacy_and_different_relation_kinds_keep_their_semantics(
    semantics_factory,
    topic,
    managed,
):
    semantics = semantics_factory([managed], topics={"customers": topic})

    result = semantics.search("total", page_size=1)

    if "kind" not in managed:
        assert [item["id"] for item in result["relations"]] == ["customers"]
        assert result["relations"][0]["kind"] == "classification"
    else:
        assert [item["kind"] for item in result["relations"]] == ["composition", "classification"]


def test_ratio_dependency_order_is_not_deduplicated(semantics_factory):
    semantics = semantics_factory(
        [
            relationship(
                id="forward", kind="ratio", parent="share", children=["personal", "total"]
            ),
            relationship(
                id="reverse", kind="ratio", parent="share", children=["total", "personal"]
            ),
        ]
    )

    result = semantics.search("share", page_size=1)

    assert [(item["numerator"], item["denominator"]) for item in result["relations"]] == [
        ("personal", "total"),
        ("total", "personal"),
    ]


def test_managed_and_topic_navigation_share_existing_limits(semantics_factory, topic):
    codes = ("total", "personal", "company", "share", *(f"p-{i}" for i in range(8)))
    relations = [
        relationship(id=f"r-{i}", kind="classification", children=[f"p-{i}"]) for i in range(8)
    ]
    semantics = semantics_factory(relations, codes=codes, topics={"customers": topic})

    result = semantics.search("total", page_size=1)

    assert [item["id"] for item in result["relations"]] == [f"r-{i}" for i in range(8)]
    assert len(result["related_metrics"]) == 8
    assert result["has_more_relations"] is True
