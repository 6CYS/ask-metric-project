"""问句边界的隔离目录回归；目录为合成夹具，原问来自 U05、M1-2、M3 失败证据。"""

from datetime import date

import pytest

from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.metric_candidates import MetricCandidateIndex
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem

QUESTION = "省联社2026年8月27日个人存款和个人定期存款分别有多少？请分开列。"


@pytest.fixture
def catalog():
    items = []
    for code, base, alias in [
        ("personal", "个人存款余额", "个人存款"),
        ("term", "个人定期存款余额", "个人定期存款"),
    ]:
        for suffix, basis, writing in [
            ("", "当日数", "当日值"),
            ("_month", "较上月", "较上月"),
            ("_rate", "较同期增长率", "较同期增长率"),
        ]:
            items.append(MetricCatalogItem(
                code=code + suffix, name=base + basis, base_name=base,
                value_basis=basis, source_metric_code=code, aliases=[alias + writing],
            ))
    return items


def test_parallel_question_keeps_both_exact_catalog_aliases(catalog):
    mentions = MetricCandidateIndex(catalog).mentions(QUESTION)

    assert [(item["text"], item["start"], item["end"]) for item in mentions] == [
        ("个人存款", 13, 17), ("个人定期存款", 18, 24),
    ]
    assert [item["resolution"]["status"] for item in mentions] == ["resolved", "resolved"]
    assert [item["resolution"]["value"]["codes"] for item in mentions] == [["personal"], ["term"]]


@pytest.mark.parametrize("suffix", [
    "有多少", "是多少", "为多少", "分别有多少", "分别是多少", "各有多少", "各是多少",
])
def test_question_predicate_does_not_extend_exact_alias(catalog, suffix):
    mentions = MetricCandidateIndex(catalog).mentions("个人定期存款" + suffix + "？")

    assert len(mentions) == 1
    assert mentions[0]["text"] == "个人定期存款"
    assert mentions[0]["resolution"]["status"] == "resolved"
    assert mentions[0]["resolution"]["value"]["codes"] == ["term"]


def test_longer_formal_name_still_wins_over_alias(catalog):
    mentions = MetricCandidateIndex(catalog).mentions("个人定期存款余额当日数是多少？")

    assert len(mentions) == 1
    assert mentions[0]["text"] == "个人定期存款余额当日数"
    assert mentions[0]["resolution"]["status"] == "resolved"
    assert mentions[0]["resolution"]["value"]["codes"] == ["term"]


@pytest.mark.parametrize("question", [
    "个人定期存款余額", "个人定期存款余款",
    "个人定期存款余額有多少", "个人定期存款余款是多少",
    "个人定期存款3余额当日数", "个人定期存款不含余额当日数",
    "个人定期存款比例当日数", "个人定期存款百分之三当日数",
    "个人定期存款分别有3笔", "个人定期存款分别不含外币", "个人定期存款分别占比多少",
    "个人定期存款有多少笔", "个人定期存款分别有多少户", "个人定期存款各有多少笔",
    "个人定期存款较同期增", "个人定期存款余额较同期增",
])
def test_typo_and_semantic_qualifiers_still_require_confirmation(catalog, question):
    mentions = MetricCandidateIndex(catalog).mentions(question)

    assert mentions
    assert all(item["resolution"]["status"] == "needs_confirmation" for item in mentions)
    assert all("value" not in item["resolution"] for item in mentions)


def test_goal_facts_preserve_shared_conditions_without_clarifying_metrics(catalog):
    facts = inspect_goal(
        QUESTION, date(2026, 10, 24), catalog,
        [OrganizationCatalogItem(code="province", name="省联社")],
    )

    assert facts["requires_calculation"] is False
    assert len(facts["fragments"]) == 1
    fragment = facts["fragments"][0]
    assert fragment["organizations"] == ["province"]
    assert fragment["calendar"] == {
        "ranges": [{"start": "2026-08-27", "end": "2026-08-27"}], "unresolved": [],
    }
    assert [item["resolution"]["status"] for item in fragment["mentions"]] == [
        "resolved", "resolved",
    ]


