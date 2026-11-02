"""报告比较结论契约；合成证据只用于隔离校验测试。"""

from contextlib import nullcontext
from copy import deepcopy
from types import SimpleNamespace

import pytest

from ask_metric.application.analysis_report import AnalysisReportRequest, compose_analysis_report
from ask_metric.application.verified_findings import (
    attach_analysis_findings,
    attach_overview_findings,
)
from ask_metric.core.errors import ApplicationError


def evidence(comparison="3", personal_comparison=None):
    metrics = [
        ("total", "各项存款余额当日数", "100", None),
        ("total_mom", "各项存款余额较上月", comparison, "较上月"),
        ("personal", "个人存款余额当日数", "60", None),
        ("corporate", "对公存款余额当日数", "40", None),
    ]
    if personal_comparison is not None:
        metrics.append(("personal_mom", "个人存款余额较上月", personal_comparison, "较上月"))
    descriptors = [
        {"binding_ref": code, "code": code, "name": name, "value_basis": basis}
        for code, name, _value, basis in metrics
    ]
    atoms = [
        {
            "ref": code,
            "type": "fact",
            "value": value,
            "display": f"{value}元",
            "metric_code": code,
            "metric_name": name,
            "date": "2026-08-27",
            "org_code": "O1",
            "org_name": "测试机构",
        }
        for code, name, value, _ in metrics
    ]
    return attach_analysis_findings(
        {
            "run_ref": "run-1",
            "scope_id": "scope-1",
            "conversation_id": "session-1",
            "status": "succeeded",
            "org_codes": ["O1"],
            "org_names": ["测试机构"],
            "date_selection": "exact",
            "requested_start": "2026-08-27",
            "requested_end": "2026-08-27",
            "analysis_date": "2026-08-27",
            "checked_on": "2026-10-25",
            "actual_dates": ["2026-08-27"],
            "metric_descriptors": descriptors,
            "evidence_items": atoms,
            "plan": {
                "objective": "核实存款变化",
                "requirements": [{"id": "q1", "question": "存款如何变化"}],
                "steps": [
                    {
                        "id": "s1",
                        "method": "observe",
                        "answers": ["q1"],
                        "metric_refs": [code for code, *_ in metrics],
                    }
                ],
            },
            "gaps": [],
            "limitations": [],
            "defaults_applied": [],
            "observations": [],
            "rows": [],
            "columns": [],
            "tasks": [],
            "complete": True,
            "requirement_dispositions": [],
            "source_notice": "隔离测试证据",
        }
    )


def report(body, *, source=None, sections=None, fallback=False, organizations=(), bindings=None):
    source = source or evidence()
    semantics = SimpleNamespace(
        resolve=lambda _ref: None,
        items={
            item["code"]: SimpleNamespace(name=item["name"])
            for item in source["metric_descriptors"]
        },
    )
    service = SimpleNamespace(
        authorized_evidence=lambda _actor, _ref: deepcopy(source),
        semantics=lambda _actor: semantics,
        tasks=SimpleNamespace(uow_factory=lambda: nullcontext(SimpleNamespace(
            organization_catalog=SimpleNamespace(list_enabled=lambda: organizations),
        ))),
    )
    return compose_analysis_report(
        service,
        object(),
        AnalysisReportRequest(
            run_refs=["run-1"],
            summary=body,
            fact_bindings=bindings or [],
            sections=sections or [],
            fallback=fallback,
        ),
    )


@pytest.mark.parametrize("body", [
    "存款余额保持增长，较上月多{{total_mom}}。",
    "从总量看存款在增长{{total_mom|cite}}，个人存款占有较大份额，余额为{{personal}}。",
    "存款增长的原因需要继续核实，现有比较结果为{{total_mom}}。",
])
def test_natural_business_narrative_does_not_require_fixed_direction_grammar(body):
    result = report(body)
    assert result["status"] == "succeeded"
    assert body.split("{{")[0] in result["report"]["summary"]
    assert not result.get("narrative_repaired")


@pytest.mark.parametrize("value,direction", [("3", "增加"), ("0", "持平"), ("-3", "减少")])
def test_server_verified_finding_is_rendered_with_its_actual_direction(value, direction):
    source = evidence(comparison=value)
    finding = source["verified_findings"]["items"][0]
    result = report("{{" + finding["ref"] + "}}", source=source)
    assert result["report"]["summary"] == f"各项存款余额较上月{direction}。"
    assert any(item["evidence_refs"] == sorted([finding["ref"], "total_mom"])
               for item in result["report"]["body_evidence"])


