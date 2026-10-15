"""语义任务验收桥：复用当前目录匹配、日历、来源对账及内存 SQL；不加载真实库配置。"""
import importlib.util
import json
import sys
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location("generic_fixture", Path(__file__).with_name("generic-query-fixture.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
from ask_metric.application.field_resolution import source_calendar_constraints, source_organization_codes
from ask_metric.api.routes.tasks import _verify_metric_coverage, SourceMetricBinding, SourceMetricSpan, BasicQueryRequest
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.analysis_selection import verify_selection
from ask_metric.api.routes.business_context import admit_semantic_plan, PlanAdmissionRequest
from types import SimpleNamespace
from ask_metric.domain.calculation import CalculationExpression, evaluate_expression, quantity


def main(payload):
    if payload["action"] == "inspect":
        return inspect_goal(payload["question"], date.fromisoformat(payload["business_date"]), fixture.METRICS, fixture.ORGS, reference_year=payload.get("reference_year"))
    if payload["action"] == "admit":
        class Uow:
            metric_catalog = SimpleNamespace(list_enabled=lambda: fixture.METRICS)
            organization_catalog = SimpleNamespace(list_enabled=lambda: fixture.ORGS)
            conversations = SimpleNamespace(get_owned=lambda *_: SimpleNamespace())
            def __enter__(self): return self
            def __exit__(self, *args): pass
        return admit_semantic_plan(PlanAdmissionRequest.model_validate(payload["payload"]), SimpleNamespace(user_id="synthetic-semantic"), Uow(),
            SimpleNamespace(authorized_org_codes=lambda **_: fixture.ALLOWED), SimpleNamespace(jwt_secret="synthetic-fixture-secret"))
    if payload["action"] == "calculate":
        spec, inputs = payload["spec"], payload["inputs"]
        if set(spec["bindings"]) != set(inputs): raise ValueError("CALCULATION_INPUT_MISSING")
        values = {name: quantity(item["value"], item["unit"]) for name, item in inputs.items()}
        return {"status": "succeeded", "task_id": "synthetic-calc", "calculation_id": "synthetic-calc", "inputs": inputs,
            "results": [evaluate_expression(CalculationExpression.model_validate(expression), values) for expression in spec["expressions"]]}

    if payload["action"] == "resolve":
        entity, raw = payload["entity"], payload["raw"]
        source = payload.get("source") or {}
        today = date.fromisoformat(source.get("business_date", "2026-10-14"))
        if entity == "date":
            result = fixture.resolve_date_field(raw[0], today, reference_year=payload.get("year"))
            result.setdefault("metadata", {})["source_calendar"] = source_calendar_constraints(
                source.get("source_question", raw[0]), today, reference_year=payload.get("year"))
        else:
            result = fixture.resolve_catalog_field(entity, raw, fixture.METRICS if entity == "metric" else fixture.ORGS)
            if entity == "organization":
                result.setdefault("metadata", {})["source_codes"] = source_organization_codes(
                    source.get("source_question", "、".join(raw)), fixture.ORGS)
        return result
    if payload["action"] == "query":
        query = payload["spec"]
        BasicQueryRequest.model_validate(query)
        if query.get("source_semantic_receipt"):
            verify_selection(query["source_semantic_receipt"], owner="synthetic-semantic", conversation=query["conversation_id"], codes=query["metric_codes"],
                scope=BasicQuerySpec.model_validate({key: value for key, value in query.items() if key in BasicQuerySpec.model_fields}).model_dump(mode="json", exclude_none=True), catalog=fixture.METRICS, secret="synthetic-fixture-secret")
        else:
            _verify_metric_coverage(query["source_question"], query["metric_codes"], fixture.METRICS,
                [SourceMetricBinding.model_validate(item) for item in query.get("source_metric_bindings", [])],
                [SourceMetricSpan.model_validate(item) for item in query.get("source_metric_exclusions", [])])
        return fixture.query({key: value for key, value in query.items() if key in BasicQuerySpec.model_fields})
    return fixture.main(payload)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "value": main(json.load(sys.stdin))}, ensure_ascii=False, default=str))
    except Exception as error:
        print(json.dumps({"ok": False, "error": getattr(error, "code", type(error).__name__), "message": str(error)}, ensure_ascii=False))
