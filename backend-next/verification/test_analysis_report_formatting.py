"""日期空格与显式正号属于排版等价，仍需匹配完整的原始依据。"""

import pytest
from test_analysis_report_claims import evidence, report

from ask_metric.core.errors import ApplicationError


@pytest.mark.parametrize("question", [
    "也可以看2025年吗？",
    "请选2026-08-28或2026-08-29。",
])
def test_date_clarification_does_not_change_or_block_a_verified_fact(question):
    result = report("余额为{{total}}。" + question)
    assert result["status"] == "succeeded"
    assert result["report"]["summary"] == "余额为100元。" + question
    assert result["analysis_date"] == "2026-08-27"




@pytest.mark.parametrize("day", ["2026-08-27", "2026年08月27日", "8 月 27 日", "08-27"])
@pytest.mark.parametrize("use_reference", [True, False])
def test_table_date_formats_preserve_the_same_verified_value(day, use_reference):
    value = "{{total}}" if use_reference else "100元{{total|cite}}"
    result = report(
        f"| 机构 | 日期 | 余额 |\n|---|---|---|\n| 测试机构 | {day} | {value} |"
    )
    assert result["status"] == "succeeded"
    assert f"| 测试机构 | {day} | 100元 |" in result["report"]["summary"]




@pytest.mark.parametrize("day", ["8 月 27 日", "2026 年 8 月 27 日", "2026 - 08 - 27",
                                "8\t月\t27\t日", "08-27", "08 - 27"])
def test_known_date_accepts_spacing_without_changing_the_visible_answer(day):
    result = report(f"截至{day}，余额为{{{{total}}}}。")
    assert result["status"] == "succeeded"
    assert day in result["report"]["summary"]


@pytest.mark.parametrize("body", [
    "| 日期 | 余额 |\n|---|---|\n| 08-27 | 08-27元{{total|cite}} |",
    "| 日期 | 客户数 |\n|---|---|\n| 8 月 27 日 | 999户 |",
])
def test_date_formatting_does_not_authorize_unrelated_quantities(body):
    with pytest.raises(ApplicationError) as caught:
        report(body)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"




def test_explicit_positive_sign_has_the_same_evidence_as_unsigned_value():
    source = evidence("0.54")
    table = "| 指标 | 变动 |\n|---|---|\n| 各项存款余额较上月 | {value} |"
    signed = report(table.format(value="+0.54元{{total_mom|cite}}"), source=source)
    unsigned = report(table.format(value="0.54元{{total_mom|cite}}"), source=source)
    assert signed["status"] == "succeeded"
    assert "+0.54元" in signed["report"]["summary"]
    assert signed["report"]["body_evidence"] == unsigned["report"]["body_evidence"]
    assert signed["report"]["requirement_coverage"] == unsigned["report"]["requirement_coverage"]


@pytest.mark.parametrize("value", ["+0.54元", "+0.54万元", "+10.54元"])
def test_explicit_positive_sign_cannot_change_negative_value_unit_or_magnitude(value):
    body = "| 指标 | 变动 |\n|---|---|\n| 各项存款余额较上月 | " + value + "{{total_mom|cite}} |"
    with pytest.raises(ApplicationError) as caught:
        report(body, source=evidence("-0.54"))
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
