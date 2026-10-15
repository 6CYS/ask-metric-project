"""机构匹配阶梯：精确 → 唯一包含 → 错字纠正 → 候选澄清。

目录别名按运行时合并后的形态构造（derive_org_aliases 派生 + 人工别名），
与 SqlAlchemyOrganizationCatalogRepository 加载结果一致。
"""

from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.org_aliases import derive_org_aliases
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


def _item(code: str, name: str, aliases: list[str] | None = None) -> OrganizationCatalogItem:
    return OrganizationCatalogItem(
        code=code, name=name, aliases=[*(aliases or []), *derive_org_aliases(name)],
    )


CATALOG = [
    _item("320001", "江苏农商联合银行（全省汇总）"),
    _item("321321", "江苏沭阳农村商业银行股份有限公司"),
    _item("321323", "江苏泗阳农村商业银行股份有限公司"),
    _item("320581", "江苏张家港农村商业银行股份有限公司"),
    _item("320582", "江苏江阴农村商业银行股份有限公司"),
    _item("321283", "江苏泰兴农村商业银行股份有限公司"),
]


def test_formal_name_and_code_resolve_exact():
    result = resolve_catalog_field(
        "organization", ["江苏江阴农村商业银行股份有限公司", "320582"], CATALOG,
    )
    assert result["status"] == "resolved"
    assert result["value"]["codes"] == ["320582"]
    assert result["metadata"]["resolution_source"] == "exact"


def test_derived_short_name_is_literal_alias_hit():
    # 派生别名合并后，“江阴”“江阴农商行”都是字面命中；更短的截断才走唯一包含。
    for raw in ("江阴", "江阴农商行", "江阴农商银行"):
        result = resolve_catalog_field("organization", [raw], CATALOG)
        assert result["status"] == "resolved"
        assert result["value"]["codes"] == ["320582"]
        assert result["metadata"]["resolution_source"] == "exact"


def test_unique_contains_resolves_without_confirmation():
    result = resolve_catalog_field("organization", ["江阴农"], CATALOG)
    assert result["status"] == "resolved"
    assert result["value"] == {
        "codes": ["320582"], "names": ["江苏江阴农村商业银行股份有限公司"],
    }
    assert result["metadata"]["resolution_source"] == "contains"


def test_shuyang_siyang_each_resolve_uniquely_without_cross_talk():
    for raw, code, name in (
        ("沭阳", "321321", "江苏沭阳农村商业银行股份有限公司"),
        ("泗阳", "321323", "江苏泗阳农村商业银行股份有限公司"),
    ):
        result = resolve_catalog_field("organization", [raw], CATALOG)
        assert result["status"] == "resolved"
        assert result["value"] == {"codes": [code], "names": [name]}


def test_single_character_typo_corrects_with_explicit_metadata():
    result = resolve_catalog_field("organization", ["沐阳"], CATALOG)
    assert result["status"] == "resolved"
    assert result["value"]["codes"] == ["321321"]
    assert result["metadata"]["resolution_source"] == "corrected"
    assert result["metadata"]["corrections"] == [{
        "raw": "沐阳",
        "corrected_name": "江苏沭阳农村商业银行股份有限公司",
        "corrected_code": "321321",
    }]


def test_homophone_typo_corrects_via_identical_pinyin():
    result = resolve_catalog_field("organization", ["张加港"], CATALOG)
    assert result["status"] == "resolved"
    assert result["value"]["codes"] == ["320581"]
    assert result["metadata"]["resolution_source"] == "corrected"
    assert result["metadata"]["corrections"][0]["corrected_code"] == "320581"


def test_close_competitors_stay_ambiguous_with_both_candidates():
    result = resolve_catalog_field("organization", ["氵阳"], CATALOG)
    assert result["status"] == "ambiguous"
    assert {candidate["code"] for candidate in result["candidates"]} == {"321321", "321323"}
    assert "value" not in result


def test_multi_contains_is_ambiguous():
    items = [
        _item("A", "江苏甲阳农村商业银行股份有限公司"),
        _item("B", "江苏乙阳农村商业银行股份有限公司"),
    ]
    result = resolve_catalog_field("organization", ["阳"], items)
    assert result["status"] == "ambiguous"
    assert {candidate["code"] for candidate in result["candidates"]} == {"A", "B"}


def test_zero_hit_keeps_catalog_rank_candidates():
    result = resolve_catalog_field("organization", ["昆仑山"], CATALOG)
    assert result["status"] == "not_found"
    assert result["metadata"]["issues"][0]["rawValue"] == "昆仑山"
    # 与编码片段有包含关系时维持既有 rank_organizations 候选。
    ranked = resolve_catalog_field("organization", ["321"], CATALOG)
    assert ranked["status"] == "needs_confirmation"
    assert {candidate["code"] for candidate in ranked["candidates"]} >= {"321321", "321323"}


