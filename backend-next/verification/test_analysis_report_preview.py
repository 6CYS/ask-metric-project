"""正文预览复用正式报告的事实边界；样本只用于隔离验证。"""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_analysis_report_availability import setup_report as setup_availability_report
from test_analysis_report_claims import evidence
from test_inquiry_calculation import setup_comparison

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.analysis import get_analysis_service, router
from ask_metric.application.analysis_calculation import calculate_analysis_results
from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError


def setup_preview(body="余额为{{total}}。", **changes):
    source = evidence()
    semantics = SimpleNamespace(
        resolve=lambda _ref: None,
        items={
            item["code"]: SimpleNamespace(name=item["name"])
            for item in source["metric_descriptors"]
        },
    )
    service = SimpleNamespace(
        authorized_evidence=Mock(side_effect=lambda _actor, _ref: deepcopy(source)),
        semantics=lambda _actor: semantics,
    )
    request = AnalysisReportRequest(
        run_refs=[source["run_ref"]], summary=body, preview=True, **changes
    )
    return source, service, request


def value_table(cell, header="个人存款"):
    return f"| 机构 | {header} |\n|---|---|\n| 测试机构 | {cell} |"


def test_preview_returns_only_rendered_body_without_mutating_sources():
    source, service, request = setup_preview("余额为{{total}}。\n\n个人存款60元{{personal|cite}}。")
    source["gaps"] = ["尚未取得其他期间记录。"]
    original = deepcopy(source)

    result = compose_analysis_report(service, object(), request)

    assert result == {
        "kind": "analysis_report_preview",
        "status": "succeeded",
        "preview_text": "余额为100元。\n\n个人存款60元。",
    }
    assert source == original


@pytest.mark.parametrize(
    ("chunks", "rendered"),
    [
        (
            ["余额{{total}}。", "个人存款60元{{personal|cite}}。"],
            ["余额100元。", "个人存款60元。"],
        ),
        (
            ["# 数据概览", "## 存款余额", "余额{{total}}。"],
            ["# 数据概览", "## 存款余额", "余额100元。"],
        ),
        (
            [
                "余额{{total}}。",
                "| 机构 | 个人存款 |\n|---|---|\n| 测试机构 | 60元{{personal|cite}} |",
            ],
            ["余额100元。", "| 机构 | 个人存款 |\n|---|---|\n| 测试机构 | 60元 |"],
        ),
        (
            ["余额{{total}}。", "```text\n余额{{total}}。\n\n个人存款{{personal}}。\n```"],
            ["余额100元。", "```text\n余额100元。\n\n个人存款60元。\n```"],
        ),
        (
            ["余额{{total}}。", "    余额{{total}}。\n    个人存款{{personal}}。"],
            ["余额100元。", "    余额100元。\n    个人存款60元。"],
        ),
    ],
    ids=["paragraphs", "headings", "table", "fenced-block", "indented-block"],
)
def test_preview_complete_chunks_equal_cumulative_body(chunks, rendered):
    source, service, request = setup_preview()
    original = deepcopy(source)
    actor = object()
    received = []
    for index, chunk in enumerate(chunks):
        # 来源及请求上下文保持不变；完整表格、围栏和首行缩进均由调用方保留。
        delta = compose_analysis_report(
            service, actor, request.model_copy(update={"summary": chunk})
        )
        received.append(delta["preview_text"])
        cumulative = compose_analysis_report(
            service,
            actor,
            request.model_copy(update={"summary": "\n\n".join(chunks[: index + 1])}),
        )
        assert received[index] == rendered[index]
        assert "\n\n".join(received) == cumulative["preview_text"]
        assert cumulative["preview_text"] == "\n\n".join(rendered[: index + 1])
    assert source == original


