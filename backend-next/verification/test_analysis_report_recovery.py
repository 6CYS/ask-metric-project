"""同日机构比较的正文恢复；合成证据仅用于隔离回归测试。"""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from test_analysis_report_claims import evidence, report

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def test_recovery_rebuilds_facts_without_orphaned_explanations_or_subjective_claims():
    body = (
        "个人存款为{{personal}}。\n\n"
        "各类均增长。这一差异主要源于比较基期不同。\n\n"
        "费用控制总体平稳，费用刚性相对较强。"
    )
    summary = report(body, fallback=True)["report"]["summary"]
    assert "这一差异" not in summary and "费用刚性" not in summary
    assert "总体平稳" not in summary
    assert all(summary.count(value) == 1 for value in ("100元", "3元", "60元", "40元"))


def test_recovery_does_not_repeat_direction_after_its_comparison_values():
    summary = report("各类均增长。", fallback=True)["report"]["summary"]
    assert summary.count("较上月增加") == 1
    assert "较上月增加3元" in summary


def test_recovery_combines_the_same_missing_institutions_for_multiple_metrics():
    source = multiple_comparison_source()
    # 两项比较均缺同七家机构；不能生成逐指标重复的缺数段落。
    extra = deepcopy(source["evidence_items"][52])
    metric = source["metric_descriptors"][1]
    extra.update(ref="ytd-53", metric_code=metric["code"], metric_name=metric["name"])
    source["evidence_items"].append(extra)
    source["gaps"] = []
    summary = report("各类均增长。", source=source, fallback=True)["report"]["summary"]
    assert summary.count("还有7家机构暂无数据") == 1
    assert "各项存款余额较上月、各项存款余额较年初" in summary


def unknown_ratio_source():
    source = evidence()
    descriptor = {"code": "cost_ratio", "binding_ref": "cost_ratio",
                  "name": "费用收入比率", "unit": "%", "value_encoding": None}
    source["metric_descriptors"].append(descriptor)
    source["plan"]["steps"][0]["metric_refs"].append("cost_ratio")
    source["evidence_items"].append({
        "ref": "cost_ratio", "type": "fact", "value": "0.3",
        "display": "原始值0.3（目录单位%，数值编码待确认）", "unit": "%",
        "metric_code": "cost_ratio", "metric_name": descriptor["name"],
        "date": "2026-08-27", "org_code": "O1", "org_name": "测试机构",
    })
    source["rows"].append({"metric_name": descriptor["name"], "org_name": "测试机构",
                           "stat_date": "2026-08-27", "metric_value": "原始值0.3",
                           "value_role": "分析时点"})
    return source


def test_recovery_keeps_unknown_ratio_in_details_and_explains_limit_in_business_terms():
    result = report("费用控制总体平稳。", source=unknown_ratio_source(), fallback=True)
    summary = result["report"]["summary"]
    assert "原始值" not in summary and "数值编码" not in summary
    assert "费用收入比率的数值口径尚待确认，暂不用于分析" in summary
    assert "100元" in summary
    assert result["rows"][0]["metric_value"] == "原始值0.3"
    assert result["partial_analysis"] is True


def test_unknown_ratio_cannot_be_presented_as_a_business_value():
    with pytest.raises(ApplicationError) as caught:
        report("费用收入比率为{{cost_ratio}}。", source=unknown_ratio_source())
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("value", ["{{ratio-calculation}}", "30%{{ratio-calculation|cite}}"])
def test_unknown_ratio_cannot_be_laundered_through_a_calculation_value(value):
    source = unknown_ratio_source()
    source["evidence_items"].append({
        "ref": "ratio-calculation", "type": "calculation", "value": "30",
        "display": "30%", "input_refs": ["cost_ratio"],
    })
    with pytest.raises(ApplicationError) as caught:
        report("| 指标 | 数值 |\n|---|---|\n| 费用收入比率 | " + value + " |", source=source)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_unknown_ratio_judgment_cannot_block_other_verified_facts_during_recovery():
    source = unknown_ratio_source()
    source["evidence_items"].extend([
        {"ref": "ratio-calculation", "type": "calculation", "value": "0.3",
         "display": "0.3", "input_refs": ["cost_ratio"]},
        {"ref": "ratio-judgment", "type": "observation", "judgment_kind": "direction",
         "org_code": "O1", "display": "费用收入比率较同期增加。",
         "input_refs": ["ratio-calculation"]},
    ])
    result = report("{{ratio-judgment}}", source=source, fallback=True)
    summary = result["report"]["summary"]
    assert "费用收入比率较同期增加" not in summary
    assert "100元" in summary and "0.3" not in summary
    assert "暂不用于分析" in summary