# 真实 58 家法人行正式名称（数据湖机构维度快照），验证长错名的建议候选排序。
REAL_NAMES = (
    "徐州农村商业银行|徐州彭城农村商业银行|徐州淮海农村商业银行|无锡农村商业银行股份有限公司|"
    "江苏东台农村商业银行|江苏东海农村商业银行|江苏丰县农村商业银行|江苏丹阳农村商业银行|"
    "江苏仪征农村商业银行|江苏兴化农村商业银行股份有限公司|江苏南通农村商业银行|"
    "江苏句容农村商业银行|江苏启东农村商业银行|江苏大丰农村商业银行|江苏太仓农村商业银行|"
    "江苏如东农村商业银行|江苏如皋农村商业银行|江苏姜堰农村商业银行|江苏宜兴农村商业银行|"
    "江苏宝应农村商业银行|江苏射阳农村商业银行|江苏建湖农村商业银行|"
    "江苏张家港农村商业银行股份有限公司|江苏扬中农村商业银行股份有限公司|江苏扬州农村商业银行|"
    "江苏新沂农村商业银行股份有限公司|江苏民丰农村商业银行股份有限公司|江苏江都农村商业银行|"
    "江苏江阴农村商业银行股份有限公司|江苏沭阳农村商业银行|江苏泗洪农村商业银行|"
    "江苏泗阳农村商业银行|江苏泰兴农村商业银行|江苏泰州农村商业银行|江苏洪泽农村商业银行|"
    "江苏海安农村商业银行|江苏海门农村商业银行|江苏涟水农村商业银行|江苏淮安农村商业银行|"
    "江苏溧水农村商业银行|江苏滨海农村商业银行|江苏灌云农村商业银行|江苏灌南农村商业银行|"
    "江苏盐城农村商业银行|江苏盱眙农村商业银行|江苏睢宁农村商业银行|江苏紫金农村商业银行|"
    "江苏苏州农村商业银行股份有限公司|江苏赣榆农村商业银行|江苏邳州农村商业银行|"
    "江苏金湖农村商业银行|江苏镇江农村商业银行|江苏阜宁农村商业银行|江苏靖江农村商业银行|"
    "江苏高淳农村商业银行|江苏高邮农村商业银行|沛县农村商业银行|连云港东方农村商业银行股份有限公司"
).split("|")

REAL_CATALOG = [
    _item(f"32{i:04d}", name) for i, name in enumerate(REAL_NAMES)
]


def test_long_typo_name_gets_fuzzy_suggestions_with_right_first_candidate():
    result = resolve_catalog_field(
        "organization", ["沐阳农村商业银行股份有限公司"], REAL_CATALOG,
    )
    assert result["status"] == "needs_confirmation"
    candidates = result["candidates"]
    assert 1 <= len(candidates) <= 5
    assert candidates[0]["value"] == "江苏沭阳农村商业银行"
    assert all(
        candidate["metadata"]["match_kind"] == "fuzzy_suggestion"
        for candidate in candidates
    )
    # 分数降序排列。
    scores = [candidate["score"] for candidate in candidates]
    assert scores == sorted(scores, reverse=True)


def test_fuzzy_suggestions_do_not_relax_correction_threshold():
    # 长错名（编辑距离 3）只能拿候选，不能自动解析；corrected 门槛不松。
    result = resolve_catalog_field(
        "organization", ["沐阳农村商业银行股份有限公司"], REAL_CATALOG,
    )
    assert "value" not in result
    assert result["metadata"]["issues"] == [
        {"rawValue": "沐阳农村商业银行股份有限公司", "reason": "needs_confirmation"},
    ]


def test_truly_unrelated_input_stays_not_found():
    for raw in ("xyz123", "昆仑山"):
        result = resolve_catalog_field("organization", [raw], REAL_CATALOG)
        assert result["status"] == "not_found"
        assert result["candidates"] == []


def test_duplicate_exact_term_stays_ambiguous():
    items = [
        OrganizationCatalogItem(code="A", name="同名农商行"),
        OrganizationCatalogItem(code="B", name="同名农商行"),
    ]
    result = resolve_catalog_field("organization", ["同名农商行"], items)
    assert result["status"] == "ambiguous"
    assert {candidate["code"] for candidate in result["candidates"]} == {"A", "B"}


def test_strict_exact_keeps_precedence_over_contains():
    items = [
        OrganizationCatalogItem(code="A", name="甲农村商业银行", aliases=["甲农商"]),
        OrganizationCatalogItem(code="B", name="甲农商行"),
    ]
    result = resolve_catalog_field("organization", ["甲农商行"], items)
    assert result["value"]["codes"] == ["B"]


def test_same_short_form_ambiguous_when_multiple_names_contain():
    items = [
        OrganizationCatalogItem(code="A", name="甲农村商业银行"),
        OrganizationCatalogItem(code="B", name="甲农商行"),
    ]
    # “甲农商”只被“甲农商行”连续包含，按唯一包含解析；两家都包含的写法才歧义。
    assert resolve_catalog_field("organization", ["甲农商"], items)["value"]["codes"] == ["B"]
    result = resolve_catalog_field("organization", ["甲"], items)
    assert result["status"] == "ambiguous"
    assert {candidate["code"] for candidate in result["candidates"]} == {"A", "B"}


def test_metric_terms_do_not_use_organization_ladder():
    items = [MetricCatalogItem(code="M", name="农商存款余额")]
    result = resolve_catalog_field("metric", ["农商存款余额行"], items)
    assert result["status"] != "resolved" or "M" not in result.get("value", {}).get("codes", [])
