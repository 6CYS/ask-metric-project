"""报告来源容量覆盖宿主有界调查；合成回执只用于隔离契约验证。"""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest
from pydantic import ValidationError
from test_analysis_report_claims import evidence

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def setup_report_sources(count, mode, *, historical=False):
    sources = {}
    paragraphs = []
    for index in range(1, count + 1):
        source = evidence()
        run_ref, org_code, org_name = f"run-{index}", f"O{index}", f"测试机构{index}"
        metric = {**source["metric_descriptors"][0], "unit": "元"}
        atom = {
            **source["evidence_items"][0],
            "ref": f"{run_ref}.total",
            "org_code": org_code,
            "org_name": org_name,
            "value": str(index),
            "display": f"{index}元",
            "unit": "元",
        }
        source.update(
            run_ref=run_ref,
            execution_mode="inquiry",
            scope_id=f"history-{index}" if historical else "current-turn",
            org_codes=[org_code],
            org_names=[org_name],
            metric_descriptors=[metric],
            evidence_items=[atom],
            rows=[
                {
                    "metric_name": metric["name"],
                    "org_name": org_name,
                    "stat_date": atom["date"],
                    "metric_value": atom["display"],
                    "value_role": "current",
                }
            ],
            row_count=1,
        )
        source["plan"]["steps"][0]["metric_refs"] = [metric["binding_ref"]]
        sources[run_ref] = source
        paragraphs.append(f"{org_name}存款余额为{{{{{atom['ref']}}}}}。")
    service = SimpleNamespace(
        authorized_evidence=Mock(side_effect=lambda _actor, ref: deepcopy(sources[ref])),
        semantics=lambda _actor: SimpleNamespace(
            resolve=lambda _ref: None,
            items={"total": SimpleNamespace(name="各项存款余额当日数")},
        ),
    )
    payload = {
        "run_refs": list(sources),
        "context_run_refs": list(sources) if historical else [],
        "focus_refs": [source["evidence_items"][0]["ref"] for source in sources.values()]
        if historical
        else [],
        "summary": "" if mode == "fallback" else "\n\n".join(paragraphs),
        "preview": mode == "preview",
        "fallback": mode == "fallback",
    }
    return sources, service, payload


@pytest.mark.parametrize("count", [13, 64])
@pytest.mark.parametrize("mode", ["preview", "final", "fallback"])
def test_independent_runs_preserve_every_source_and_fact(count, mode):
    sources, service, payload = setup_report_sources(count, mode)
    original = deepcopy(sources)
    actor = object()

    result = compose_analysis_report(service, actor, AnalysisReportRequest.model_validate(payload))

    assert result["status"] == "succeeded"
    assert service.authorized_evidence.call_args_list == [call(actor, ref) for ref in sources]
    assert sources == original
    body = result["preview_text"] if mode == "preview" else result["report"]["summary"]
    for index in range(1, count + 1):
        assert f"测试机构{index}" in body
        assert f"为{index}元。" in body
    if mode == "preview":
        assert result["kind"] == "analysis_report_preview"
    else:
        assert result["run_refs"] == list(sources)
        assert result["row_count"] == count
        assert {atom["ref"] for atom in result["evidence_items"]} == {
            f"{ref}.total" for ref in sources
        }
        assert all(item["status"] == "covered" for item in result["report"]["requirement_coverage"])


@pytest.mark.parametrize("mode", ["preview", "final", "fallback"])
def test_context_source_capacity_matches_report_capacity(mode):
    sources, service, payload = setup_report_sources(64, mode, historical=True)

    result = compose_analysis_report(
        service, object(), AnalysisReportRequest.model_validate(payload)
    )

    assert result["status"] == "succeeded"
    assert service.authorized_evidence.call_count == len(sources)
    if mode != "preview":
        assert result["run_refs"] == list(sources)
        assert result["row_count"] == len(sources)


@pytest.mark.parametrize("field", ["run_refs", "context_run_refs"])
def test_source_capacity_rejects_65_entries(field):
    _, _, payload = setup_report_sources(1, "final")
    payload[field] = [f"run-{index}" for index in range(65)]

    with pytest.raises(ValidationError) as caught:
        AnalysisReportRequest.model_validate(payload)

    assert [(error["loc"], error["type"]) for error in caught.value.errors()] == [
        ((field,), "too_long")
    ]


@pytest.mark.parametrize("mode", ["preview", "final", "fallback"])
@pytest.mark.parametrize("change", ["conversation", "scope", "duplicate", "conflicting_fact"])
def test_more_sources_preserve_identity_scope_and_conflict_checks(mode, change):
    sources, service, payload = setup_report_sources(13, mode)
    last = sources["run-13"]
    expected = "ANALYSIS_REPORT_SCOPE"
    if change == "conversation":
        last["conversation_id"] = "other-session"
    elif change == "scope":
        last["scope_id"] = "other-turn"
    elif change == "duplicate":
        payload["run_refs"].append("run-1")
    else:
        last.update(org_codes=["O1"], org_names=["测试机构1"])
        last["evidence_items"][0].update(org_code="O1", org_name="测试机构1")
        last["rows"][0]["org_name"] = "测试机构1"
        expected = "ANALYSIS_REPORT_REFERENCE"

    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), AnalysisReportRequest.model_validate(payload))

    assert caught.value.code == expected


@pytest.mark.parametrize("mode", ["preview", "final", "fallback"])
def test_permission_failure_in_later_source_stops_all_delivery_modes(mode):
    sources, service, payload = setup_report_sources(13, mode)

    def authorize(actor, ref):
        if ref == "run-13":
            raise ApplicationError("ANALYSIS_FORBIDDEN", "无权读取分析范围。", status_code=403)
        return deepcopy(sources[ref])

    service.authorized_evidence.side_effect = authorize

    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), AnalysisReportRequest.model_validate(payload))

    assert caught.value.code == "ANALYSIS_FORBIDDEN"
    assert caught.value.status_code == 403
    assert service.authorized_evidence.call_count == 13