@pytest.mark.parametrize(
    ("chunk", "code"),
    [
        (value_table("999元{{personal|cite}}"), "ANALYSIS_REPORT_NUMBER"),
        (value_table("60万元{{personal|cite}}"), "ANALYSIS_REPORT_NUMBER"),
        (value_table("-60元{{personal|cite}}"), "ANALYSIS_REPORT_NUMBER"),
        (value_table("100元", "余额"), "ANALYSIS_REPORT_NUMBER"),
        ("个人存款{{unknown}}。", "ANALYSIS_REPORT_REFERENCE"),
        ("个人存款{{personal。", "ANALYSIS_REPORT_FORMAT"),
        (
            "| 机构 | 个人存款 |\n|---|---|\n| 测试机构 | 60{{personal|cite}} |",
            "ANALYSIS_REPORT_NUMBER",
        ),
    ],
)
def test_preview_increment_rejects_same_invalid_values_and_refs_as_cumulative(chunk, code):
    _, service, request = setup_preview()
    actor = object()
    assert compose_analysis_report(service, actor, request)["preview_text"] == "余额为100元。"
    for body in (chunk, request.summary + "\n\n" + chunk):
        with pytest.raises(ApplicationError) as caught:
            compose_analysis_report(service, actor, request.model_copy(update={"summary": body}))
        assert caught.value.code == code


@pytest.mark.parametrize(
    ("boundary", "code", "status"),
    [
        ("authorization", "ANALYSIS_FORBIDDEN", 403),
        ("binding", "ANALYSIS_BINDING_INVALID", 422),
        ("binding", "ANALYSIS_METADATA_CHANGED", 409),
    ],
)
def test_preview_increment_rechecks_access_and_binding_after_success(boundary, code, status):
    _, service, request = setup_preview()
    actor = object()
    assert compose_analysis_report(service, actor, request)["preview_text"] == "余额为100元。"
    failure = ApplicationError(code, "读取边界已经变化。", status_code=status)
    if boundary == "authorization":
        service.authorized_evidence.side_effect = failure
    else:
        service.semantics(actor).resolve = Mock(side_effect=failure)
    for body in ("## 后续说明", request.summary + "\n\n## 后续说明"):
        with pytest.raises(ApplicationError) as caught:
            compose_analysis_report(service, actor, request.model_copy(update={"summary": body}))
        assert caught.value.code == code
        assert caught.value.status_code == status


def test_prefix_can_preview_before_all_questions_are_covered_but_cannot_finish_report():
    source, service, request = setup_preview()
    source["plan"]["requirements"].append({"id": "q2", "question": "个人存款多少"})
    source["plan"]["steps"][0]["metric_refs"].remove("personal")
    source["plan"]["steps"].append(
        {"id": "s2", "method": "observe", "answers": ["q2"], "metric_refs": ["personal"]}
    )

    prefix = compose_analysis_report(service, object(), request)
    assert prefix["preview_text"] == "余额为100元。"
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request.model_copy(update={"preview": False}))
    assert caught.value.code == "ANALYSIS_REPORT_PROSE_COVERAGE"

    complete = request.model_copy(
        update={"summary": request.summary + "\n\n个人存款{{personal}}。"}
    )
    preview = compose_analysis_report(service, object(), complete)
    final = compose_analysis_report(
        service, object(), complete.model_copy(update={"preview": False})
    )
    assert (
        preview["preview_text"] == final["report"]["summary"] == ("余额为100元。\n\n个人存款60元。")
    )
    assert final["kind"] == "business_report"


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (value_table("999元{{total|cite}}", "余额"), "ANALYSIS_REPORT_NUMBER"),
        (value_table("100万元{{total|cite}}", "余额"), "ANALYSIS_REPORT_NUMBER"),
        (value_table("-100元{{total|cite}}", "余额"), "ANALYSIS_REPORT_NUMBER"),
        ("余额{{total}}。\n\n" + value_table("100元"), "ANALYSIS_REPORT_NUMBER"),
        ("余额{{unknown}}。", "ANALYSIS_REPORT_REFERENCE"),
        ("余额{{total。", "ANALYSIS_REPORT_FORMAT"),
    ],
)
def test_preview_and_final_share_reference_and_structured_value_checks(body, code):
    _, service, request = setup_preview(body)
    for preview in (True, False):
        with pytest.raises(ApplicationError) as caught:
            compose_analysis_report(
                service, object(), request.model_copy(update={"preview": preview})
            )
        assert caught.value.code == code


