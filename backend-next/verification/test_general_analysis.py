"""隔离样本验证公共分析协议；本文件不证明真实查询库或模型效果。"""

from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError
from test_business_overview import make_environment

from ask_metric.application.analysis_execution import AnalysisRequest, GeneralAnalysisService, display_number
from ask_metric.application.analysis_report import (
    AnalysisReportRequest,
    compose_analysis_report,
    public_analysis_gap,
)
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import AnalysisPlan


@pytest.fixture
def general_environment(tmp_path):
    old, actor, sessions, source, engine = make_environment(
        tmp_path / "general.sqlite",
        source_metrics={
            "income": {"name": "营业收入金额当日数", "unit": "元"},
            "profit": {"name": "净利润金额当日数", "unit": "元"},
            "capital": {"name": "资本充足比率当日数", "unit": "%"},
            "change": {"name": "营业收入金额较上月", "unit": "元"},
        },
        observations=[
            ("income", date(2026, 7, 31), Decimal("100000000")),
            ("income", date(2026, 8, 31), Decimal("120000000")),
            ("income", date(2025, 8, 31), Decimal("80000000")),
            ("profit", date(2026, 7, 31), Decimal("0")),
            ("profit", date(2026, 8, 31), Decimal("-20000000")),
            ("capital", date(2026, 8, 31), Decimal("0.17")),
            ("change", date(2026, 7, 31), Decimal("-10000000")),
            ("change", date(2026, 8, 31), Decimal("20000000")),
        ],
    )
    old.execution.today_provider = lambda: date(2026, 10, 15)
    service = GeneralAnalysisService(
        old.tasks,
        old.execution,
        CalculationApplicationService(old.execution),
        secret="isolated-signing-key",
    )
    yield service, actor, sessions, source
    engine.dispose()


def binding(service, actor, keyword):
    return service.semantics(actor).search(keyword)["items"][0]["binding_ref"]


def plan(reference, **changes):
    value = {
        "objective": "分析经营表现",
        "scope_notice": "只覆盖本次正式指标，不代表全部经营状况。",
        "requirements": [{"id": "performance", "question": "最近表现与可比时点有何变化？"}],
        "steps": [
            {
                "id": "first",
                "method": "compare",
                "metric_refs": [reference],
                "answers": ["performance"],
                "comparisons": ["mom", "yoy"],
                "rationale": "核对现状与两种可比时点。",
            }
        ],
    }
    value.update(changes)
    return AnalysisPlan.model_validate(value)


def request(analysis_plan, **changes):
    value = {
        "plan": analysis_plan,
        "conversation_id": "overview-conversation",
        "calculation_context": {
            "scope_id": "general-turn",
            "user_question": "最近经营情况怎么样？",
        },
    }
    value.update(changes)
    return AnalysisRequest.model_validate(value)


def test_unconfigured_income_compiles_existing_queries_and_calculations(general_environment):
    service, actor, _, source = general_environment
    result = service.execute(
        request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "income"
    )
    assert result["analysis_date"] == "2026-08-31"
    assert result["query_count"] == 2
    assert len(result["rows"]) == 3
    assert any("差额0.20亿元" in item["text"] for item in result["observations"])
    assert any("差额0.40亿元" in item["text"] for item in result["observations"])
    assert result["requirement_dispositions"][0]["status"] == "completed"
    assert source.calls
    assert result["metric_descriptors"][0]["code"] == "income"


def test_replay_does_not_query_again_and_checks_request_fingerprint(general_environment):
    service, actor, _, source = general_environment
    payload = request(plan(binding(service, actor, "营业收入金额当日数")))
    first = service.execute(payload, actor, "repeat")
    calls = len(source.calls)
    assert service.execute(payload, actor, "repeat") == first
    assert len(source.calls) == calls
    with pytest.raises(ApplicationError, match="同一分析请求键"):
        service.execute(
            payload.model_copy(update={"anchor_date": date(2026, 7, 31)}), actor, "repeat"
        )


def test_verified_judgments_precede_prose_and_expand_to_requirement_sources(general_environment):
    service, actor, _, _ = general_environment
    income, profit = (binding(service, actor, name) for name in ["营业收入金额当日数", "净利润金额当日数"])
    analysis_plan = plan(income, requirements=[{"id": "income", "question": "收入变化？"},
                                               {"id": "profit", "question": "利润变化？"}],
        steps=[{"id": name, "method": "compare", "metric_refs": [ref], "answers": [name],
                "comparisons": ["mom"], "rationale": "核对正式取值变化。"}
               for name, ref in [("income", income), ("profit", profit)]])
    result = service.execute(request(analysis_plan), actor, "findings")
    items = result["verified_findings"]["items"]
    assert len(items) == 2
    assert any("增加" in item["text"] for item in items)
    assert any("减少" in item["text"] for item in items)
    body = "\n\n".join("{{" + item["ref"] + "}}" for item in items)
    report = compose_analysis_report(service, actor, AnalysisReportRequest(run_refs=[result["run_ref"]], summary=body))
    assert all(row["status"] == "covered" for row in report["report"]["requirement_coverage"])
    assert all(set(item["evidence_refs"]) <= set(paragraph["evidence_refs"])
               for item, paragraph in zip(items, report["report"]["body_evidence"], strict=True))
    with pytest.raises(ApplicationError, match="报告遗漏原始子问题"):
        compose_analysis_report(service, actor, AnalysisReportRequest(
            run_refs=[result["run_ref"]], summary="{{" + items[0]["ref"] + "}}"))
    fallback = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="经营收入999999亿元", fallback=True))
    assert any(item["text"] in fallback["report"]["sections"][0]["text"] for item in items)
    for claim in ["费用控制并未恶化，反而有所改善。", "成本效率有所优化。"]:
        with pytest.raises(ApplicationError, match="未经证实"):
            compose_analysis_report(service, actor, AnalysisReportRequest(
                run_refs=[result["run_ref"]], summary=body + "\n\n" + claim))


