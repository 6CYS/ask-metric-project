"""隔离数据验证正常空结果的交付边界，不调用模型或外部查询库。"""

from copy import deepcopy

import pytest
from test_general_analysis import binding, plan, request

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.query_result_messages import completed_empty_message, empty_query_notice

pytest_plugins = ["test_general_analysis"]


def test_empty_notice_uses_verified_scope_without_guessing():
    notice = empty_query_notice(["隔离农商行"], "各项存款余额", "2026-08-31", "2026-08-31")
    assert notice["message"] == "查询已完成，未查到隔离农商行在2026年8月31日的各项存款余额记录。"


def test_empty_report_and_date_followup_replace_speculative_model_prose(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "资本充足比率当日数")
    analysis = plan(ref, steps=[{"id": "read", "method": "observe", "metric_refs": [ref],
                                "answers": ["performance"], "rationale": "读取指定日期"}])
    answers = []
    for day in ["2026-07-31", "2026-09-30"]:
        evidence = service.execute(request(analysis, date_selection="exact", start=day, end=day),
                                   actor, "empty-" + day)
        report = compose_analysis_report(service, actor, AnalysisReportRequest(
            run_refs=[evidence["run_ref"]],
            summary="该范围未取得有效数值，可能漏报或未覆盖，请调整日期。",
        ))
        assert evidence["tasks"] and all(t["status"] == "succeeded" for t in evidence["tasks"])
        assert report["status"] == "succeeded" and report["row_count"] == 0
        assert not report["partial_analysis"]
        assert report["report"]["summary"] == evidence["empty_result"] == report["public_answer"]
        assert "查询已完成，未查到" in report["public_answer"]
        assert "资本充足比率当日数记录。" in report["public_answer"]
        assert report["gaps"] == [] and report["report"]["sections"] == []
        assert not report["report"]["presentation"]["limitations"]
        answers.append(report["public_answer"])
    assert "2026年7月31日" in answers[0] and "2026年9月30日" in answers[1]
    assert "7月31日" not in answers[1]


def test_zero_remains_a_real_value(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "净利润金额当日数")
    evidence = service.execute(request(plan(ref), date_selection="exact",
                                       start="2026-07-31", end="2026-07-31"), actor, "zero-is-data")
    assert evidence["empty_result"] is None
    assert any(item.get("type") == "fact" and float(item["value"]) == 0
               for item in evidence["evidence_items"])


def empty_step():
    notice = empty_query_notice(["隔离机构甲", "隔离机构乙"], "净利润", "2026-08-01", "2026-08-31")
    return {"tasks": [{"status": "succeeded"}], "gaps": [notice["message"]],
            "empty_results": [notice], "facts": [], "calculations": [], "observations": []}


@pytest.mark.parametrize("change", [
    {"tasks": [{"status": "failed"}]}, {"gaps": ["查询结果被截断"]},
    {"execution_error": "ANALYSIS_DEPENDENCY_UNAVAILABLE"},
    {"gaps": ["预算耗尽，本项未执行"]}, {"empty_results": []}, {"facts": [{"value": 0}]},
])
def test_incomplete_or_nonempty_results_are_not_successful_empty(change):
    step = empty_step()
    step.update(change)
    assert completed_empty_message([step]) is None


def test_multiple_metrics_share_one_factual_empty_statement():
    first = empty_step()
    second = deepcopy(first)
    notice = empty_query_notice(
        ["隔离机构甲", "隔离机构乙"], "营业收入", "2026-08-01", "2026-08-31",
    )
    second.update(empty_results=[notice], gaps=[notice["message"]])
    summary = completed_empty_message([first, second])
    assert summary == ("查询已完成，未查到隔离机构甲、隔离机构乙在"
                       "2026年8月1日至2026年8月31日的净利润、营业收入记录。")
