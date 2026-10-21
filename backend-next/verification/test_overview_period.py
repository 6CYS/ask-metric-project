"""灵活日期与期间概览的隔离测试，不代表真实数据湖验收。"""

from datetime import date
from decimal import Decimal

import pytest
from test_business_overview import make_environment, request

from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.time_expression import parse_time_expression


@pytest.mark.parametrize(
    "expression",
    [
        "今年五月份到十月份",
        "今年5月至10月期间",
        "五月到十月",
        "5月到10月",
    ],
)
def test_relative_month_range(expression):
    result = parse_time_expression(expression, today=date(2026, 10, 13))
    assert result.start == date(2026, 5, 1)
    assert result.end == date(2026, 10, 31)


@pytest.mark.parametrize("expression", ["最近三个月", "过去3个月", "最近30天"])
def test_bounded_recent_is_a_range(expression):
    result = parse_time_expression(expression, today=date(2026, 10, 13))
    assert result.start < result.end == date(2026, 10, 13)
    assert result.preset is None


def test_period_uses_actual_monthly_records_and_calculates_first_last(tmp_path):
    metrics = {"total": {"name": "各项贷款", "unit": "亿元"}}
    observations = [
        ("total", date.fromisoformat(day), Decimal(value))
        for day, value in [
            ("2026-04-30", "90"),
            ("2026-05-31", "100"),
            ("2026-06-15", "110"),
            ("2026-06-30", "120"),
            ("2026-08-27", "150"),
            ("2026-10-30", "999"),
        ]
    ]
    service, actor, _, source, engine = make_environment(
        tmp_path / "period.sqlite", source_metrics=metrics, observations=observations
    )
    try:
        result = service.execute(
            request(
                date_selection="available_in_range",
                start="2026-05-01",
                end="2026-10-31",
                metric_ids=["total"],
                goal="growth",
                sections=["scale", "growth"],
                comparisons=[],
            ),
            actor,
            "period",
            today=date(2026, 10, 13),
        )
        assert result["period"]["snapshot_dates"] == ["2026-05-31", "2026-06-30", "2026-08-27"]
        assert [row["当前值"] for row in result["table_rows"]] == [
            "100.00亿元",
            "120.00亿元",
            "150.00亿元",
        ]
        refs = {item["ref"]: item for item in result["evidence_items"]}
        assert refs["d20260531.total.current"]["value"] == "100"
        assert refs["total.current"]["value"] == "150"
        assert refs["period.total.difference"]["value"] == "50"
        assert refs["period.total.rate"]["display"] == "50.00%"
        assert any("2026-07" in gap["reason"] for gap in result["gaps"])
        assert all(
            fact["date"] <= "2026-10-13"
            for snap in result["snapshots"]
            for facts in snap["facts"].values()
            for fact in facts.values()
        )
        assert source.calls
    finally:
        engine.dispose()


def test_explicit_month_with_partial_data_is_presented_without_other_months(tmp_path):
    metrics = {"total": {"name": "各项贷款", "unit": "亿元"}}
    service, actor, _, _, engine = make_environment(
        tmp_path / "partial.sqlite",
        source_metrics=metrics,
        observations=[("total", date(2026, 8, 27), Decimal("150"))],
    )
    try:
        result = service.execute(
            request(
                date_selection="available_in_range",
                start="2026-08-01",
                end="2026-08-31",
                metric_ids=["total"],
                comparisons=[],
            ),
            actor,
            "partial",
            today=date(2026, 10, 13),
        )
        assert result["analysis_date"] == "2026-08-27"
        assert len(result["table_rows"]) == 1
        assert "月中记录不冒充月末" in result["public_answer"]
        empty = service.execute(
            request(
                date_selection="available_in_range",
                start="2026-05-01",
                end="2026-07-31",
                metric_ids=["total"],
                comparisons=[],
            ),
            actor,
            "empty",
            today=date(2026, 10, 13),
        )
        assert empty["analysis_date"] is None
        assert empty["table_rows"] == []
        assert empty["period"]["snapshot_dates"] == []
    finally:
        engine.dispose()


def test_period_calculation_failure_keeps_facts_but_authorization_failure_propagates(
    tmp_path, monkeypatch
):
    service, actor, _, _, engine = make_environment(
        tmp_path / "calculation-failure.sqlite",
        source_metrics={"total": {"name": "各项贷款", "unit": "亿元"}},
        observations=[
            ("total", date(2026, 5, 31), Decimal("100")),
            ("total", date(2026, 8, 27), Decimal("150")),
        ],
    )
    payload = request(
        date_selection="available_in_range",
        start="2026-05-01",
        end="2026-08-31",
        metric_ids=["total"],
        goal="growth",
        sections=["scale", "growth"],
        comparisons=[],
    )
    try:

        def unavailable(*args, **kwargs):
            raise ApplicationError("CALCULATION_UNAVAILABLE", "隔离测试故障", status_code=503)

        monkeypatch.setattr(service.calculation, "calculate", unavailable)
        result = service.execute(payload, actor, "calc-failure", today=date(2026, 10, 13))
        assert len(result["table_rows"]) == 2
        assert result["range_calculations"] == []
        assert not any(item["ref"].startswith("period.total.") for item in result["evidence_items"])
        assert any(gap.get("error_code") == "CALCULATION_UNAVAILABLE" for gap in result["gaps"])

        def forbidden(*args, **kwargs):
            raise ApplicationError("PERMISSION_DENIED", "隔离测试撤权", status_code=403)

        monkeypatch.setattr(service.calculation, "calculate", forbidden)
        with pytest.raises(ApplicationError, match="隔离测试撤权"):
            service.execute(payload, actor, "calc-forbidden", today=date(2026, 10, 13))
    finally:
        engine.dispose()


def test_quality_data_is_not_blocked_by_missing_root_balance(tmp_path):
    service, actor, _, _, engine = make_environment(
        tmp_path / "quality-only.sqlite",
        source_metrics={"npl_balance": {"name": "不良贷款余额", "unit": "亿元"}},
        observations=[("npl_balance", date(2026, 8, 27), Decimal("10"))],
    )
    try:
        result = service.execute(
            request(
                date_selection="latest_snapshot",
                start=None,
                end=None,
                goal="quality",
                sections=["quality"],
                metric_ids=["npl_balance"],
                comparisons=[],
            ),
            actor,
            "quality-only",
            today=date(2026, 10, 13),
        )
        assert result["analysis_date"] == "2026-08-27"
        assert result["table_rows"][0]["指标"] == "不良贷款余额"
    finally:
        engine.dispose()


def test_period_permission_is_checked_before_any_data_query(tmp_path):
    service, actor, _, source, engine = make_environment(tmp_path / "forbidden.sqlite")
    try:
        with pytest.raises(PermissionDeniedError, match="无权"):
            service.execute(
                request(
                    date_selection="available_in_range",
                    start="2026-05-01",
                    end="2026-10-31",
                    org_codes=["O2"],
                ),
                actor,
                "forbidden",
            )
        assert not source.calls
    finally:
        engine.dispose()
