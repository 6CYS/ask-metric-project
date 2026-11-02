"""正文失败后只交付已授权事实；合成机构和金额仅用于隔离回归。"""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from test_analysis_report_availability import setup_report
from test_analysis_report_claims import evidence, report
from test_inquiry_calculation import setup_comparison
from test_inquiry_report_scope import setup_sources

from ask_metric.application.analysis_calculation import (
    AnalysisCalculationRequest,
    CalculationReference,
    calculate_analysis_results,
)
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def ranked_inquiry(position="top"):
    source = evidence()
    metric = source["metric_descriptors"][0]
    source.update(execution_mode="inquiry", metric_descriptors=[metric], observations=[],
                  evidence_items=[], rows=[], org_codes=[], org_names=[])
    source["plan"]["steps"][0].update(
        method="ranking", metric_refs=[metric["binding_ref"]], position=position, top_n=60,
    )
    for index in range(60):
        code = f"O{index}"
        name = f"测试银行{chr(65 + index // 26)}{chr(65 + index % 26)}"
        value = str(index + 1)
        source["org_codes"].append(code)
        source["org_names"].append(name)
        source["evidence_items"].append({
            "ref": f"fact-{index}", "type": "fact", "metric_code": metric["code"],
            "metric_name": metric["name"], "org_code": code, "org_name": name,
            "date": "2026-08-27", "value": value, "display": f"{value}元", "unit": "元",
        })
        source["rows"].append({
            "metric_name": metric["name"], "org_name": name, "stat_date": "2026-08-27",
            "metric_value": f"{value}元", "value_role": "分析时点",
        })
    source["row_count"] = 60
    return source


@pytest.mark.parametrize("position,direction", [("top", "从高到低"), ("bottom", "从低到高")])
def test_inquiry_fallback_delivers_all_ranked_facts_without_reusing_rejected_claims(
    position, direction,
):
    source = ranked_inquiry(position)
    original = deepcopy(source)
    result = report("排名前10位，唯一突破4000亿元，苏南县域整体领先。",
                    source=source, fallback=True)
    summary = result["report"]["summary"]
    assert result["status"] == "succeeded" and result["narrative_repaired"] is True
    assert "| 机构 | 指标值 |" in summary and direction in summary
    assert "2026-08-27" in result["public_answer"]
    rows = [line for line in summary.splitlines() if line.startswith("| 测试银行")]
    expected = sorted(source["evidence_items"], key=lambda atom: int(atom["value"]),
                      reverse=position == "top")
    assert rows == [f"| {atom['org_name']} | {atom['display']} |" for atom in expected]
    assert len(rows) == result["row_count"] == 60
    assert not any(text in summary for text in ("排名前10", "4000", "苏南", "| 排名 |"))
    body_refs = {ref for item in result["report"]["body_evidence"]
                 for ref in item["evidence_refs"]}
    assert body_refs == {atom["ref"] for atom in source["evidence_items"]}
    assert source == original


def test_inquiry_factual_fallback_preserves_existing_nonranking_delivery():
    source = evidence()
    expected = report("", source=source, fallback=True)["report"]["summary"]
    source["execution_mode"] = "inquiry"
    result = report("", source=source, fallback=True)
    assert result["report"]["summary"] == expected
    assert "| 机构 |" not in result["report"]["summary"]


def test_fallback_current_selection_does_not_expand_to_all_queried_institutions():
    current, _, service, request = setup_sources()
    current.update(ranked_inquiry())
    current["run_ref"] = "current"
    request.run_refs, request.context_run_refs = ["current"], []
    request.summary, request.fallback = "", True
    request.focus_refs = ["fact-59", "fact-58"]
    original = deepcopy(current)

    result = compose_analysis_report(service, object(), request)

    assert set(result["org_codes"]) == {"O59", "O58"}
    refs = {ref for item in result["report"]["body_evidence"] for ref in item["evidence_refs"]}
    assert refs == {"fact-59", "fact-58"}
    assert result["row_count"] == 2
    assert current == original


