"""正文展示回归；隔离样本不写入应用数据，原始取数与计算证据保持不变。"""

from copy import deepcopy
from datetime import date
from decimal import Decimal

import pytest

from ask_metric.application.calculation_service import build_calculation_facts
from ask_metric.application.result_answering import flatten_blocks, render_fact_answer
from ask_metric.domain.query_execution import QueryExecutionPlan
from ask_metric.domain.value_presentation import money_reply_fields


def value_plan():
    return QueryExecutionPlan(
        shape="metric_value", template="metric_value_exact", dialect="mysql", dsl={},
    )


def render_row(**changes):
    row = {
        "org_name": "甲农村商业银行", "metric_name": "各项存款余额当日数",
        "metric_value": Decimal("238179089037.35"), "unit": "元",
        "stat_date": date(2026, 8, 27), **changes,
    }
    original = deepcopy(row)
    rendered = render_fact_answer(value_plan(), [row], [])
    assert row == original
    assert rendered.facts[0].fields["metric_value"] == str(original["metric_value"])
    assert rendered.facts[0].fields["metric_name"] == original["metric_name"]
    assert flatten_blocks(rendered.blocks) == rendered.message
    return rendered


def test_balance_answer_uses_natural_date_and_readable_amount_without_rewriting_fact():
    result = render_row()
    assert result.message == "截至2026年8月27日，甲农村商业银行各项存款余额约2,381.79亿元。"


@pytest.mark.parametrize(("value", "unit", "expected_value", "expected_unit"), [
    ("238179089037.35", "元", "2381.79", "亿元"),
    ("23817908.903735", "万元", "2381.79", "亿元"),
    ("2381.7908903735", "亿元", "2381.79", "亿元"),
    ("100000000", "元", "1.00", "亿元"),
    ("99999999", "元", "10000.00", "万元"),
    ("10000", "元", "1.00", "万元"),
    ("9999.99", "元", "9999.99", "元"),
    ("-100000000.5", "元", "-1.00", "亿元"),
    ("0", "元", "0.00", "元"),
    ("-0.001", "元", "-0.001", "元"),
])
def test_money_uses_confirmed_unit_and_size(value, unit, expected_value, expected_unit):
    assert money_reply_fields(Decimal(value), unit) == {
        "reply_value": expected_value, "reply_unit": expected_unit,
    }


@pytest.mark.parametrize(("value", "unit"), [("NaN", "元"), ("Infinity", "元"), ("1", "")])
def test_unknown_unit_and_nonfinite_amount_are_not_converted(value, unit):
    assert money_reply_fields(Decimal(value), unit) == {}


def test_exact_amount_does_not_claim_approximation():
    assert "为1.00亿元" in render_row(metric_value=Decimal("100000000")).message


def test_negative_amount_keeps_sign_and_rounding_notice():
    assert "约-1.00亿元" in render_row(metric_value=Decimal("-100000000.5")).message


def test_rounding_check_uses_the_full_original_precision():
    result = render_row(metric_value=Decimal("1.000000000000000000000000000001"))
    assert "约1.00元" in result.message


def test_calculation_facts_keep_original_value_and_unit_with_readable_reply_fields():
    facts = build_calculation_facts("task1", [{
        "metric_code": "m1", "org_code": "o1", "org_name": "甲行",
        "stat_date": "2026-08-27", "metric_value": "238179089037.35",
    }], {"metrics": [{"code": "m1", "name": "存款余额", "unit": "元"}]})
    assert facts[0]["value"] == "238179089037.35"
    assert facts[0]["unit"] == "元"
    assert facts[0]["reply_value"] == "2381.79"
    assert facts[0]["reply_unit"] == "亿元"


@pytest.mark.parametrize("metric", ["存款日均余额", "各项存款余额较同期", "当日数"])
def test_meaningful_metric_qualifiers_are_preserved(metric):
    assert metric in render_row(metric_name=metric).message


def test_daily_flow_does_not_get_balance_as_of_wording():
    result = render_row(metric_name="交易金额当日数", metric_value=Decimal("12800"))
    assert result.message == "2026年8月27日，甲农村商业银行交易金额为1.28万元。"


def test_ratio_is_not_scaled_or_rounded_like_money():
    result = render_row(metric_name="存款占比", metric_value=Decimal("24.781"), unit="%")
    assert result.message == "2026年8月27日，甲农村商业银行存款占比为24.781%。"
