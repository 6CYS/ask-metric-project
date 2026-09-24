"""算法回归使用合成目录，不连接模型或业务数据库。"""
import pytest

from ask_metric.api.routes.tasks import _verify_metric_coverage
from ask_metric.application.catalog_sync import _build_metric_catalog
from ask_metric.application.metric_candidates import (
    MetricCandidateIndex,
    metric_candidate_index,
    unique_high_confidence_candidate,
)
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem


def catalog():
    return [
        MetricCatalogItem(code="D", name="贷款余额当日数"),
        MetricCatalogItem(code="T", name="各项贷款余额", aliases=["贷款余额"]),
        MetricCatalogItem(code="S", name="存款余额月日均", aliases=["存款日均"],
                          description="本月每天存款余额的平均值"),
        MetricCatalogItem(code="R", name="合成客户风险比率", aliases=["合成风险率"],
                          description="存在风险的客户占全部客户的比例"),
    ]


@pytest.mark.parametrize("question,expected", [
    ("查询省联社2026年3月31日贷款余额当日数。", "D"),
    ("查 存 款 日 均", "S"),
    ("贷款余额", "T"),
])
def test_exact_longest_and_alias(question, expected):
    result = MetricCandidateIndex(catalog()).mentions(question)
    assert len(result) == 1
    assert result[0]["resolution"]["status"] == "resolved"
    assert result[0]["resolution"]["value"]["codes"] == [expected]


@pytest.mark.parametrize("question,expected", [
    ("查询省联社2026年3月31日贷款讯额当日数", "D"),
    ("本月每天的存款平均值是多少", "S"),
    ("存在风险的客户占全部客户多少比例", "R"),
])
def test_low_confidence_typo_and_description_remain_candidates(question, expected):
    result = MetricCandidateIndex(catalog()).mentions(question)
    assert result
    candidates = [candidate for mention in result
                  for candidate in mention["resolution"].get("candidates", [])]
    assert expected in [candidate["code"] for candidate in candidates[:5]]
    assert all(mention["resolution"]["status"] != "resolved" for mention in result)


@pytest.mark.parametrize("question,expected", [
    ("贷款余额当日树", "D"),
    ("存款余鹅月日均", "S"),
    ("戴款余额当日数", "D"),
    ("合成客护风险比率", "R"),
])
def test_unique_high_confidence_homophone_is_resolved(question, expected):
    result = MetricCandidateIndex(catalog()).mentions(question)
    assert len(result) == 1
    assert result[0]["resolution"]["value"]["codes"] == [expected]
    assert result[0]["resolution"]["metadata"]["score"] >= .95


@pytest.mark.parametrize("scores,expected", [
    ([.949999], None), ([.95], "A"), ([.96, .95], "A"),
    ([.97, .97], None), ([1, 1], None), ([], None),
])
def test_threshold_boundary_and_ties(scores, expected):
    hits = [{"code": chr(65 + i), "value": "合成指标", "score": score}
            for i, score in enumerate(scores)]
    result = unique_high_confidence_candidate(hits)
    assert (result["code"] if result else None) == expected


def test_same_code_alias_hits_are_not_a_tie():
    assert unique_high_confidence_candidate([
        {"code": "A", "score": 1}, {"code": "A", "score": 1}, {"code": "B", "score": .8},
    ])["code"] == "A"


@pytest.mark.parametrize("name,raw,expected", [
    ("abcdefghijklmnopqrst", "abcdefghijklmnopqrsz", "resolved"),
    ("abcdefghijklmnopqrs", "abcdefghijklmnopqrz", "needs_confirmation"),
])
def test_full_fragment_score_at_and_below_threshold(name, raw, expected):
    index = MetricCandidateIndex([MetricCatalogItem(code="A", name=name)])
    result = index.resolve_candidates(raw, index.candidates(raw))
    assert result["status"] == expected
    if expected == "resolved":
        assert result["metadata"]["score"] == .95
    else:
        assert result["candidates"][0]["score"] < .95


