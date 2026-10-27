"""预设路线的隔离回归；Milvus/模型使用桩，执行使用合成数据和可丢弃SQLite。"""

from copy import deepcopy
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError
from test_general_analysis import request
from test_multi_org_ranking import multi

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.analysis_workflows import (
    load_workflows,
    pilot_parameters,
    profitability_plan,
    retrieve_workflow,
    route_focus,
    validate_workflow_admission,
    workflow_admission,
)
from ask_metric.application.workflow_evidence import bind_ranked_scope
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import AnalysisPlan
from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
)
from ask_metric.infrastructure.model.workflow_vectors import MilvusWorkflowIndex

pytest_plugins = ["test_general_analysis"]
CATALOG = load_workflows(Path(__file__).parents[1] / "config" / "analysis-workflows.json")


def prepared(service, actor, **changes):
    service.workflow_catalog = lambda: CATALOG
    return AnalysisPlan.model_validate(profitability_plan(
        "各家农商行近期哪个机构收益不好？为什么？", semantics=service.semantics(actor),
        catalog=CATALOG, parameters={"position": "bottom", "top_n": 1, "explain": True, **changes},
    )["plan"])


@pytest.mark.parametrize("count", [2, 10, 20, 61])
@pytest.mark.parametrize("position", ["top", "bottom"])
def test_ranked_result_binds_selected_institution_and_date(general_environment, count, position):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, count)
    value = service.execute(request(prepared(service, actor, position=position), org_codes=codes),
                            actor, "workflow")
    source_code = codes[-1] if position == "top" else codes[0]
    assert value["workflow_brief"]["selected_org_codes"] == [source_code]
    assert value["workflow_brief"]["coverage"]["valid_org_count"] == count
    trace = {step["id"]: step for step in value["workflow_execution"]["steps"]}
    assert trace["rank"]["org_count"] == count
    assert trace["rank"]["fact_count"] == count
    assert trace["selected_drivers"]["org_count"] == 1
    assert trace["selected_drivers"]["actual_dates"] == [value["analysis_date"]]
    state = service._read_run(actor, value["run_ref"])
    assert state["result"]["workflow_execution"] == value["workflow_execution"]
    for step_id in ["selected_history", "selected_drivers"]:
        result = state["completed_steps"][step_id]
        assert {f["org_code"] for f in result["facts"]} == {source_code}
        current_dates = {f["date"] for f in result["facts"] if f["role"] == "current"}
        assert current_dates == {value["analysis_date"]}
    queries = len(source.calls)
    assert service.execute(request(prepared(service, actor, position=position), org_codes=codes),
                           actor, "workflow") == value
    assert len(source.calls) == queries
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], fallback=True,
    ))
    assert "完整文字分析尚未完成" not in report["public_answer"]
    assert "净利润" in report["public_answer"]
    assert "具体业务原因" in report["public_answer"]


def test_exact_missing_date_is_a_coverage_result_not_an_execution_error(general_environment):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 10)
    value = service.execute(request(
        prepared(service, actor), org_codes=codes, date_selection="exact",
        start=date(2026, 6, 30), end=date(2026, 6, 30),
    ), actor, "no-data")
    assert value["status"] == "succeeded"
    assert value["actual_dates"] == []
    assert value["workflow_brief"]["outcome"] == "no_data"
    assert value["requested_end"] == "2026-06-30"
    assert not value["workflow_brief"]["selected_org_codes"]
    trace = value["workflow_execution"]["steps"]
    assert trace[0]["status"] == "no_data"
    assert all(s["status"] == "skipped_no_data" for s in trace[1:])
    assert all("error_code" not in s for s in trace)
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], fallback=True,
    ))
    assert "2026-06-30" in report["public_answer"]
    assert "缺失不等于零" in report["public_answer"]
    assert "模型" not in report["public_answer"]


def test_supplement_timeout_keeps_ranking_and_other_supplement(general_environment, monkeypatch):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 20)
    original = service._execute_step

    def execute(context, step):
        if step.id == "selected_history":
            raise TimeoutError("private diagnostic")
        return original(context, step)

    monkeypatch.setattr(service, "_execute_step", execute)
    value = service.execute(request(prepared(service, actor), org_codes=codes), actor, "timeout")
    assert value["workflow_brief"]["outcome"] == "answered"
    assert value["workflow_brief"]["selected_org_codes"] == [codes[0]]
    assert not value["complete"]
    assert next(s for s in value["workflow_execution"]["steps"]
                if s["id"] == "selected_history")["status"] == "failed"
    assert any(a.get("metric_code") == "income" for a in value["evidence_items"])
    assert "private diagnostic" not in str(value)


