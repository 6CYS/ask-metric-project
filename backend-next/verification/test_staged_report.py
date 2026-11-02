"""同一原始范围内的分阶段调查，使用隔离证据验证合并边界。"""

from copy import deepcopy
from datetime import date
from types import SimpleNamespace

import pytest
from test_analysis_report_claims import evidence

from ask_metric.application.analysis_execution import GeneralAnalysisService
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def sources():
    initial = evidence()
    initial["org_codes"] = ["O1", "O2"]
    initial["org_names"] = ["测试机构", "另一机构"]
    initial["plan"]["requirements"].append({"id": "q2", "question": "进一步分析原因",
                                          "deferred_reason": "等待定位机构"})
    initial["complete"] = False
    initial["requirement_dispositions"] = [{"id": "q1", "status": "completed"},
                                            {"id": "q2", "status": "pending"}]
    followup = deepcopy(initial)
    followup.update(run_ref="run-2", org_codes=["O1"], org_names=["测试机构"])
    followup["plan"]["requirements"] = [{"id": "q2", "question": "进一步分析原因"}]
    followup["plan"]["steps"][0]["answers"] = ["q2"]
    for atom in followup["evidence_items"]:
        atom["ref"] = "next." + atom["ref"]
        if "input_refs" in atom:
            atom["input_refs"] = ["next." + ref for ref in atom["input_refs"]]
    for finding in followup["verified_findings"]["items"]:
        finding["ref"] = "next." + finding["ref"]
        finding["evidence_refs"] = ["next." + ref for ref in finding["evidence_refs"]]
    followup["complete"] = True
    followup["requirement_dispositions"] = [{"id": "q2", "status": "completed"}]
    return initial, followup


def compose(items, summary="存款为{{total}}，较上月变化{{total_mom}}。"):
    by_ref = {item["run_ref"]: item for item in items}
    service = SimpleNamespace(
        authorized_evidence=lambda _actor, ref: deepcopy(by_ref[ref]),
        semantics=lambda _actor: SimpleNamespace(resolve=lambda _ref: None, items={
            item["code"]: SimpleNamespace(name=item["name"])
            for source in items for item in source["metric_descriptors"]}),
    )
    return compose_analysis_report(service, object(), AnalysisReportRequest(
        run_refs=list(by_ref), summary=summary, sections=[]))


def test_focused_followup_combines_with_initial_scope_and_answers_deferred_question():
    result = compose(sources(), "存款为{{total}}，补查后较上月变化{{next.total_mom}}。")
    assert result["report"]["requirement_coverage"][1]["status"] == "covered"
    assert "等待定位机构" not in result["public_answer"]
    assert result["partial_analysis"] is False


@pytest.mark.parametrize("field,value", [("org_codes", ["O3"]), ("scope_id", "other-turn"),
                                       ("conversation_id", "other-session"),
                                       ("requested_start", "2026-08-28")])
def test_followup_cannot_expand_or_mix_other_turns_and_dates(field, value):
    first, next_source = sources()
    next_source[field] = value
    with pytest.raises(ApplicationError) as caught:
        compose([first, next_source])
    assert caught.value.code == "ANALYSIS_REPORT_SCOPE"


def test_unfinished_investigation_is_disclosed_without_claiming_data_is_absent():
    first, _ = sources()
    result = compose([first])
    assert "尚未完成" in result["public_answer"]
    assert "进一步分析原因" in result["public_answer"]
    assert "没有数据" not in result["public_answer"]
    assert result["partial_analysis"] is True


def test_initial_batch_cannot_cover_followup_using_the_same_metric_code():
    with pytest.raises(ApplicationError) as caught:
        compose(sources())
    assert caught.value.code == "ANALYSIS_REPORT_PROSE_COVERAGE"


def test_atom_step_ownership_distinguishes_same_metric_inside_one_run():
    first, _ = sources()
    first["plan"]["requirements"][1].pop("deferred_reason")
    first["plan"]["steps"].append({"id": "s2", "method": "observe", "answers": ["q2"],
                                     "metric_refs": ["total"]})
    for atom in first["evidence_items"]:
        atom["step_ids"] = ["s1"]
    second = deepcopy(first["evidence_items"][0])
    second.update(ref="other.total", org_code="O2", org_name="另一机构", step_ids=["s2"])
    first["evidence_items"].append(second)
    with pytest.raises(ApplicationError) as caught:
        compose([first])
    assert caught.value.code == "ANALYSIS_REPORT_PROSE_COVERAGE"
    result = compose([first], "本机构存款为{{total}}，另一机构为{{other.total}}。")
    assert all(item["status"] == "covered" for item in result["report"]["requirement_coverage"])


def test_finish_keeps_all_owning_steps_for_shared_facts_and_derived_atoms():
    metric = {"code": "total", "name": "存款", "unit": "亿元", "metadata_version": "v1",
              "limitations": []}
    fact = {"fact_id": "fact-1", "binding_ref": "total", "metric_code": "total",
            "org_code": "O1", "org_name": "测试机构", "date": "2026-08-27",
            "value": "100", "unit": "亿元", "role": "current"}
    first = {"step_id": "s1", "answers": ["q1"], "facts": [fact], "calculations": [],
             "observations": [], "gaps": [], "tasks": []}
    second = deepcopy(first)
    second.update(step_id="s2", answers=["q2"], calculations=[{
        "calculation_id": "calculation-1", "metric_descriptor": metric,
        "inputs": {"current": fact}, "results": [{"name": "difference", "value": "1",
                                                   "unit": "亿元", "display_value": "1"}]}],
        observations=[{"type": "ranking", "text": "测试机构排名已核实", "date": "2026-08-27",
                       "rank": 1, "position": "bottom", "org_code": "O1",
                       "comparison_fact_refs": ["fact-1"]}])
    payload = SimpleNamespace(
        execution_mode="inquiry",
        plan=SimpleNamespace(requirements=[], model_dump=lambda: {}),
        calculation_context=SimpleNamespace(user_question="存款情况", scope_id="scope-1"),
        organization_scope=None, conversation_id="session-1", date_selection="exact",
        start=date(2026, 8, 27), end=date(2026, 8, 27), org_codes=["O1"],
    )
    result = GeneralAnalysisService._finish(None, {
        "state": {"completed_steps": {"s1": first, "s2": second}, "query_count": 1},
        "payload": payload, "run_id": "analysis:run-1", "bindings": {"total": metric},
        "org_codes": ["O1"], "org_names": {"O1": "测试机构"}, "today": date(2026, 8, 27),
        "semantics": SimpleNamespace(comparison_candidates=lambda _metrics: []),
    })
    atoms = result["evidence_items"]
    assert result["execution_mode"] == "inquiry"
    assert len([atom for atom in atoms if atom["type"] == "fact"]) == 1
    assert atoms[0]["step_ids"] == ["s1", "s2"]
    assert all(atom["step_ids"] == ["s2"] for atom in atoms[1:])
    ranking = next(atom for atom in atoms if atom.get("judgment_kind") == "ranking")
    assert (ranking["rank"], ranking["position"]) == (1, "bottom")