def test_forged_or_cross_user_bindings_never_query(general_environment):
    service, actor, _, source = general_environment
    ref = binding(service, actor, "营业收入金额当日数")
    for invalid in [ref[:-1] + ("a" if ref[-1] != "a" else "b"), "invented-code", "e30=.bad"]:
        with pytest.raises(ApplicationError):
            service.execute(request(plan(invalid)), actor, "forged")
    other = actor.model_copy(update={"user_id": "different-user"})
    with pytest.raises(ApplicationError):
        service.execute(request(plan(ref)), other, "other")
    assert source.calls == []


def test_metadata_change_invalidates_old_binding(general_environment):
    service, actor, sessions, source = general_environment
    from ask_metric.infrastructure.db.models import MetricTerm

    ref = binding(service, actor, "营业收入金额当日数")
    with sessions() as session:
        term = session.query(MetricTerm).filter_by(metric_code="income").one()
        term.unit = "万元"
        session.commit()
    with pytest.raises(ApplicationError, match="指标定义或规则已更新"):
        service.execute(request(plan(ref)), actor, "changed")
    assert not source.calls


def test_exact_missing_date_does_not_silently_rewind(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "营业收入金额当日数")
    result = service.execute(
        request(plan(ref), date_selection="exact", start="2026-10-01", end="2026-10-01"),
        actor,
        "exact",
    )
    assert result["rows"] == []
    assert result["analysis_date"] is None
    assert result["gaps"]
    gap = next(item for item in result["evidence_items"] if item["type"] == "gap")
    report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]],
            summary="2026年10月1日未取得请求指标记录，保持指定日期，不改查最近数据。",
            sections=[
                {
                    "title": "覆盖检查结果",
                    "text": "{{" + gap["ref"] + "}}",
                    "evidence_refs": [gap["ref"]],
                }
            ],
        ),
    )
    assert report["row_count"] == 0
    assert report["partial_analysis"]
    assert gap["display"] in report["public_answer"]
    presentation = report["report"]["presentation"]
    assert presentation["version"] == 1
    assert "未取得可用记录" in presentation["scope"]
    assert result["source_notice"] in presentation["source_notices"]


def test_report_presentation_varies_layout_without_changing_facts(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "营业收入金额当日数")
    result = service.execute(request(plan(ref)), actor, "presentation")
    observation = next(item for item in result["evidence_items"] if item["type"] == "observation")
    report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]],
            summary="已核验收入变化。",
            sections=[{"title": "变化", "text": "{{" + observation["ref"] + "}}", "evidence_refs": [observation["ref"]]}],
            presentation={"profile": "diagnostic", "density": "detailed"},
        ),
    )
    presentation = report["report"]["presentation"]
    assert presentation["profile"] == "diagnostic"
    assert presentation["density"] == "detailed"
    assert presentation["layout"] in (["summary", "data", "analysis"], ["summary", "analysis", "data"])
    assert presentation["labels"]["summary"] == "问题判断"
    assert presentation["body_mode"] == "narrative"
    assert presentation["layout"] == ["summary", "analysis", "data"]
    assert report["row_count"] == len(report["rows"])  # 风格选择不生成或修改事实行
    assert observation["display"] in report["public_answer"]


def test_period_preserves_available_months_and_discloses_missing(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "营业收入金额当日数")
    analysis_plan = plan(
        ref,
        steps=[
            {
                "id": "trend",
                "method": "trend",
                "metric_refs": [ref],
                "answers": ["performance"],
                "rationale": "查看范围内观测。",
            }
        ],
    )
    result = service.execute(
        request(
            analysis_plan, date_selection="available_in_range", start="2026-07-01", end="2026-10-15"
        ),
        actor,
        "period",
    )
    assert result["actual_dates"] == ["2026-07-31", "2026-08-31"]
    assert any("2026-09、2026-10" in gap for gap in result["gaps"])
    assert not result["complete"]