def test_ranking_failure_is_not_described_as_no_data(general_environment, monkeypatch):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    def unavailable(*args):
        raise TimeoutError()

    monkeypatch.setattr(service, "_execute_step", unavailable)
    value = service.execute(
        request(prepared(service, actor), org_codes=codes), actor, "unavailable"
    )
    assert value["workflow_brief"]["outcome"] == "unavailable"
    assert value["workflow_execution"]["steps"][0]["status"] == "failed"


@pytest.mark.parametrize("failure", ["failed_query", "budget"])
def test_incomplete_query_or_budget_is_not_no_data(general_environment, monkeypatch, failure):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    if failure == "failed_query":
        monkeypatch.setattr(service.execution, "execute", lambda command: SimpleNamespace(
            status="failed", truncated=False, error_code="QUERY_TIMEOUT"))
    else:
        original = service._execute_step
        def expired(context, step):
            context["deadline"] = 0
            return original(context, step)
        monkeypatch.setattr(service, "_execute_step", expired)
    value = service.execute(request(prepared(service, actor), org_codes=codes), actor, failure)
    assert value["workflow_brief"]["outcome"] == "unavailable"
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], fallback=True,
    ))
    assert "不代表数据库没有数据" in report["public_answer"]


@pytest.mark.parametrize("literal_first", [True, False])
def test_repeated_literal_and_same_value_reference_display_once(general_environment, literal_first):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    analysis_plan = prepared(service, actor, explain=False).model_copy(update={"workflow_id": None})
    value = service.execute(request(analysis_plan, org_codes=codes),
                            actor, f"duplicate-{literal_first}")
    atom = next(a for a in value["evidence_items"] if a["type"] == "fact")
    literal, placeholder = f"**{atom['display']}**", "{{" + atom["ref"] + "}}"
    text = literal + placeholder if literal_first else placeholder + literal
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], summary="净利润为" + text + "。",
    ))
    assert report["report"]["summary"].count(atom["display"]) == 1
    assert atom["ref"] in report["report"]["body_evidence"][0]["evidence_refs"]


def test_profit_point_values_cannot_prove_profit_conversion(general_environment):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    analysis_plan = prepared(service, actor, explain=False).model_copy(update={"workflow_id": None})
    value = service.execute(request(analysis_plan, org_codes=codes), actor, "cause")
    atom = next(a for a in value["evidence_items"] if a["type"] == "fact")
    with pytest.raises(ApplicationError) as failure:
        compose_analysis_report(service, actor, AnalysisReportRequest(
            run_refs=[value["run_ref"]], summary="营业利润与净利润差距较小，"
            "说明税后利润基本由营业利润转化而来{{" + atom["ref"] + "|cite}}。",
        ))
    assert failure.value.code == "ANALYSIS_REPORT_CAUSE"


@pytest.mark.parametrize("claim", [
    "营业支出规模较大，占营业收入的比重较高。",
    "是三家中唯一同比增长的机构。",
    "营收规模是其净利润领先的重要基础。",
    "海安本月环比增幅在三家中最大，盈利保持稳健。",
])
def test_pilot_does_not_invent_thresholds_growth_rank_or_causality(general_environment, claim):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    value = service.execute(request(prepared(service, actor), org_codes=codes), actor, "claims")
    atom = next(a for a in value["evidence_items"] if a["type"] == "fact")
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], summary=claim + "{{" + atom["ref"] + "|cite}}",
    ))
    assert claim not in report["public_answer"]
    assert report["report"]["delivery_mode"] == "registered_workflow"
    fallback = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], summary="### 排名结果\n\n" + claim, fallback=True,
    ))
    assert claim not in fallback["public_answer"]
    assert "净利润" in fallback["report"]["summary"]
    assert "营业收入" in fallback["report"]["summary"]
    assert all(o["type"] == "comparison" for o in value["workflow_brief"]["comparisons"])


def test_registered_route_cannot_be_relabelled_with_other_metrics(general_environment):
    service, actor, _, _ = general_environment
    plan = prepared(service, actor)
    mutated = plan.model_dump()
    mutated["steps"][0]["metric_refs"] = [next(
        m["binding_ref"] for m in service.semantics(actor).search("营业收入金额当日数")["items"]
    )]
    with pytest.raises(ApplicationError) as failure:
        service.validate_plan(AnalysisPlan.model_validate(mutated), actor)
    assert failure.value.code == "ANALYSIS_WORKFLOW_PLAN_INVALID"


