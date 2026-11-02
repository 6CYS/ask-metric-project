"""日期解析接口保留最新数据策略及原文期间；不访问模型或业务数据库。"""

from datetime import date

import pytest

from ask_metric.api.routes.business_context import ResolveFieldRequest, resolve_field

TODAY = date(2026, 10, 27)


def test_latest_query_resolves_without_a_calendar_date():
    payload = ResolveFieldRequest(
        entity="date", raw_values=["latest"], business_date=TODAY,
        source_question="我行最近存款情况如何？",
    )
    result = resolve_field(payload, actor=object(), uow=object(), permissions=object())

    assert result["status"] == "resolved"
    assert result["value"] == {"preset": "latest"}
    assert result["metadata"]["source_calendar"] == {"ranges": [], "unresolved": []}


@pytest.mark.parametrize("expression", [
    "latest", "最新一期", "最近一期", "当前最新", "最新", "最近", "近期",
])
def test_latest_expressions_ignore_model_calendar_guesses(expression):
    payload = ResolveFieldRequest(
        entity="date", raw_values=[expression], business_date=TODAY,
        model_value={"start": "2026-10-27", "end": "2026-10-27"},
    )
    result = resolve_field(payload, actor=object(), uow=object(), permissions=object())

    assert result["status"] == "resolved"
    assert result["value"] == {"preset": "latest"}
    assert result["metadata"]["resolution_source"] == "deterministic"
    assert result["metadata"]["businessDate"] == "2026-10-27"


@pytest.mark.parametrize(("question", "start", "end"), [
    ("2026年8月各项存款余额", "2026-08-01", "2026-08-31"),
    ("2026年8月末各项存款余额", "2026-08-31", "2026-08-31"),
])
def test_latest_resolution_preserves_explicit_source_calendar(question, start, end):
    payload = ResolveFieldRequest(
        entity="date", raw_values=["latest"], business_date=TODAY,
        source_question=question,
    )
    result = resolve_field(payload, actor=object(), uow=object(), permissions=object())

    assert result["status"] == "resolved"
    assert result["value"] == {"preset": "latest"}
    assert result["metadata"]["source_calendar"] == {
        "ranges": [{"start": start, "end": end}], "unresolved": [],
    }


@pytest.mark.parametrize(("expression", "reason"), [
    ("2026-02-30", "invalid_calendar"),
    ("2026-13", "invalid_calendar"),
    ("到2026年8月末", "incomplete_range"),
])
def test_invalid_calendar_cannot_be_replaced_with_model_date(expression, reason):
    payload = ResolveFieldRequest(
        entity="date", raw_values=[expression], business_date=TODAY,
        model_value={"start": "2026-08-31", "end": "2026-08-31"},
    )
    result = resolve_field(payload, actor=object(), uow=object(), permissions=object())

    assert result["status"] == "invalid"
    assert result["metadata"]["reason"] == reason
    assert "value" not in result
