"""隔离合成数据验证多机构、最近覆盖与整月逐期排名，不连接业务数据库。"""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from test_general_analysis import binding, plan, request

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.field_resolution import resolve_date_field
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
)
from ask_metric.infrastructure.db.models import OrgTerm

pytest_plugins = ["test_general_analysis"]


def multi(service, actor, sessions, source, count):
    codes = [f"R{index:03}" for index in range(count)]
    with sessions() as session:
        session.add_all(
            OrgTerm(org_code=code, org_name=f"合成行{index}") for index, code in enumerate(codes)
        )
        session.commit()
    actor = actor.model_copy(update={"role_code": "SYSTEM_ADMIN"})
    original = source.execute_readonly

    def execute(*, sql, parameters):
        result = original(sql=sql, parameters=parameters)
        if "require_all" in parameters:
            return result
        result.rows = [
            {
                **row,
                "org_code": code,
                "org_name": f"合成行{index}",
                "metric_value": Decimal(index - count),
            }
            for row in result.rows
            for index, code in enumerate(parameters["org_codes"])
        ]
        return result

    source.execute_readonly = execute
    return actor, codes


@pytest.mark.parametrize("count", [1, 2, 5, 10, 20, 61])
def test_recent_ranking_uses_all_institutions_and_latest_actual_date(general_environment, count):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, count)
    ref = binding(service, actor, "净利润金额当日数")
    payload = request(
        plan(
            ref,
            steps=[
                {
                    "id": "rank",
                    "method": "ranking",
                    "metric_refs": [ref],
                    "answers": ["performance"],
                    "rationale": "最低值",
                    "position": "bottom",
                    "top_n": 1,
                }
            ],
        ),
        org_codes=codes,
    )
    result = service.execute(payload, actor, f"all-{count}")
    assert result["actual_dates"] == ["2026-08-31"]
    assert len(result["rows"]) == count
    finding = result["verified_findings"]["items"][0]
    assert finding["kind"] == "ranking" and finding["org_code"] == codes[0]
    assert len(finding["evidence_refs"]) == count
    report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(run_refs=[result["run_ref"]], summary="{{" + finding["ref"] + "}}"),
    )
    assert report["row_count"] == count
    assert f"本期参与{count}家" in report["public_answer"]
    count_report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]], summary=f"本次有{count}家机构参与排名。"
        ),
    )
    assert f"本次有{count}家机构参与排名" in count_report["public_answer"]
    ordinal = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]], summary="为后序第1位。{{" + finding["ref"] + "|cite}}"
        ),
    )
    assert "为后序第1位" in ordinal["public_answer"]
    with pytest.raises(ApplicationError, match="未获本段证据支持"):
        compose_analysis_report(
            service,
            actor,
            AnalysisReportRequest(
                run_refs=[result["run_ref"]], summary="为后序第2位。{{" + finding["ref"] + "|cite}}"
            ),
        )
    with pytest.raises(ApplicationError, match="未获本段证据支持"):
        compose_analysis_report(
            service,
            actor,
            AnalysisReportRequest(
                run_refs=[result["run_ref"]], summary=f"本次有{count + 2}家机构参与排名。"
            ),
        )
    with pytest.raises(ApplicationError, match="未获本段证据支持"):
        compose_analysis_report(
            service,
            actor,
            AnalysisReportRequest(run_refs=[result["run_ref"]], summary=f"利润{count}亿元。"),
        )
    fallback = compose_analysis_report(
        service, actor, AnalysisReportRequest(run_refs=[result["run_ref"]], fallback=True)
    )
    assert "后序第1位" in fallback["report"]["sections"][0]["text"]


def test_whole_month_preserves_every_observation_and_batches_large_sets(general_environment):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 61)
    source.observations = [("profit", date(2026, 8, day), Decimal(day)) for day in range(1, 32)]
    ref = binding(service, actor, "净利润金额当日数")
    result = service.execute(
        request(
            plan(
                ref,
                steps=[
                    {
                        "id": "rank",
                        "method": "ranking",
                        "metric_refs": [ref],
                        "answers": ["performance"],
                        "rationale": "按日排序，不相加快照",
                        "position": "bottom",
                        "top_n": 1,
                    }
                ],
            ),
            org_codes=codes,
            date_selection="all_in_range",
            start=date(2026, 8, 1),
            end=date(2026, 8, 31),
        ),
        actor,
        "whole-month",
    )
    assert len(result["actual_dates"]) == 31
    assert len(result["rows"]) == 61 * 31
    rankings = [item for item in result["observations"] if item["type"] == "ranking"]
    assert len(rankings) == 31
    assert result["complete"]
    assert result["query_count"] > 1
    assert all(len(parameters["org_codes"]) == 61 for _, parameters in source.calls)