@pytest.mark.parametrize(
    "body",
    [
        "各项存款余额较上月增加{{total_mom}}。",
        "各项存款余额较上月增加3元{{total_mom|cite}}。",
        "当前余额为{{personal}}，缺少比较数据，不能认定各类均增长。",
        "尚无法判断个人存款是否增长，需要补充比较数据。",
        "各类是否全部下降，尚需核实。",
    ],
)
def test_verified_values_and_explicit_limits_remain_available(body):
    assert report(body)["status"] == "succeeded"


def test_fallback_drops_unverified_heading_and_keeps_verified_facts():
    result = report("**总量与分类均呈增长**\n\n当前余额为{{total}}。", fallback=True)
    assert "分类均呈增长" not in result["public_answer"]
    assert "各项存款余额当日数为100元。" in result["public_answer"]
    assert result["public_answer"].count("100元") == 1
    assert "100元" in result["public_answer"]
    assert result["partial_analysis"] is False


@pytest.mark.parametrize(
    "body,value",
    [
        ("较上月减少3元{{total_mom|cite}}。", "-3"),
        ("较上月减少{{total_mom}}。", "-3"),
    ],
)
def test_negative_comparison_keeps_valid_absolute_amount_expression(body, value):
    assert report(body, source=evidence(comparison=value))["status"] == "succeeded"


@pytest.mark.parametrize(
    "body,expected",
    [
        ("较上月减少约{{total_mom}}。", "较上月减少约3元。"),
        ("较上月减少约 **{{total_mom}}**。", "较上月减少约 **3元**。"),
        ("较上月减少约为{{total_mom}}。", "较上月减少约为3元。"),
        ("较上月减少了{{total_mom}}。", "较上月减少了3元。"),
    ],
)
def test_negative_comparison_connectors_render_absolute_amount(body, expected):
    result = report(body, source=evidence(comparison="-3"))
    assert result["report"]["summary"] == expected


def test_numeric_formatting_preserves_negative_balance_sign():
    source = evidence()
    atom = next(item for item in source["evidence_items"] if item["ref"] == "total")
    atom.update(value="-100", display="-100元")
    result = report("余额下降到{{total}}，当前余额下降{{total}}。", source=source)
    assert result["report"]["summary"] == "余额下降到-100元，当前余额下降-100元。"


def test_negative_balance_cannot_authorize_an_unsigned_table_value():
    source = evidence()
    atom = next(item for item in source["evidence_items"] if item["ref"] == "total")
    atom.update(value="-100", display="-100元")
    with pytest.raises(ApplicationError) as caught:
        report("| 指标 | 余额 |\n|---|---|\n| 各项存款 | 100元{{total|cite}} |", source=source)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("heading", ["**增长情况分析**", "## 增长情况分析"])
def test_neutral_heading_does_not_assert_direction(heading):
    assert report(heading + "\n\n当前余额为{{total}}。")["status"] == "succeeded"


@pytest.mark.parametrize(
    "body",
    [
        "较上月增加 **{{total_mom}}**。",
        "较上月**增加**{{total_mom}}。",
        "各类都增长了吗？",
        "个人存款增长与否尚未确认。",
    ],
)
def test_emphasis_and_postposed_questions_remain_available(body):
    assert report(body)["status"] == "succeeded"


def test_natural_count_and_comparison_do_not_create_implicit_evidence():
    body = "两类存款中，个人存款余额较高。"
    result = report(body)
    assert result["report"]["summary"] == body
    assert result["report"]["body_evidence"] == [{"paragraph": 1, "evidence_refs": []}]
    assert result["narrative_repaired"] is False


def test_fallback_preserves_finding_facts_without_repeating_the_same_direction():
    source = evidence()
    finding = source["verified_findings"]["items"][0]
    body = "{{" + finding["ref"] + "}}，即所有分类都在增长。"
    result = report(body, source=source, fallback=True)
    assert result["partial_analysis"] is False
    assert "所有分类都在增长" not in result["public_answer"]
    assert result["report"]["summary"].count("较上月增加") == 1
    assert "较上月增加3元" in result["report"]["summary"]
    assert any(item["evidence_refs"] == ["total_mom"]
               for item in result["report"]["body_evidence"])


def institution_evidence():
    source = evidence(comparison="-3.25")
    first = next(atom for atom in source["evidence_items"] if atom["ref"] == "total_mom")
    first["org_name"] = "测试甲农村商业银行"
    first["display"] = "-3.25亿元"
    second = dict(
        first,
        ref="other_mom",
        org_code="O2",
        org_name="测试乙农村商业银行",
        value="-1.50",
        display="-1.50亿元",
    )
    source["evidence_items"].append(second)
    source["org_codes"] = ["O1", "O2"]
    source["org_names"] = [first["org_name"], second["org_name"]]
    for atom in source["evidence_items"]:
        if atom.get("org_code") == "O1" and atom["type"] == "fact":
            atom["org_name"] = first["org_name"]
    return source


