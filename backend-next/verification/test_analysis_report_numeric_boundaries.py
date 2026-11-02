"""说明中的数字不代表业务量值；明确量值及表格仍绑定真实证据。"""

import pytest
from test_analysis_report_claims import report

from ask_metric.core.errors import ApplicationError


@pytest.mark.parametrize("explanation", [
    "请问要看前3名还是前5名？",
    "1年期LPR和5年期LPR属于不同期限报价。",
    "这是第1份说明，分2步查看统计口径。",
    "这是第1份建议。",
    "1. 先确认指标口径。\n2. 再确认比较期间。",
    "（15）先确认比较期间。",
])
def test_explanation_numbers_do_not_block_verified_facts(explanation):
    result = report("余额为{{total}}。\n\n" + explanation)
    assert result["status"] == "succeeded"
    assert "余额为100元。" in result["report"]["summary"]
    assert explanation in result["report"]["summary"]
    assert "total" in result["report"]["body_evidence"][0]["evidence_refs"]


@pytest.mark.parametrize("value", [
    "999元", "100万元", "-100元", "100%", "999户", "08-27元",
    "999", "9.99e2", "999名", "999位", "999{{total|cite}}",
])
def test_numeric_table_cells_require_their_own_evidence(value):
    with pytest.raises(ApplicationError) as caught:
        report("| 机构 | 数值 |\n|---|---|\n| 测试机构 | " + value + " |")
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
