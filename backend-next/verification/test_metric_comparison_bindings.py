"""比较候选只取自已启用的正式目录，并由同一用户绑定签发。"""

from types import SimpleNamespace

from ask_metric.api.routes.analysis import CatalogBindingRequest, bind_catalog_metrics
from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.domain.semantics import MetricCatalogItem


def metric(code, basis, **overrides):
    return MetricCatalogItem.model_validate({
        "code": code, "name": f"营业支出金额{basis}", "source_metric_code": "expense-source",
        "base_name": "营业支出金额", "unit": "元", "value_basis": basis, **overrides,
    })


def bind(items, metric_codes, **options):
    semantics = MetricSemantics(items, secret="test-secret", actor_id="user", topics={})
    service = SimpleNamespace(semantics=lambda actor: semantics)
    request = CatalogBindingRequest(metric_codes=metric_codes, **options)
    return semantics, bind_catalog_metrics(request, object(), service)


def test_comparison_hints_require_opt_in_and_sign_full_catalog_descriptors():
    items = [metric("base", "当日数"), metric("reported-change", "较同期"),
             metric("monthly-change", "较上月"), metric("annual-change", "较年初")]
    _, default = bind(items, ["base", "unknown"])
    semantics, result = bind(items, ["base", "unknown"], include_comparisons=True)

    assert set(default) == {"items", "missing_codes"}
    assert result["items"] == default["items"]
    assert result["missing_codes"] == default["missing_codes"] == ["unknown"]
    hints = result["comparison_items"]
    assert {item["code"]: item["comparison_period"] for item in hints} == {
        "reported-change": "yoy", "monthly-change": "mom", "annual-change": "ytd",
    }
    for item in hints:
        assert item["base_metric_code"] == "base"
        assert item["analysis_hint"] is None
        assert item["source_metric_code"] == "expense-source"
        assert semantics.resolve(item["binding_ref"])["code"] == item["code"]


def test_ambiguous_or_incompatible_catalog_entries_do_not_produce_hints():
    items = [
        metric("base", "当日数"), metric("missing-source", "当日数", source_metric_code=None),
        metric("yoy-one", "较同期"), metric("yoy-two", "较同期"),
        metric("foreign-mom", "较上月", source_metric_code="other-source"),
        metric("wrong-unit-mom", "较上月", unit="万元"),
        metric("other-base-ytd", "较年初", base_name="其他费用金额"),
        metric("no-source-ytd", "较年初", source_metric_code=None),
        metric("base_CMP_YTD", "较年初增幅"),
    ]
    _, result = bind(items, ["base", "missing-source", "yoy-one"], include_comparisons=True)

    assert result["comparison_items"] == []