@pytest.mark.parametrize("word", ["近期", "最近", "近来", "最新", "这段时间"])
def test_unbounded_recent_never_accepts_model_today(word):
    result = resolve_date_field(
        word, date(2026, 10, 22), model_value={"start": "2026-10-22", "end": "2026-10-22"}
    )
    assert result["status"] == "invalid" and "value" not in result
    assert result["metadata"]["reason"] == "unsupported_expression"


def test_exact_date_still_remains_exact():
    result = resolve_date_field(
        "2026-08-31", date(2026, 10, 22), model_value={"start": "2026-10-22", "end": "2026-10-22"}
    )
    assert result["value"] == {"start": "2026-08-31", "end": "2026-08-31"}


def test_cohort_uses_hierarchy_provider_and_discloses_actual_count(general_environment):
    service, actor, sessions, source = general_environment
    actor, _ = multi(service, actor, sessions, source, 2)
    with sessions() as session:
        entries = session.query(OrgTerm).all()
        snapshot = OrganizationHierarchySnapshot(
            nodes=tuple(
                OrganizationHierarchyNode(
                    item.org_code,
                    item.org_name,
                    None if item.org_code == "O1" else "O1",
                    "1" if item.org_code == "O1" else "3",
                )
                for item in entries
            )
        )
    hierarchy = SimpleNamespace(strict_snapshot=lambda: snapshot)
    service.execution.org_hierarchy_provider = hierarchy
    # 与实际依赖装配一致：权限范围提供器没有 strict_snapshot，不能优先把它当层级。
    assert not hasattr(service.execution.organization_scope_provider, "strict_snapshot")
    with service.tasks.uow_factory() as uow:
        organizations = uow.organization_catalog.list_enabled()
    scope = {"kind": "authorized_cohort", "cohort": "rural_commercial_banks"}
    resolved = resolve_query_scope(
        scope=scope,
        actor=actor,
        organizations=organizations,
        permissions=service.execution.permission_service,
        hierarchy=hierarchy,
    )
    ref = binding(service, actor, "净利润金额当日数")
    result = service.execute(
        request(
            plan(
                ref,
                steps=[
                    {
                        "id": "rank",
                        "method": "ranking",
                        "metric_refs": [ref],
                        "answers": ["performance"],
                        "rationale": "集合排序",
                        "position": "bottom",
                        "top_n": 1,
                    }
                ],
            ),
            organization_scope=scope,
            scope_fingerprint=resolved["scope_fingerprint"],
            calculation_context={
                "scope_id": "cohort",
                "user_question": "61家机构哪个近期净利润最差",
            },
        ),
        actor,
        "cohort",
    )
    assert result["org_codes"] == resolved["codes"]
    assert len(result["rows"]) == 3
    assert any(
        "提及61家" in notice and "实际为3家" in notice for notice in result["defaults_applied"]
    )
    count_report = compose_analysis_report(
        service,
        actor,
        AnalysisReportRequest(
            run_refs=[result["run_ref"]], summary="## 61家机构净利润比较\n\n当前授权集合实际为3家。"
        ),
    )
    assert not count_report.get("partial_analysis")