def test_percent_encoding_not_guessed_and_zero_baseline_not_divided(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "资本充足比率当日数")
    result = service.execute(request(plan(ref)), actor, "unknown-percent")
    assert any("原始值 0.17" in row["metric_value"] for row in result["rows"])
    assert not any(item["type"] == "calculation" for item in result["evidence_items"])
    raw_report = AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="当前原始值为0.1700；无法判断是否符合监管要求。"
    )
    assert "0.1700" in compose_analysis_report(service, actor, raw_report)["public_answer"]
    with pytest.raises(ApplicationError):
        compose_analysis_report(
            service, actor, raw_report.model_copy(update={"summary": "当前原始值为0.18"})
        )
    ref = binding(service, actor, "净利润金额当日数")
    result = service.execute(request(plan(ref)), actor, "zero-base")
    assert any("差额-0.20亿元" in item["text"] for item in result["observations"])
    assert not any(
        item.get("type") == "calculation" and "%" in item["display"]
        for item in result["evidence_items"]
    )


def test_dag_cycles_unanswered_goals_and_unapproved_structure_rejected(general_environment):
    service, actor, _, source = general_environment
    ref = binding(service, actor, "营业收入金额当日数")
    value = plan(ref).model_dump()
    value["steps"][0]["depends_on"] = ["first"]
    with pytest.raises(ValidationError):
        AnalysisPlan.model_validate(value)
    with pytest.raises(ValidationError):
        plan(ref, steps=[])
    analysis_plan = plan(
        ref,
        steps=[
            {
                "id": "structure",
                "method": "structure",
                "metric_refs": [ref],
                "answers": ["performance"],
                "rationale": "不能猜关系。",
                "relation_id": "invented",
            }
        ],
    )
    with pytest.raises(ApplicationError, match="审核后的"):
        service.execute(request(analysis_plan), actor, "bad-relation")
    assert not source.calls


def test_report_checks_numbers_refs_scope_and_actual_sources(general_environment):
    service, actor, _, _ = general_environment
    analysis_plan = plan(binding(service, actor, "营业收入金额当日数")).model_copy(
        update={"scope_notice": "模型误写：用户未明确机构，默认使用账户机构。"}
    )
    result = service.execute(request(analysis_plan), actor, "report")
    observation = next(item for item in result["evidence_items"] if item["type"] == "observation")
    payload = AnalysisReportRequest(
        run_refs=[result["run_ref"]],
        summary="已取得现状及可比观测。",
        sections=[
            {
                "title": "主要变化",
                "text": "{{" + observation["ref"] + "}}",
                "evidence_refs": [observation["ref"]],
            }
        ],
    )
    report = compose_analysis_report(service, actor, payload)
    assert report["rows"] == result["rows"]
    assert report["tasks"] == result["tasks"]
    assert "实际指标查询库" in report["public_answer"]
    assert "模型误写" not in report["public_answer"]
    assert report["report"]["plans"][0]["scope_notice"] == analysis_plan.scope_notice
    assert observation["display"] in report["public_answer"]
    chinese = payload.model_copy(update={"summary": "截至2026年8月31日，已取得现状及可比观测。"})
    assert "2026年8月31日" in compose_analysis_report(service, actor, chinese)["public_answer"]
    fact = next(item for item in result["evidence_items"] if item["type"] == "fact")
    duplicate = payload.model_copy(update={"summary": "当前观测{{" + fact["ref"] + "}}亿元"})
    assert "亿元亿元" not in compose_analysis_report(service, actor, duplicate)["public_answer"]
    limits = payload.model_copy(
        update={
            "summary": "无法认定客户流失导致下降；"
            "系统未提供监管达标阈值，无法判定是否符合监管要求。"
            "余额变化不能证明贷款投放节奏平稳，不能认定客户基础扎实或不良贷款率较低。"
        }
    )
    assert "无法认定" in compose_analysis_report(service, actor, limits)["public_answer"]
    for summary in [
        "收入100亿元",
        "{{invented}}",
        "客户都流失导致收入下滑",
        "截至2026年9月30日",
        "经营规模与收益保持稳定",
        "目前无法判断收入原因，但客户流失导致收入下降",
        "已经符合监管要求",
        "这说明收入增长被成本或费用增量抵消",
        "该差额反映的是月末时点的累计口径差异",
        "该指标判断为累计差额",
        "贷款投放节奏相对平稳",
        "月度投放节奏有所趋缓",
        "月度动能明显趋缓",
        "负债端稳定性较好",
        "客户基础较为扎实",
        "不良贷款率处于较低水平",
        "资产质量处于可控水平",
        "资产质量指标良好",
        "质量改善更多是近期的边际变化",
        "当前改善扭转了同比上升趋势",
        "资产质量中长期承压",
        "存款增长动能强于贷款投放",
        "反映负债端扩张动能更强",
        "存贷比处于较低水平",
        "反映出资金运用端相对存款积累偏弱",
        "月度环比改善与累计同比回落并存",
        "存款增长明显快于贷款",
    ]:
        try:
            compose_analysis_report(service, actor, payload.model_copy(update={"summary": summary}))
        except ApplicationError:
            pass
        else:
            pytest.fail(f"未经证据支持的断言未被拒绝：{summary}")