@pytest.fixture
def margin_catalog(catalog):
    return catalog + [
        MetricCatalogItem(
            code="margin" + suffix, name="对公保证金存款余额" + basis,
            base_name="对公保证金存款余额", value_basis=basis,
            source_metric_code="margin", aliases=["开票押金" + writing],
        )
        for suffix, basis, writing in [
            ("", "当日数", "当日值"),
            ("_month", "较上月", "较上月"),
            ("_rate", "较同期增长率", "较同期增长率"),
        ]
    ]


def test_balance_alias_covers_complete_metric_in_replacement_question(margin_catalog):
    mentions = MetricCandidateIndex(margin_catalog).mentions("换成开票押金余额，机构和日期都不变。")

    assert [(item["text"], item["start"], item["end"]) for item in mentions] == [
        ("开票押金余额", 2, 8),
    ]
    assert mentions[0]["resolution"]["status"] == "resolved"
    assert mentions[0]["resolution"]["value"]["codes"] == ["margin"]


@pytest.mark.parametrize(("raw", "code"), [
    ("开票押金余额", "margin"),
    ("开票押金余额较上月", "margin_month"),
    ("开票押金较上月", "margin_month"),
])
def test_balance_alias_satisfies_full_field_coverage_and_preserves_basis(margin_catalog, raw, code):
    resolution = resolve_catalog_field("metric", [raw], margin_catalog)

    assert resolution["status"] == "resolved"
    assert resolution["value"]["codes"] == [code]


@pytest.mark.parametrize("raw", [
    "开票押金余额占比", "开票押金余额不含外币", "开票押金不含余额",
    "开票押金余额较同期增", "开票押金余額当日数", "开票押金余款当日数",
])
def test_balance_alias_does_not_discard_qualifiers_or_create_typo_aliases(margin_catalog, raw):
    resolution = resolve_catalog_field("metric", [raw], margin_catalog)

    assert resolution["status"] == "needs_confirmation"
    assert "value" not in resolution


@pytest.mark.parametrize("name, aliases", [
    ("开票押金余额", []), ("其他业务金额", ["开票押金余额"]),
])
def test_balance_composition_preserves_existing_full_name_or_alias(margin_catalog, name, aliases):
    items = margin_catalog + [MetricCatalogItem(code="other", name=name, aliases=aliases)]
    mentions = MetricCandidateIndex(items).mentions("开票押金余额")

    assert len(mentions) == 1
    assert mentions[0]["resolution"]["value"]["codes"] == ["other"]
    assert resolve_catalog_field("metric", ["开票押金余额"], items)["value"]["codes"] == ["other"]


def test_balance_composition_preserves_existing_base_alias(margin_catalog):
    items = margin_catalog + [
        MetricCatalogItem(
            code="other" + suffix, name="其他专户余额" + basis, base_name="其他专户余额",
            value_basis=basis, source_metric_code="other", aliases=["开票押金余额" + writing],
        )
        for suffix, basis, writing in [("", "当日数", "当日值"), ("_month", "较上月", "较上月")]
    ]
    resolution = resolve_catalog_field("metric", ["开票押金余额较上月"], items)

    assert resolution["status"] == "resolved"
    assert resolution["value"]["codes"] == ["other_month"]


@pytest.mark.parametrize("conflict", ["full_name", "full_alias", "base_alias"])
def test_ambiguous_original_alias_is_not_extended_to_balance(margin_catalog, conflict):
    if conflict == "base_alias":
        additions = [item.model_copy(update={
            "code": item.code.replace("margin", "other"),
            "source_metric_code": "other", "base_name": "其他专户余额",
            "name": "其他专户余额" + item.value_basis,
        }) for item in margin_catalog if item.source_metric_code == "margin"]
    else:
        additions = [MetricCatalogItem(
            code="other", name="开票押金" if conflict == "full_name" else "其他业务金额",
            aliases=["开票押金"] if conflict == "full_alias" else [],
        )]
    resolution = resolve_catalog_field("metric", ["开票押金余额"], margin_catalog + additions)

    assert resolution["status"] != "resolved"
    assert "value" not in resolution