def comparison_source(*, missing=True):
    source = evidence()
    metric = source["metric_descriptors"][1]
    source["metric_descriptors"] = [metric]
    source["org_codes"] = [f"O{index}" for index in range(1, 61 if missing else 54)]
    source["org_names"] = [
        f"测试机构{chr(65 + index // 26)}{chr(65 + index % 26)}"
        for index in range(60 if missing else 53)
    ]
    source["plan"]["steps"][0]["metric_refs"] = [metric["binding_ref"]]
    source["evidence_items"] = []
    source["rows"] = []
    for index in range(1, 54):
        value = {1: "+24.82", 2: "-8.20", 53: "-14.44"}.get(index, "0")
        source["evidence_items"].append({
            "ref": f"change-{index}", "type": "fact", "value": value,
            "display": f"{value}亿元", "metric_code": metric["code"],
            "metric_name": metric["name"], "date": "2026-08-27",
            "org_code": f"O{index}", "org_name": source["org_names"][index - 1],
        })
        source["rows"].append({
            "metric_name": metric["name"], "org_name": source["org_names"][index - 1],
            "stat_date": "2026-08-27", "metric_value": f"{value}亿元",
            "value_role": "分析时点",
        })
    source["row_count"] = 53
    source["complete"] = not missing
    source["gaps"] = ["有7家机构未取得有效值。"] if missing else []
    source["requirement_dispositions"] = [{
        "id": "q1", "status": "partial" if missing else "completed",
    }]
    return source


def test_comparison_recovery_sorts_verified_values_and_keeps_real_missing_data():
    source = comparison_source()
    body = "全省汇总存款下降。\n\n三家合计减少23.7亿元。\n\n本次覆盖52家机构。"
    result = report(body, source=source, fallback=True)
    answer = result["public_answer"]
    assert result.get("narrative_repaired") is True
    assert "还有7家机构暂无数据，未纳入本次分析。" in answer
    assert answer.index("测试机构CA") < answer.index("测试机构AB")
    assert "-14.44亿元" in answer and "+24.82亿元" in answer
    assert "全省汇总存款下降" not in answer and "23.7" not in answer
    assert "未通过" not in answer and "已省略" not in answer
    assert "不能据此确认整体变化或完整贡献" in answer
    assert result["partial_analysis"] is True
    assert "有7家机构未取得有效值。" in result["gaps"]
    refs = {ref for item in result["report"]["body_evidence"] for ref in item["evidence_refs"]}
    assert {"change-53", "change-2", "change-1"} <= refs
    assert result["report"]["requirement_coverage"][0]["status"] == "covered"


def test_fully_covered_comparison_is_not_partial_only_because_prose_was_repaired():
    result = report("各机构均下降。", source=comparison_source(missing=False), fallback=True)
    assert result.get("narrative_repaired") is True
    assert result["partial_analysis"] is False
    assert result["gaps"] == []


