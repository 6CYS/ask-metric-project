"""自然概括不经过数量词裁决，引用与表格仍由真实回执校验。"""

import pytest
from test_analysis_report_claims import report
from test_analysis_report_preview import setup_preview
from test_analysis_report_value_contract import ratio_evidence

from ask_metric.application.analysis_report import compose_analysis_report
from ask_metric.core.errors import ApplicationError


@pytest.mark.parametrize("description", [
    "个人存款超过六成，对公约占三分之一强。",
    "个人存款占大头，对公不到一半。",
    "个人占比高于60%，对公占比不足40%。",
])
def test_natural_summary_after_verified_values_keeps_body_and_evidence(description):
    source = ratio_evidence()
    source["evidence_items"][-1].update(value="0.6343", display="63.43%")
    for atom in source["evidence_items"]:
        if atom["ref"] == "personal":
            atom.update(value="63.43", display="63.43元")
        elif atom["ref"] == "corporate":
            atom.update(value="36.57", display="36.57元")
    result = report("个人存款占比{{personal_ratio}}。\n\n" + description, source=source)
    assert result["report"]["summary"] == "个人存款占比63.43%。\n\n" + description
    assert result["narrative_repaired"] is False
    assert result["report"]["body_evidence"] == [
        {"paragraph": 1, "evidence_refs": ["personal_ratio"]},
        {"paragraph": 2, "evidence_refs": []},
    ]


def test_streamed_summary_needs_no_repeated_citation_or_extra_calculation():
    _, service, request = setup_preview()
    description = "个人存款占六成，其余为对公存款。"
    preview = compose_analysis_report(service, object(), request.model_copy(
        update={"summary": description},
    ))
    assert preview["preview_text"] == description


@pytest.mark.parametrize("value", ["999元", "100万元", "-100元", "100%"])
def test_tabular_values_cannot_conflict_with_explicit_fact(value):
    with pytest.raises(ApplicationError) as caught:
        report("| 指标 | 数值 |\n|---|---|\n| 余额 | " + value + "{{total|cite}} |")
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_natural_expression_does_not_authorize_a_missing_reference():
    with pytest.raises(ApplicationError) as caught:
        report("约占三分之一{{unknown|cite}}。")
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


@pytest.mark.parametrize("border", ["", "|", "left", "right"])
@pytest.mark.parametrize("value", ["100元", "999元"])
def test_table_border_style_does_not_change_value_validation(border, value):
    rows = ["指标 | 数值", "--- | ---", "余额 | " + value + "{{total|cite}}"]
    left = "|" if border in {"|", "left"} else ""
    right = "|" if border in {"|", "right"} else ""
    body = "\n".join(left + row + right for row in rows)
    if value == "100元":
        assert report(body)["report"]["summary"] == body.replace("{{total|cite}}", "")
    else:
        with pytest.raises(ApplicationError) as caught:
            report(body)
        assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("values,valid", [
    ("100元{{total|cite}}、60元{{personal|cite}}", True),
    ("100元{{personal|cite}}、60元{{total|cite}}", False),
])
def test_each_value_in_table_cell_keeps_its_own_explicit_reference(values, valid):
    body = "| 指标 | 数值 |\n|---|---|\n| 总量、个人 | " + values + " |"
    if valid:
        assert report(body)["report"]["summary"] == (
            body.replace("{{total|cite}}", "").replace("{{personal|cite}}", "")
        )
    else:
        with pytest.raises(ApplicationError) as caught:
            report(body)
        assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("separator", ["-", ":--", "---:"])
@pytest.mark.parametrize("trailing_cells", ["", "说明 |", "说明 | 多余列 |"])
@pytest.mark.parametrize("value", ["100元", "999元"])
def test_rendered_table_variants_keep_exact_value_validation(separator, trailing_cells, value):
    body = (
        "| 指标 | 数值 | 备注 |\n"
        f"| {separator} | {separator} | {separator} |\n"
        "| 余额 | " + value + "{{total|cite}} | " + trailing_cells
    )
    if value == "100元":
        assert report(body)["report"]["summary"] == body.replace("{{total|cite}}", "")
    else:
        with pytest.raises(ApplicationError) as caught:
            report(body)
        assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
