"""已鉴权的问数来源可以跨机构比较，历史展示范围只包含实际引用的机构。"""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_analysis_report_claims import evidence

from ask_metric.application.analysis_report import (
    AnalysisReportRequest,
    ReportFactBinding,
    compose_analysis_report,
)
from ask_metric.core.errors import ApplicationError


def setup_sources():
    current, history = evidence(), evidence()
    current.update(execution_mode="inquiry", run_ref="current", scope_id="new-turn")
    history.update(execution_mode="inquiry", run_ref="history", scope_id="old-turn")
    for atom in history["evidence_items"]:
        atom["ref"] = "old." + atom["ref"]
        if "input_refs" in atom:
            atom["input_refs"] = ["old." + ref for ref in atom["input_refs"]]
    by_ref = {"current": current, "history": history}
    service = SimpleNamespace(
        authorized_evidence=Mock(side_effect=lambda _actor, ref: deepcopy(by_ref[ref])),
        semantics=lambda _actor: SimpleNamespace(
            resolve=lambda _ref: None,
            items={
                item["code"]: SimpleNamespace(name=item["name"])
                for source in by_ref.values()
                for item in source["metric_descriptors"]
            },
        ),
    )
    request = AnalysisReportRequest(
        run_refs=["current", "history"],
        context_run_refs=["history"],
        summary="本机构存款为{{total}}，此前查询也有该项记录{{old.total|cite}}。",
        sections=[],
    )
    return current, history, service, request


@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("selected_orgs", [["O1"], ["O2"], ["O1", "O2"]])
def test_historical_reuse_projects_selected_facts_without_expanding_same_metric(
    selected_orgs, fallback,
):
    _, history, service, request = setup_sources()
    history.update(org_codes=["O1", "O2"], org_names=["测试机构", "另一机构"])
    other_facts = [
        {
            **atom, "ref": atom["ref"].replace("old.", "other."),
            "org_code": "O2", "org_name": "另一机构",
        }
        for atom in history["evidence_items"] if atom["type"] == "fact"
    ]
    history["evidence_items"].extend(other_facts)
    history["rows"] = [
        {
            "metric_name": atom["metric_name"], "org_name": atom["org_name"],
            "stat_date": atom["date"], "metric_value": atom["display"],
            "value_role": "分析时点",
        }
        for atom in history["evidence_items"] if atom["type"] == "fact"
    ]
    history["row_count"] = len(history["rows"])
    selected = [
        atom for atom in history["evidence_items"]
        if atom.get("metric_code") == "total" and atom["org_code"] in selected_orgs
    ]
    request.run_refs = request.context_run_refs = ["history"]
    request.focus_refs = [atom["ref"] for atom in selected]
    request.fallback = fallback
    request.summary = "" if fallback else "\n\n".join(
        atom["org_name"] + "存款为{{" + atom["ref"] + "}}。" for atom in selected
    )
    original = deepcopy(history)

    result = compose_analysis_report(service, object(), request)

    assert result["status"] == "succeeded"
    assert result["org_codes"] == selected_orgs
    assert {atom["ref"] for atom in result["evidence_items"]} == set(request.focus_refs)
    assert result["rows"] == [
        row for row in history["rows"]
        if row["metric_name"] == selected[0]["metric_name"]
        and row["org_name"] in {atom["org_name"] for atom in selected}
    ]
    assert result["row_count"] == len(selected_orgs)
    assert result["report"]["presentation"]["scope"] == (
        "、".join(atom["org_name"] for atom in selected) + " · 2026-08-27"
    )
    assert history == original


@pytest.mark.parametrize("fallback", [False, True])
def test_historical_reuse_retains_explicit_gap_without_expanding_unselected_evidence(fallback):
    current, history, service, request = setup_sources()
    gap = {"ref": "old.g1", "type": "gap", "display": "另一机构在四月末没有存款记录。"}
    history.update(
        org_codes=["O2"], org_names=["另一机构"],
        requested_start="2026-04-30", requested_end="2026-04-30",
        actual_dates=[], analysis_date=None, complete=False,
        evidence_items=[gap, {
            "ref": "old.g2", "type": "gap", "display": "另一项查询尚未完成。",
        }],
        observations=[], rows=[], row_count=0,
        gaps=[gap["display"], "另一项查询尚未完成。"],
    )
    request.context_run_refs = request.run_refs.copy()
    request.focus_refs = ["total", "old.g1"]
    request.fallback = fallback
    request.summary = "" if fallback else "本机构存款为{{total}}。\n\n{{old.g1}}"
    original = deepcopy([current, history])

    result = compose_analysis_report(service, object(), request)

    assert result["status"] == "succeeded"
    assert result["org_codes"] == ["O1", "O2"]
    assert result["run_refs"] == ["current", "history"]
    assert result["partial_analysis"] is True
    assert {atom["ref"] for atom in result["evidence_items"]} == {"total", "old.g1"}
    assert gap["display"] in result["public_answer"]
    assert gap["display"] in result["gaps"]
    assert "另一项查询尚未完成。" not in result["public_answer"]
    assert [current, history] == original


