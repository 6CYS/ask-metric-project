"""机构写法剥离组织形式后缀后的核心名匹配：唯一相等直接解析，截断与撞名仍确认。"""

import pytest

from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem

CATALOG = [
    OrganizationCatalogItem(
        code="320188000", name="江苏紫金农村商业银行",
        aliases=["紫金", "紫金农商", "紫金银行"],
    ),
    OrganizationCatalogItem(
        code="320602000", name="江苏南通农村商业银行",
        aliases=["南通", "南通农商", "南通银行"],
    ),
]


@pytest.mark.parametrize("raw", [
    "紫金", "紫金农商", "紫金农商行", "紫金农商银行", "紫金银行", "江苏紫金农商行",
])
def test_institution_form_variants_resolve_without_confirmation(raw):
    assert resolve_catalog_field("organization", [raw], CATALOG) == {
        "status": "resolved",
        "value": {"codes": ["320188000"], "names": ["江苏紫金农村商业银行"]},
    }


def test_core_matching_applies_to_own_level_rule():
    result = resolve_catalog_field("organization", ["紫金农商行本级"], CATALOG)
    assert result["value"]["codes"] == ["320188000"]


def test_strict_exact_keeps_precedence_over_core_matching():
    items = [
        OrganizationCatalogItem(code="A", name="甲农村商业银行", aliases=["甲农商"]),
        OrganizationCatalogItem(code="B", name="甲农商行"),
    ]
    result = resolve_catalog_field("organization", ["甲农商行"], items)
    assert result["value"]["codes"] == ["B"]


def test_same_core_name_stays_ambiguous():
    items = [
        OrganizationCatalogItem(code="A", name="甲农村商业银行"),
        OrganizationCatalogItem(code="B", name="甲农商行"),
    ]
    result = resolve_catalog_field("organization", ["甲农商"], items)
    assert result["status"] == "ambiguous"
    assert {candidate["code"] for candidate in result["candidates"]} == {"A", "B"}


def test_truncated_or_unknown_text_still_needs_confirmation():
    for raw in ("紫金农", "独特未知实体xyz"):
        result = resolve_catalog_field("organization", [raw], CATALOG)
        assert result["status"] != "resolved"
        assert result["metadata"]["issues"][0]["rawValue"] == raw


def test_metric_terms_do_not_use_core_matching():
    items = [MetricCatalogItem(code="M", name="农商存款余额")]
    result = resolve_catalog_field("metric", ["农商存款余额行"], items)
    assert result["status"] != "resolved" or "M" not in result.get("value", {}).get("codes", [])