@pytest.mark.parametrize("body", [
    "2026-08-27，测试甲行存款是全省下降的最主要来源。",
    "2026-08-26，测试甲农村商业银行各项存款余额较上月减少999亿元。",
    "{{total_mom}}{{other_mom}}，说明各机构都在下降。",
])
def test_fallback_uses_complete_evidence_instead_of_guessing_facts_from_bad_prose(body):
    source = institution_evidence()
    result = report(body, source=source, fallback=True)
    summary = result["report"]["summary"]
    assert "测试甲农村商业银行：-3.25亿元" in summary
    assert "测试乙农村商业银行：-1.50亿元" in summary
    assert "个人存款余额当日数" in summary
    assert "999" not in summary and "最主要来源" not in summary
    assert result["partial_analysis"] is True  # 第二家机构没有余额及分类数据。
    refs = {ref for item in result["report"]["body_evidence"] for ref in item["evidence_refs"]}
    assert {"total_mom", "other_mom", "personal", "corporate"} <= refs
    assert result["evidence_items"] == source["evidence_items"]


@pytest.mark.parametrize("body", ["{{missing}}", "{{total_mom}}{{missing}}"])
def test_fallback_rejects_unknown_references_even_with_other_valid_facts(body):
    with pytest.raises(ApplicationError) as caught:
        report(body, source=institution_evidence(), fallback=True)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_fallback_does_not_choose_between_conflicting_facts_with_same_identity():
    source = institution_evidence()
    original = next(atom for atom in source["evidence_items"] if atom["ref"] == "total_mom")
    source["evidence_items"].append(dict(original, ref="conflicting", value="-8", display="-8亿元"))
    with pytest.raises(ApplicationError) as caught:
        report("各机构下降。", source=source, fallback=True)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


@pytest.mark.parametrize("direction", ["降", "减"])
def test_existing_short_direction_words_keep_correct_negative_comparison(direction):
    result = report(f"各项存款较上月{direction}" + "{{total_mom}}。", source=evidence("-3"))
    assert f"较上月{direction}3元" in result["public_answer"]


def test_verified_literal_and_reference_have_same_coverage_and_completion():
    literal = report("当前余额为100元{{total|cite}}。")
    reference = report("当前余额为{{total}}。")
    assert literal["public_answer"] == reference["public_answer"]
    assert literal["partial_analysis"] is False
    assert literal["report"]["requirement_coverage"] == reference["report"]["requirement_coverage"]
    assert literal["report"]["body_evidence"] == reference["report"]["body_evidence"]


def test_literal_binding_matches_complete_value_instead_of_numeric_suffix():
    source = evidence()
    other = next(atom for atom in source["evidence_items"] if atom["ref"] == "personal")
    other.update(value="1100", display="1100元")
    literal = report("当前余额为100元{{total|cite}}。", source=source)
    reference = report("当前余额为{{total}}。", source=source)
    assert literal["partial_analysis"] is False
    assert literal["report"]["body_evidence"] == reference["report"]["body_evidence"]
    assert literal["report"]["requirement_coverage"] == reference["report"]["requirement_coverage"]


@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("already_in_body", [False, True])
def test_report_gap_is_visible_once_in_summary_and_public_answer(fallback, already_in_body):
    source = evidence()
    gap = "部分请求机构未取得有效值。"
    source.update(gaps=[gap, gap], complete=False)
    body = "当前余额为{{total}}。" + ("\n\n" + gap if already_in_body else "")
    result = report(body, source=source, fallback=fallback)
    assert result["report"]["summary"].count(gap) == 1
    assert result["public_answer"].count(gap) == 1
    assert result["gaps"] == [gap]
    assert result["partial_analysis"] is True


def test_recovery_keeps_comparison_value_without_repeating_official_judgment():
    source = evidence()
    result = report("各机构均下降。", source=source, fallback=True)
    assert result["report"]["summary"].count("较上月增加") == 1
    assert "较上月增加3元" in result["report"]["summary"]
    assert "已核验比较判断" not in result["report"]["summary"]
    assert "。。" not in result["public_answer"]


def test_literal_binding_does_not_cover_unanswered_second_requirement():
    source = evidence()
    source["plan"]["requirements"] = [
        {"id": "q1", "question": "余额是多少"}, {"id": "q2", "question": "个人存款是多少"},
    ]
    source["plan"]["steps"] = [
        {"id": "s1", "method": "observe", "answers": ["q1"],
         "metric_refs": ["total", "total_mom", "corporate"]},
        {"id": "s2", "method": "observe", "answers": ["q2"], "metric_refs": ["personal"]},
    ]
    with pytest.raises(ApplicationError) as caught:
        report("当前余额为100元{{total|cite}}。", source=source)
    assert caught.value.code == "ANALYSIS_REPORT_PROSE_COVERAGE"


