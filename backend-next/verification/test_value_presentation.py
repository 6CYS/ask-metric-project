"""展示规则的隔离回归，不修改真实查询值。"""

from decimal import Decimal

import pytest
from ask_metric.domain.value_presentation import display_number, money_reply_fields


@pytest.mark.parametrize(
    "value,unit",
    [
        ("1", "元"),
        ("-25.01", "元"),
        ("12500", "元"),
        ("-0.001", "元"),
        ("0.00000001", "亿元"),
        ("151071000000", "元"),
        ("0", "万元"),
    ],
)
def test_query_and_analysis_share_money_presentation(value, unit):
    fields = money_reply_fields(Decimal(value), unit)
    assert display_number(value, {"unit": unit}) == (fields["reply_value"] + fields["reply_unit"])


@pytest.mark.parametrize("value", ["0.001", "-0.001", "0.000000000001"])
def test_small_nonzero_amount_does_not_lose_its_sign_or_become_zero(value):
    fields = money_reply_fields(Decimal(value), "元")
    assert Decimal(fields["reply_value"]) == Decimal(value)
    assert display_number(value, {"unit": "元"}) == value + "元"


@pytest.mark.parametrize(
    "encoding,value,expected",
    [
        ("percent", "0.001", "0.001"),
        ("ratio", "0.00001", "0.001"),
        ("percent", "-0.001", "-0.001"),
        ("ratio", "-0.00001", "-0.001"),
        ("percent", "12.34", "12.34"),
        ("ratio", "0.1234", "12.34"),
    ],
)
def test_percent_and_percentage_points_preserve_encoding_and_small_values(
    encoding,
    value,
    expected,
):
    metric = {"unit": "%", "value_encoding": encoding}
    assert display_number(value, metric) == expected + "%"
    assert display_number(value, metric, difference=True) == expected + "个百分点"


def test_unknown_ratio_encoding_or_unit_is_not_inferred():
    assert display_number("0.1", {"unit": "%"}) == "原始值 0.1（目录单位%，数值编码待确认）"
    assert display_number("0.001", {}) == "0.001（单位未提供）"
