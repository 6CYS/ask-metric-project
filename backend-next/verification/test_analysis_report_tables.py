"""排名表的序号与行归属契约；合成回执仅用于隔离校验。"""

import pytest
from test_analysis_report_claims import institution_evidence, report

from ask_metric.core.errors import ApplicationError


def ranking_source():
    source = institution_evidence()
    step = source["plan"]["steps"][0]
    step.update(method="ranking", position="bottom", top_n=2)
    facts = [atom for atom in source["evidence_items"] if atom["ref"] in {"total_mom", "other_mom"}]
    for fact in facts:
        fact["fact_id"] = "fact-" + fact["ref"]
    inputs = [fact["ref"] for fact in facts]
    for rank, fact in enumerate(facts, 1):
        ref = f"rank-{rank}"
        source["observations"].append({
            "ref": ref, "type": "ranking", "metric": "total_mom", "step_id": "s1",
            "rank": rank, "position": "bottom", "date": fact["date"],
            "org_code": fact["org_code"], "fact_refs": [fact["fact_id"]],
            "comparison_fact_refs": [item["fact_id"] for item in facts],
        })
        source["evidence_items"].append({
            "ref": ref, "type": "observation", "judgment_kind": "ranking",
            "rank": rank, "position": "bottom", "date": fact["date"],
            "org_code": fact["org_code"], "input_refs": inputs, "step_ids": ["s1"],
            "display": f"本次机构集合内后序第{rank}位：{fact['org_name']}。",
        })
    return source


def table(first_rank="1", first_ref="total_mom", header="排名（后序）"):
    return (
        f"| {header} | 机构 | 各项存款余额较上月 |\n"
        "|---|---|---|\n"
        f"| {first_rank} | 测试甲农村商业银行 | {{{{{first_ref}}}}} |\n"
        "| 2 | 测试乙农村商业银行 | {{other_mom}} |"
    )


def test_verified_ranking_table_preserves_ordinals_and_includes_rank_evidence():
    result = report(table(), source=ranking_source())
    assert "| 1 | 测试甲农村商业银行 | -3.25亿元 |" in result["report"]["summary"]
    refs = set(result["report"]["body_evidence"][0]["evidence_refs"])
    assert {"rank-1", "rank-2", "total_mom", "other_mom"} <= refs


def cited_table(**kwargs):
    return table(**kwargs).replace("{{total_mom}}", "-3.25亿元{{total_mom|cite}}").replace(
        "{{other_mom}}", "-1.50亿元{{other_mom|cite}}"
    )


def test_cited_values_use_the_same_verified_ranking_as_display_references():
    result = report(cited_table(), source=ranking_source())
    assert "| 1 | 测试甲农村商业银行 | -3.25亿元 |" in result["report"]["summary"]
    refs = set(result["report"]["body_evidence"][0]["evidence_refs"])
    assert {"rank-1", "rank-2", "total_mom", "other_mom"} <= refs


@pytest.mark.parametrize("body", [
    cited_table(first_rank="2"),
    cited_table(header="排名（前序）"),
    cited_table(first_ref="other_mom"),
])
def test_citations_do_not_authorize_wrong_rank_direction_or_institution(body):
    with pytest.raises(ApplicationError) as caught:
        report(body, source=ranking_source())
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("missing_observation", [False, True])
def test_citations_require_rank_evidence_within_the_executed_top_n(missing_observation):
    source = ranking_source()
    if missing_observation:
        source["observations"] = []
    else:
        source["plan"]["steps"][0]["top_n"] = 1
    with pytest.raises(ApplicationError) as caught:
        report(cited_table(), source=source)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("body,code", [
    (table(first_rank="2"), "ANALYSIS_REPORT_NUMBER"),
    (table(header="排名（前序）"), "ANALYSIS_REPORT_NUMBER"),
    (table(first_ref="personal"), "ANALYSIS_REPORT_NUMBER"),
])
def test_wrong_rank_direction_and_metric_remain_rejected(body, code):
    with pytest.raises(ApplicationError) as caught:
        report(body, source=ranking_source())
    assert caught.value.code == code


def test_table_requires_actual_ranking_observation():
    source = ranking_source()
    source["observations"] = []
    with pytest.raises(ApplicationError) as caught:
        report(table(), source=source)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"






def test_ranking_for_another_date_cannot_authorize_table_ordinal():
    source = ranking_source()
    source["observations"][0]["date"] = "2026-08-26"
    with pytest.raises(ApplicationError) as caught:
        report(table(), source=source)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"




def test_ranking_table_requires_a_fact_reference_in_its_row():
    body = "| 机构 | 排名 |\n|---|---|\n| 测试甲农村商业银行 | 1 |"
    with pytest.raises(ApplicationError) as caught:
        report(body, source=ranking_source())
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


def test_natural_ordinal_does_not_create_implicit_ranking_evidence():
    result = report("测试甲农村商业银行位于本次后序第1位，{{total_mom}}。", source=ranking_source())
    assert "后序第1位" in result["report"]["summary"]
    refs = {ref for item in result["report"]["body_evidence"] for ref in item["evidence_refs"]}
    assert refs == {"total_mom"}