@pytest.mark.parametrize("body", [
    "尚不能判断两项指标的方向是否一致。",
    "不能依据不同基期的数据，认定两项指标方向相反。",
])
def test_direction_relation_question_or_boundary_remains_available(body):
    assert report(body)["status"] == "succeeded"


@pytest.mark.parametrize("body", [
    "余额为{{total}}，尚不能认定规模处于较高水平。",
    "现有数值不能判断费用控制是否总体平稳。",
    "是否主动压降，需要结合实际管理措施核实。",
    "可以核实费用刚性是否相对较强。",
])
def test_evaluation_boundaries_and_verification_questions_remain_available(body):
    assert report(body)["status"] == "succeeded"


@pytest.mark.parametrize("body", [
    "费用控制是否总体平稳，需进一步核实。",
    "费用控制总体平稳与否尚需核实。",
    "不能依据不同基期的数据，认定两项指标方向相反。",
    "无法仅凭当前数值，判断费用控制总体平稳。",
])
def test_uncertainty_directly_governing_claim_remains_allowed(body):
    assert report(body)["status"] == "succeeded"


@pytest.mark.parametrize("fallback", [False, True])
def test_unreferenced_cyclic_or_missing_dependencies_are_hard_errors(fallback):
    for parents in [["cyclic"], ["missing"]]:
        source = evidence()
        source["evidence_items"].append({"ref": "cyclic", "type": "observation",
                                         "display": "依据不完整。", "input_refs": parents})
        with pytest.raises(ApplicationError) as caught:
            report("当前余额{{total}}。", source=source, fallback=fallback)
        assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_verified_comparison_uses_business_wording_and_keeps_shared_boundary():
    source = {"org_codes": ["O1"], "analysis_date": "2026-08-27", "evidence_items": [
        {"ref": "total.mom.difference", "value": "-2", "display": "-2元"},
        {"ref": "total.yoy.difference", "value": "3", "display": "3元"},
    ]}
    topic = {"metrics": [{"id": "total", "label": "各项存款"}], "relationships": []}
    result = attach_overview_findings(source, topic)
    findings = result["verified_findings"]["items"]
    divergence = next(item for item in findings if item["kind"] == "baseline_divergence")
    assert divergence["text"] == "截至2026-08-27，各项存款较上月减少、较同期增加。"
    assert "连续趋势" in result["verified_findings"]["boundary"]
    assert divergence["evidence_refs"] == ["total.mom.difference", "total.yoy.difference"]


@pytest.mark.parametrize("value", ["999元", "100万元"])
def test_table_still_rejects_unverified_numbers_and_units(value):
    body = "| 指标 | 余额 |\n|---|---|\n| 各项存款 | " + value + "{{total|cite}} |"
    with pytest.raises(ApplicationError) as caught:
        report(body)
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("day", [
    "2026-08-27", "2026年8月27日", "2026年08月27日", "8月27日", "08月27日",
])
def test_known_date_accepts_chinese_padding_and_month_day(day):
    result = report(f"截至{day}，余额为{{{{total}}}}。")
    assert result["status"] == "succeeded"
    assert result["narrative_repaired"] is False
    assert "余额为100元" in result["report"]["summary"]




def test_known_date_does_not_remove_an_unverified_business_number():
    with pytest.raises(ApplicationError) as caught:
        report(
            "截至2026年08月27日。\n\n"
            "| 指标 | 余额 |\n|---|---|\n| 各项存款 | 999元{{total|cite}} |"
        )
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"


@pytest.mark.parametrize("body", ["{{unknown}}", "存款增长{{unknown|cite}}。"])
def test_natural_narrative_still_rejects_unknown_references(body):
    with pytest.raises(ApplicationError) as caught:
        report(body)
    assert caught.value.code == "ANALYSIS_REPORT_REFERENCE"


def test_interpretation_cites_finding_without_reproducing_fixed_sentence():
    finding = evidence()["verified_findings"]["items"][0]["ref"]
    result = report("存款较上月有所增长{{" + finding + "|cite}}，当前余额为{{total}}。")
    assert result["report"]["summary"] == "存款较上月有所增长，当前余额为100元。"
    assert set(result["report"]["body_evidence"][0]["evidence_refs"]) >= {
        finding, "total_mom", "total",
    }


def test_section_heading_rejects_conflicting_duplicate_display():
    with pytest.raises(ApplicationError) as caught:
        report("余额为{{total}}。", sections=[{
            "title": "存款{{total}}（999元）", "text": "个人余额为{{personal}}。",
            "evidence_refs": ["personal"],
        }])
    assert caught.value.code == "ANALYSIS_REPORT_NUMBER"