def test_single_institution_does_not_claim_cross_institution_ranking(general_environment):
    service, actor, _, _ = general_environment
    value = service.execute(request(prepared(service, actor)), actor, "single")
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], summary="这家银行利润全省最低。",
    ))
    assert "无法据此比较机构之间" in report["report"]["summary"]
    assert "全省最低" not in report["public_answer"]


def test_result_binding_cannot_select_an_unrelated_organization(general_environment):
    service, actor, _, _ = general_environment
    context = {"org_codes": ["allowed"], "state": {"completed_steps": {"rank": {
        "facts": [{"fact_id": "f1", "org_code": "other", "date": "2026-07-31"}],
        "observations": [{"type": "ranking", "org_code": "other", "date": "2026-07-31",
                          "fact_refs": ["f1"]}],
    }}}}
    with pytest.raises(ApplicationError, match="排名来源"):
        bind_ranked_scope(context, "rank")


def test_result_binding_requires_a_real_preceding_ranking(general_environment):
    service, actor, _, _ = general_environment
    plan = prepared(service, actor).model_dump()
    plan["steps"][1]["organization_from_step"] = "selected_drivers"
    with pytest.raises(ValidationError):
        AnalysisPlan.model_validate(plan)


@pytest.mark.parametrize("question", [
    "哪家银行资产收益率最低？", "各行明年利润预计谁最高？", "不要查利润，贷款最多是哪家？",
    "全省净利润和存款对比分析", "哪个机构净利润下降最多？", "每个月净利润最低的银行？",
    "各行营业收入排名", "紫金净利润怎么样？", "净利润最高和最低都列出来", "全省成本收入比最低是谁",
])
def test_uncovered_tasks_do_not_get_swallowed_by_pilot(question):
    assert pilot_parameters(question) is None


@pytest.mark.parametrize("token,count", [
    ("三", 3), ("两", 2), ("十一", 11), ("二十", 20), ("61", 61), ("一百", 100),
])
def test_rank_count_keeps_whole_number(token, count):
    question = f"各家农商行七月末净利润最高的前{token}家，分析一下原因"
    assert pilot_parameters(question) == {"position": "top", "top_n": count, "explain": True}
    assert route_focus(question) == "各家农商行净利润最高的前N家，分析一下原因"


@pytest.mark.parametrize("question", [
    "各家农商行近期哪个机构收益不好？为什么？",
    "2026年8月31日各家农商行哪家净利润最低？为什么？",
    "请帮我查询近期各家农商行哪家净利润最低？",
])
def test_explicit_cohort_is_bound_before_model_proposal(question):
    assert workflow_admission(question) == {"organization_expression": "各家农商行"}


def test_regional_subset_is_not_expanded_to_all_authorized_banks():
    assert workflow_admission("南京各家农商行哪家净利润最低") is None
    assert pilot_parameters("各家农商行排除紫金后谁净利润最高") is None


@pytest.mark.parametrize("requested,allowed,expected", [
    (2, ["A", "B", "ROOT"], True), (3, ["A", "B", "ROOT"], True),
    (20, ["A", "B", "ROOT"], False), (3, ["A"], False),
])
def test_numbered_scope_must_match_actual_authorized_cohort(
    general_environment, requested, allowed, expected,
):
    _, actor, _, _ = general_environment
    snapshot = OrganizationHierarchySnapshot(nodes=(
        OrganizationHierarchyNode("ROOT", "合成省级汇总", None, "1"),
        OrganizationHierarchyNode("A", "合成机构甲", "ROOT", "3"),
        OrganizationHierarchyNode("B", "合成机构乙", "ROOT", "3"),
    ))
    admission = workflow_admission(f"{requested}家机构哪个近期净利润最差")
    assert admission["expected_org_count"] == requested
    result = validate_workflow_admission(
        admission, actor=actor,
        organizations=[SimpleNamespace(code=n.code, name=n.name) for n in snapshot.nodes],
        permissions=SimpleNamespace(authorized_org_codes=lambda **_: set(allowed)),
        hierarchy=SimpleNamespace(strict_snapshot=lambda: snapshot),
    )
    assert (result is not None) == expected
    if result:
        assert result["numbered_cohort"] is True