def test_inquiry_accepts_historical_latest_and_current_exact_at_same_actual_date():
    current, history, service, request = setup_sources()
    history.update(date_selection="latest_snapshot", requested_start=None, requested_end=None)
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["analysis_date"] == "2026-08-27"
    assert result["org_codes"] == current["org_codes"]
    assert service.authorized_evidence.call_count == 2


def test_inquiry_accepts_authorized_wider_history_without_expanding_current_scope():
    current, history, service, request = setup_sources()
    history.update(org_codes=["O1", "O2"], org_names=["测试机构", "另一机构"])
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["org_codes"] == current["org_codes"] == ["O1"]
    assert result["report"]["requirement_coverage"][0]["status"] == "covered"
    assert service.authorized_evidence.call_count == 2


def test_inquiry_compares_historical_zijin_with_current_jiangnan_at_inherited_date():
    current, history, service, request = setup_sources()
    for source, code, name in (
        (current, "FR001", "江苏江南农村商业银行"),
        (history, "320188000", "江苏紫金农村商业银行"),
    ):
        source.update(
            org_codes=[code],
            org_names=[name],
            actual_dates=["2026-07-31"],
            analysis_date="2026-07-31",
            requested_start="2026-07-31",
            requested_end="2026-07-31",
        )
        for atom in source["evidence_items"]:
            atom.update(org_code=code, org_name=name, date="2026-07-31")
    history.update(date_selection="latest_snapshot", requested_start=None, requested_end=None)
    request.summary = "江南存款为{{total}}，紫金存款为{{old.total}}。"

    result = compose_analysis_report(service, object(), request)

    assert result["status"] == "succeeded"
    assert result["org_codes"] == ["FR001", "320188000"]
    assert result["report"]["presentation"]["scope"] == (
        "江苏江南农村商业银行、江苏紫金农村商业银行 · 2026-07-31"
    )
    assert result["report"]["summary"] == "江南存款为100元，紫金存款为100元。"


def test_inquiry_scope_keeps_current_target_and_only_referenced_historical_organizations():
    current, history, service, request = setup_sources()
    current.update(org_codes=["O1", "O4"], org_names=["测试机构", "当前另一机构"])
    history.update(org_codes=["O2", "O3"], org_names=["历史比较机构", "未引用机构"])
    for atom in history["evidence_items"]:
        code, name = ("O2", "历史比较机构") if atom["ref"] == "old.total" else ("O3", "未引用机构")
        atom.update(org_code=code, org_name=name)
    request.summary = "本机构存款为{{total}}。"
    request = AnalysisReportRequest.model_validate(
        {
            **request.model_dump(),
            "sections": [
                {
                    "title": "机构对比",
                    "text": "历史比较机构存款为{{old.total}}。",
                    "evidence_refs": ["old.total"],
                },
            ],
        }
    )

    result = compose_analysis_report(service, object(), request)

    assert result["org_codes"] == ["O1", "O4", "O2"]
    assert result["report"]["presentation"]["scope"] == (
        "测试机构、当前另一机构、历史比较机构 · 2026-08-27"
    )
    assert "未引用机构" not in result["public_answer"]


def test_inquiry_combines_same_turn_batches_for_different_organizations():
    current, other, service, request = setup_sources()
    other.update(scope_id=current["scope_id"], org_codes=["O2"], org_names=["对比机构"])
    for atom in other["evidence_items"]:
        atom.update(org_code="O2", org_name="对比机构")
    request.context_run_refs = []
    request.summary = "本机构存款为{{total}}，对比机构存款为{{old.total}}。"

    result = compose_analysis_report(service, object(), request)

    assert result["status"] == "succeeded"
    assert result["org_codes"] == ["O1", "O2"]
    assert result["report"]["presentation"]["scope"] == "测试机构、对比机构 · 2026-08-27"


def test_same_turn_sources_can_describe_their_different_actual_periods():
    current, followup, service, request = setup_sources()
    current.update(date_selection="latest_snapshot", requested_start=None, requested_end=None)
    followup.update(
        scope_id=current["scope_id"],
        actual_dates=["2026-07-31"],
        analysis_date="2026-07-31",
        requested_start="2026-07-31",
        requested_end="2026-07-31",
    )
    for atom in followup["evidence_items"]:
        atom["date"] = "2026-07-31"
    request.context_run_refs = []
    request.summary = "截至2026-08-27存款为{{total}}；2026-07-31存款为{{old.total}}，统计日期不同。"
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert "各指标截至日不同" in result["public_answer"]
    assert "2026-08-27存款为100元" in result["public_answer"]
    assert "2026-07-31存款为100元" in result["public_answer"]


def test_same_period_empty_followup_preserves_real_gap_without_inventing_values():
    current, followup, service, request = setup_sources()
    current.update(date_selection="latest_snapshot", requested_start=None, requested_end=None)
    followup.update(
        scope_id=current["scope_id"],
        actual_dates=[],
        analysis_date=None,
        evidence_items=[],
        observations=[],
        complete=False,
        gaps=["个人存款在指定日期没有有效记录。"],
    )
    request.context_run_refs = []
    request.summary = "本机构存款为{{total}}。"
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert "个人存款在指定日期没有有效记录" in result["public_answer"]
    assert not any(atom["ref"].startswith("old.") for atom in result["evidence_items"])


