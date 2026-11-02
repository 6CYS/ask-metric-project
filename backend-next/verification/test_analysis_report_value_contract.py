"""精确引用和结构化展示保持事实边界；自然措辞保留来源关联。"""

import pytest
from test_analysis_report_claims import evidence, report

from ask_metric.core.errors import ApplicationError


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("余额为 **{{total}}**（100元）。", "余额为 **100元**。"),
        ("余额为{{total}} （ **100元** ）。", "余额为100元。"),
        ("余额为 __100元__（{{total}}）。", "余额为 __100元__。"),
        ("余额为100元 ( **{{total}}** )。", "余额为100元。"),
        ("余额为{{total}}（100.00元）。", "余额为100元。"),
    ],
)
def test_reference_and_equal_literal_are_one_value_before_expansion(body, expected):
    result = report(body)
    assert result["report"]["summary"] == expected
    assert "total" in result["report"]["body_evidence"][0]["evidence_refs"]


@pytest.mark.parametrize(
    "body",
    [
        "余额为 **{{total}}**（999元）。",
        "余额为100万元（{{total}}）。",
        "余额为-100元（{{total}}）。",
        "余额为100元（{{unknown}}）。",
    ],
)
def test_conflicting_or_unknown_value_is_not_hidden_by_duplicate_normalization(body):
    with pytest.raises(ApplicationError):
        report(body)


@pytest.mark.parametrize(
    "body",
    [
        "余额为 **{{total}}**（存款口径）。",
        "余额为 **{{total}}**；个人存款为{{personal}}。",
        "余额为100元{{total|cite}}。",
        "余额为{{total}}（其中个人存款为60元{{personal|cite}}）。",
    ],
)
def test_normalization_keeps_explanations_and_other_facts(body):
    result = report(body)
    expected = (
        body.replace("{{total}}", "100元")
        .replace("{{personal}}", "60元")
        .replace("{{total|cite}}", "")
        .replace("{{personal|cite}}", "")
    )
    assert result["report"]["summary"] == expected


def ratio_evidence():
    source = evidence()
    atom = dict(
        source["evidence_items"][0],
        ref="personal_ratio",
        metric_code="personal_ratio",
        metric_name="个人存款占比",
        value="0.7522",
        unit="%",
        display="75.22%",
    )
    source["evidence_items"].append(atom)
    source["plan"]["steps"][0]["metric_refs"].append("personal_ratio")
    source["metric_descriptors"].append(
        {
            "binding_ref": "personal_ratio",
            "code": "personal_ratio",
            "name": "个人存款占比",
            "unit": "%",
            "semantic_status": "approved",
            "value_encoding": "ratio",
        }
    )
    return source


@pytest.mark.parametrize(
    "body",
    [
        "个人存款占比约四分之三{{personal_ratio|cite}}。",
        "个人存款占比约为75%{{personal_ratio|cite}}。",
        "个人存款约占四分之三{{personal_ratio|cite}}。",
    ],
)
def test_natural_approximation_keeps_explicit_source_without_claiming_numeric_verification(body):
    result = report(body, source=ratio_evidence())
    assert result["status"] == "succeeded"
    assert result["report"]["summary"] == body.replace("{{personal_ratio|cite}}", "")
    assert "personal_ratio" in result["report"]["body_evidence"][0]["evidence_refs"]


def test_equal_values_from_different_facts_are_not_collapsed():
    source = evidence()
    next(atom for atom in source["evidence_items"] if atom["ref"] == "personal")["display"] = (
        "100元"
    )
    next(atom for atom in source["evidence_items"] if atom["ref"] == "personal")["value"] = "100"
    result = report("两项分别为{{total}}（{{personal}}）。", source=source)
    assert result["report"]["summary"] == "两项分别为100元（100元）。"


def test_duplicate_normalization_does_not_shift_later_negative_comparison():
    result = report(
        "余额为 **{{total}}**（100元），较上月减少{{total_mom}}。", source=evidence("-3")
    )
    assert result["report"]["summary"] == "余额为 **100元**，较上月减少3元。"


def test_unknown_percentage_encoding_cannot_be_displayed_as_verified_ratio():
    source = ratio_evidence()
    source["metric_descriptors"][-1].pop("value_encoding")
    with pytest.raises(ApplicationError) as caught:
        report("个人存款占比{{personal_ratio}}。", source=source)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize(
    "body", ["余额为--100元。", "余额为++100元。", "余额为100元{{personal|cite}}。"]
)
def test_full_quantity_and_explicit_source_are_validated_in_table(body):
    with pytest.raises(ApplicationError) as caught:
        report("| 指标 | 数值 |\n|---|---|\n| 余额 | " + body + " |")
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize(
    "body",
    [
        "个人存款占比超过四分之三{{personal_ratio|cite}}。",
        "个人存款占比高于75%{{personal_ratio|cite}}。",
        "个人存款占比不低于75%{{personal_ratio|cite}}。",
        "个人存款占比不足八成{{personal_ratio|cite}}。",
    ],
)
def test_natural_comparison_preserves_source_without_lexical_judgment(body):
    result = report(body, source=ratio_evidence())
    assert result["report"]["summary"] == body.replace("{{personal_ratio|cite}}", "")
    assert "personal_ratio" in result["report"]["body_evidence"][0]["evidence_refs"]


def test_quantity_comparison_uses_explicit_reference_before_resolving_ambiguity():
    source = ratio_evidence()
    source["org_codes"].append("O2")
    source["org_names"].append("另一测试机构")
    source["evidence_items"].append(
        dict(
            source["evidence_items"][-1],
            ref="other_org_ratio",
            org_code="O2",
            org_name="另一测试机构",
            value="0.8",
            display="80%",
        )
    )
    result = report("1. 测试机构：个人存款占比超过75%{{personal_ratio|cite}}。", source=source)
    refs = result["report"]["body_evidence"][0]["evidence_refs"]
    assert "personal_ratio" in refs
    assert "other_org_ratio" not in refs
