"""动态指标选择、单日范围及正式复合比较的隔离回归；不是实际数据湖验收。"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from test_business_overview import make_environment, request

from ask_metric.application.overview_evidence import (
    display_value,
    followup_candidates,
    overview_evidence,
)
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.models import MetricTerm


def test_selected_metrics_do_not_expand_into_fixed_full_report(tmp_path):
    service, actor, _, source, engine = make_environment(tmp_path / "adaptive.sqlite")
    try:
        result = service.execute(
            request(
                goal="growth",
                sections=["scale", "growth", "structure"],
                metric_ids=["personal"],
                comparisons=["mom"],
                objective="只分析个人贷款",
                questions=["个人贷款如何变化？"],
            ),
            actor,
            "adaptive",
        )
        assert {item["metric"] for item in result["tasks"]} == {"total", "personal"}
        assert {item["metric_id"] for item in result["table_rows"]} == {"total", "personal"}
        assert result["plan"]["questions"] == ["个人贷款如何变化？"]
        assert result["evidence_items"]
        assert not any("组成数据不完整" in gap["reason"] for gap in result["gaps"])
    finally:
        engine.dispose()


def test_point_in_time_uses_published_comparison_without_reconstructing_history(tmp_path):
    metrics = {
        "ORG_VRS_LOAN_BAL": {"name": "各项贷款余额_人行口径当日数", "unit": "元"},
        "ORG_VRS_LOAN_BAL_CMPRLATMO": {"name": "各项贷款余额_人行口径较上月", "unit": "元"},
        "ORG_VRS_LOAN_BAL_CMPRLATMO_INCRRNG": {
            "name": "各项贷款余额_人行口径较上月增幅",
            "unit": "%",
        },
    }
    day = date(2026, 8, 27)
    observations = [
        (code, day, Decimal(value))
        for code, value in zip(metrics, ["20000000000", "500000000", "0.025641025641"], strict=True)
    ]
    service, actor, sessions, _, engine = make_environment(
        tmp_path / "published.sqlite", source_metrics=metrics, observations=observations
    )
    try:
        with sessions() as session:
            for term in session.scalars(select(MetricTerm)):
                term.value_basis = None
            session.commit()
        result = service.execute(
            request(
                start=day,
                end=day,
                goal="growth",
                sections=["scale", "growth"],
                metric_ids=["total"],
                comparisons=["mom"],
            ),
            actor,
            "published",
        )
        assert result["analysis_date"] == "2026-08-27"
        assert list(result["facts"]["total"]) == ["2026-08-27"]
        assert result["reported_comparisons"][0]["facts"]["difference"]["fact_id"]
        assert result["table_rows"][0]["当前值"] == "200.00亿元"
        assert result["table_rows"][0]["较上月"] == "5.00亿元；2.56%（正式指标）"
        assert not result["calculations"]
    finally:
        engine.dispose()


def test_unknown_theme_metric_is_rejected_before_query(tmp_path):
    service, actor, _, source, engine = make_environment(tmp_path / "invalid.sqlite")
    try:
        with pytest.raises(ApplicationError, match="不属于当前主题"):
            service.execute(request(metric_ids=["invented"]), actor, "invalid")
        assert not source.calls
    finally:
        engine.dispose()


@pytest.mark.parametrize("reported_difference,reported_rate", [("200", "0"), ("5", "0.5")])
def test_inconsistent_formal_comparison_is_a_gap_not_zero_growth(
    tmp_path, reported_difference, reported_rate
):
    metrics = {
        "ORG_VRS_LOAN_BAL": {"name": "各项贷款余额_人行口径当日数", "unit": "亿元"},
        "ORG_VRS_LOAN_BAL_CMPRLATMO": {"name": "各项贷款余额_人行口径较上月", "unit": "亿元"},
        "ORG_VRS_LOAN_BAL_CMPRLATMO_INCRRNG": {
            "name": "各项贷款余额_人行口径较上月增幅",
            "unit": "%",
        },
    }
    day = date(2026, 8, 27)
    observations = [
        (code, day, Decimal(value))
        for code, value in zip(metrics, ["200", reported_difference, reported_rate], strict=True)
    ]
    service, actor, sessions, _, engine = make_environment(
        tmp_path / "inconsistent.sqlite", source_metrics=metrics, observations=observations
    )
    try:
        with sessions() as session:
            for term in session.scalars(select(MetricTerm)):
                term.value_basis = None
            session.commit()
        result = service.execute(
            request(
                start=day,
                end=day,
                goal="growth",
                sections=["scale", "growth"],
                metric_ids=["total"],
                comparisons=["mom"],
            ),
            actor,
            "inconsistent",
        )
        assert result["reported_comparisons"] == []
        assert result["table_rows"][0]["较上月"] == "—"
        assert any("不一致或比较分母为零" in gap["reason"] for gap in result["gaps"])
        assert not any("total.mom" in evidence["ref"] for evidence in result["evidence_items"])
    finally:
        engine.dispose()


def test_percentage_encoding_and_money_display_do_not_change_fact_values():
    fact = {"value": "0.0123975296", "unit": "%"}
    assert display_value(fact, encoding="ratio") == "1.24%"
    assert fact["value"] == "0.0123975296"
    assert (
        display_value({"value": "-0.00008", "unit": "%"}, encoding="ratio", percentage_points=True)
        == "-0.01个百分点"
    )
    assert (
        display_value({"value": "3504983198528.820839", "unit": "元"}, money_unit="亿元")
        == "35049.83亿元"
    )


@pytest.mark.parametrize(
    "goal,root_change,parent_change,selected,available,expected",
    [
        ("overview", "10", "-3", ["total", "branch"], ["detail"], ["detail"]),
        ("growth", "10", "-3", ["total", "branch", "detail"], ["detail"], []),
        ("quality", "10", "-3", ["total", "branch"], ["detail"], []),
        ("overview", "-10", "-3", ["total", "branch"], ["detail"], []),
        ("overview", "10", "3", ["total", "branch"], ["detail"], []),
        ("overview", "10", "-3", ["total", "branch"], [], []),
    ],
)
def test_followup_depends_on_evidence_and_configured_tree(
    goal, root_change, parent_change, selected, available, expected
):
    topic = {
        "followup_policy": {"goals": ["overview", "growth"], "root_metric": "total"},
        "metrics": [{"id": "branch", "label": "分项"}, {"id": "detail"}],
        "relationships": [{"type": "classification", "parent": "branch", "children": ["detail"]}],
    }
    result = {
        "goal": goal,
        "analysis_date": "2026-08-27",
        "plan": {"metric_ids": selected, "comparisons": ["mom"]},
        "available_metric_ids": available,
    }
    evidence = [
        {"ref": "total.mom.difference", "value": root_change},
        {"ref": "branch.mom.difference", "value": parent_change},
    ]
    candidates = followup_candidates(result, topic, evidence)
    assert [metric for candidate in candidates for metric in candidate["metric_ids"]] == expected


def test_growth_source_order_uses_comparison_differences_not_stock_size():
    day = "2026-08-27"
    topic = {
        "metrics": [{"id": metric, "label": metric} for metric in ["total", "large", "small"]],
        "relationships": [
            {"type": "reconciliation", "parent": "total", "children": ["large", "small"]}
        ],
    }
    result = {
        "analysis_date": day,
        "plan": {"comparisons": ["mom"]},
        "facts": {
            metric: {day: {"value": value, "unit": "亿元"}}
            for metric, value in [("total", "100"), ("large", "80"), ("small", "20")]
        },
        "calculations": [],
        "reported_comparisons": [
            {
                "metric": metric,
                "comparison": "mom",
                "facts": {"difference": {"value": value, "unit": "亿元"}},
            }
            for metric, value in [("large", "1"), ("small", "5")]
        ],
        "gaps": [],
        "reconciliations": [],
    }
    evidence = overview_evidence(result, topic)["evidence_items"]
    observation = next(item for item in evidence if item["ref"] == "growth_sources.mom")
    assert "small、large" in observation["display"]
    assert observation["ranked_increases"] == ["small", "large"]
    assert "不代表已经核实完整贡献比例" in observation["display"]


def test_recent_snapshot_uses_coverage_not_current_month_and_excludes_future(tmp_path):
    metrics = {"total": {"name": "各项贷款", "unit": "亿元"}}
    service, actor, _, source, engine = make_environment(
        tmp_path / "recent.sqlite",
        source_metrics=metrics,
        observations=[
            ("total", date(2026, 8, 27), Decimal("120")),
            ("total", date(2026, 10, 14), Decimal("150")),
        ],
    )
    try:
        result = service.execute(
            request(
                start=None,
                end=None,
                date_selection="latest_snapshot",
                metric_ids=["total"],
                comparisons=[],
            ),
            actor,
            "recent",
            today=date(2026, 10, 13),
        )
        assert result["analysis_date"] == "2026-08-27"
        assert result["requested_date"] == "2026-10-13"
        assert result["org_codes"] == ["O1"]
        assert result["data_freshness"]["lag_days"] == 47
        assert "不代表今天或完整月份" in result["public_answer"]
        assert "120.00亿元" in result["table_rows"][0]["当前值"]
        assert source.calls[0][1]["end_date"] == date(2026, 10, 13)
        assert "2026-10-14" not in str(result["facts"])
        assert any(item["ref"] == "scope.freshness" for item in result["evidence_items"])
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "overrides", [{}, {"start": None, "end": None, "allow_latest_reference": True}]
)
def test_recent_mode_cannot_override_explicit_dates(tmp_path, overrides):
    service, actor, _, source, engine = make_environment(tmp_path / "conflict.sqlite")
    try:
        with pytest.raises(ApplicationError, match="不能同时指定日期"):
            service.execute(
                request(date_selection="latest_snapshot", **overrides), actor, "conflict"
            )
        assert not source.calls
    finally:
        engine.dispose()


def test_recent_without_past_coverage_returns_gap_instead_of_future_or_zero(tmp_path):
    service, actor, _, source, engine = make_environment(
        tmp_path / "future.sqlite",
        source_metrics={"total": {"name": "各项贷款", "unit": "亿元"}},
        observations=[("total", date(2026, 10, 14), Decimal("150"))],
    )
    try:
        result = service.execute(
            request(start=None, end=None, date_selection="latest_snapshot", metric_ids=["total"]),
            actor,
            "future",
            today=date(2026, 10, 13),
        )
        assert result["analysis_date"] is None
        assert result["facts"] == {}
        assert result["table_rows"] == []
        assert result["gaps"]
        assert source.calls[0][1]["end_date"] == date(2026, 10, 13)
    finally:
        engine.dispose()