def test_recovery_rebuilds_the_complete_fact_set_without_reusing_failed_prose():
    body = (
        "存款整体平稳。\n\n"
        "各项存款余额为{{total}}，较上月增加{{total_mom}}。\n\n"
        "目前只能确认余额变化，具体业务原因还需结合客户流水核实。"
    )
    result = report(body, fallback=True)
    summary = result["report"]["summary"]
    assert "各项存款余额当日数为100元。" in summary and "较上月增加3元。" in summary
    assert "具体业务原因还需结合客户流水核实" not in summary
    assert "整体平稳" not in summary
    assert summary.count("100元") == 1 and summary.count("3元") == 1
    assert "60元" in summary and "40元" in summary
    assert "正向变动" not in summary and "列示部分机构" not in summary
    assert result["partial_analysis"] is False


def test_recovery_does_not_keep_an_orphaned_boundary_from_a_rejected_paragraph():
    body = (
        "各项存款余额为{{total}}，较上月增加{{total_mom}}。\n\n"
        "关于为什么：因此只能确认余额在三个基期上均有所增长，尚不能判断增长的具体原因。"
        "若要进一步解释，需要补充存款分项结构或相关业务证据。"
    )
    summary = report(body, fallback=True)["report"]["summary"]
    assert "若要进一步解释，需要补充存款分项结构或相关业务证据。" not in summary
    assert "均有所增长" not in summary
    assert summary.count("100元") == 1 and summary.count("3元") == 1


def test_recovery_keeps_numeric_facts_instead_of_selecting_sentences_from_failed_prose():
    body = (
        "各项存款余额为{{total}}，较上月增加{{total_mom}}。"
        "各分类都在增长。具体业务原因尚需客户流水核实。"
    )
    result = report(body, source=evidence(comparison="3.25"), fallback=True)
    summary = result["report"]["summary"]
    assert "各项存款余额当日数为100元。" in summary and "较上月增加3.25元。" in summary
    assert "具体业务原因尚需客户流水核实。" not in summary
    assert "各分类都在增长" not in summary
    assert summary.count("100元") == 1 and summary.count("3.25元") == 1


def test_sentence_recovery_does_not_hide_unknown_reference():
    with pytest.raises(ApplicationError) as caught:
        report("当前余额为{{total}}。整体平稳。其他余额为{{unknown}}。", fallback=True)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_sentence_recovery_does_not_keep_broken_markdown_fragment():
    summary = report("**当前余额为{{total}}。各类均增长。**", fallback=True)["report"]["summary"]
    assert "当前余额为" not in summary
    assert "100元" in summary and "均增长" not in summary


@pytest.mark.parametrize("body", [
    "存款整体平稳。\n\n**已取得的数据**\n\n{{total|cite}}",
    "各项存款余额为{{total}}，因为营销活动导致增长。",
])
def test_recovery_citation_or_rejected_paragraph_does_not_hide_required_facts(body):
    result = report(body, fallback=True)
    summary = result["report"]["summary"]
    assert all(value in summary for value in ["100元", "3元", "60元", "40元"])
    assert "营销活动" not in summary and "整体平稳" not in summary


def test_report_scope_uses_business_date_and_keeps_requested_range_when_different():
    result = report("各项存款余额为{{total}}。")
    assert result["report"]["presentation"]["scope"] == "测试机构 · 2026-08-27"
    assert "覆盖检查日期" not in result["public_answer"]
    source = evidence()
    source.update(requested_start="2026-08-01", requested_end="2026-08-31")
    result = report("各项存款余额为{{total}}。", source=source)
    assert "查询期间：2026-08-01至2026-08-31" in result["report"]["presentation"]["scope"]
    assert "实际数据日期：2026-08-27" in result["report"]["presentation"]["scope"]


@pytest.mark.parametrize("count", [1, 53])
def test_complete_institution_results_do_not_display_execution_coverage_counts(count):
    source = comparison_source(missing=False)
    for key in ["org_codes", "org_names", "evidence_items", "rows"]:
        source[key] = source[key][:count]
    source["row_count"] = count
    result = report("各机构均下降。", source=source, fallback=True)
    answer = result["public_answer"]
    assert "本次请求" not in answer
    assert f"取得有效值{count}家" not in answer
    assert "未取得有效值0家" not in answer
    assert "其余结果见数据明细" not in answer
    assert "+24.82亿元" in answer
    if count > 4:
        assert "列示部分机构" in answer
    assert result["row_count"] == count
    assert result["partial_analysis"] is False