def test_numbered_scope_keeps_qualifiers_and_does_not_use_top_n_as_scope():
    assert workflow_admission("南京61家机构哪个净利润最低") is None
    assert workflow_admission("净利润最高的前20家机构") == {}


def test_formal_comparisons_do_not_duplicate_history_queries():
    names = ["净利润金额当日数", "净利润金额较上月", "净利润金额较同期"]
    semantics = SimpleNamespace(items={str(i): SimpleNamespace(code=str(i), name=n, unit="元")
                                     for i, n in enumerate(names)})
    semantics.descriptor = lambda code: {"code": code, "name": names[int(code)]}
    semantics.binding = lambda descriptor, name: descriptor["code"]
    value = profitability_plan("哪家净利润最低为什么", semantics=semantics, catalog=CATALOG,
                               parameters={"position": "bottom", "top_n": 1, "explain": True})
    assert [s["id"] for s in value["plan"]["steps"]] == ["rank", "selected_drivers"]


@pytest.mark.parametrize("top_n", [3, 10, 20])
def test_multiple_ranked_institutions_all_bind_and_survive_fallback(general_environment, top_n):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 61)
    value = service.execute(request(prepared(service, actor, top_n=top_n), org_codes=codes),
                            actor, f"many-{top_n}")
    selected = set(codes[:top_n])
    assert set(value["workflow_brief"]["selected_org_codes"]) == selected
    state = service._read_run(actor, value["run_ref"])
    assert {
        f["org_code"] for f in state["completed_steps"]["selected_drivers"]["facts"]
    } == selected
    report = compose_analysis_report(service, actor, AnalysisReportRequest(
        run_refs=[value["run_ref"]], fallback=True,
    ))
    for code in selected:
        name = next(f["org_name"] for f in value["evidence_items"] if f.get("org_code") == code)
        assert name in report["report"]["summary"]


def test_retrieval_confidence_and_rerank_shape_are_required():
    index = SimpleNamespace(search=lambda **_: CATALOG["documents"])
    scores = [{"index": i, "relevance_score": 0.9 if i == 0 else 0.1}
              for i in range(len(CATALOG["documents"]))]
    model = SimpleNamespace(rerank=lambda **_: scores)
    route = retrieve_workflow("各行哪家利润最低为什么", index=index, model=model,
                              catalog=CATALOG)
    assert route["status"] == "matched"
    assert route["retrieval"] == {
        "strategy": "embedding_milvus_rerank",
        "matched_document": {"id": CATALOG["documents"][0]["id"],
                             "text": CATALOG["documents"][0]["text"]},
        "rerank_score": 0.9, "other_class_score": 0.1,
        "min_score": 0.5, "min_margin": 0.04,
    }
    scores[0]["relevance_score"] = 0.12
    assert retrieve_workflow("各行哪家利润最低为什么", index=index, model=model,
                             catalog=CATALOG)["status"] == "fallback"
    scores[0]["index"] = 1
    assert retrieve_workflow("各行哪家利润最低为什么", index=index, model=model,
                             catalog=CATALOG)["reason"] == "invalid_rerank"


def test_milvus_contract_and_corpus_version_do_not_store_questions():
    calls = []

    def handle(request):
        import json
        body = json.loads(request.content)
        calls.append((request.url.path, body))
        if request.url.path.endswith("/has"):
            data = {"has": False}
        elif request.url.path.endswith("/search"):
            data = [{"document_id": "profit-rank-cause"}]
        else:
            data = {}
        return httpx.Response(200, json={"code": 0, "data": data})

    model = SimpleNamespace(embed=lambda texts: [[1.0] * 1024 for _ in texts],
                            embedding_cache_key=lambda: "bge-m3-version")
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        index = MilvusWorkflowIndex(uri="http://milvus.test", token="", collection="routes",
                                    client=client)
        for version in ["one", "two"]:
            result = index.search(model=model, documents=deepcopy(CATALOG["documents"]),
                                  version=version, query="private-question")
            assert result[0]["id"] == "profit-rank-cause"
    creates = [body for path, body in calls if path.endswith("/create")]
    assert creates[0]["params"]["max_length"] == "128"
    upserts = [body for path, body in calls if path.endswith("/upsert")]
    assert upserts[0]["data"][0]["revision"] != upserts[1]["data"][0]["revision"]
    assert "private-question" not in str(upserts)