@pytest.mark.parametrize("unselected_run", [False, True])
def test_selected_fallback_retains_current_missing_coverage(unselected_run):
    current, other, service, request = setup_sources()
    for item in (current, other):
        item["tasks"] = [{"task_id": "task-" + item["run_ref"]}]
        item["plan"]["objective"] = item["run_ref"]
    partial = other if unselected_run else current
    partial.update(
        scope_id=current["scope_id"], complete=False,
        gaps=["个人存款本期没有记录。"],
        requirement_dispositions=[{
            "id": "q1", "status": "partial", "reason": "个人存款本期没有记录。",
        }],
    )
    prefix = "old." if unselected_run else ""
    partial["evidence_items"] = [
        atom for atom in partial["evidence_items"] if atom["ref"] == prefix + "total"
    ]
    request.run_refs = ["current", "history"] if unselected_run else ["current"]
    request.context_run_refs = []
    request.summary, request.fallback, request.focus_refs = "", True, ["total"]

    result = compose_analysis_report(service, object(), request)

    assert result["partial_analysis"] is True
    assert "个人存款本期没有记录。" in result["gaps"]
    assert "个人存款本期没有记录。" in result["public_answer"]
    assert result["requirement_dispositions"] == partial["requirement_dispositions"]
    assert {item["ref"] for item in result["evidence_items"]} == {"total"}
    assert {item["task_id"] for item in result["tasks"]} == {
        "task-" + ref for ref in request.run_refs
    }
    assert {item["objective"] for item in result["report"]["plans"]} == set(request.run_refs)


def test_selected_fallback_validates_availability_against_original_query_scope():
    source, service, request = setup_report("", org_codes=["O1", "O2"])
    original = evidence()
    source.update(
        execution_mode="inquiry", org_codes=["O1", "O2"], org_names=["测试机构", "另一机构"],
        requested_start="2026-08-27", requested_end="2026-08-27", actual_dates=["2026-08-27"],
        analysis_date="2026-08-27",
        metric_descriptors=[original["metric_descriptors"][0]],
        evidence_items=[original["evidence_items"][0], {
            **original["evidence_items"][0], "ref": "other.total",
            "org_code": "O2", "org_name": "另一机构",
        }],
    )
    with service.tasks.uow_factory() as uow:
        uow.organization_catalog.list_enabled = lambda: [
            SimpleNamespace(code=code, name=name)
            for code, name in zip(source["org_codes"], source["org_names"], strict=True)
        ]
    request.fallback, request.focus_refs = True, ["total"]

    result = compose_analysis_report(service, object(), request)

    assert result["org_codes"] == ["O1"]
    query = service.execution.data_source.execute_readonly.call_args.kwargs["parameters"]
    assert query["org_codes"] == ["O1", "O2"]


def test_selected_later_run_keeps_original_pending_question_and_unpresented_facts():
    current, later, service, request = setup_sources()
    current["plan"]["requirements"].append({
        "id": "q2", "question": "贷款余额如何", "deferred_reason": "需要补充指标",
    })
    current.update(complete=False, requirement_dispositions=[
        {"id": "q1", "status": "completed"},
        {"id": "q2", "status": "pending", "reason": "需要补充指标"},
    ])
    later["scope_id"] = current["scope_id"]
    later["plan"]["requirements"] = [{"id": "q1", "question": "个人存款余额如何"}]
    request.context_run_refs = []
    request.summary, request.fallback, request.focus_refs = "", True, ["old.personal"]

    result = compose_analysis_report(service, object(), request)

    assert result["partial_analysis"] is True
    assert result["report"]["requirement_coverage"] == [
        {"id": "q1", "question": "存款如何变化", "status": "facts_only", "sections": []},
        {"id": "q2", "question": "贷款余额如何", "status": "pending", "sections": []},
    ]
    assert "尚未完成：贷款余额如何。" in result["gaps"]
    assert "尚未完成：贷款余额如何。" in result["public_answer"]
    assert {item["ref"] for item in result["evidence_items"]} == {"old.personal"}


