"""统一交付的隔离回归：局部文案失效不抹去有效事实，范围与权限保持严格。"""

import pytest
from test_general_analysis import binding, plan, request

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError

pytest_plugins = ["test_general_analysis"]


def run_income(service, actor, key="delivery"):
    reference = binding(service, actor, "营业收入金额当日数")
    return service.execute(request(plan(reference)), actor, key)


def test_valid_paragraph_survives_invalid_number_cause_and_reference(general_environment):
    service, actor, _, _ = general_environment
    result = run_income(service, actor)
    fact = next(item for item in result["evidence_items"] if item["type"] == "fact")
    valid = "营业收入为{{" + fact["ref"] + "}}。"
    draft = valid + "\n\n利润999999亿元。\n\n成本效率有所优化。\n\n{{invented.reference}}"
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary=draft, retain_valid=True,
    ))
    assert report["status"] == "succeeded"
    assert "营业收入为" in report["report"]["summary"]
    assert "999999" not in report["public_answer"]
    assert "成本效率有所优化" not in report["public_answer"]
    assert "invented.reference" not in report["public_answer"]
    assert {item["code"] for item in report["report"]["narrative_issues"]} == {
        "ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_CAUSE", "ANALYSIS_REPORT_REFERENCE",
    }
    assert len(report["report"]["body_evidence"]) == 1
    assert fact["ref"] in report["report"]["body_evidence"][0]["evidence_refs"]


@pytest.mark.parametrize("draft", ["", "利润999999亿元。", "{{missing.fact}}"])
def test_empty_or_invalid_draft_delivers_specific_verified_facts(general_environment, draft):
    service, actor, _, _ = general_environment
    result = run_income(service, actor)
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary=draft, retain_valid=True,
    ))
    assert report["status"] == "succeeded"
    assert report["report"]["delivery_mode"] == "verified_facts"
    assert report["rows"] == result["rows"]
    assert "营业收入" in report["report"]["summary"]
    assert report["report"]["body_evidence"][0]["evidence_refs"]
    assert "完整文字分析尚未完成" not in report["public_answer"]
    assert "999999" not in report["public_answer"]


def test_missing_requirement_gets_only_its_own_fact_supplement(general_environment):
    service, actor, _, _ = general_environment
    income, profit = (binding(service, actor, name) for name in
                      ["营业收入金额当日数", "净利润金额当日数"])
    analysis = plan(income, requirements=[{"id": "income", "question": "收入如何"},
                                         {"id": "profit", "question": "利润如何"}],
                    steps=[{"id": name, "method": "observe", "metric_refs": [ref],
                            "answers": [name], "rationale": "核对当前值"}
                           for name, ref in [("income", income), ("profit", profit)]])
    result = service.execute(request(analysis), actor, "coverage-delivery")
    fact = next(item for item in result["evidence_items"]
                if item["type"] == "fact" and "营业收入" in item["metric_name"])
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="收入为{{" + fact["ref"] + "}}。",
        retain_valid=True,
    ))
    assert report["report"]["summary"].count("收入为") == 1
    assert "净利润" in report["report"]["summary"]
    assert all(item["status"] == "covered"
               for item in report["report"]["requirement_coverage"])
    assert report["report"]["narrative_issues"] == [
        {"code": "ANALYSIS_REPORT_COVERAGE", "location": "profit"},
    ]


def test_narrative_repair_never_relaxes_scope_or_owner(general_environment):
    service, actor, _, _ = general_environment
    result = run_income(service, actor)
    with pytest.raises(ApplicationError) as denied:
        compose_analysis_report(service, actor.model_copy(update={"user_id": "other-user"}),
                                AnalysisReportRequest(run_refs=[result["run_ref"]],
                                                      retain_valid=True))
    assert denied.value.code == "ANALYSIS_RUN_NOT_FOUND"
    with pytest.raises(ApplicationError) as invalid:
        compose_analysis_report(service, actor, AnalysisReportRequest(
            run_refs=[result["run_ref"]], context_run_refs=[result["run_ref"]],
            retain_valid=True,
        ))
    assert invalid.value.code == "ANALYSIS_REPORT_SCOPE"