def test_public_gaps_hide_catalog_refs_and_use_authoritative_names():
    text = (
        "利润总额ORG_PRFT_TOTAMT（k21）及比较指标(k15/k16/k22)待补查；"
        "个人贷款k55和对公贷款k56已发现。"
    )
    public = public_analysis_gap(text, {"ORG_PRFT_TOTAMT": "利润总额金额当日数"})
    assert public == "利润总额利润总额金额当日数及比较指标待补查；个人贷款和对公贷款已发现。"
    # 正式名称中含相似字符时必须保留，未知正式编码也不能猜成其他指标。
    assert (
        public_analysis_gap("k21类产品及ORG_KNOWN，ORG_UNKNOWN待核验", {"ORG_KNOWN": "k21类产品"})
        == "k21类产品及k21类产品，ORG_UNKNOWN待核验"
    )
    assert public_analysis_gap("sk21、k21x、K21", {}) == "sk21、k21x、K21"


def test_report_explicit_history_context_keeps_scope_and_current_goal(general_environment, monkeypatch):
    service, actor, _, _ = general_environment
    old = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "context-old")
    latest = service.execute(request(plan(binding(service, actor, "净利润金额当日数")),
                                     calculation_context={"scope_id": "follow-up-turn", "user_question": "那利润呢？"}), actor, "context-new")
    old_atom = next(item for item in old["evidence_items"] if item["type"] == "fact")
    new_atom = next(item for item in latest["evidence_items"] if item["type"] == "fact")
    payload = AnalysisReportRequest(run_refs=[old["run_ref"], latest["run_ref"]],
        summary="原收入观测{{" + old_atom["ref"] + "}}；本次利润观测{{" + new_atom["ref"] + "}}。")
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_SCOPE"
    payload.context_run_refs = [old["run_ref"]]
    report = compose_analysis_report(service, actor, payload)
    assert report["status"] == "succeeded"
    assert len(report["rows"]) == len(old["rows"]) + len(latest["rows"])
    assert report["report"]["requirement_coverage"][0]["status"] == "covered"
    for context_refs in [[old["run_ref"], latest["run_ref"]], ["invented"], [old["run_ref"], old["run_ref"]]]:
        with pytest.raises(ApplicationError) as failure:
            compose_analysis_report(service, actor, payload.model_copy(update={"context_run_refs": context_refs}))
        assert failure.value.code == "ANALYSIS_REPORT_SCOPE"
    # 显式背景不能跨越原机构、会话和日期目标边界。
    authorized = service.authorized_evidence
    monkeypatch.setattr(service, "authorized_evidence", lambda user, ref:
        {**authorized(user, ref), "org_codes": ["other-org"]} if ref == old["run_ref"] else authorized(user, ref))
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_SCOPE"


def test_report_cleans_public_gaps_but_keeps_original_plan(general_environment):
    service, actor, _, _ = general_environment
    analysis_plan = plan(
        binding(service, actor, "营业收入金额当日数"),
        requirements=[
            {"id": "performance", "question": "收入k21表现如何？"},
            {
                "id": "cost",
                "question": "费用情况？",
                "gap_reason": "费用比较指标（k15/k16）尚未查询。",
            },
        ],
    )
    result = service.execute(request(analysis_plan), actor, "public-gap")
    observation = next(item for item in result["evidence_items"] if item["type"] == "observation")
    report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]],
            summary="已取得部分观测，仍有未完成事项。",
            sections=[
                {
                    "title": "收入观测",
                    "text": "{{" + observation["ref"] + "}}",
                    "evidence_refs": [observation["ref"]],
                }
            ],
            planning_gaps=["个人贷款k55和对公贷款k56待补查。"],
        ),
    )
    assert "费用比较指标尚未查询。" in report["public_answer"]
    assert "个人贷款和对公贷款待补查。" in report["public_answer"]
    assert "k15" not in report["public_answer"]
    assert report["report"]["plans"][0]["questions"][0] == "收入表现如何？"
    assert (
        report["report"]["plans"][0]["requirements"][1]["gap_reason"]
        == "费用比较指标（k15/k16）尚未查询。"
    )
    assert report["partial_analysis"] is True


def test_permission_revoked_blocks_report_and_replay(general_environment):
    service, actor, _, _ = general_environment
    payload = request(plan(binding(service, actor, "营业收入金额当日数")))
    result = service.execute(payload, actor, "revoked")
    service.execution.permission_service = type(
        "Denied", (), {"authorize_logical_dsl": lambda self, **kwargs: {"orgs": []}}
    )()
    with pytest.raises(ApplicationError):
        compose_analysis_report(
            service, actor, AnalysisReportRequest(run_refs=[result["run_ref"]], fallback=True)
        )
    with pytest.raises(ApplicationError):
        service.execute(payload, actor, "revoked")


def test_latest_record_without_value_searches_back_but_exact_never_does(
    general_environment, monkeypatch
):
    service, actor, _, source = general_environment
    source.observations.append(("income", date(2026, 9, 30), None))
    coverage = service._coverage

    def includes_null(context, code, start, end):
        if code == "income" and end >= date(2026, 9, 30):
            return "2026-09-30"
        return coverage(context, code, start, end)

    monkeypatch.setattr(service, "_coverage", includes_null)
    payload = request(plan(binding(service, actor, "营业收入金额当日数")))
    result = service.execute(payload, actor, "null-latest")
    assert result["analysis_date"] == "2026-08-31"
    assert any("回查至2026-08-31" in note for note in result["defaults_applied"])
    exact = payload.model_copy(
        update={"date_selection": "exact", "start": date(2026, 9, 30), "end": date(2026, 9, 30)}
    )
    assert service.execute(exact, actor, "null-exact")["rows"] == []


