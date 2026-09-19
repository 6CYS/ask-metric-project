"""配置模型语义探针：只发送虚构目录，不连接业务数据库；从 backend-next 目录运行。"""

import argparse
import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from ask_metric.api.dependencies import get_model_service
from ask_metric.application.semantic_workflow import advance_slot_frame
from ask_metric.core.config import get_settings
from ask_metric.domain.query_capabilities import capability_error
from ask_metric.domain.semantic_engine import SemanticEngine
from ask_metric.domain.semantic_normalization import query_shape_for
from ask_metric.domain.semantic_reference import freeze_source_reference, merge_reference_frame
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem, SlotFrame
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

parser = argparse.ArgumentParser()
parser.add_argument("--contains", default="", help="只运行包含该文本的合成用例")
args = parser.parse_args()
settings = get_settings()
service = get_model_service(
    SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(settings=settings, model_http_client=None, model_semaphore=None)
        )
    )
)


class RecordingModel:
    def __init__(self, wrapped):
        self.wrapped = wrapped
        self.outputs = []

    def __getattr__(self, name):
        return getattr(self.wrapped, name)

    def analyze(self, **kwargs):
        result = self.wrapped.analyze(**kwargs)
        self.outputs.append(result)
        return result


service = RecordingModel(service)
metrics = [
    MetricCatalogItem(code="M1", name="演示指标甲"),
    MetricCatalogItem(code="M2", name="演示指标乙"),
]
orgs = [
    OrganizationCatalogItem(code="A", name="虚构甲机构", aliases=["甲机构", "虚构甲机构"]),
    OrganizationCatalogItem(code="B", name="虚构乙机构", aliases=["乙机构", "虚构乙机构"]),
]
config = SemanticConfigRepository(Path("config/semantic-config.json")).load()
frame = SlotFrame(
    metrics=[{"code": "M1", "name": metrics[0].name}],
    orgs=[orgs[0].name],
    time="2026-01-01至2026-01-31",
)
source = freeze_source_reference(
    source_task_id="synthetic-source",
    source_version=3,
    change_field="compose",
    source_slots=frame.model_dump(mode="json"),
    source_logical_dsl={"time": {"start": "2026-01-01", "end": "2026-01-31"}},
)
cases = [
    ("虚构甲机构这个指标有数据的还有哪几个月份呢？", "metric_availability", None, None),
    ("这个指标都在哪些月有记录？", "metric_availability", None, None),
    ("最早是哪天开始有的？", "metric_availability", "earliest", None),
    ("最后一次有数的日期是什么时候？", "metric_availability", "latest", None),
    ("只看今年有数据的月份", "metric_availability", "all", "2026-01-01"),
    ("那乙机构去年每个月的呢？", "metric_trend", None, "2025-01-01"),
    ("再加上乙机构，日期改成2026年4月末", "metric_value", None, "2026-04-30"),
    ("换成乙机构2026年4月末的演示指标乙", "metric_value", None, "2026-04-30"),
    ("为什么这个指标下降，帮我分析原因", "unsupported", None, None),
]
candidate_cases = [
    ("乙机构四月份的呢？", "metric_value", None, "2026-04-01"),
    ("四月换乙机构", "metric_value", None, "2026-04-01"),
    ("乙机构，4月份", "metric_value", None, "2026-04-01"),
    ("这个指标有数据的月份呢", "metric_availability", None, None),
    ("虚构乙机构2026年5月演示指标乙是多少", "metric_value", None, "2026-05-01"),
    ("另外查演示指标乙", "clarification", None, None),
]
report = []
for mode, (question, shape, selection, start) in [
    *(("explicit", case) for case in cases),
    *(("candidate", case) for case in candidate_cases),
]:
    if args.contains and args.contains not in question:
        continue
    source["mode"] = mode
    service.outputs = []
    item = {"question": question, "expected_shape": shape, "mode": mode}
    try:
        analysis = SemanticEngine(service).analyze(
            question,
            metrics=metrics,
            organizations=orgs,
            config=config,
            current_date=date(2026, 9, 19),
            reference_context=source,
        )
        item["extracted"] = analysis.slot_frame.model_dump(mode="json")
        if analysis.slot_frame.context_relation == "independent" and mode == "candidate":
            merged = SimpleNamespace(frame=analysis.slot_frame, resolved_time=None)
        else:
            merged = merge_reference_frame(source, analysis.slot_frame)
        actual_shape = query_shape_for(merged.frame)
        unsupported = capability_error(merged.frame, actual_shape)
        if unsupported:
            item.update(
                actual_shape="unsupported", pass_=shape == "unsupported", message=unsupported
            )
        else:
            result = advance_slot_frame(
                merged.frame,
                metrics=metrics,
                organizations=orgs,
                config=config,
                today=date(2026, 9, 19),
                resolved_time_override=merged.resolved_time,
            )
            dsl = result.logical_dsl
            passed = dsl is not None and result.query_shape == shape
            if shape == "clarification":
                passed = (
                    dsl is None
                    and set(result.slot_frame.missing) == {"orgs", "time"}
                    and [m.code for m in result.slot_frame.metrics] == ["M2"]
                )
            if passed and selection:
                passed = dsl.ops[0].get("selection") == selection
            if passed and start:
                passed = str(dsl.time.start) == start
            if passed and shape == "metric_availability" and not start:
                passed = dsl.time.start is None and dsl.time.preset is None
            if passed and dsl:
                passed = dsl.orgs == (
                    ["B"]
                    if question.startswith(("那乙", "换成乙", "乙机构", "四月换乙", "虚构乙"))
                    else ["A", "B"]
                    if question.startswith("再加")
                    else ["A"]
                )
            if passed and dsl:
                passed = dsl.metrics == (["M2"] if "演示指标乙" in question else ["M1"])
            item.update(
                actual_shape=result.query_shape,
                pass_=passed,
                dsl=dsl.model_dump(mode="json") if dsl else None,
                missing=result.slot_frame.missing,
            )
    except Exception as exc:
        item.update(
            pass_=False,
            error_type=type(exc).__name__,
            error=str(exc)[:250],
            validation_errors=getattr(exc, "errors", None),
            model_outputs=service.outputs,
        )
    report.append(item)
    print(
        json.dumps(item, ensure_ascii=False),
        flush=True,
    )
if any(not item["pass_"] for item in report):
    raise SystemExit(1)
