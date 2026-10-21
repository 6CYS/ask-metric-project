"""隔离合成样本验证存款规划边界；真实查询验收另行记录。"""

from datetime import date
from decimal import Decimal

import pytest

from ask_metric.application.business_overview import load_topic
from ask_metric.core.errors import ApplicationError
from verification.test_business_overview import make_environment, request


@pytest.fixture
def deposit(tmp_path):
    topic = load_topic("deposit")
    metrics = {
        item["code"]: {"name": item["names"][0], "unit": item["units"][0]}
        for item in topic["metrics"]
        if not item["id"].startswith("personal_fixed_")
    }
    observations = [
        (item["code"], day, Decimal("0.25") if item["units"] == ["%"] else Decimal(value))
        for item in topic["metrics"]
        for day, value in (
            [(date(2026, 7, 31), "30")]
            if item["id"].startswith("company_") or item["id"] == "market_share"
            else [(date(2026, 8, 27), "100")]
        )
        if item["code"] in metrics
    ]
    env = make_environment(
        tmp_path / "deposit.sqlite", source_metrics=metrics, observations=observations
    )
    yield env
    env[-1].dispose()


def plan(**changes):
    return request(
        topic="deposit",
        topic_version=load_topic("deposit")["version"],
        sections=["scale", "growth", "structure"],
        **changes,
    )


def test_focused_latest_uses_requested_detail_date(deposit):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            metric_ids=["company_current", "company_fixed"],
        ),
        actor,
        "focused",
        today=date(2026, 10, 14),
    )
    assert result["analysis_date"] == "2026-07-31"
    assert set(result["facts"]) == {"company_current", "company_fixed"}
    assert "向前查询" in result["data_freshness"]["notice"]
    assert "实际指标查询库" in result["source_notice"]
    assert "未指定机构" in result["context_notice"]


def test_formal_current_share_binds_percent_unit_and_ratio_encoding(deposit):
    service, actor, _, _, _ = deposit
    assert {"personal_current_share", "company_current_share"} <= set(
        service.describe("deposit")["bindings"]
    )
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            goal="structure",
            metric_ids=["company_current_share"],
        ),
        actor,
        "official-share",
        today=date(2026, 10, 14),
    )
    assert result["table_rows"][0]["当前值"] == "25.00%"


def test_latest_overview_keeps_gaps_without_mixing_old_detail(deposit):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            metric_ids=["total", "personal", "company_current"],
        ),
        actor,
        "overview",
        today=date(2026, 10, 14),
    )
    assert result["analysis_date"] == "2026-08-27"
    assert not result["facts"].get("company_current", {}).get("2026-08-27")
    assert any(gap.get("metric") == "company_current" for gap in result["gaps"])
    assert result["table_rows"]


@pytest.mark.parametrize("term", ["存款市场份额", "存款市场占有率"])
def test_named_metric_sets_latest_date_even_with_newer_auxiliary_totals(deposit, term):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            metric_ids=["total", "personal", "market_share"],
            calculation_context={"scope_id": "named-focus", "user_question": f"最近{term}如何？"},
        ),
        actor,
        f"named-{term}",
        today=date(2026, 10, 14),
    )
    assert result["analysis_date"] == "2026-07-31"
    assert result["coverage_metric_ids"] == ["market_share"]
    assert {row["metric_id"] for row in result["table_rows"]} == {"market_share"}


def test_separate_named_categories_are_not_reduced_to_one(deposit):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            metric_ids=["total", "personal", "company"],
            calculation_context={
                "scope_id": "two-focus",
                "user_question": "个人存款和对公存款怎么样？",
            },
        ),
        actor,
        "two-focus",
        today=date(2026, 10, 14),
    )
    assert result["coverage_metric_ids"] == ["personal", "company"]
    assert result["analysis_date"] == "2026-08-27"


def test_structure_parent_does_not_mask_older_available_children(deposit):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            goal="structure",
            metric_ids=["company", "company_current", "company_fixed"],
        ),
        actor,
        "structure",
        today=date(2026, 10, 14),
    )
    assert result["analysis_date"] == "2026-07-31"
    assert {row["metric_id"] for row in result["table_rows"]} == {
        "company_current",
        "company_fixed",
    }


def test_explicit_date_does_not_fallback(deposit):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(start="2026-10-01", end="2026-10-31", metric_ids=["total"]),
        actor,
        "explicit",
        today=date(2026, 10, 14),
    )
    assert result["analysis_date"] is None
    assert result["table_rows"] == []
    assert "不改用其他日期" in result["public_answer"]


def test_conflicting_code_and_unregistered_terms_never_execute(deposit):
    service, actor, _, source, _ = deposit
    source.calls.clear()
    result = service.execute(
        plan(metric_ids=["current_share_excluded", "personal_fixed_3y"]),
        actor,
        "conflict",
        today=date(2026, 10, 14),
    )
    assert not source.calls
    assert len(result["gaps"]) >= 2
    assert "口径冲突" in result["public_answer"]


def test_followup_keeps_anchor_instead_of_changing_snapshot(deposit):
    service, actor, _, _, _ = deposit
    result = service.execute(
        plan(
            start=None,
            end=None,
            date_selection="latest_snapshot",
            anchor_date=date(2026, 7, 31),
            metric_ids=["personal"],
        ),
        actor,
        "anchor",
        today=date(2026, 10, 14),
    )
    assert result["analysis_date"] == "2026-07-31"
    assert not result["table_rows"]
    with pytest.raises(ApplicationError):
        service.execute(
            plan(anchor_date=date(2026, 10, 15)), actor, "bad-anchor", today=date(2026, 10, 14)
        )


def test_period_followup_keeps_initial_snapshot_coverage(deposit):
    service, actor, _, _, _ = deposit
    first = service.execute(
        plan(
            start="2026-05-01",
            end="2026-10-31",
            date_selection="available_in_range",
            metric_ids=["total", "personal"],
        ),
        actor,
        "period-first",
        today=date(2026, 10, 14),
    )
    second = service.execute(
        plan(
            start="2026-05-01",
            end="2026-10-31",
            date_selection="available_in_range",
            metric_ids=["company_current"],
            coverage_metric_ids=["total", "personal"],
        ),
        actor,
        "period-followup",
        today=date(2026, 10, 14),
    )
    assert first["period"] == second["period"]
    assert second["analysis_date"] == first["analysis_date"] == "2026-08-27"
    assert second["table_rows"] == []
    assert second["gaps"]
