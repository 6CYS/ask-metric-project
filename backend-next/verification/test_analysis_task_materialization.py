"""正式计划验证回执为跨轮任务重建提供可核验身份；仅使用隔离合成目录。"""

from test_general_analysis import binding, general_environment, plan

from ask_metric.api.routes.analysis import PlanValidationRequest, validate_plan
from ask_metric.domain.analysis_methods import AnalysisPlan


def test_validation_receipt_preserves_exact_metric_bindings(general_environment):
    service, actor, *_ = general_environment
    income = binding(service, actor, "营业收入金额当日数")
    profit = binding(service, actor, "净利润金额当日数")
    value = plan(income).model_dump()
    value["steps"][0].update(method="observe", metric_refs=[income, profit])
    value["steps"][0].pop("comparisons")
    result = validate_plan(
        PlanValidationRequest(plan=AnalysisPlan.model_validate(value), question=""),
        actor,
        service,
    )
    assert result["status"] == "validated"
    assert result["metric_count"] == 2
    descriptors = result["metric_descriptors"]
    assert {item["binding_ref"] for item in descriptors} == {income, profit}
    assert {item["name"] for item in descriptors} == {"营业收入金额当日数", "净利润金额当日数"}
    for item in descriptors:
        resolved = service.semantics(actor).resolve(item["binding_ref"])
        assert item["code"] == resolved["code"]
        assert item["name"] == resolved["name"]