def test_interrupted_run_resumes_only_uncompleted_steps(general_environment, monkeypatch):
    service, actor, _, _ = general_environment
    income = binding(service, actor, "营业收入金额当日数")
    profit = binding(service, actor, "净利润金额当日数")
    first = plan(income)
    second = first.steps[0].model_copy(
        update={"id": "second", "metric_refs": [profit], "depends_on": ["first"]}
    )
    payload = request(first.model_copy(update={"steps": [*first.steps, second]}))
    execute = service._execute_step
    calls = []

    def intermittent(context, step):
        calls.append(step.id)
        if calls == ["first", "second"]:
            raise RuntimeError("隔离测试中的临时中断")
        return execute(context, step)

    monkeypatch.setattr(service, "_execute_step", intermittent)
    with pytest.raises(RuntimeError):
        service.execute(payload, actor, "resume")
    assert service.run_status(actor, "resume", payload.conversation_id)["status"] == "interrupted"
    result = service.execute(payload, actor, "resume")
    assert calls == ["first", "second", "second"]
    assert result["rows"]
    assert service.run_status(actor, "resume", payload.conversation_id)["evidence"] == result
    with pytest.raises(ApplicationError):
        service.run_status(actor, "resume", "other-conversation")


def test_concurrent_claim_is_rejected_without_extra_query(general_environment):
    service, actor, _, source = general_environment
    payload = request(plan(binding(service, actor, "营业收入金额当日数")))
    service._claim(payload, actor, "concurrent", ["O1"])
    with pytest.raises(ApplicationError, match="仍在执行"):
        service.execute(payload, actor, "concurrent")
    assert not source.calls


def test_literal_display_values_need_exact_signed_evidence(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(
        request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "literal"
    )
    source = next(item for item in result["evidence_items"] if item.get("type") == "fact")
    payload = AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="当前观测为" + source["display"]
    )
    assert source["display"] in compose_analysis_report(service, actor, payload)["public_answer"]
    repeated = "当前观测为" + source["display"] + "（{{" + source["ref"] + "}}）。"
    rendered = compose_analysis_report(service, actor, payload.model_copy(update={"summary": repeated}))["report"]["summary"]
    assert rendered.count(source["display"]) == 1
    for wrong in ["-" + source["display"], "999.00亿元"]:
        with pytest.raises(ApplicationError):
            compose_analysis_report(service, actor, payload.model_copy(update={"summary": wrong}))


def test_report_allows_checked_missing_dates_and_encoding_boundary(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(
        request(plan(binding(service, actor, "资本充足比率当日数"))), actor, "missing-date-prose"
    )
    payload = AnalysisReportRequest(
        run_refs=[result["run_ref"]],
        summary="缺少2026-07-31比较基期。数值编码待确认，未做乘100或百分点换算。",
    )
    assert "未做乘100" in compose_analysis_report(service, actor, payload)["public_answer"]
    for summary in ["缺少2026-06-30比较基期", "当前原始值为0.17%", "当前为100%"]:
        with pytest.raises(ApplicationError):
            compose_analysis_report(service, actor, payload.model_copy(update={"summary": summary}))
    trend = service.execute(
        request(
            plan(
                binding(service, actor, "资本充足比率当日数"),
                steps=[
                    {
                        "id": "trend",
                        "method": "trend",
                        "metric_refs": [binding(service, actor, "资本充足比率当日数")],
                        "answers": ["performance"],
                        "rationale": "检查最近三月真实覆盖",
                    }
                ],
            )
        ),
        actor,
        "missing-month-prose",
    )
    text = "2026-06、2026-07数据缺失，无法确定连续走势。"
    assert (
        text
        in compose_analysis_report(
            service, actor, AnalysisReportRequest(run_refs=[trend["run_ref"]], summary=text)
        )["public_answer"]
    )


def test_report_checks_comparison_direction_and_negative_magnitude(general_environment):
    service, actor, _, _ = general_environment
    ref = binding(service, actor, "营业收入金额较上月")
    observe = plan(
        ref,
        steps=[
            {
                "id": "read",
                "method": "observe",
                "metric_refs": [ref],
                "answers": ["performance"],
                "rationale": "读取正式比较量",
            }
        ],
    )
    positive = service.execute(request(observe), actor, "positive-direction")
    atom = next(item for item in positive["evidence_items"] if item["type"] == "fact")
    payload = AnalysisReportRequest(
        run_refs=[positive["run_ref"]], summary="较上月增加{{" + atom["ref"] + "}}"
    )
    assert "增加0.20亿元" in compose_analysis_report(service, actor, payload)["public_answer"]
    for summary in ["较上月下降{{" + atom["ref"] + "}}", "较上月减少0.20亿元", "较上月**减少**{{" + atom["ref"] + "}}"]:
        with pytest.raises(ApplicationError, match="增减方向"):
            compose_analysis_report(service, actor, payload.model_copy(update={"summary": summary}))
    negative = service.execute(
        request(observe, date_selection="exact", start="2026-07-31", end="2026-07-31"),
        actor,
        "negative-direction",
    )
    negative_atom = next(item for item in negative["evidence_items"] if item["type"] == "fact")
    styled = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[negative["run_ref"]], summary="较上月**减少**{{" + negative_atom["ref"] + "}}。"))
    assert "**减少**0.10亿元" in styled["public_answer"]
    assert "**减少**-" not in styled["public_answer"]
    for summary in ["较上月减少0.10亿元", "较上月下降0.10亿元"]:
        assert (
            summary
            in compose_analysis_report(
                service,
                actor,
                AnalysisReportRequest(run_refs=[negative["run_ref"]], summary=summary),
            )["public_answer"]
        )
    with pytest.raises(ApplicationError):
        compose_analysis_report(
            service,
            actor,
            AnalysisReportRequest(run_refs=[negative["run_ref"]], summary="较上月为0.10亿元"),
        )
    with pytest.raises(ApplicationError) as invalid:
        compose_analysis_report(
            service,
            actor,
            AnalysisReportRequest.model_validate(
                {
                    **payload.model_dump(),
                    "summary": "收入999.00亿元",
                    "sections": [
                        {
                            "title": "方向检查",
                            "text": "较上月下降{{" + atom["ref"] + "}}",
                            "evidence_refs": [atom["ref"]],
                        }
                    ],
                }
            ),
        )
    assert "正文第1段" in invalid.value.message
    assert "方向检查" in invalid.value.message


