"""短引用核验真实来源，旧显式声明仅作兼容一致性检查。"""

import pytest
from test_analysis_report_claims import institution_evidence, report

from ask_metric.core.errors import ApplicationError

LAYOUTS = [
    "测试甲行：{{other_mom}}。",
    "1. 测试甲行：{{other_mom}}。",
    "- 测试甲行：{{other_mom}}。",
    "| 机构 | 数值 |\n|---|---|\n| 测试甲行 | {{other_mom}} |",
]


def binding(source):
    atom = next(item for item in source["evidence_items"] if item["ref"] == "other_mom")
    return {key: atom[key] for key in ("ref", "org_code", "metric_code", "date")}


@pytest.mark.parametrize("body", LAYOUTS)
@pytest.mark.parametrize(
    "field,value",
    [
        ("org_code", "O1"),
        ("metric_code", "personal"),
        ("date", "2026-07-31"),
    ],
)
def test_declared_wrong_identity_is_rejected_in_every_layout(body, field, value):
    source = institution_evidence()
    claim = {**binding(source), field: value}
    with pytest.raises(ApplicationError) as caught:
        report(body, source=source, bindings=[claim])
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


@pytest.mark.parametrize("body", LAYOUTS)
def test_short_reference_uses_authorized_fact_without_repeated_coordinates(body):
    result = report(
        body.replace("测试甲行", "测试乙行"), source=institution_evidence(), bindings=[]
    )
    assert result["status"] == "succeeded"
    assert "-1.50亿元" in result["public_answer"]


@pytest.mark.parametrize("body", LAYOUTS)
def test_correct_binding_renders_value_without_repeating_identity(body):
    source = institution_evidence()
    result = report(body.replace("测试甲行", "测试乙行"), source=source, bindings=[binding(source)])
    assert "-1.50亿元" in result["report"]["summary"]
    assert "org_code" not in result["public_answer"]


def test_unbound_table_value_cannot_borrow_a_global_value():
    source = institution_evidence()
    with pytest.raises(ApplicationError) as caught:
        report(
            "| 机构 | 余额变动 |\n|---|---|\n| 测试乙行 | -1.50亿元 |",
            source=source,
            bindings=[],
        )
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_table_value_cannot_borrow_a_fact_declared_in_another_paragraph():
    source = institution_evidence()
    with pytest.raises(ApplicationError) as caught:
        report(
            "测试乙行变动{{other_mom}}。\n\n"
            "| 机构 | 余额变动 |\n|---|---|\n| 测试甲行 | -1.50亿元 |",
            source=source,
            bindings=[binding(source)],
        )
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_literal_with_local_short_citation_uses_only_that_fact():
    result = report(
        "| 机构 | 余额变动 |\n|---|---|\n| 测试乙行 | -1.50亿元{{other_mom|cite}} |",
        source=institution_evidence(),
        bindings=[],
    )
    assert "-1.50亿元" in result["public_answer"]
    assert result["report"]["body_evidence"] == [
        {"paragraph": 1, "evidence_refs": ["other_mom"]}
    ]


def test_short_citation_does_not_support_a_different_value():
    with pytest.raises(ApplicationError) as caught:
        report(
            "| 机构 | 余额变动 |\n|---|---|\n| 测试乙行 | -2.50亿元{{other_mom|cite}} |",
            source=institution_evidence(),
            bindings=[],
        )
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_binding_does_not_claim_to_prove_free_text_semantics():
    source = institution_evidence()
    result = report(
        "这是待核实的解释，不等于增幅{{other_mom}}。", source=source, bindings=[binding(source)]
    )
    assert result["status"] == "succeeded"


@pytest.mark.parametrize(
    "body", ["{{total|org=O1|metric=total|date=2026-08-27}", "{{total", "total}}", "{{}}"]
)
def test_malformed_reference_cannot_escape_to_public_answer(body):
    with pytest.raises(ApplicationError) as caught:
        report(body, bindings=[])
    assert caught.value.code == "ANALYSIS_REPORT_FORMAT"


def test_scope_counts_are_not_mistaken_for_metric_values():
    source = institution_evidence()
    result = report(
        "两家机构的情况如下。\n\n测试乙行：{{other_mom}}。",
        source=source,
        bindings=[binding(source)],
    )
    assert result["status"] == "succeeded"
    assert result["report"]["body_evidence"] == [
        {"paragraph": 1, "evidence_refs": []},
        {"paragraph": 2, "evidence_refs": ["other_mom"]},
    ]


def test_natural_quantity_does_not_create_an_implicit_fact_binding():
    body = "测试乙行余额较上月减少1.50亿元。"
    result = report(body, source=institution_evidence())
    assert result["report"]["summary"] == body
    assert result["report"]["body_evidence"] == [{"paragraph": 1, "evidence_refs": []}]


def test_reports_unsupported_values_across_table_paragraphs():
    with pytest.raises(ApplicationError) as caught:
        report(
            "| 指标 | 数值 |\n|---|---|\n| 变动 | 999元 |\n\n"
            "| 指标 | 数值 |\n|---|---|\n| 变动 | 1000元{{other_mom|cite}} |",
            source=institution_evidence(),
        )
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
    assert "999元" in str(caught.value) and "1000元" in str(caught.value)