@pytest.mark.parametrize("change", ["institution", "unit_conflict", "unknown_reference"])
def test_inquiry_fallback_still_rejects_invalid_evidence(change):
    source = ranked_inquiry()
    body = ""
    if change == "institution":
        source["evidence_items"][0]["org_code"] = "OUTSIDE"
    elif change == "unit_conflict":
        source["evidence_items"].append({**source["evidence_items"][0],
                                         "ref": "conflict", "unit": "万元"})
    else:
        body = "余额{{unknown}}"
    with pytest.raises(ApplicationError) as caught:
        report(body, source=source, fallback=True)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


@pytest.mark.parametrize("change", ["conversation", "unmarked_context", "revoked"])
def test_inquiry_fallback_cannot_bypass_history_ownership_or_permission(change):
    _, history, service, request = setup_sources()
    request.summary, request.fallback = "", True
    if change == "conversation":
        history["conversation_id"] = "another-session"
    elif change == "unmarked_context":
        request.context_run_refs = []
    else:
        service.authorized_evidence.side_effect = ApplicationError(
            "ANALYSIS_FORBIDDEN", "历史范围权限已撤销", status_code=403,
        )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == (
        "ANALYSIS_FORBIDDEN" if change == "revoked" else "ANALYSIS_REPORT_SCOPE"
    )


def test_inquiry_fallback_does_not_treat_authorized_background_as_current_target():
    _, history, service, request = setup_sources()
    history.update(org_codes=["O2"], org_names=["对比机构"])
    for atom in history["evidence_items"]:
        if atom.get("org_code"):
            atom.update(org_code="O2", org_name="对比机构")
    request.summary, request.fallback = "", True
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["org_codes"] == ["O1"]
    refs = {ref for paragraph in result["report"]["body_evidence"]
            for ref in paragraph["evidence_refs"]}
    assert "total" in refs and "old.total" not in refs
    assert result["run_refs"] == ["current"]
    assert result["partial_analysis"] is True
    assert service.authorized_evidence.call_count == 2


@pytest.mark.parametrize("focus", [[], ["old.total"]])
def test_empty_current_period_cannot_fallback_to_loaded_historical_balances(focus):
    current, history, service, request = setup_sources()
    current.update(
        requested_start="2026-07-31", requested_end="2026-07-31",
        actual_dates=[], analysis_date=None, evidence_items=[], observations=[], rows=[],
        complete=False, empty_coverages=[{
            "request": {"dimension": "dates", "match": "any", "org_codes": ["O1"],
                        "metric_codes": ["total"], "start": "2026-07-31", "end": "2026-07-31"},
            "date_count": 0, "dates": [], "has_more": False, "gaps": [],
        }],
    )
    request.summary, request.fallback, request.focus_refs = "", True, focus
    result = compose_analysis_report(service, object(), request)
    assert "2026-07-31" in result["public_answer"]
    assert "没有查到记录" in result["public_answer"]
    assert "100元" not in result["public_answer"]
    assert "2026-08-27" not in result["public_answer"]
    assert result["analysis_date"] is None
    assert result["run_refs"] == [current["run_ref"]]
    assert result["evidence_items"] == []
    assert history["evidence_items"]


def test_fallback_keeps_selected_history_without_dropping_current_targets():
    current, history, service, request = setup_sources()
    history.update(org_codes=["O2", "O3"], org_names=["对比机构", "其他机构"])
    for atom in history["evidence_items"]:
        if atom.get("org_code"):
            atom.update(org_code="O2", org_name="对比机构")
    for row in history["rows"]:
        row["org_name"] = "对比机构"
    selected = next(atom for atom in history["evidence_items"] if atom["ref"] == "old.total")
    history["evidence_items"].append({
        **selected, "ref": "unselected", "org_code": "O3", "org_name": "其他机构",
    })
    history["rows"].append({
        "metric_name": selected["metric_name"], "org_name": "其他机构",
        "stat_date": selected["date"], "metric_value": selected["display"],
        "value_role": "分析时点",
    })
    request.summary, request.fallback, request.focus_refs = "", True, ["old.total"]
    result = compose_analysis_report(service, object(), request)
    refs = {ref for paragraph in result["report"]["body_evidence"]
            for ref in paragraph["evidence_refs"]}
    assert {"total", "personal", "old.total"} <= refs
    assert not {"unselected", "old.personal"}.intersection(refs)
    assert set(result["org_codes"]) == {"O1", "O2"}
    assert "其他机构" not in result["public_answer"]
    assert result["partial_analysis"] is True
    assert set(result["run_refs"]) == {current["run_ref"], history["run_ref"]}
    assert service.authorized_evidence.call_count == 2