def test_semantic_config_rejects_unreviewed_authority_and_bad_relations():
    from ask_metric.application.metric_semantics import SemanticExtensions

    with pytest.raises(ValidationError):
        SemanticExtensions.model_validate({"metrics": {"income": {"status": "approved"}}})
    with pytest.raises(ValidationError):
        SemanticExtensions.model_validate(
            {"relations": [{"id": "cycle", "source": "隔离测试", "parent": "a", "children": ["a"]}]}
        )


def test_discovery_reuses_unique_domain_bindings_without_guessing_codes():
    from ask_metric.application.metric_semantics import MetricSemantics
    from ask_metric.domain.semantics import MetricCatalogItem

    metrics = [
        MetricCatalogItem(code="isolated-total", name="各项贷款余额_人行口径当日数", unit="元"),
        MetricCatalogItem(code="isolated-personal", name="个人贷款当日数", unit="元"),
        MetricCatalogItem(code="isolated-noise", name="贷款余额当日数", unit="元"),
        MetricCatalogItem(
            code="isolated-total_CMPRLATMO", name="各项贷款余额_人行口径较上月", unit="元"
        ),
    ]
    semantics = MetricSemantics(metrics, secret="isolated-key", actor_id="isolated")
    result = semantics.search("贷款余额")
    assert result["items"][0]["code"] == "isolated-total"
    assert result["items"][0]["analysis_hint"]["metric_id"] == "total"
    assert result["items"][1]["code"] == "isolated-total_CMPRLATMO"
    assert result["items"][1]["analysis_hint"]["comparison"] == "mom"
    assert result["topic_hints"][0]["topic"] == "loan"
    assert not semantics.descriptor("isolated-noise")["analysis_hint"]
    # 已查当前水平后提供正式比较入口，引用可复核；不制造不存在的同比编码。
    followup = semantics.comparison_candidates([semantics.descriptor("isolated-total")])
    assert [item["code"] for item in followup] == ["isolated-total_CMPRLATMO"]
    assert semantics.resolve(followup[0]["binding_ref"])["code"] == followup[0]["code"]
    assert semantics.comparison_candidates(
        [semantics.descriptor("isolated-total"), semantics.descriptor(followup[0]["code"])]
    ) == []
    assert semantics.comparison_candidates([semantics.descriptor("isolated-noise")]) == []
    # 同名冲突保持未绑定，不能凭顺序或相似度选中。
    ambiguous = MetricSemantics(
        [*metrics, metrics[0].model_copy(update={"code": "duplicate"})],
        secret="isolated-key",
        actor_id="isolated",
    )
    assert not ambiguous.descriptor("isolated-total")["analysis_hint"]


def test_formal_ratio_difference_uses_percentage_points_without_guessing_encoding():
    metric = {"unit": "%", "value_encoding": "ratio",
              "analysis_hint": {"comparison_role": "difference"}}
    assert display_number("-0.0001", metric) == "-0.01个百分点"
    assert display_number("0.0143", {**metric, "analysis_hint": {}}) == "1.43%"
    assert display_number("0.1", {**metric, "value_encoding": None}).startswith("原始值")