def test_missing_observed_institutions_cannot_become_complete_from_prose_recovery():
    source = comparison_source()
    source["complete"] = True
    result = report("各机构均下降。", source=source, fallback=True)
    assert result.get("narrative_repaired") is True
    assert result["partial_analysis"] is True


def test_positive_sort_preserves_decimal_digits_beyond_context_precision():
    source = comparison_source()
    for atom in source["evidence_items"]:
        atom["value"], atom["display"] = "0", "0元"
    source["evidence_items"][0].update(
        value="123456789012345678901234567890.01", display="123456789012345678901234567890.01元"
    )
    source["evidence_items"][1].update(
        value="123456789012345678901234567890.02", display="123456789012345678901234567890.02元"
    )
    result = report("各机构均下降。", source=source, fallback=True)
    summary = result["report"]["summary"]
    assert summary.index("测试机构AB") < summary.index("测试机构AA")
    assert "123456789012345678901234567890.02元" in summary


@pytest.mark.parametrize(
    "case", ["metrics", "dates", "conflict", "method", "requirements", "nonfinite", "outside_scope"]
)
def test_recovery_distinguishes_legal_groups_from_invalid_evidence(case):
    source = comparison_source()
    if case == "metrics":
        source["metric_descriptors"].append(evidence()["metric_descriptors"][0])
    elif case == "dates":
        source["evidence_items"][-1]["date"] = "2026-08-26"
        source["actual_dates"].append("2026-08-26")
    elif case == "conflict":
        conflicting = {
            **source["evidence_items"][0], "ref": "conflict", "value": "12", "display": "12亿元"
        }
        source["evidence_items"].append(conflicting)
    elif case == "method":
        source["plan"]["steps"][0]["method"] = "attribution"
    elif case == "requirements":
        source["plan"]["requirements"].append({"id": "q2", "question": "增长原因"})
    elif case == "nonfinite":
        source["evidence_items"][0]["value"] = "NaN"
    else:
        source["evidence_items"][0]["org_code"] = "OUTSIDE"
    if case in {"metrics", "conflict", "method", "nonfinite", "outside_scope"}:
        with pytest.raises(ApplicationError) as caught:
            report("机构变化情况。", source=source, fallback=True)
        assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"
    else:
        result = report("机构变化情况。", source=source, fallback=True)
        assert result["narrative_repaired"] is True
        assert result["partial_analysis"] is True
        assert "-14.44亿元" in result["public_answer"]


def test_duplicate_identical_facts_do_not_inflate_coverage():
    source = comparison_source()
    duplicate = {**deepcopy(source["evidence_items"][0]), "ref": "same-fact"}
    source["evidence_items"].append(duplicate)
    source["row_count"] = 54
    result = report("各机构均下降。", source=source, fallback=True)
    assert result.get("narrative_repaired") is True
    assert "还有7家机构暂无数据，未纳入本次分析。" in result["public_answer"]


@pytest.mark.parametrize("body", [
    "{{unknown-fact}}",
    "全省汇总存款下降。\n\n{{unknown-fact}}",
])
def test_invalid_reference_is_not_hidden_by_earlier_claim_failure(body):
    for fallback in [False, True]:
        with pytest.raises(ApplicationError) as caught:
            report(body, source=comparison_source(), fallback=fallback)
        assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def multiple_comparison_source():
    source = comparison_source()
    metric = {**source["metric_descriptors"][0], "code": "total_ytd",
              "binding_ref": "total_ytd", "name": "各项存款余额较年初", "value_basis": "较年初"}
    source["metric_descriptors"].append(metric)
    source["plan"]["steps"][0]["metric_refs"].append(metric["binding_ref"])
    for index, atom in enumerate(deepcopy(source["evidence_items"][:52])):
        value = {0: "-30.01", 1: "+8.02"}.get(index, "0")
        atom.update(ref=f"ytd-{index + 1}", metric_code=metric["code"], metric_name=metric["name"],
                    value=value, display=f"{value}亿元")
        source["evidence_items"].append(atom)
        source["rows"].append({
            "metric_name": metric["name"], "org_name": atom["org_name"],
            "stat_date": atom["date"], "metric_value": atom["display"], "value_role": "分析时点",
        })
    source["gaps"].append("较年初有8家机构未取得有效值。")
    source["row_count"] = 105
    return source