def test_fallback_rejects_unknown_history_selection():
    _, _, service, request = setup_sources()
    request.summary, request.fallback, request.focus_refs = "", True, ["unknown"]
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_fallback_does_not_hide_invalid_unselected_history():
    _, history, service, request = setup_sources()
    history["evidence_items"][0]["org_code"] = "OUTSIDE"
    request.summary, request.fallback = "", True
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_selected_history_does_not_inherit_unselected_scope_gaps():
    current, history, service, request = setup_sources()
    current["gaps"] = ["本轮其他目标仍待核实。"]
    history.update(
        metric_descriptors=[history["metric_descriptors"][0]],
        evidence_items=[atom for atom in history["evidence_items"] if atom["ref"] == "old.total"],
        observations=[], gaps=["有7家机构未取得有效值"], complete=False,
        requirement_dispositions=[{"id": "q1", "status": "partial", "reason": "旧范围缺数"}],
    )
    history["plan"]["steps"][0]["metric_refs"] = ["total"]
    original = deepcopy(history)
    request.summary, request.fallback, request.focus_refs = "", True, ["old.total"]
    result = compose_analysis_report(service, object(), request)
    assert "有7家机构未取得有效值" not in result["public_answer"]
    assert "有7家机构未取得有效值" not in result["gaps"]
    assert result["gaps"] == ["本轮其他目标仍待核实。"]
    assert not any(
        item.get("reason") == "旧范围缺数" for item in result["requirement_dispositions"]
    )
    assert history == original


@pytest.mark.parametrize("separate_dates", [False, True])
@pytest.mark.parametrize("history_only", [False, True])
def test_selected_history_preserves_only_actual_metric_organization_pairs(
    separate_dates, history_only,
):
    _, history, service, request = setup_sources()
    history.update(org_codes=["O2", "O3"], org_names=["对比甲行", "对比乙行"])
    for atom in history["evidence_items"]:
        if atom.get("org_code"):
            code, name = ("O3", "对比乙行") if atom.get("metric_code") == "personal" else (
                "O2", "对比甲行"
            )
            atom.update(org_code=code, org_name=name)
            if separate_dates and atom.get("metric_code") == "personal":
                atom["date"] = "2026-08-26"
    if separate_dates:
        history["actual_dates"].append("2026-08-26")
    history["rows"] = [{
        "metric_name": atom["metric_name"], "org_name": atom["org_name"],
        "stat_date": atom["date"], "metric_value": atom["display"], "value_role": "分析时点",
    } for atom in history["evidence_items"] if atom["type"] == "fact"]
    request.summary, request.fallback = "", True
    request.focus_refs = ["old.total", "old.personal"]
    if history_only:
        request.context_run_refs = request.run_refs
    result = compose_analysis_report(service, object(), request)
    assert "对比甲行" in result["public_answer"] and "对比乙行" in result["public_answer"]
    assert "暂无" not in result["public_answer"]
    assert not any("未取得" in gap for gap in result["gaps"])


def test_selected_history_keeps_each_runs_own_metric_scope():
    current, history, service, request = setup_sources()
    history.update(org_codes=["O2"], org_names=["历史对比机构"])
    for atom in history["evidence_items"]:
        if atom.get("org_code"):
            atom.update(org_code="O2", org_name="历史对比机构")
    older = deepcopy(history)
    older.update(run_ref="older", scope_id="older-turn", actual_dates=["2026-08-26"])
    for atom in older["evidence_items"]:
        atom["ref"] = "older." + atom["ref"]
        atom["date"] = "2026-08-26"
        if atom.get("input_refs"):
            atom["input_refs"] = ["older." + ref for ref in atom["input_refs"]]
    sources = {source["run_ref"]: source for source in [current, history, older]}
    service.authorized_evidence.side_effect = lambda _actor, ref: deepcopy(sources[ref])
    request.run_refs.append("older")
    request.context_run_refs.append("older")
    request.summary, request.fallback = "", True
    request.focus_refs = ["old.total", "older.old.personal"]
    result = compose_analysis_report(service, object(), request)
    refs = {ref for paragraph in result["report"]["body_evidence"]
            for ref in paragraph["evidence_refs"]}
    assert {"old.total", "older.old.personal"} <= refs
    assert not {"old.personal", "older.old.total"}.intersection(refs)
    assert "暂无" not in result["public_answer"]
    assert result["gaps"] == []


