"""数字月份格式与中文月份共用日历口径；不访问模型或业务数据库。"""

from datetime import date

import pytest

from ask_metric.api.routes.business_context import ResolveFieldRequest, resolve_field
from ask_metric.application.field_resolution import resolve_date_field
from ask_metric.domain.time_expression import SemanticValidationError, parse_time_expression

TODAY = date(2026, 10, 26)


@pytest.mark.parametrize(("expression", "start", "end"), [
    ("2026-08", date(2026, 8, 1), date(2026, 8, 31)),
    ("2024-02", date(2024, 2, 1), date(2024, 2, 29)),
    ("2025-02", date(2025, 2, 1), date(2025, 2, 28)),
    ("2026-01", date(2026, 1, 1), date(2026, 1, 31)),
    ("2026-12", date(2026, 12, 1), date(2026, 12, 31)),
])
def test_numeric_month_has_the_same_full_range_as_chinese_month(expression, start, end):
    year, month = map(int, expression.split("-"))
    result = parse_time_expression(expression, today=TODAY)
    assert result == parse_time_expression(f"{year}年{month}月", today=TODAY)
    assert (result.start, result.end) == (start, end)
    assert result.start != result.end


@pytest.mark.parametrize("expression", ["2026-00", "2026-13", "2026-99"])
def test_invalid_numeric_month_cannot_be_replaced_by_a_model_date(expression):
    with pytest.raises(SemanticValidationError) as caught:
        parse_time_expression(expression, today=TODAY)
    assert caught.value.reason == "invalid_calendar"
    result = resolve_date_field(
        expression, TODAY, model_value={"start": "2026-08-31", "end": "2026-08-31"}
    )
    assert result["status"] == "invalid"
    assert result["metadata"]["reason"] == "invalid_calendar"


def test_resolve_field_preserves_month_range_for_existing_record_selection():
    payload = ResolveFieldRequest(
        entity="date", raw_values=["2026-08"], business_date=TODAY,
        source_question="2026年8月各项存款余额",
        model_value={"start": "2026-08-31", "end": "2026-08-31"},
    )
    result = resolve_field(payload, actor=object(), uow=object(), permissions=object())
    chinese = resolve_field(
        payload.model_copy(update={"raw_values": ["2026年8月"]}),
        actor=object(), uow=object(), permissions=object(),
    )
    assert result == chinese
    assert result["status"] == "resolved"
    assert result["value"] == {"start": "2026-08-01", "end": "2026-08-31"}
    assert result["metadata"]["resolution_source"] == "deterministic"
    assert result["metadata"]["source_calendar"]["ranges"] == [result["value"]]


def test_iso_day_and_explicit_month_end_keep_their_single_day_meaning():
    for expression in ("2026-08-31", "2026年8月末"):
        result = parse_time_expression(expression, today=TODAY)
        assert result.start == result.end == date(2026, 8, 31)
