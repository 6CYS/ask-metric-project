"""精确数值格式只在结构化展示边界使用，不解析数量词或近似关系。"""

import re
from decimal import Decimal

import pytest

from ask_metric.application.report_quantities import (
    QUANTITY_PATTERN,
    matches_quantity,
    parse_quantity,
)


@pytest.mark.parametrize(("text", "value", "unit"), [
    ("75.22%", "75.22", "%"),
    ("75.22％", "75.22", "%"),
    ("-1,234.50 亿元", "-1234.50", "亿元"),
    ("+0.15个百分点", "0.15", "个百分点"),
    ("20005户", "20005", "户"),
])
def test_exact_value_preserves_sign_and_dimension(text, value, unit):
    result = parse_quantity(text)
    assert result is not None
    assert (result.value, result.unit) == (Decimal(value), unit)


@pytest.mark.parametrize(("text", "display", "expected"), [
    ("-1,234.50亿元", "-1234.5亿元", True),
    ("+100.00元", "100元", True),
    ("75.22％", "75.22%", True),
    ("75%", "75.22%", False),
    ("0.15个百分点", "0.15%", False),
    ("1,234.50亿元", "-1234.5亿元", False),
    ("100万元", "1000000元", False),
    ("999元", "100元", False),
])
def test_exact_value_matching_normalizes_format_only(text, display, expected):
    assert matches_quantity(text, display) is expected


@pytest.mark.parametrize("text", ["1,23元", "1e3元", "--100元", "08-27元", "NaN元"])
def test_malformed_exact_values_are_not_matched(text):
    assert parse_quantity(text) is None
    assert not matches_quantity(text, "100元")


def test_tokenizer_keeps_complete_values_instead_of_accepting_suffixes():
    assert re.findall(QUANTITY_PATTERN, "--100元；++30%；08-27元") == [
        "--100元", "++30%", "08-27元",
    ]
