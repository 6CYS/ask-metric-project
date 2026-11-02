"""报告展示只使用已授权证据；以下为隔离单元测试。"""

from copy import deepcopy

from ask_metric.application.analysis_report_view import report_rows, shared_date_text
from test_analysis_report_claims import evidence, report


def test_public_narrative_keeps_actual_dates_and_gaps_without_appending_internal_notes():
    source = evidence()
    source.update(
        date_selection="latest_snapshot", requested_start=None, requested_end=None,
        source_notice="数值来自项目配置指标查询库；上游生产来源与批次一致性需另行核实。",
        defaults_applied=["用户未指定日期，按指标覆盖选择最新观测。"],
        limitations=["目录未提供完整业务定义，不能据名称推断公式。"],
        gaps=["个人存款较同期数据暂不可用。"], complete=False,
    )
    answer = report("存款余额为{{total}}。", source=source)
    assert "配置指标查询库" not in answer["public_answer"]
    assert "目录未提供完整业务定义" not in answer["public_answer"]
    assert "用户未指定日期" not in answer["public_answer"]
    assert "最新可用数据：2026-08-27" in answer["public_answer"]
    assert "个人存款较同期数据暂不可用" in answer["public_answer"]
    assert answer["report"]["presentation"]["limitations"] == source["limitations"]
    assert answer["source_notice"] == source["source_notice"]
    assert answer["partial_analysis"] is True


def test_chart_values_come_from_matching_facts_without_changing_table_display():
    row = {"metric_name": "存款余额", "org_name": "测试机构", "stat_date": "2026-08-27",
           "metric_value": "23.09亿元", "value_role": "分析时点"}
    atom = {"type": "fact", "metric_name": "存款余额", "org_name": "测试机构",
            "date": "2026-08-27", "display": "23.09亿元", "value": "2309000000.25", "unit": "元"}
    source = {"rows": [row], "evidence_items": [atom]}
    before = deepcopy(source)
    assert report_rows([source]) == [{**row, "raw_value": "2309000000.25", "unit": "元"}]
    assert source == before
    del atom["unit"]
    assert report_rows([source]) == [row]
    atom["unit"] = "元"
    source["evidence_items"].append({**atom, "value": "2309000001"})
    assert report_rows([source]) == [row]


def test_percentage_encoding_is_not_guessed_from_display_text():
    row = {"metric_name": "不良率", "org_name": "测试机构", "stat_date": "2026-08-27",
           "metric_value": "2.50%", "value_role": "分析时点"}
    atom = {"type": "fact", "metric_name": "不良率", "org_name": "测试机构",
            "date": "2026-08-27", "display": "2.50%", "value": "0.025", "unit": "%"}
    assert report_rows([{"rows": [row], "evidence_items": [atom]}]) == [row]


def test_shared_scope_date_removed_only_from_same_date_heading():
    day = ["2026-08-27"]
    heading = "**存款同比环比（截至 2026-08-27）**\n\n正文。"
    assert shared_date_text(heading, day) == "**存款同比环比**\n\n正文。"
    assert shared_date_text("## 存款情况（截至2026年8月27日）", day) == "## 存款情况"
    for text in ["**基期（截至2026-07-27）**", "正文（截至2026-08-27）", "`截至2026-08-27`",
                 "```\n## 存款（截至2026-08-27）\n```"]:
        assert shared_date_text(text, day) == text
    text = "**存款（截至2026-08-27）**"
    assert shared_date_text(text, ["2026-07-27", *day]) == text


def test_repeated_canonical_scope_is_rendered_once_and_evidence_indices_stay_aligned():
    scope = "测试机构 · 2026-08-27"
    result = report(f"{scope}\n\n存款余额为{{{{total}}}}。")
    assert result["public_answer"].count(scope) == 1
    assert not result["report"]["summary"].startswith(scope)
    assert result["report"]["body_evidence"] == [{"paragraph": 1, "evidence_refs": ["total"]}]


def test_different_scope_in_body_is_not_silently_deleted():
    body = "其他机构 · 2026-07-31\n\n存款余额为{{total}}。"
    result = report(body)
    assert result["report"]["summary"].startswith("其他机构 · 2026-07-31")