def test_preview_rechecks_authorization_before_disclosing_body():
    _, service, request = setup_preview()
    actor = object()
    service.authorized_evidence.side_effect = ApplicationError(
        "ANALYSIS_FORBIDDEN", "无权读取分析范围。", status_code=403
    )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, actor, request)
    assert caught.value.status_code == 403
    service.authorized_evidence.assert_called_once_with(actor, "run-1")


def test_preview_keeps_explicit_fact_identity_binding():
    _, service, request = setup_preview(
        fact_bindings=[
            {"ref": "total", "org_code": "O2", "metric_code": "total", "date": "2026-08-27"}
        ]
    )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_preview_does_not_reexecute_availability_and_final_still_does():
    _, service, request = setup_availability_report("指定日期没有可用数据。")
    request = AnalysisReportRequest.model_validate({**request.model_dump(), "preview": True})

    result = compose_analysis_report(service, object(), request)
    assert result["preview_text"] == "指定日期没有可用数据。"
    service.execution.data_source.execute_readonly.assert_not_called()

    final = compose_analysis_report(
        service, object(), request.model_copy(update={"preview": False})
    )
    assert final["kind"] == "business_report"
    service.execution.data_source.execute_readonly.assert_called_once()


@pytest.mark.parametrize(
    "changes",
    [
        {"fallback": True},
        {"sections": [{"title": "明细", "text": "{{total}}", "evidence_refs": ["total"]}]},
    ],
)
def test_preview_cannot_generate_fallback_or_deliver_sections(changes):
    _, service, request = setup_preview(**changes)
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, object(), request)
    assert caught.value.code == "ANALYSIS_REPORT_FORMAT"


def test_preview_http_reuses_saved_calculation_without_committing_or_changing_state():
    service, actor, calculation_request, source, saved = setup_comparison()
    calculation = calculate_analysis_results(service, actor, calculation_request, "preview-input")
    atom = calculation["evidence_items"][0]
    payload = {
        "run_refs": calculation_request.run_refs,
        "context_run_refs": calculation_request.run_refs,
        "focus_refs": [atom["ref"]],
        "calculation_refs": [calculation["calculation_ref"]],
        "summary": "两期差额为{{" + atom["ref"] + "}}。",
        "preview": True,
    }
    original_source = deepcopy(source)
    original_records = {key: deepcopy(value.payload) for key, value in saved.items()}
    with service.tasks.uow_factory() as uow:
        task = uow.tasks.get_owned_for_update("test-task", actor.user_id)
        original_task = deepcopy(task.state_json)
        uow.commit.reset_mock()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_analysis_service] = lambda: service
    app.dependency_overrides[require_actor] = lambda: actor

    with TestClient(app) as client:
        response = client.post("/api/v1/analysis/report", json=payload)

    assert response.status_code == 200
    assert response.json() == {
        "kind": "analysis_report_preview",
        "status": "succeeded",
        "preview_text": "两期差额为2.50个百分点。",
    }
    assert source == original_source
    assert {key: value.payload for key, value in saved.items()} == original_records
    assert task.state_json == original_task
    uow.commit.assert_not_called()

    invalid = AnalysisReportRequest.model_validate(
        {
            **payload,
            "calculation_refs": [{**calculation["calculation_ref"], "calculation_id": "missing"}],
        }
    )
    with pytest.raises(ApplicationError) as caught:
        compose_analysis_report(service, actor, invalid)
    assert caught.value.code == "ANALYSIS_CALCULATION_SOURCE"
