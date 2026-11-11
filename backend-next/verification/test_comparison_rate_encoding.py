"""正式比较映射的增幅编码独立于基础指标；样本只用于隔离语义校验。"""

import json

import pytest

from ask_metric.application.metric_semantics import MetricSemantics, load_business_topics
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.domain.value_presentation import display_number


def comparison_catalog(metric_id="personal"):
    topics = load_business_topics()
    topic = topics["deposit"]
    definition = next(item for item in topic["metrics"] if item["id"] == metric_id)
    base_name = definition["names"][0].removesuffix(definition["value_basis"])
    items = [
        MetricCatalogItem(
            code=definition["code"],
            name=definition["names"][0],
            unit=definition["units"][0],
            value_basis=definition["value_basis"],
        )
    ]
    for period, fields in topic["comparison_suffixes"].items():
        for role, rule in fields.items():
            items.append(
                MetricCatalogItem(
                    code=definition["comparison_codes"][period][role],
                    name=base_name + rule["value_basis"],
                    value_basis=rule["value_basis"],
                    unit="%" if role == "rate" else definition["units"][0],
                )
            )
    return topics, definition, items


def semantics(items, topics, **kwargs):
    return MetricSemantics(
        items, secret="isolated-test", actor_id="test-user", topics=topics, **kwargs
    )


@pytest.mark.parametrize("period", ["mom", "yoy", "ytd"])
def test_money_comparison_rates_use_official_ratio_encoding(period):
    topics, definition, items = comparison_catalog()
    service = semantics(items, topics)
    descriptor = service.descriptor(definition["comparison_codes"][period]["rate"])
    assert descriptor["value_encoding"] == "ratio"
    assert descriptor["analysis_hint"]["comparison_role"] == "rate"
    assert display_number("0.0892825203", descriptor) == "8.93%"
    assert display_number("0.0678393219", descriptor) == "6.78%"
    resolved = service.resolve(service.binding(descriptor, "个人存款增幅"))
    assert resolved["code"] == definition["comparison_codes"][period]["rate"]
    assert resolved["value_encoding"] == "ratio"
    assert resolved["metadata_version"] == descriptor["metadata_version"]
    assert service.descriptor(definition["code"])["value_encoding"] is None
    difference = service.descriptor(definition["comparison_codes"][period]["difference"])
    assert difference["value_encoding"] is None
    assert display_number("100", difference) == "100.00元"


@pytest.mark.parametrize(
    "base_encoding, expected_difference",
    [
        ("ratio", "5.00个百分点"),
        ("percent", "0.05个百分点"),
    ],
)
def test_ratio_comparison_rate_does_not_inherit_base_encoding(base_encoding, expected_difference):
    topics, definition, items = comparison_catalog("personal_share")
    definition["value_encoding"] = base_encoding
    service = semantics(items, topics)
    difference = service.descriptor(definition["comparison_codes"]["yoy"]["difference"])
    rate = service.descriptor(definition["comparison_codes"]["yoy"]["rate"])
    assert difference["value_encoding"] == base_encoding
    assert display_number("0.05", difference) == expected_difference
    assert rate["value_encoding"] == "ratio"
    assert display_number("0.05", rate) == "5.00%"


def test_approved_rate_encoding_overrides_topic_projection(tmp_path):
    topics, definition, items = comparison_catalog()
    code = definition["comparison_codes"]["yoy"]["rate"]
    path = tmp_path / "analysis-semantics.json"
    path.write_text(
        json.dumps(
            {
                "metrics": {
                    code: {
                        "status": "approved",
                        "source": "隔离测试的正式百分数口径",
                        "value_encoding": "percent",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    descriptor = semantics(items, topics, semantics_path=path).descriptor(code)
    assert descriptor["value_encoding"] == "percent"
    assert descriptor["semantic_status"] == "approved"
    assert display_number("8.93", descriptor) == "8.93%"


@pytest.mark.parametrize("invalid", ["unmapped", "disabled", "unit", "basis"])
def test_unknown_or_incompatible_comparisons_do_not_gain_ratio_encoding(invalid):
    topics, definition, items = comparison_catalog()
    code = definition["comparison_codes"]["yoy"]["rate"]
    rate = next(item for item in items if item.code == code)
    if invalid == "unmapped":
        items.remove(rate)
        code = "UNMAPPED_RATE"
        items.append(rate.model_copy(update={"code": code}))
    elif invalid == "disabled":
        definition["disabled_reason"] = "隔离测试停用映射"
    else:
        items[items.index(rate)] = rate.model_copy(
            update={
                "unit" if invalid == "unit" else "value_basis": "元"
                if invalid == "unit"
                else "较上月增幅",
            }
        )
    descriptor = semantics(items, topics).descriptor(code)
    assert descriptor["value_encoding"] is None
    assert descriptor["analysis_hint"] is None
    if invalid != "unit":
        assert "数值编码待确认" in display_number("0.05", descriptor)


def test_source_raw_comparison_retains_raw_value_policy():
    topics, definition, items = comparison_catalog()
    code = definition["comparison_codes"]["yoy"]["rate"]
    items = [
        item.model_copy(update={"value_policy": "source_raw_v1"}) if item.code == code else item
        for item in items
    ]
    descriptor = semantics(items, topics).descriptor(code)
    assert descriptor["value_encoding"] is None
    assert descriptor["source_value_encoding"] == "ratio"
    assert display_number("0.05", descriptor) == "0.05（原始值，单位未提供）"