def test_homophone_two_different_codes_stays_ambiguous():
    index = MetricCandidateIndex([
        MetricCatalogItem(code="A", name="合成客户余额"),
        MetricCatalogItem(code="B", name="合成客护余额"),
    ])
    resolution = index.mentions("合成客互余额")[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert {hit["code"] for hit in resolution["candidates"] if hit["score"] == 1} == {"A", "B"}


def test_question_tail_does_not_turn_exact_metric_into_fuzzy_longer_one():
    names = ["个人活期存款余额当日数", "活期存款余额当日数", "个人定期存款余额当日数",
             "个人活期存款余额占比当日数", "个人活期存款余额当日数排名"]
    index = MetricCandidateIndex([MetricCatalogItem(code=f"M{i}", name=name)
                                  for i, name in enumerate(names)])
    for tail in ["是多少？", "是多少呢", "是多少", "的数值"]:
        result = index.mentions("紫金农商行2026年3月末" + names[0] + tail)
        assert len(result) == 1
        assert result[0]["text"] == names[0]
        assert result[0]["resolution"]["value"]["codes"] == ["M0"]


def test_incomplete_second_metric_clarifies_full_user_phrase():
    items = [
        MetricCatalogItem(code="A", name="收单客户数量当日数"),
        MetricCatalogItem(code="C", name="其他客户数量", aliases=["客户数量"]),
        MetricCatalogItem(code="B1", name="个人贷记卡普通卡客户数量当日数"),
        MetricCatalogItem(code="B2", name="个人贷记卡普通卡客户数量较上月"),
    ]
    question = "紫金农商行4月末收单客户数量当日数、个人贷记卡普通卡客户数量是多少？"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert [item["text"] for item in mentions] == [
        "收单客户数量当日数", "个人贷记卡普通卡客户数量"
    ]
    assert mentions[0]["resolution"]["value"]["codes"] == ["A"]
    assert mentions[1]["resolution"]["status"] == "needs_confirmation"
    assert {candidate["code"] for candidate in mentions[1]["resolution"]["candidates"]} == {
        "B1", "B2"
    }


def test_prefix_segment_with_multiple_codes_needs_confirmation():
    items = [
        MetricCatalogItem(code="G1", name="保证金存款利息支出金额当日数"),
        MetricCatalogItem(code="G2", name="保证金存款利息支出金额较同期"),
        MetricCatalogItem(code="G3", name="保证金存款利息支出金额较上月增幅"),
    ]
    mentions = MetricCandidateIndex(items).mentions("保证金存款利息支出金额")
    assert len(mentions) == 1
    assert mentions[0]["text"] == "保证金存款利息支出金额"
    assert mentions[0]["source"]["kind"] == "catalog_name_prefix"
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert {c["code"] for c in resolution["candidates"]} == {"G1", "G2", "G3"}


def test_unique_prefix_segment_is_resolved():
    items = [
        MetricCatalogItem(code="U1", name="特种单位协定存款余额当日数"),
        MetricCatalogItem(code="U2", name="特种单位协定存款户数当日数"),
    ]
    mentions = MetricCandidateIndex(items).mentions("特种单位协定存款余额")
    assert len(mentions) == 1
    assert mentions[0]["source"]["kind"] == "catalog_name_prefix"
    assert mentions[0]["resolution"]["status"] == "resolved"
    assert mentions[0]["resolution"]["value"]["codes"] == ["U1"]


def test_prefix_segment_coexists_with_exact_mention():
    items = [
        MetricCatalogItem(code="A", name="收单客户数量当日数"),
        MetricCatalogItem(code="G1", name="保证金存款利息支出金额当日数"),
        MetricCatalogItem(code="G2", name="保证金存款利息支出金额较同期"),
    ]
    question = "紫金农商行4月末收单客户数量当日数、保证金存款利息支出金额"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert [item["text"] for item in mentions] == [
        "收单客户数量当日数", "保证金存款利息支出金额"
    ]
    assert mentions[0]["resolution"]["value"]["codes"] == ["A"]
    assert mentions[1]["resolution"]["status"] == "needs_confirmation"
    assert {c["code"] for c in mentions[1]["resolution"]["candidates"]} == {"G1", "G2"}
    assert all(question[m["start"]:m["end"]] == m["text"] for m in mentions)


def test_prefix_segment_shorter_than_four_chars_does_not_trigger():
    index = MetricCandidateIndex([MetricCatalogItem(code="P", name="净利润本年累计")])
    mentions = index.mentions("净利润")
    assert all(m.get("source", {}).get("kind") != "catalog_name_prefix" for m in mentions)
    assert all(m["resolution"]["status"] != "resolved" for m in mentions)


def test_prefix_must_cover_whole_segment():
    items = [
        MetricCatalogItem(code="G1", name="保证金存款利息支出金额当日数"),
        MetricCatalogItem(code="G2", name="保证金存款利息支出金额较同期"),
    ]
    # 尾带“是多少”使整段不再是名称前缀，段内子串不能触发前缀通道。
    mentions = MetricCandidateIndex(items).mentions("保证金存款利息支出金额是多少")
    assert all(m.get("source", {}).get("kind") != "catalog_name_prefix" for m in mentions)
    assert all(m["resolution"]["status"] != "resolved" for m in mentions)


def test_partial_substring_full_score_does_not_auto_select_wrong_metric():
    index = MetricCandidateIndex([MetricCatalogItem(code="A", name="甲乙丙丁")])
    resolution = index.resolve_candidates("甲乙丙丁戊己", index.candidates("甲乙丙丁戊己"))
    assert resolution["status"] == "needs_confirmation"
    assert resolution["candidates"][0]["score"] < .95


def test_duplicate_alias_and_name_never_overwritten():
    items = [MetricCatalogItem(code=code, name="合成指标全称", aliases=["共同别名"])
             for code in ["A", "B"]]
    index = MetricCandidateIndex(items)
    for text in ["合成指标全称", "共同别名"]:
        resolution = index.mentions(text)[0]["resolution"]
        assert resolution["status"] == "ambiguous"
        assert {c["code"] for c in resolution["candidates"]} == {"A", "B"}


def test_full_name_wins_over_ambiguous_embedded_alias():
    items = catalog() + [MetricCatalogItem(code="X", name="其他合成指标", aliases=["贷款余额"])]
    result = MetricCandidateIndex(items).mentions("查贷款余额当日数")
    assert len(result) == 1
    assert result[0]["resolution"]["value"]["codes"] == ["D"]


def test_short_alias_inside_unfinished_specific_name_needs_confirmation():
    # 复现原句：用户写“个人贷记卡普通卡客户数量”漏掉“当日数”，短别名“客户数量”不能被静默取值。
    items = [
        MetricCatalogItem(code="ACQ", name="收单客户数量当日数"),
        MetricCatalogItem(code="CUST", name="客户数量当日数", aliases=["客户数量"]),
        MetricCatalogItem(code="PSON", name="个人贷记卡普通卡客户数量当日数"),
    ]
    result = MetricCandidateIndex(items).mentions(
        "紫金农商行4月末收单客户数量当日数、个人贷记卡普通卡客户数量是多少？")
    by_text = {mention["text"]: mention["resolution"] for mention in result}
    # 第一项是完整名称，正常 resolved。
    assert by_text["收单客户数量当日数"]["status"] == "resolved"
    assert by_text["收单客户数量当日数"]["value"]["codes"] == ["ACQ"]
    # 第二项的“客户数量”是更长未说完整名称内部的短别名：降级为待确认，指向更具体编码，不误取 CUST。
    downgraded = next(res for text, res in by_text.items()
                      if "客户数量" in text and res["status"] != "resolved")
    assert downgraded["status"] == "needs_confirmation"
    assert "PSON" in {candidate["code"] for candidate in downgraded["candidates"]}
    assert all(mention["resolution"].get("value", {}).get("codes", []) != ["CUST"]
               for mention in result)


def test_same_code_short_alias_does_not_hide_unfinished_official_name():
    item = MetricCatalogItem(code="D", name="净利润本年累计", aliases=["净利润"])
    index = MetricCandidateIndex([item])
    incomplete = index.mentions("净利润本年累")
    assert len(incomplete) == 1
    assert incomplete[0]["text"] == "净利润本年累"
    assert incomplete[0]["resolution"]["status"] == "needs_confirmation"
    assert incomplete[0]["resolution"]["candidates"][0]["code"] == "D"
    assert index.mentions("净利润是多少")[0]["resolution"]["value"]["codes"] == ["D"]
    with pytest.raises(ApplicationError) as unresolved:
        _verify_metric_coverage("净利润本年累", ["D"], [item])
    assert unresolved.value.code == "METRIC_TARGETS_UNRESOLVED"


def test_crossing_names_are_ambiguous_instead_of_selecting_the_longer_one():
    index = MetricCandidateIndex([
        MetricCatalogItem(code="A", name="甲乙丙"),
        MetricCatalogItem(code="B", name="乙丙丁戊"),
    ])
    result = index.mentions("查甲乙丙丁戊")
    assert len(result) == 1
    assert result[0]["resolution"]["status"] == "ambiguous"
    assert {hit["code"] for hit in result[0]["resolution"]["candidates"]} == {"A", "B"}


def test_exact_and_typo_in_same_question_keep_both_groups():
    result = MetricCandidateIndex(catalog()).mentions("贷款余额当日数和存款余鹅月日均")
    assert len(result) == 2
    assert result[0]["resolution"]["value"]["codes"] == ["D"]
    assert result[1]["resolution"]["status"] == "resolved"
    assert result[1]["resolution"]["value"]["codes"] == ["S"]


def test_no_match_does_not_invent_metric_and_snapshot_changes_invalidate_cache():
    items = catalog()
    first = metric_candidate_index(items)
    assert first is metric_candidate_index(items)
    assert first.mentions("你好，明天天气怎么样") == []
    changed = metric_candidate_index([item for item in items if item.code != "D"])
    assert changed is not first
    assert "D" not in {hit["code"] for hit in changed.candidates("贷款余额当日数")}


def test_input_spans_preserve_original_whitespace_and_unicode():
    question = "📈查询 贷 款余 额当日数。"
    result = MetricCandidateIndex(catalog()).mentions(question)
    assert result[0]["text"] == question[result[0]["start"]:result[0]["end"]]
    assert result[0]["resolution"]["value"]["codes"] == ["D"]


def test_source_based_ellipsis_keeps_all_four_metrics_without_connector_rules():
    items = [
        MetricCatalogItem(code="A1", name="中间业务净收入金额当日数",
                          source_metric_code="A", base_name="中间业务净收入金额",
                          value_basis="当日数"),
        MetricCatalogItem(code="A2", name="中间业务净收入金额较上月增幅",
                          source_metric_code="A", base_name="中间业务净收入金额",
                          value_basis="较上月增幅"),
        MetricCatalogItem(code="B", name="手续费及佣金净收入当日数",
                          source_metric_code="B", base_name="手续费及佣金净收入",
                          value_basis="当日数"),
        MetricCatalogItem(code="C", name="净利润本年累计",
                          source_metric_code="C", base_name="净利润",
                          value_basis="本年累计"),
    ]
    index = MetricCandidateIndex(items)
    for question in [
        "7月31日省联社的中间业务净收入金额当日数和较上月增幅",
        "中间业务净收入金额的当日数、较上月增幅，手续费及佣金净收入当日数、净利润本年累计",
    ]:
        mentions = index.mentions(question)
        expected = ["A1", "A2"] if question.startswith("7月") else ["A1", "A2", "B", "C"]
        assert [m["resolution"]["value"]["codes"][0] for m in mentions] == expected
        assert all(question[m["start"]:m["end"]] == m["text"] for m in mentions)


def test_legacy_catalog_completes_unique_shared_name_without_source_fields():
    items = [
        MetricCatalogItem(code="A1", name="合成收入金额当日数"),
        MetricCatalogItem(code="A2", name="合成收入金额较上月增幅"),
        MetricCatalogItem(code="B1", name="合成贷款余额当日数"),
        MetricCatalogItem(code="B2", name="合成贷款余额较同期增幅"),
    ]
    index = MetricCandidateIndex(items)
    for question, expected in [
        ("7月31日样本机构的合成收入金额当日数和较上月增幅", ["A1", "A2"]),
        ("合成贷款余额当日数、较同期增幅", ["B1", "B2"]),
        ("合成收入金额当日数和较上月增幅、合成贷款余额当日数", ["A1", "A2", "B1"]),
    ]:
        mentions = index.mentions(question)
        assert [m["resolution"]["value"]["codes"][0] for m in mentions] == expected
        assert all(question[m["start"]:m["end"]] == m["text"] for m in mentions)
        _verify_metric_coverage(question, expected, items)
        with pytest.raises(ApplicationError) as incomplete:
            _verify_metric_coverage(question, expected[:1], items)
        assert incomplete.value.code == "METRIC_TARGETS_INCOMPLETE"


def test_legacy_catalog_does_not_select_ambiguous_or_unrelated_ellipsis():
    items = [
        MetricCatalogItem(code="A1", name="合成收入金额当日数"),
        MetricCatalogItem(code="A2", name="合成收入金额较上月增幅"),
        MetricCatalogItem(code="A3", name="合成收入金额较上月增幅"),
        MetricCatalogItem(code="B", name="合成贷款余额较上月增幅"),
    ]
    index = MetricCandidateIndex(items)
    mentions = index.mentions("合成收入金额当日数和较上月增幅")
    assert mentions[0]["resolution"]["value"]["codes"] == ["A1"]
    assert mentions[1]["resolution"]["status"] == "ambiguous"
    assert {item["code"] for item in mentions[1]["resolution"]["candidates"]} == {"A2", "A3"}
    unrelated = index.mentions("合成收入金额当日数和贷款余额较上月增幅")
    assert not any(m.get("source", {}).get("kind") == "catalog_name_completion"
                   for m in unrelated)


@pytest.mark.parametrize("structured", [False, True])
@pytest.mark.parametrize("last_name,confirmed", [
    ("合成贷款余额当日数", True),
    ("合成贷款余当日数", False),
])
def test_four_metrics_keep_ellipsis_group_and_independent_last_metric(
    structured, last_name, confirmed
):
    names = {
        "A": "合成收入金额当日数",
        "B": "合成收入金额较上月增幅",
        "C": "合成收入金额较去年同期增幅",
        "D": "合成贷款余额当日数",
    }
    items = []
    for code, name in names.items():
        base = "合成收入金额" if code != "D" else "合成贷款余额"
        source = "INCOME" if code != "D" else "LOAN"
        items.append(MetricCatalogItem(code=code, name=name, **(
            {"source_metric_code": source, "base_name": base,
             "value_basis": name[len(base):]} if structured else {}
        )))
    question = f"查询{names['A']}、较上月增幅、较去年同期增幅、{last_name}"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert [item["text"] for item in mentions] == [
        names["A"], "较上月增幅", "较去年同期增幅", last_name,
    ]
    assert [item["resolution"]["value"]["codes"] for item in mentions[:3]] == [
        ["A"], ["B"], ["C"],
    ]
    if confirmed:
        assert mentions[3]["resolution"]["value"]["codes"] == ["D"]
        _verify_metric_coverage(question, ["A", "B", "C", "D"], items)
    else:
        assert mentions[3]["resolution"]["status"] == "needs_confirmation"
        assert "D" in {candidate["code"] for candidate
                       in mentions[3]["resolution"]["candidates"]}
        with pytest.raises(ApplicationError) as unresolved:
            _verify_metric_coverage(question, ["A", "B", "C", "D"], items)
        assert unresolved.value.code == "METRIC_TARGETS_UNRESOLVED"


def test_source_structure_must_be_trusted_and_ambiguous_basis_is_not_selected():
    items = [
        MetricCatalogItem(code="A1", name="合成余额当日数", source_metric_code="A",
                          base_name="合成余额", value_basis="当日数"),
        MetricCatalogItem(code="A2", name="合成余额较上月增幅", source_metric_code="A",
                          base_name="合成余额", value_basis="较上月增幅"),
        MetricCatalogItem(code="A3", name="合成余额较上月增幅", source_metric_code="A-alt",
                          base_name="合成余额", value_basis="较上月增幅"),
        MetricCatalogItem(code="X", name="其他业务较上月增幅", source_metric_code="X",
                          base_name="错误基础", value_basis="较上月增幅"),
    ]
    mentions = MetricCandidateIndex(items).mentions("合成余额当日数、较上月增幅")
    assert mentions[0]["resolution"]["value"]["codes"] == ["A1"]
    assert mentions[1]["resolution"]["value"]["codes"] == ["A2"]
    uncertain = MetricCandidateIndex(items).mentions("合成余额的较上月增幅")
    assert uncertain[0]["resolution"]["status"] == "needs_confirmation"
    assert {c["code"] for c in uncertain[0]["resolution"]["candidates"]} == {"A2", "A3"}
    assert MetricCandidateIndex([items[-1]]).mentions("错误基础较上月增幅") == []


def test_ellipsis_does_not_cross_distinct_source_metric_lineages():
    items = [
        MetricCatalogItem(code="A1", name="合成余额当日数", source_metric_code="A",
                          base_name="合成余额", value_basis="当日数"),
        MetricCatalogItem(code="A2", name="合成余额较上月增幅", source_metric_code="A",
                          base_name="合成余额", value_basis="较上月增幅"),
        MetricCatalogItem(code="B3", name="合成余额较去年同期增幅", source_metric_code="B",
                          base_name="合成余额", value_basis="较去年同期增幅"),
    ]
    mentions = MetricCandidateIndex(items).mentions("合成余额当日数和较上月增幅、较去年同期增幅")
    assert mentions[0]["resolution"]["value"]["codes"] == ["A1"]
    assert mentions[1]["resolution"]["value"]["codes"] == ["A2"]
    assert mentions[2]["resolution"]["status"] == "needs_confirmation"


def test_catalog_sync_retains_source_structure_and_rejects_conflicting_source_rows():
    configs = {"SOURCE": {"indcr_nm": "机构合成净收入"}}
    selected, skipped, errors = _build_metric_catalog([
        {"indcr_no": "VALUE", "orig_indcr_no": "SOURCE", "indcr_nm": "当日数"},
        {"indcr_no": "GROWTH", "orig_indcr_no": "SOURCE", "indcr_nm": "较上月增幅"},
    ], configs)
    assert (skipped, errors) == (0, 0)
    assert selected["GROWTH"] == {
        "metric_name": "合成净收入较上月增幅", "source_metric_code": "SOURCE",
        "base_name": "合成净收入", "value_basis": "较上月增幅", "config": configs["SOURCE"],
    }
    _, _, conflict_count = _build_metric_catalog([
        {"indcr_no": "VALUE", "orig_indcr_no": "SOURCE", "indcr_nm": "当日数"},
        {"indcr_no": "VALUE", "orig_indcr_no": "SOURCE", "indcr_nm": "较上月增幅"},
    ], configs)
    assert conflict_count == 1


def test_catalog_snapshot_changes_when_source_structure_changes():
    plain = MetricCatalogItem(code="A", name="合成余额较上月增幅")
    structured = plain.model_copy(update={"source_metric_code": "S", "base_name": "合成余额",
                                         "value_basis": "较上月增幅"})
    assert metric_candidate_index([plain]) is not metric_candidate_index([structured])


def test_formal_task_rejects_omitted_or_uncertain_targets_before_sql():
    items = [
        MetricCatalogItem(code="A1", name="合成余额当日数", source_metric_code="A",
                          base_name="合成余额", value_basis="当日数"),
        MetricCatalogItem(code="A2", name="合成余额较上月增幅", source_metric_code="A",
                          base_name="合成余额", value_basis="较上月增幅"),
    ]
    question = "合成余额当日数和较上月增幅"
    _verify_metric_coverage(question, ["A1", "A2"], items)
    with pytest.raises(ApplicationError) as missing:
        _verify_metric_coverage(question, ["A1"], items)
    assert getattr(missing.value, "code", None) == "METRIC_TARGETS_INCOMPLETE"
    with pytest.raises(ApplicationError) as uncertain:
        _verify_metric_coverage("未登记的指标", ["A1"], items)
    assert getattr(uncertain.value, "code", None) == "METRIC_TARGETS_UNRESOLVED"