@pytest.mark.parametrize("label", ["同比增幅（", "环比增速为", "增幅："])
def test_amount_reference_cannot_be_labeled_as_growth_rate(general_environment, label):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额较上月"))), actor, "amount-label")
    atom = next(item for item in result["evidence_items"] if item["type"] == "fact")
    reference = "{{" + atom["ref"] + "}}"
    for value in [reference, atom["display"]]:
        payload = AnalysisReportRequest(run_refs=[result["run_ref"]], summary=label + value)
        with pytest.raises(ApplicationError) as failure:
            compose_analysis_report(service, actor, payload)
        assert failure.value.code == "ANALYSIS_REPORT_NUMBER"
    valid = AnalysisReportRequest(run_refs=[result["run_ref"]], summary="正式比较增量为" + reference + "，不能把金额称为增幅。")
    assert compose_analysis_report(service, actor, valid)["status"] == "succeeded"


@pytest.mark.parametrize("claim", ["增长主要集中在个人业务", "增长主要来自客户新增", "主要由对公贷款增长拉动",
                                    "改善主要集中在最近一个月", "结构较为稳定", "尚未回到同期高位",
                                    "连续收缩", "增长的贡献可能来自贴现", "可能存在息差收窄或成本上升"])
def test_parallel_facts_do_not_authorize_growth_attribution(general_environment, claim):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "attribution")
    atom = next(item for item in result["evidence_items"] if item["type"] == "fact")
    payload = AnalysisReportRequest(run_refs=[result["run_ref"]],
                                    summary="观测值为{{" + atom["ref"] + "}}；" + claim + "。", sections=[])
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_CAUSE"
    payload.summary = "观测值为{{" + atom["ref"] + "}}；是否" + claim + "，需要补充业务证据核实。"
    assert compose_analysis_report(service, actor, payload)["status"] == "succeeded"


def test_empty_narrative_recovery_does_not_claim_failed_fact_validation(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "no-narrative")
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="", sections=[], fallback=True,
    ))
    assert report["partial_analysis"]
    assert "完整文字分析尚未完成" in report["report"]["summary"]
    assert "部分文字分析未通过校验" not in report["public_answer"]
    assert not any("未通过" in gap for gap in report["gaps"])
    assert report["rows"]


def test_verification_question_allowed_and_fallback_keeps_valid_analysis(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "partial-sections")
    atom = next(item for item in result["evidence_items"] if item["type"] == "fact")
    reference = "{{" + atom["ref"] + "}}"
    valid = {"title": "后续核查", "text": "观测值为" + reference + "。需进一步核查导致变动的具体业务动因。",
             "evidence_refs": [atom["ref"]]}
    invalid = {**valid, "title": "错误归因", "text": "业务增长主要来自客户新增。"}
    payload = AnalysisReportRequest(run_refs=[result["run_ref"]], summary="观测值为" + reference,
                                    sections=[valid, invalid], fallback=True)
    report = compose_analysis_report(service, actor, payload)
    assert [item["title"] for item in report["report"]["sections"]] == ["后续核查"]
    assert report["partial_analysis"]
    assert "部分分析文字未通过" in report["gaps"][-1]
    assert "客户新增" not in report["public_answer"]


def test_narrative_fallback_keeps_only_verified_whole_paragraphs(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "paragraphs")
    atom = next(item for item in result["evidence_items"] if item["type"] == "fact")
    valid = "当前观测{{" + atom["ref"] + "}}，仍需核对同期间构成。"
    payload = AnalysisReportRequest(run_refs=[result["run_ref"]],
        summary=valid + "\n\n利润999亿元。\n\n客户流失导致收入下降。")
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert "正文第2段" in failure.value.message and "正文第3段" in failure.value.message
    report = compose_analysis_report(service, actor, payload.model_copy(update={"fallback": True}))
    assert report["partial_analysis"]
    assert "当前观测" in report["report"]["summary"]
    assert "999" not in report["public_answer"] and "客户流失" not in report["public_answer"]
    assert report["report"]["sections"] == []


def test_report_enumeration_is_not_a_business_value(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "list-markers")
    atom = next(item for item in result["evidence_items"] if item["type"] == "fact")
    payload = AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="观测值为{{" + atom["ref"] + "}}。",
        sections=[{"title": "后续核查", "text": "建议下一步核查：1）收入构成；2）费用变化；3）减值变化。",
                   "evidence_refs": [atom["ref"]]}],
    )
    report = compose_analysis_report(service, actor, payload)
    assert "1）收入构成" in report["public_answer"]
    for text in ["建议核查：1）净利润为999亿元。", "建议核查：1）亿元。", "利润为1。"]:
        payload.sections[0].text = text
        with pytest.raises(ApplicationError) as failure:
            compose_analysis_report(service, actor, payload)
        assert failure.value.code == "ANALYSIS_REPORT_NUMBER"


def test_report_does_not_merge_distinct_comparison_baselines(general_environment):
    service, actor, _, _ = general_environment
    result = service.execute(request(plan(binding(service, actor, "营业收入金额当日数"))), actor, "baseline-labels")
    payload = AnalysisReportRequest(run_refs=[result["run_ref"]],
                                    summary="同比和较年初均低于上年同期水平。", sections=[])
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_DIRECTION"


