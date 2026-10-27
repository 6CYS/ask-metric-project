"""使用隔离SQLite与合成只读数据验证分段交付；不调用真实模型或业务数据库。"""

import pytest
from test_general_analysis import binding, plan, request
from test_multi_org_ranking import multi

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.core.errors import ApplicationError

pytest_plugins = ["test_general_analysis"]


def staged_plan(service, actor):
    profit = binding(service, actor, "净利润金额当日数")
    income = binding(service, actor, "营业收入金额当日数")
    capital = binding(service, actor, "资本充足比率当日数")
    return plan(
        profit,
        requirements=[
            {"id": "rank", "question": "哪个机构净利润最低？"},
            {"id": "cause", "question": "收入能否解释差异？"},
            {"id": "capital", "question": "资本水平如何？"},
        ],
        steps=[
            {
                "id": "rank",
                "method": "ranking",
                "metric_refs": [profit],
                "answers": ["rank"],
                "rationale": "先确定排名",
                "position": "bottom",
                "top_n": 1,
            },
            {
                "id": "cause",
                "method": "observe",
                "metric_refs": [income],
                "answers": ["cause"],
                "rationale": "定向核对收入",
                "depends_on": ["rank"],
            },
            {
                "id": "dependent",
                "method": "observe",
                "metric_refs": [income],
                "answers": ["cause"],
                "rationale": "依赖收入的后续步骤",
                "depends_on": ["cause"],
            },
            {
                "id": "capital",
                "method": "observe",
                "metric_refs": [capital],
                "answers": ["capital"],
                "rationale": "独立检查资本",
            },
        ],
    )


@pytest.mark.parametrize("count", [2, 10, 20, 61])
@pytest.mark.parametrize("failure", ["timeout", "upstream"])
def test_cause_failure_preserves_ranking_and_independent_branch(
    general_environment,
    monkeypatch,
    count,
    failure,
):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, count)
    analysis_plan = staged_plan(service, actor)
    original = service._execute_step
    executed = []

    def execute(context, step):
        executed.append(step.id)
        if step.id == "cause":
            if failure == "timeout":
                raise TimeoutError("internal connection detail must not be exposed")
            raise ApplicationError("UPSTREAM_UNAVAILABLE", "private detail", status_code=503)
        return original(context, step)

    monkeypatch.setattr(service, "_execute_step", execute)
    payload = request(analysis_plan, org_codes=codes)
    result = service.execute(payload, actor, "partial")
    assert executed == ["rank", "cause", "capital"]
    assert not result["complete"]
    assert result["status"] == "succeeded"  # 证据读取成功，不代表全部业务目标完成。
    statuses = {item["id"]: item["status"] for item in result["step_dispositions"]}
    assert statuses == {
        "rank": "completed",
        "cause": "failed",
        "dependent": "blocked",
        "capital": "completed",
    }
    assert {item["id"]: item["status"] for item in result["requirement_dispositions"]} == {
        "rank": "completed",
        "cause": "gap",
        "capital": "completed",
    }
    finding = next(
        item for item in result["verified_findings"]["items"] if item["kind"] == "ranking"
    )
    assert finding["org_code"] == codes[0]
    assert len(finding["evidence_refs"]) == count
    assert any(item.get("metric_code") == "capital" for item in result["evidence_items"])
    assert "private detail" not in str(result)
    assert "internal connection" not in str(result)
    capital = next(
        item for item in result["evidence_items"] if item.get("metric_code") == "capital"
    )
    report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]],
            summary="{{" + finding["ref"] + "}}；资本水平{{" + capital["ref"] + "}}",
        ),
    )
    assert report["partial_analysis"]
    assert f"本期参与{count}家" in report["public_answer"]
    calls = len(source.calls)
    assert service.execute(payload, actor, "partial") == result
    assert len(source.calls) == calls
    assert service.run_status(actor, "partial", payload.conversation_id)["evidence"] == result