def mixed_value_source():
    source = comparison_source(missing=False)
    balance = {**source["metric_descriptors"][0], "code": "balance",
               "binding_ref": "balance", "name": "各项存款余额当日数", "value_basis": None}
    source["metric_descriptors"].append(balance)
    source["plan"]["steps"][0]["metric_refs"].append("balance")
    for index, atom in enumerate(deepcopy(source["evidence_items"])):
        atom.update(ref=f"balance-{index}", metric_code="balance", metric_name=balance["name"],
                    value="100", display="100亿元")
        source["evidence_items"].append(atom)
    return source


def test_mixed_balance_and_comparison_recovery_keeps_both_groups_without_prose_repair():
    source = mixed_value_source()
    result = report("全省均下降999亿元。", source=source, fallback=True)
    summary = result["report"]["summary"]
    assert result["narrative_repaired"] is True
    assert result["partial_analysis"] is False
    assert "各项存款余额当日数" in summary and "100亿元" in summary
    assert "各项存款余额较上月" in summary and "-14.44亿元" in summary
    assert "+24.82亿元" in summary and "999" not in summary
    assert result["evidence_items"] == source["evidence_items"]


def test_multiple_dates_and_requirements_keep_each_fact_group_and_coverage():
    source = mixed_value_source()
    source["actual_dates"].append("2026-08-26")
    source["plan"]["requirements"].append({"id": "q2", "question": "余额是多少"})
    source["plan"]["steps"] = [
        {"id": "s1", "method": "observe", "answers": ["q1"], "metric_refs": ["total_mom"]},
        {"id": "s2", "method": "observe", "answers": ["q2"], "metric_refs": ["balance"]},
    ]
    for atom in source["evidence_items"]:
        if atom["metric_code"] == "balance":
            atom["date"] = "2026-08-26"
    result = report("均下降999亿元。", source=source, fallback=True)
    assert result["narrative_repaired"] is True
    assert "2026-08-26" in result["report"]["summary"]
    assert "2026-08-27" in result["report"]["summary"]
    assert {item["id"]: item["status"] for item in result["report"]["requirement_coverage"]} == {
        "q1": "covered", "q2": "covered",
    }


@pytest.mark.parametrize("fallback", [False, True])
def test_mixed_report_never_hides_unknown_reference_or_conflicting_fact(fallback):
    source = mixed_value_source()
    with pytest.raises(ApplicationError) as caught:
        report("均下降。{{unknown}}", source=source, fallback=fallback)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"
    source["evidence_items"].append({**source["evidence_items"][0],
                                     "ref": "conflicting", "value": "999", "display": "999亿元"})
    with pytest.raises(ApplicationError) as caught:
        report("均下降。", source=source, fallback=fallback)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_all_missing_report_delivers_verified_gap_without_zero_or_ranking():
    source = comparison_source()
    source.update(evidence_items=[], rows=[], row_count=0, actual_dates=[], analysis_date=None,
                  gaps=["所有请求机构均未取得有效值。"], complete=False)
    result = report("均下降999亿元。", source=source, fallback=True)
    assert result["narrative_repaired"] is True
    assert result["partial_analysis"] is True
    assert "未取得有效值" in result["report"]["summary"]
    assert "999" not in result["public_answer"]
    assert "负向变动" not in result["report"]["summary"]


