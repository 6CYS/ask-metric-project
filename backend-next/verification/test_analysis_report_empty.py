"""空查询可解释已执行的目标，不能以请求参数冒充业务结果。"""

import pytest
from test_analysis_report_claims import evidence, report

from ask_metric.core.errors import ApplicationError


def empty_ranking(day="2026-08-31", position="top"):
    source = evidence()
    source.update(actual_dates=[], analysis_date=None, evidence_items=[], observations=[],
                  requested_start=day, requested_end=day, complete=False,
                  gaps=["指定日期没有可用数据。"])
    source["plan"]["steps"][0].update(method="ranking", position=position, top_n=3)
    return source


@pytest.mark.parametrize("body", [
    "2026年8月末各家农商行所查询的正式业务指标在本次统计日没有可用数据。",
    "未取得2026年8月底的有效值，因此无法给出前3名排名。",
    "查询目标为2026-08-31的前3名，当前没有可用的排名结果。",
])
def test_empty_result_can_restate_executed_period_and_ranking_target(body):
    result = report(body, source=empty_ranking())
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert result["narrative_repaired"] is False


def test_empty_bottom_ranking_uses_its_confirmed_position():
    result = report("没有可用数据，暂不能给出后3名。", source=empty_ranking(position="bottom"))
    assert result["status"] == "succeeded"


def test_inquiry_without_values_keeps_gap_metadata_without_appending_diagnostics():
    source = empty_ranking()
    source["execution_mode"] = "inquiry"
    source["gaps"] = ["本次请求1家机构，取得有效值0家。"]
    result = report("2026年8月末没有可用数据，暂不能给出前3名。", source=source)
    assert result["gaps"] == source["gaps"]
    assert result["partial_analysis"] is True
    assert "没有可用数据" in result["public_answer"]
    assert "取得有效值0家" not in result["public_answer"]


@pytest.mark.parametrize("body", [
    "没有可用数据，暂不能给出前4名。",
    "没有可用数据，暂不能给出后3名。",
])
def test_empty_result_ranking_quantities_are_not_actual_ranks(body):
    result = report(body, source=empty_ranking())
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert body in result["report"]["summary"]


@pytest.mark.parametrize("body", [
    "| 机构 | 排名 |\n|---|---|\n| 测试机构 | 3 |",
    "| 机构 | 余额 |\n|---|---|\n| 测试机构 | 3元 |",
    "| 机构 | 信贷客户数量 |\n|---|---|\n| 测试机构 | 3户 |",
])
def test_request_metadata_does_not_authorize_business_values_or_actual_ranks(body):
    with pytest.raises(ApplicationError) as caught:
        report(body, source=empty_ranking())
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"




def test_date_clarification_keeps_the_executed_empty_target():
    result = report("是否继续查询2026-08-31？", source=empty_ranking("2026-08-27"))
    assert result["analysis_date"] is None
    assert result["partial_analysis"] is True
    assert "查询期间：2026-08-27至2026-08-27" in result["report"]["presentation"]["scope"]