def fallback_calculation(*, cross_org=True, unit="元", encoding=None, current="120", base="100"):
    service, actor, calculation, source, _ = setup_comparison(
        unit=unit, encoding=encoding, current=current, base=base,
    )
    if cross_org:
        source["org_codes"].append("B")
        source["org_names"].append("乙行")
        source["evidence_items"][1].update(org_code="B", org_name="乙行", date="2026-08-31")
        with service.execution.uow_factory() as uow:
            task = uow.tasks.get_owned_for_update("test-task", actor.user_id)
            artifact = task.state_json["result_artifact"]
            artifact["logical_dsl"]["orgs"] = ["A", "B"]
            artifact["result"]["facts"][1].update(
                org_code="B", org_name="乙行", date="2026-08-31",
            )
        service.execution._authorize_query = lambda **_: (
            SimpleNamespace(orgs=["A", "B"]), [SimpleNamespace(code="M1", unit=unit)], [],
        )
    sources = []
    for index, fact in enumerate(source["evidence_items"][:2]):
        item = deepcopy(source)
        item.update(
            run_ref=f"analysis:source-{index}", scope_id="current" if index == 0 else "history",
            org_codes=[fact["org_code"]], org_names=[fact["org_name"]],
            actual_dates=[fact["date"]], analysis_date=fact["date"], observations=[],
            evidence_items=[{**fact, "ref": f"source-{index}.f1"}],
        )
        item["rows"] = [{
            "metric_name": fact["metric_name"], "org_name": fact["org_name"],
            "stat_date": fact["date"], "metric_value": fact["display"], "value_role": "分析时点",
        }]
        sources.append(item)
    service.authorized_evidence = lambda _actor, ref: deepcopy(
        next(item for item in sources if item["run_ref"] == ref)
    )
    calculation.run_refs = [item["run_ref"] for item in sources]
    calculation.current_ref, calculation.base_ref = [
        item["evidence_items"][0]["ref"] for item in sources
    ]
    result = calculate_analysis_results(service, actor, calculation, "fallback-comparison")
    request = AnalysisReportRequest(
        run_refs=calculation.run_refs, context_run_refs=[calculation.run_refs[1]],
        calculation_refs=[CalculationReference(**result["calculation_ref"])],
        focus_refs=[result["evidence_items"][0]["ref"]], fallback=True,
    )
    return service, actor, sources, result, request


@pytest.mark.parametrize("cross_org", [False, True])
@pytest.mark.parametrize("operation,expression,display", [
    ("difference", "取值差额", "20.00元"), ("change_rate", "相对差异率", "20.00%"),
])
def test_fallback_restores_only_selected_calculation_with_both_input_identities(
    cross_org, operation, expression, display,
):
    service, actor, sources, calculated, request = fallback_calculation(cross_org=cross_org)
    selected = next(atom for atom in calculated["evidence_items"] if atom["name"] == operation)
    request.focus_refs = [selected["ref"]]
    original = deepcopy(sources)
    result = compose_analysis_report(service, actor, request)
    paragraphs = result["report"]["summary"].split("\n\n")
    comparison = next(text for text in paragraphs if f"{expression}为{display}" in text)
    assert "甲行（2026-08-31）" in comparison
    assert ("乙行（2026-08-31）" if cross_org else "甲行（2026-07-31）") in comparison
    calculation_refs = {
        atom["ref"] for atom in result["evidence_items"] if atom["type"] == "calculation"
    }
    assert calculation_refs == {selected["ref"]}
    assert set(result["run_refs"]) == set(request.run_refs)
    refs = {
        ref for paragraph in result["report"]["body_evidence"] for ref in paragraph["evidence_refs"]
    }
    assert {selected["ref"], "source-0.f1", "source-1.f1"} <= refs
    assert sources == original