def test_complementary_runs_keep_all_institutions_in_one_verified_fact_group():
    source = comparison_source(missing=False)
    supplement = deepcopy(source)
    supplement["run_ref"] = "run-2"
    source["evidence_items"] = source["evidence_items"][:30]
    supplement["evidence_items"] = supplement["evidence_items"][30:]
    source["rows"] = source["rows"][:30]
    supplement["rows"] = supplement["rows"][30:]
    by_ref = {source["run_ref"]: source, supplement["run_ref"]: supplement}
    semantics = SimpleNamespace(resolve=lambda _ref: None, items={
        item["code"]: SimpleNamespace(name=item["name"])
        for item in source["metric_descriptors"]
    })
    service = SimpleNamespace(authorized_evidence=lambda _actor, ref: deepcopy(by_ref[ref]),
                              semantics=lambda _actor: semantics)
    result = compose_analysis_report(service, object(), AnalysisReportRequest(
        run_refs=list(by_ref), summary="均下降999亿元。", fallback=True))
    summary = result["report"]["summary"]
    assert "本次请求" not in summary and "未取得有效值0家" not in summary
    assert "+24.82亿元" in summary and "-14.44亿元" in summary
    assert result["partial_analysis"] is False
    assert result["row_count"] == 53


def test_recovered_calculations_keep_observed_date_and_comparison_basis():
    source = evidence()
    source["actual_dates"].append("2026-08-26")
    source["evidence_items"].append({
        "ref": "calculated", "type": "calculation", "name": "difference",
        "metric_code": "total", "metric_name": "各项存款余额当日数",
        "value": "-5", "display": "-5元", "date": "2026-08-26", "org_code": "O1",
        "comparison": "mom", "comparison_role": "difference", "input_refs": ["total"],
    })
    result = report("均下降999元。", source=source, fallback=True)
    assert "2026-08-26" in result["report"]["summary"]
    assert "较上月差额：-5元" in result["report"]["summary"]


def test_recovery_obeys_explicit_ranking_limit_and_keeps_zero_distinct_from_missing():
    source = comparison_source(missing=False)
    source["plan"]["steps"][0].update(method="ranking", position="top", top_n=2)
    source["evidence_items"][1].update(value=None, display="暂无数据")
    result = report("均下降999亿元。", source=source, fallback=True)
    summary = result["report"]["summary"]
    assert "| 测试机构AA | +24.82亿元 |" in summary
    assert "| 测试机构AJ | 0亿元 |" in summary
    assert "测试机构CA" not in summary
    assert "还有1家机构暂无数据，未纳入本次分析。" in summary
    assert result["partial_analysis"] is True


def test_ranked_list_does_not_repeat_a_judgment_that_references_the_full_population():
    source = comparison_source(missing=False)
    source["plan"]["steps"][0].update(method="ranking", position="bottom", top_n=1)
    source["evidence_items"].append({
        "ref": "ranking", "type": "observation", "judgment_kind": "ranking",
        "org_code": "O53", "date": "2026-08-27", "display": "按比较值从低到高排第1位。",
        "input_refs": [atom["ref"] for atom in source["evidence_items"]],
    })
    result = report("均下降999亿元。", source=source, fallback=True)
    assert result["report"]["summary"].count("测试机构CA") == 1
    assert "排第1位" not in result["report"]["summary"]
    assert result["row_count"] == 53
    source["plan"]["steps"][0]["method"] = "observe"
    observed = report("均下降999亿元。", source=source, fallback=True)
    assert "排第1位" in observed["report"]["summary"]


