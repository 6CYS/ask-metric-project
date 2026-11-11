"""报告投影与缺数交付契约；样本仅用于隔离回归。"""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from test_analysis_report_claims import evidence, report
from test_inquiry_report_scope import setup_sources

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.analysis_report_view import focused_sources
from ask_metric.core.errors import ApplicationError


@pytest.mark.parametrize(
    "body",
    [
        "增加额第4名（{{total}}）。",
        "增加额第4名 ( **{{total}}** )。",
        "{{total}}（4名）。",
        "1户（{{total}}）。",
    ],
)
def test_different_quantity_dimensions_are_not_assumed_to_be_duplicate_values(body):
    result = report(body)
    assert result["report"]["summary"] == body.replace("{{total}}", "100元")


@pytest.mark.parametrize("missing", [False, True])
def test_selected_display_keeps_original_query_coverage(missing):
    source = evidence()
    source.update(
        execution_mode="inquiry", org_codes=["O1", "O2", "O3"], org_names=["甲行", "乙行", "丙行"]
    )
    source["metric_descriptors"] = source["metric_descriptors"][:2]
    source["plan"]["steps"][0]["metric_refs"] = ["total", "total_mom"]
    source["evidence_items"] = []
    for index in range(3):
        for metric in source["metric_descriptors"]:
            source["evidence_items"].append(
                {
                    "ref": f"{metric['code']}-{index}",
                    "type": "fact",
                    "value": "100",
                    "display": "100元",
                    "metric_code": metric["code"],
                    "metric_name": metric["name"],
                    "date": "2026-08-27",
                    "org_code": source["org_codes"][index],
                    "org_name": source["org_names"][index],
                }
            )
    source["rows"] = [
        {
            "metric_name": atom["metric_name"],
            "org_name": atom["org_name"],
            "stat_date": atom["date"],
            "metric_value": atom["display"],
            "value_role": "分析时点",
        }
        for atom in source["evidence_items"]
    ]
    if missing:
        source["org_codes"].extend(["O4", "O5"])
        source["org_names"].extend(["丁行", "戊行"])
        source.update(complete=False, gaps=["丁行、戊行未取得有效值。"])
    service = SimpleNamespace(
        authorized_evidence=lambda _actor, _ref: deepcopy(source),
        semantics=lambda _actor: SimpleNamespace(
            resolve=lambda _ref: None,
            items={
                item["code"]: SimpleNamespace(name=item["name"])
                for item in source["metric_descriptors"]
            },
        ),
    )
    result = compose_analysis_report(
        service,
        object(),
        AnalysisReportRequest(
            run_refs=["run-1"],
            focus_refs=["total-0", "total_mom-1"],
            fallback=True,
        ),
    )
    assert result["partial_analysis"] is missing
    assert result["org_codes"] == ["O1", "O2"]
    assert result["row_count"] == 2
    assert "丙行" not in result["report"]["summary"]
    assert ("还有2家机构暂无数据" in result["public_answer"]) is missing
    assert "还有1家机构暂无数据" not in result["public_answer"]


@pytest.mark.parametrize("fallback", [False, True])
def test_historical_gap_only_report_keeps_query_identity(fallback):
    _, history, service, request = setup_sources()
    gap = {"ref": "old.g1", "type": "gap", "display": "对公存款在七月末没有可用数据。"}
    history.update(
        org_codes=["O2"],
        org_names=["另一机构"],
        actual_dates=[],
        analysis_date=None,
        requested_start="2026-07-31",
        requested_end="2026-07-31",
        complete=False,
        evidence_items=[gap],
        gaps=[gap["display"]],
        observations=[],
        rows=[],
        row_count=0,
        tasks=[{"task_id": "empty-task", "status": "succeeded"}],
    )
    history["metric_descriptors"] = [history["metric_descriptors"][-1]]
    history["plan"]["steps"][0]["metric_refs"] = ["corporate"]
    service.tasks = SimpleNamespace(
        get_task_result=lambda *args, **kwargs: SimpleNamespace(
            status="succeeded",
            truncated=False,
            row_count=0,
            rows=[],
            facts=[],
            evidence={
                "logical_dsl": {
                    "metrics": ["corporate"],
                    "orgs": ["O2"],
                    "time": {"start": "2026-07-31", "end": "2026-07-31"},
                }
            },
        )
    )
    request.run_refs = request.context_run_refs = ["history"]
    request.focus_refs = ["old.g1"]
    request.summary = "该期没有可用数据。{{old.g1|cite}}"
    request.fallback = fallback
    result = compose_analysis_report(service, object(), request)
    assert result["status"] == "succeeded"
    assert result["partial_analysis"] is True
    assert result["org_codes"] == ["O2"]
    assert "2026-07-31" in result["public_answer"]
    view = focused_sources([history], request.focus_refs)[0]
    for field in ("metric_descriptors", "requested_start", "requested_end", "date_selection"):
        assert view[field] == history[field]
    assert result["report"]["plans"][0]["steps"][0]["metric_refs"] == ["corporate"]
    assert result["evidence_items"] == [gap]
    assert result["row_count"] == 0
    assert "元" not in result["public_answer"]


def test_historical_gap_cannot_authorize_an_unknown_value_reference():
    _, history, service, request = setup_sources()
    history.update(
        evidence_items=[{"ref": "old.g1", "type": "gap", "display": "无数据"}],
        actual_dates=[],
        rows=[],
        observations=[],
        complete=False,
        gaps=["无数据"],
    )
    request.run_refs = request.context_run_refs = ["history"]
    request.focus_refs = ["old.g1"]
    request.summary = "余额{{old.total}}。"
    with pytest.raises(ApplicationError) as error:
        compose_analysis_report(service, object(), request)
    assert error.value.code == "ANALYSIS_REPORT_REFERENCE"
