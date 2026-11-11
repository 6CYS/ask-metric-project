"""长对照表仍经过既有事实引用和数字校验；仅使用隔离回执。"""

import pytest
from pydantic import ValidationError
from test_analysis_report_preview import setup_preview

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def long_table(cell="{{total}}"):
    return "| 机构 | 余额 |\n|---|---|\n" + f"| 测试机构 | {cell} |\n" * 400


@pytest.mark.parametrize("preview", [True, False])
def test_long_report_table_is_rendered_without_bypassing_fact_validation(preview):
    body = long_table()
    assert 6000 < len(body) < 32000
    _, service, request = setup_preview(body)
    request = request.model_copy(update={"preview": preview})
    result = compose_analysis_report(service, object(), request)
    rendered = result["preview_text"] if preview else result["report"]["summary"]
    assert rendered.count("| 测试机构 | 100元 |") == 400
    assert "{{total}}" not in rendered
    invalid = AnalysisReportRequest(
        run_refs=request.run_refs, summary=long_table("999元{{total|cite}}"), preview=preview,
    )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), invalid)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
    unknown = AnalysisReportRequest(
        run_refs=request.run_refs, summary=body + "\n\n余额为{{foreign}}。", preview=preview,
    )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), unknown)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_report_body_capacity_remains_bounded():
    with pytest.raises(ValidationError) as caught:
        AnalysisReportRequest(run_refs=["run"], summary="甲" * 32001)
    assert caught.value.errors()[0]["loc"] == ("summary",)