def test_truncated_comparison_lists_do_not_append_directions_for_omitted_institutions():
    source = multiple_comparison_source()
    source["evidence_items"].extend([
        {"ref": "unlisted-direction", "type": "observation",
         "judgment_kind": "comparison_direction", "org_code": "O3", "date": "2026-08-27",
         "display": "各项存款余额较上月持平、较年初持平。",
         "input_refs": ["change-3", "ytd-3"]},
        {"ref": "independent-calculation", "type": "calculation", "value": "7",
         "display": "7亿元", "label": "已核验差额", "date": "2026-08-27",
         "input_refs": ["change-3", "ytd-3"]},
    ])
    result = report("均下降999亿元。", source=source, fallback=True)
    assert "测试机构AC" not in result["report"]["summary"]
    assert "较上月持平、较年初持平" not in result["report"]["summary"]
    assert "已核验差额：7亿元" in result["report"]["summary"]
    assert result["row_count"] == 105


def test_multiple_comparisons_keep_independent_rankings_coverage_and_references():
    source = multiple_comparison_source()
    original = deepcopy(source)
    result = report("两个基期全省存款均下降，合计减少23.7亿元。", source=source, fallback=True)
    summary = result["report"]["summary"]
    assert result.get("narrative_repaired") is True
    assert result["partial_analysis"] is True
    assert "**各项存款余额较上月**" in summary and "**各项存款余额较年初**" in summary
    monthly, yearly = summary.split("**各项存款余额较年初**", 1)
    assert monthly.index("测试机构CA") < monthly.index("测试机构AB")
    assert "-14.44亿元" in monthly and "-30.01亿元" not in monthly
    assert "-30.01亿元" in yearly and "+8.02亿元" in yearly
    assert "各项存款余额较上月：还有7家机构暂无数据，未纳入本次分析。" in summary
    assert "各项存款余额较年初：还有8家机构暂无数据，未纳入本次分析。" in summary
    assert "23.7" not in summary and "均下降" not in summary and "已省略" not in summary
    refs = {ref for item in result["report"]["body_evidence"] for ref in item["evidence_refs"]}
    assert {"change-53", "change-2", "ytd-1", "ytd-2"} <= refs
    assert result["gaps"] == source["gaps"]
    assert source == original


@pytest.mark.parametrize("case", [
    "unbound", "balance", "different_date", "conflict", "duplicate_descriptor",
    "duplicate_code", "duplicate_ref", "unknown_metric", "empty_metric",
])
def test_multiple_comparisons_still_require_complete_bindings_and_compatible_facts(case):
    source = multiple_comparison_source()
    if case == "unbound":
        source["plan"]["steps"][0]["metric_refs"].pop()
    elif case == "balance":
        source["metric_descriptors"][1].update(name="各项存款余额当日数", value_basis=None)
        for atom in source["evidence_items"]:
            if atom["metric_code"] == "total_ytd":
                atom["metric_name"] = "各项存款余额当日数"
    elif case == "different_date":
        source["evidence_items"][-1]["date"] = "2026-08-26"
    elif case == "conflict":
        source["evidence_items"].append({
            **source["evidence_items"][-1], "ref": "conflict-ytd", "value": "5",
        })
    elif case == "duplicate_descriptor":
        source["metric_descriptors"].append(deepcopy(source["metric_descriptors"][0]))
    elif case == "duplicate_code":
        source["metric_descriptors"][1]["code"] = source["metric_descriptors"][0]["code"]
    elif case == "duplicate_ref":
        duplicate = source["metric_descriptors"][0]["binding_ref"]
        source["metric_descriptors"][1]["binding_ref"] = duplicate
        source["plan"]["steps"][0]["metric_refs"][1] = duplicate
    elif case == "unknown_metric":
        source["evidence_items"][-1]["metric_code"] = "unknown_metric"
    else:
        source["evidence_items"] = [
            atom for atom in source["evidence_items"] if atom["metric_code"] != "total_ytd"
        ]
    if case in {"balance", "empty_metric"}:
        result = report("机构变化情况。", source=source, fallback=True)
        assert result["narrative_repaired"] is True
        assert result["partial_analysis"] is True
        assert "-14.44亿元" in result["public_answer"]
    else:
        with pytest.raises(ApplicationError) as caught:
            report("机构变化情况。", source=source, fallback=True)
        assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"