def test_multi_goal_report_checks_original_requirements_and_exposes_gaps(general_environment):
    service, actor, _, _ = general_environment
    income = binding(service, actor, "营业收入金额当日数")
    profit = binding(service, actor, "净利润金额当日数")
    analysis_plan = plan(
        income,
        requirements=[
            {"id": "income", "question": "收入情况"},
            {"id": "profit", "question": "利润情况"},
        ],
        steps=[
            {
                "id": key,
                "method": "observe",
                "metric_refs": [ref],
                "answers": [key],
                "rationale": "隔离样本验证覆盖",
            }
            for key, ref in [("income", income), ("profit", profit)]
        ],
    )
    result = service.execute(request(analysis_plan), actor, "multi-report-coverage")
    atoms = {
        atom["metric_code"]: atom for atom in result["evidence_items"] if atom["type"] == "fact"
    }
    sections = [
        {"title": code, "text": "{{" + atom["ref"] + "}}", "evidence_refs": [atom["ref"]]}
        for code, atom in atoms.items()
    ]
    payload = AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary="分方面观察。", sections=sections[:1]
    )
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_COVERAGE"
    report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest.model_validate(
            {
                **payload.model_dump(),
                "sections": sections,
                "planning_gaps": ["隔离样本尚缺构成方向"],
            }
        ),
    )
    assert len(report["report"]["requirement_coverage"]) == 2
    assert report["partial_analysis"]
    assert "隔离样本尚缺构成方向" in report["public_answer"]
    integrated = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], sections=[],
        summary="；".join("观测值为{{" + atom["ref"] + "}}" for atom in atoms.values()),
    ))
    assert all(item["status"] == "covered" for item in integrated["report"]["requirement_coverage"])
    assert integrated["report"]["sections"] == []
    assert "**核心判断**" not in integrated["public_answer"]
    assert integrated["rows"] == report["rows"]

    # 回应子问题需要证据，不能因此强迫正文复述所有比较数值。
    concise = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[result["run_ref"]], sections=[],
        summary="重点观测值为{{" + atoms["income"]["ref"] + "}}。\n\n利润情况已核对{{"
        + atoms["profit"]["ref"] + "|cite}}，当前资料尚不能证明业务原因。",
    ))
    assert all(item["status"] == "covered" for item in concise["report"]["requirement_coverage"])
    assert atoms["profit"]["display"] not in concise["report"]["summary"]
    assert concise["rows"] == report["rows"]
    assert concise["report"]["body_evidence"][1]["evidence_refs"] == [atoms["profit"]["ref"]]
    for text, code in [
        ("已核对{{missing|cite}}。", "ANALYSIS_REPORT_REFERENCE"),
        ("收入999亿元{{" + atoms["income"]["ref"] + "|cite}}。", "ANALYSIS_REPORT_NUMBER"),
        ("客户流失导致收入下降{{" + atoms["income"]["ref"] + "|cite}}。", "ANALYSIS_REPORT_CAUSE"),
    ]:
        with pytest.raises(ApplicationError) as invalid:
            compose_analysis_report(service, actor, AnalysisReportRequest(run_refs=[result["run_ref"]], summary=text))
        assert invalid.value.code == code


@pytest.mark.parametrize("date_label", ["2026年8月末", "8月末", "8月底"])
def test_midmonth_observation_cannot_be_reported_as_month_end(general_environment, date_label):
    service, actor, _, source = general_environment
    source.observations = [
        (code, date(2026, 8, 27) if day == date(2026, 8, 31) else day, value)
        for code, day, value in source.observations
    ]
    ref = binding(service, actor, "营业收入金额当日数")
    analysis_plan = plan(
        ref,
        steps=[
            {
                "id": "current",
                "method": "observe",
                "metric_refs": [ref],
                "answers": ["performance"],
                "rationale": "检查实际日期",
            }
        ],
    )
    result = service.execute(request(analysis_plan), actor, "midmonth-report")
    payload = AnalysisReportRequest(
        run_refs=[result["run_ref"]], summary=f"截至{date_label}最新观测。"
    )
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_NUMBER"
    assert "月中记录称为月末" in failure.value.message


@pytest.mark.parametrize("claim", ["贷款月度增长近乎停滞", "单月增量有所增加", "贷款增长明显乏力", "单月看，贷款余额增加"])
def test_midmonth_comparisons_do_not_establish_full_month_performance(general_environment, claim):
    service, actor, _, source = general_environment
    source.observations = [(code, date(2026, 8, 27) if day == date(2026, 8, 31) else day, value)
                           for code, day, value in source.observations]
    ref = binding(service, actor, "营业收入金额当日数")
    result = service.execute(request(plan(ref)), actor, "midmonth-strength")
    payload = AnalysisReportRequest(run_refs=[result["run_ref"]], summary=claim)
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, payload)
    assert failure.value.code == "ANALYSIS_REPORT_CAUSE"
    valid = payload.model_copy(update={"summary": "变化集中在两点：比较基期有差异，缺少连续记录，不能认定月度增长停滞。"})
    assert compose_analysis_report(service, actor, valid)["status"] == "succeeded"