def test_empty_target_can_explain_another_date_as_reference_without_replacing_the_target():
    current, reference, service, request = setup_sources()
    current.update(
        actual_dates=[],
        analysis_date=None,
        evidence_items=[],
        observations=[],
        complete=False,
        requested_start="2026-07-31",
        requested_end="2026-07-31",
        gaps=["2026-07-31未取得存款有效记录。"],
    )
    reference.update(
        scope_id=current["scope_id"],
        date_selection="latest_snapshot",
        requested_start=None,
        requested_end=None,
    )
    request.context_run_refs = []
    request.summary = (
        "2026年7月末没有可用数据。2026-08-27存款为{{old.total}}，"
        "仅作其他日期的参考，不能代表七月末情况。"
    )

    result = compose_analysis_report(service, object(), request)

    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert "2026年7月末没有可用数据" in result["public_answer"]
    assert "2026-08-27存款为100元" in result["public_answer"]
    assert "查询期间：2026-07-31至2026-07-31" in result["report"]["presentation"]["scope"]
    assert "实际数据日期：2026-08-27" in result["report"]["presentation"]["scope"]

    request.summary = (
        "| 机构 | 日期 | 存款 |\n|---|---|---|\n| 测试机构 | 2026-08-31 | {{old.total}} |"
    )
    request.fact_bindings = [
        ReportFactBinding(
            ref="old.total",
            org_code="O1",
            metric_code="total",
            date="2026-08-31",
        )
    ]
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


@pytest.mark.parametrize(
    "change",
    [
        "legacy_history",
        "legacy_current",
        "conversation",
        "unmarked_context",
        "unknown_atom",
    ],
)
def test_inquiry_scope_compatibility_does_not_relax_other_boundaries(change):
    current, history, service, request = setup_sources()
    history.update(date_selection="latest_snapshot", requested_start=None, requested_end=None)
    if change == "legacy_history":
        history.pop("execution_mode")
    elif change == "legacy_current":
        current.pop("execution_mode")
    elif change == "conversation":
        history["conversation_id"] = "another-session"
    elif change == "unknown_atom":
        request.summary = "存款为{{not-an-atom}}。"
    else:
        request.context_run_refs = []
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == (
        "ANALYSIS_REPORT_REFERENCE" if change == "unknown_atom" else "ANALYSIS_REPORT_SCOPE"
    )


def test_inquiry_history_permission_revocation_stops_report_before_composition():
    _, history, service, request = setup_sources()
    history.update(org_codes=["O1", "O2"], org_names=["测试机构", "另一机构"])
    authorized = service.authorized_evidence.side_effect

    def read(actor, ref):
        if ref == "history":
            raise ApplicationError("ANALYSIS_FORBIDDEN", "历史范围权限已撤销", status_code=403)
        return authorized(actor, ref)

    service.authorized_evidence.side_effect = read
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_FORBIDDEN"


@pytest.mark.parametrize("selection", ["exact", "latest_snapshot", "mixed"])
def test_same_turn_separate_metrics_keep_their_individual_confirmed_dates(selection):
    current, other, service, request = setup_sources()
    for source, code, day in (
        (current, "personal", "2026-08-27"),
        (other, "corporate", "2026-07-31"),
    ):
        date_selection = (
            ("latest_snapshot" if code == "personal" else "exact")
            if selection == "mixed"
            else selection
        )
        source.update(
            scope_id="new-turn",
            requested_start=day,
            requested_end=day,
            actual_dates=[day],
            analysis_date=day,
            date_selection=date_selection,
        )
        if date_selection == "latest_snapshot":
            source.update(requested_start=None, requested_end=None)
        source["metric_descriptors"] = [
            item for item in source["metric_descriptors"] if item["code"] == code
        ]
        source["evidence_items"] = [
            item
            for item in source["evidence_items"]
            if item.get("metric_code") == code and item["type"] == "fact"
        ]
        for item in source["evidence_items"]:
            item["date"] = day
        source["plan"]["steps"][0]["metric_refs"] = [code]
    request.context_run_refs = []
    request.summary = (
        "个人存款截至2026-08-27为{{personal}}；"
        "对公存款截至2026-07-31为{{old.corporate}}，两项日期不同。"
    )
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert "各指标截至日不同" in result["public_answer"]
    assert "查询期间：2026-08-27至2026-08-27" not in result["public_answer"]
    other.update(
        actual_dates=[],
        evidence_items=[],
        complete=False,
        gaps=["对公存款在2026-07-31没有可用数据。"],
    )
    request.summary = "个人存款截至2026-08-27为{{personal}}，对公存款在2026-07-31没有可用数据。"
    partial = compose_analysis_report(service, object(), request)
    assert partial["partial_analysis"] is True
    assert "60元" in partial["public_answer"]
    assert "2026-07-31没有可用数据" in partial["public_answer"]
    other["scope_id"] = "another-turn"
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_SCOPE"