def test_non_balance_source_does_not_gain_balance_alias(margin_catalog):
    items = [item.model_copy(update={
        "base_name": "保证金客户户数", "name": "保证金客户户数" + item.value_basis,
    }) if item.source_metric_code == "margin" else item for item in margin_catalog]
    resolution = resolve_catalog_field("metric", ["开票押金余额"], items)

    assert resolution["status"] == "needs_confirmation"
    assert "value" not in resolution


@pytest.fixture
def ratio_catalog():
    return [
        MetricCatalogItem(
            code=source + suffix, name=base + basis, base_name=base,
            value_basis=basis, source_metric_code=source, aliases=["活期比例" + writing],
            unit="%",
        )
        for source, base in [
            ("overall_ratio", "活期存款余额占比_含协定"),
            ("personal_ratio", "个人活期存款余额占比"),
        ]
        for suffix, basis, writing in [
            ("", "当日数", "当日值"),
            ("_month", "较上月", "较上月"),
            ("_year", "较同期", "较同期"),
            ("_previous", "上日数", "上日数"),
        ]
    ]


def test_shared_exact_alias_keeps_both_catalog_defaults_as_confirmation(ratio_catalog):
    items = ratio_catalog + [MetricCatalogItem(
        code="old_balance_year", name="活期存款余额较同期", aliases=["活期同比"], unit="元",
    )]
    mentions = MetricCandidateIndex(items).mentions("查省联社2026年7月31日的活期比例。")

    assert len(mentions) == 1
    assert mentions[0]["text"] == "活期比例"
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert "value" not in resolution
    assert {item["code"] for item in resolution["candidates"]} == {
        "overall_ratio", "personal_ratio",
    }
    field = resolve_catalog_field("metric", ["活期比例"], items)
    assert field["status"] == "needs_confirmation"
    assert "value" not in field
    assert {item["code"] for item in field["candidates"]} == {
        "overall_ratio", "personal_ratio",
    }


@pytest.mark.parametrize("default_problem", ["missing", "duplicate"])
def test_shared_alias_does_not_narrow_defaults_unless_every_source_has_one(
    ratio_catalog, default_problem,
):
    if default_problem == "missing":
        items = [item for item in ratio_catalog if item.code != "personal_ratio"]
    else:
        original = next(item for item in ratio_catalog if item.code == "personal_ratio")
        items = ratio_catalog + [original.model_copy(update={"code": "personal_ratio_duplicate"})]
    mentions = MetricCandidateIndex(items).mentions("活期比例")

    assert len(mentions) == 1
    assert mentions[0]["text"] == "活期比例"
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert "value" not in resolution
    assert {item["code"] for item in resolution["candidates"]} == {item.code for item in items}


def test_shared_alias_with_explicit_basis_keeps_only_that_basis(ratio_catalog):
    resolution = resolve_catalog_field("metric", ["活期比例较上月"], ratio_catalog)

    assert resolution["status"] == "ambiguous"
    assert "value" not in resolution
    assert {item["code"] for item in resolution["candidates"]} == {
        "overall_ratio_month", "personal_ratio_month",
    }


def test_shared_alias_does_not_override_another_formal_base(ratio_catalog):
    items = ratio_catalog + [MetricCatalogItem(
        code="formal_ratio", name="活期比例当日数", source_metric_code="formal_ratio",
        base_name="活期比例", value_basis="当日数", unit="%",
    )]
    resolution = resolve_catalog_field("metric", ["活期比例"], items)

    assert resolution["status"] == "resolved"
    assert resolution["value"]["codes"] == ["formal_ratio"]


def test_shared_alias_homophone_still_requires_confirmation(ratio_catalog):
    mentions = MetricCandidateIndex(ratio_catalog).mentions("活期比利")

    assert mentions
    assert all(item["resolution"]["status"] == "needs_confirmation" for item in mentions)
    assert all("value" not in item["resolution"] for item in mentions)