def test_fallback_calculation_identity_alone_does_not_select_all_operations_or_history():
    service, actor, _, _, request = fallback_calculation()
    request.focus_refs = []
    result = compose_analysis_report(service, actor, request)
    assert result["run_refs"] == [request.run_refs[0]]
    assert not any(atom["type"] == "calculation" for atom in result["evidence_items"])
    assert "乙行" not in result["public_answer"]


def test_historical_fallback_calculation_does_not_expand_other_organizations():
    service, actor, sources, calculated, request = fallback_calculation()
    history = sources[1]
    history["org_codes"].append("C")
    history["org_names"].append("未选丙行")
    history["evidence_items"].append({
        **history["evidence_items"][0], "ref": "unselected.f1", "fact_id": "unselected-fact",
        "org_code": "C", "org_name": "未选丙行", "value": "999", "display": "999.00元",
    })
    request.context_run_refs = request.run_refs
    result = compose_analysis_report(service, actor, request)
    assert "取值差额为20.00元" in result["public_answer"]
    assert "未选丙行" not in result["public_answer"]
    assert {atom["ref"] for atom in result["evidence_items"]} == {
        "source-0.f1", "source-1.f1", calculated["evidence_items"][0]["ref"],
    }


def test_fallback_restores_calculation_owned_by_historical_source():
    service, actor, sources, _, request = fallback_calculation()
    calculated = calculate_analysis_results(service, actor, AnalysisCalculationRequest(
        conversation_id="test-conversation", run_refs=request.run_refs,
        current_ref="source-1.f1", base_ref="source-0.f1",
        calculation_context={"scope_id": "new-turn", "user_question": "乙行相对甲行差多少"},
    ), "reverse-comparison")
    request.calculation_refs = [CalculationReference(**calculated["calculation_ref"])]
    request.focus_refs = [calculated["evidence_items"][0]["ref"]]
    original = deepcopy(sources)
    result = compose_analysis_report(service, actor, request)
    assert "乙行（2026-08-31）相对甲行（2026-08-31）的隔离测试指标取值差额为-20.00元" in (
        result["public_answer"]
    )
    assert {atom["ref"] for atom in result["evidence_items"] if atom["type"] == "calculation"} == {
        calculated["evidence_items"][0]["ref"],
    }
    assert sources == original


@pytest.mark.parametrize("change", ["missing_calculation", "changed_fact", "revoked"])
def test_fallback_checks_calculation_and_original_sources_before_projection(change):
    service, actor, sources, _, request = fallback_calculation()
    if change == "missing_calculation":
        request.calculation_refs[0].calculation_id = "missing"
    elif change == "changed_fact":
        sources[1]["evidence_items"][0]["value"] = "99"
    else:
        service.authorized_evidence = lambda *_: (_ for _ in ()).throw(ApplicationError(
            "ANALYSIS_FORBIDDEN", "来源权限已撤销", status_code=403,
        ))
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, actor, request)
    assert caught.value.code == (
        "ANALYSIS_FORBIDDEN" if change == "revoked" else "ANALYSIS_CALCULATION_SOURCE"
    )


def test_fallback_keeps_percentage_point_difference_without_creating_a_ratio():
    service, actor, _, calculated, request = fallback_calculation(
        unit="%", encoding="ratio", current="0.035", base="0.01",
    )
    result = compose_analysis_report(service, actor, request)
    assert "取值差额为2.50个百分点" in result["public_answer"]
    assert "2.5倍" not in result["public_answer"]
    request.fallback = False
    request.focus_refs = []
    request.summary = (
        "| 指标 | 差额 |\n|---|---|\n| 隔离测试指标 | 2.5倍{{"
        + calculated["evidence_items"][0]["ref"] + "|cite}} |"
    )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, actor, request)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
