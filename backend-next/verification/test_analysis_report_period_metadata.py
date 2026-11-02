"""空目标期间与另一期真实观测并存时，目标日期仍可用于业务说明。"""

import pytest
from test_analysis_report_claims import report
from test_inquiry_report_scope import compose_analysis_report, setup_sources

from ask_metric.core.errors import ApplicationError


@pytest.mark.parametrize("period", ["8月末", "2026年8月底", "8 月 末"])
@pytest.mark.parametrize("explanation", [
    "不能将本次观测视为{period}数据。",
    "与{period}的情况尚无法比较。",
])
def test_natural_period_boundaries_do_not_relabel_the_actual_observation(period, explanation):
    body = "余额为{{total}}。" + explanation.format(period=period)
    result = report(body)
    assert result["status"] == "succeeded"
    assert result["analysis_date"] == "2026-08-27"
    assert result["report"]["presentation"]["scope"] == "测试机构 · 2026-08-27"
    assert explanation.format(period=period) in result["report"]["summary"]


def mixed_period_report(body):
    target, reference, service, request = setup_sources()
    target.update(actual_dates=[], analysis_date=None, evidence_items=[], observations=[],
                  complete=False, requested_start="2026-09-30", requested_end="2026-09-30",
                  gaps=["指定统计日没有可用记录。"])
    reference.update(scope_id=target["scope_id"])
    request.context_run_refs = []
    request.summary = body
    return compose_analysis_report(service, object(), request)


@pytest.mark.parametrize("period", ["9月末", "2026年9月底", "9 月 末"])
@pytest.mark.parametrize("body", [
    "原查询目标为{period}。现有观测为2026-08-27，余额为{{{{old.total}}}}。",
    "2026-08-27余额为{{{{old.total}}}}，不能当作{period}的数据。",
])
def test_empty_target_period_remains_known_when_reference_values_exist(period, body):
    result = mixed_period_report(body.format(period=period))
    assert result["status"] == "succeeded"
    assert period in result["report"]["summary"]
    assert "100元" in result["report"]["summary"]
    assert "查询期间：2026-09-30至2026-09-30" in result["report"]["presentation"]["scope"]
    assert "实际数据日期：2026-08-27" in result["report"]["presentation"]["scope"]




def test_empty_target_metadata_does_not_authorize_an_unverified_amount():
    with pytest.raises(ApplicationError) as caught:
        mixed_period_report(
            "原查询目标为9月末。\n\n"
            "| 日期 | 余额 |\n|---|---|\n| 2026-08-27 | 999元{{old.total|cite}} |"
        )
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
