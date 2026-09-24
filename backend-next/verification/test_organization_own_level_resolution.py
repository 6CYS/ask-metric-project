"""机构本级修饰只允许精确实体映射，保留原文和原有模糊匹配。"""

import pytest

from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


@pytest.mark.parametrize("raw", ["甲农商行本级", "甲行本级", " 甲 农 商 行 本 级 "])
def test_own_level_resolves_unique_exact_name_or_alias_without_children(raw):
    items = [
        OrganizationCatalogItem(code="A", name="甲农商行", aliases=["甲行"]),
        OrganizationCatalogItem(code="A1", name="甲农商行第一支行"),
    ]
    assert resolve_catalog_field("organization", [raw], items) == {
        "status": "resolved", "value": {"codes": ["A"], "names": ["甲农商行"]},
    }


@pytest.mark.parametrize("field", ["name", "alias"])
def test_full_catalog_term_ending_in_own_level_takes_precedence(field):
    full = OrganizationCatalogItem(
        code="B", name="甲农商行本级" if field == "name" else "另一正式机构",
        aliases=["甲农商行本级"] if field == "alias" else [],
    )
    items = [OrganizationCatalogItem(code="A", name="甲农商行"), full]
    result = resolve_catalog_field("organization", ["甲农商行本级"], items)
    assert result["value"]["codes"] == ["B"]


def test_own_level_duplicate_name_preserves_ambiguity_and_raw_value():
    items = [OrganizationCatalogItem(code=code, name="同名农商行") for code in ("A", "B")]
    result = resolve_catalog_field("organization", ["同名农商行本级"], items)
    assert result["status"] == "ambiguous"
    assert {candidate["code"] for candidate in result["candidates"]} == {"A", "B"}
    assert result["metadata"]["issues"] == [
        {"rawValue": "同名农商行本级", "reason": "ambiguous"},
    ]


def test_multiple_own_level_organizations_do_not_expand_or_drop_targets():
    items = [OrganizationCatalogItem(code=code, name=name) for code, name in (
        ("A", "甲农商行"), ("B", "乙农商行"), ("A1", "甲农商行第一支行"),
    )]
    raw = ["甲农商行本级", "乙农商行本级"]
    result = resolve_catalog_field("organization", raw, items)
    assert result["value"]["codes"] == ["A", "B"]
    assert raw == ["甲农商行本级", "乙农商行本级"]
    unresolved = resolve_catalog_field("organization", [*raw, "独特未知实体xyz本级"], items)
    assert unresolved["status"] != "resolved"
    assert "value" not in unresolved
    assert unresolved["metadata"]["issues"][0]["rawValue"] == "独特未知实体xyz本级"


def test_own_level_suffix_does_not_turn_partial_or_unknown_name_into_exact():
    items = [OrganizationCatalogItem(code="A", name="甲农商行")]
    for raw in ("甲农本级", "独特未知实体xyz本级", "本级", "甲农商行本级支行"):
        result = resolve_catalog_field("organization", [raw], items)
        assert result["status"] != "resolved"
        assert result["metadata"]["issues"][0]["rawValue"] == raw
    assert resolve_catalog_field("organization", ["甲农"], items)["status"] == "needs_confirmation"


def test_metric_names_do_not_use_organization_own_level_rule():
    items = [MetricCatalogItem(code="M", name="指标甲")]
    result = resolve_catalog_field("metric", ["指标甲本级"], items)
    assert result["status"] != "resolved"