@pytest.mark.parametrize(
    "error",
    [
        ApplicationError("ANALYSIS_FORBIDDEN", "permission", status_code=403),
        ApplicationError("ANALYSIS_CONFIGURATION_ERROR", "configuration", status_code=503),
        ApplicationError("ANALYSIS_METADATA_BROKEN", "unexpected metadata", status_code=500),
        RuntimeError("unexpected program defect"),
    ],
)
def test_permission_configuration_and_unknown_errors_are_not_swallowed(
    general_environment, monkeypatch, error
):
    service, actor, _, _ = general_environment
    original = service._execute_step

    def execute(context, step):
        if step.id == "cause":
            raise error
        return original(context, step)

    monkeypatch.setattr(service, "_execute_step", execute)
    with pytest.raises(type(error)):
        service.execute(request(staged_plan(service, actor)), actor, "fatal")
    state = service.run_status(actor, "fatal", "overview-conversation")
    assert state["status"] == "interrupted"
    assert "evidence" not in state
    saved = service._read_run(actor, state["run_ref"])
    assert "rank" in saved["completed_steps"]


def test_missing_explicit_metrics_returns_formal_identity_for_targeted_recovery(
    general_environment,
):
    service, actor, _, _ = general_environment
    with pytest.raises(ApplicationError) as caught:
        service.validate_plan(
            plan(binding(service, actor, "营业收入金额当日数")),
            actor,
            "营业收入金额当日数和净利润金额当日数是多少？",
        )
    assert caught.value.code == "ANALYSIS_EXPLICIT_METRIC_MISSING"
    assert caught.value.details == {
        "missing_metrics": [{"code": "profit", "name": "净利润金额当日数"}]
    }


@pytest.mark.parametrize("claims_answer", [False, True])
def test_deferred_explicit_metric_requires_unanswered_gap(general_environment, claims_answer):
    service, actor, _, _ = general_environment
    income = binding(service, actor, "营业收入金额当日数")
    analysis_plan = plan(
        income,
        requirements=[
            {"id": "income", "question": "营业收入金额当日数是多少？"},
            {
                "id": "profit",
                "question": "净利润金额当日数是多少？",
                "gap_reason": "利润指标待补查",
            },
        ],
        steps=[
            {
                "id": "income",
                "method": "observe",
                "metric_refs": [income],
                "answers": ["income", "profit"] if claims_answer else ["income"],
                "rationale": "独立读取已具备条件的收入",
            }
        ],
    )
    question = "营业收入金额当日数和净利润金额当日数是多少？"
    if claims_answer:
        with pytest.raises(ApplicationError) as caught:
            service.validate_plan(analysis_plan, actor, question)
        assert caught.value.code == "ANALYSIS_EXPLICIT_METRIC_MISSING"
        return
    payload = request(
        analysis_plan,
        calculation_context={
            "scope_id": "deferred",
            "user_question": question,
        },
    )
    evidence = service.execute(payload, actor, "deferred")
    assert evidence["rows"]
    assert not evidence["complete"]
    assert {item["id"]: item["status"] for item in evidence["requirement_dispositions"]} == {
        "income": "completed",
        "profit": "gap",
    }
    assert "利润指标待补查" in evidence["gaps"]


def test_failure_within_step_keeps_verified_facts_and_marks_partial(
    general_environment, monkeypatch
):
    service, actor, _, _ = general_environment
    original = service._execute_step

    def execute(context, step):
        result = original(context, step)
        assert result["facts"]
        raise TimeoutError("private response detail")

    monkeypatch.setattr(service, "_execute_step", execute)
    evidence = service.execute(
        request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "within-step"
    )
    assert evidence["rows"]
    assert not evidence["complete"]
    assert evidence["requirement_dispositions"][0]["status"] == "partial"
    assert "查询服务暂时异常" in evidence["requirement_dispositions"][0]["reason"]
    assert "private response" not in str(evidence)


def test_interrupted_run_resumes_without_repeating_completed_ranking(
    general_environment, monkeypatch
):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    original = service._execute_step
    executed = []
    fail_once = True

    def execute(context, step):
        nonlocal fail_once
        executed.append(step.id)
        if step.id == "cause" and fail_once:
            fail_once = False
            raise RuntimeError("unexpected defect")
        return original(context, step)

    monkeypatch.setattr(service, "_execute_step", execute)
    payload = request(staged_plan(service, actor), org_codes=codes)
    with pytest.raises(RuntimeError):
        service.execute(payload, actor, "resume")
    evidence = service.execute(payload, actor, "resume")
    assert evidence["complete"]
    assert executed == ["rank", "cause", "cause", "dependent", "capital"]