def test_report_list_cannot_attribute_another_institutions_value(general_environment):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 2)
    names = dict(zip(codes, ["合成甲银行", "合成乙银行"], strict=True))
    with sessions() as session:
        for code, name in names.items():
            session.query(OrgTerm).filter(OrgTerm.org_code == code).update({"org_name": name})
        session.commit()
    original = source.execute_readonly

    def execute(*, sql, parameters):
        result = original(sql=sql, parameters=parameters)
        for row in result.rows:
            if row.get("org_code") in names:
                row["org_name"] = names[row["org_code"]]
                row["metric_value"] = Decimal((codes.index(row["org_code"]) + 1) * 100000000)
        return result

    source.execute_readonly = execute
    ref = binding(service, actor, "净利润金额当日数")
    result = service.execute(request(plan(ref, steps=[{
        "id": "rank", "method": "ranking", "metric_refs": [ref], "answers": ["performance"],
        "rationale": "比较完整集合", "position": "bottom", "top_n": 2,
    }]), org_codes=codes), actor, "list-owner")
    atoms = {atom["org_code"]: atom for atom in result["evidence_items"] if atom["type"] == "fact"}
    first, second = (atoms[code] for code in codes)
    prefix = "1. **合成甲银行**，净利润 "
    valid = AnalysisReportRequest(run_refs=[result["run_ref"]], summary=prefix + "{{" + first["ref"] + "}}")
    assert "1.00亿元" in compose_analysis_report(service, actor, valid)["report"]["summary"]
    comparison = valid.model_copy(update={
        "summary": "1. 合成甲银行与合成乙银行，对照值{{" + second["ref"] + "}}"
    })
    assert "2.00亿元" in compose_analysis_report(service, actor, comparison)["report"]["summary"]
    for text in [prefix + "{{" + second["ref"] + "}}", prefix + second["display"]]:
        with pytest.raises(ApplicationError) as failure:
            compose_analysis_report(service, actor, valid.model_copy(update={"summary": text}))
        assert failure.value.code in {"ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_NUMBER"}


def test_rank_ordinal_uses_verified_ranking_not_an_arbitrary_digit(general_environment):
    service, actor, sessions, source = general_environment
    actor, codes = multi(service, actor, sessions, source, 3)
    names = dict(zip(codes, ["合成甲银行", "合成乙银行", "合成丙银行"], strict=True))
    with sessions() as session:
        for code, name in names.items():
            session.query(OrgTerm).filter(OrgTerm.org_code == code).update({"org_name": name})
        session.commit()
    original = source.execute_readonly

    def execute(*, sql, parameters):
        result = original(sql=sql, parameters=parameters)
        for row in result.rows:
            if row.get("org_code") in names:
                row["org_name"] = names[row["org_code"]]
        return result

    source.execute_readonly = execute
    ref = binding(service, actor, "净利润金额当日数")
    result = service.execute(request(plan(ref, steps=[{
        "id": "rank", "method": "ranking", "metric_refs": [ref], "answers": ["performance"],
        "rationale": "核对名次", "position": "top", "top_n": 1,
    }]), org_codes=codes), actor, "verified-ordinal")
    judgment = next(
        atom for atom in result["evidence_items"] if atom.get("judgment_kind") == "ranking"
    )
    fact = next(atom for atom in result["evidence_items"] if atom["type"] == "fact"
                and atom["org_code"] == judgment["org_code"])
    body = (
        fact["org_name"] + "，净利润{{" + fact["ref"]
        + "}}，位列第1{{" + judgment["ref"] + "|cite}}。"
    )
    valid = AnalysisReportRequest(run_refs=[result["run_ref"]], summary=body)
    assert "位列第1" in compose_analysis_report(service, actor, valid)["report"]["summary"]
    spaced = valid.model_copy(update={"summary": body + "本次参与3 家。"})
    assert "3 家" in compose_analysis_report(service, actor, spaced)["report"]["summary"]
    other = next(atom for atom in result["evidence_items"] if atom["type"] == "fact"
                 and atom["org_code"] != judgment["org_code"])
    for invalid in [body.replace("位列第1", "位列第2"),
                    body.replace(fact["org_name"], other["org_name"]),
                    body.replace("位列第1", "位列第1次"),
                    body.replace("位列第1", "位列第1亿元"),
                    body.replace("位列第1", "位列第1名亿元"),
                    body + "本次参与3 元。",
                    body + "本次参与999 家。",
                    body.replace("位列第1", "位列第1，另有999亿元")]:
        with pytest.raises(ApplicationError) as failure:
            compose_analysis_report(service, actor, valid.model_copy(update={"summary": invalid}))
        assert failure.value.code == "ANALYSIS_REPORT_NUMBER"
