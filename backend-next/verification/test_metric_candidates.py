"""算法回归使用合成目录，不连接模型或业务数据库。"""
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from ask_metric.api.routes.tasks import (
    BasicQueryRequest,
    SourceMetricBinding,
    SourceMetricSpan,
    _verify_metric_coverage,
    execute_basic_query,
)
from ask_metric.application.catalog_sync import _build_metric_catalog
from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.metric_candidates import (
    MetricCandidateIndex,
    metric_candidate_index,
)
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import QueryExecutionResult
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


def structured(source, base, bases, *, synonym_bases=(), writings=None):
    """按源端结构生成“基础指标 + 口径”目录，编码为 源编码:口径。

    同义词按“指标术语”的实际维护方式逐指标给出（基础叫法 + 口径叫法拼接），
    基础别名与口径别名由识别索引从中推导。
    """
    writings = writings or {}
    return [
        MetricCatalogItem(
            code=f"{source}:{basis}", name=base + basis, source_metric_code=source,
            base_name=base, value_basis=basis,
            aliases=[prefix + writings.get(basis, basis) for prefix in synonym_bases],
        )
        for basis in bases
    ]


def deposit_catalog():
    bases = ["当日数", "较同期", "较同期增幅", "较同期增幅排名", "较同期增量排名",
             "较上月增幅", "较上月增幅排名"]
    writings = {"较同期": "同比", "较上月增幅": "环比增幅"}
    return [
        *structured("CORP", "对公日均存款余额", bases, synonym_bases=["对公日均"],
                    writings=writings),
        *structured("PSON", "个人日均存款余额", bases, synonym_bases=["个人日均"],
                    writings=writings),
        *structured("TOTAL", "各项存款余额", bases, synonym_bases=["存款余额"],
                    writings=writings),
    ]


def summary(mentions):
    return [
        (mention["text"], mention["resolution"]["status"],
         mention["resolution"].get("value", {}).get("codes")
         or [candidate.get("code") for candidate in mention["resolution"].get("candidates", [])])
        for mention in mentions
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
    # 无结构目录无法独立核验基础身份和口径，非同音纠错仍交用户确认。
    ("合成客户风险比例", "R"),
])
def test_non_homophone_typo_and_description_remain_candidates(question, expected):
    result = MetricCandidateIndex(catalog()).mentions(question)
    assert result
    candidates = [candidate for mention in result
                  for candidate in mention["resolution"].get("candidates", [])]
    assert expected in [candidate.get("code") for candidate in candidates[:5]]
    assert all(mention["resolution"]["status"] != "resolved" for mention in result)


@pytest.mark.parametrize("question,expected", [
    ("贷款余额当日树", "D"),
    ("存款余鹅月日均", "S"),
    ("戴款余额当日数", "D"),
    ("合成客护风险比率", "R"),
])
def test_unique_homophone_is_resolved_and_marked(question, expected):
    result = MetricCandidateIndex(catalog()).mentions(question)
    assert len(result) == 1
    resolution = result[0]["resolution"]
    assert resolution["value"]["codes"] == [expected]
    assert resolution["metadata"]["match"] == "homophone"


@pytest.mark.parametrize("base,raw", [
    ("净利润金额", "净利润金融"),
    ("合成交易金额", "合成交易金件"),
    ("业务签约数量", "业务签签约数量"),
    ("服务收费金额", "服务费金额"),
])
def test_high_confidence_base_typo_resolves_with_exact_basis_and_audit(base, raw):
    items = structured("SYNTH", base, ["当日数", "较上期增幅"])
    question = "📈 甲机构2035年4月 " + raw + "当日数是多少"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert summary(mentions) == [(raw + "当日数", "resolved", ["SYNTH:当日数"])]
    mention = mentions[0]
    assert question[mention["start"]:mention["end"]] == mention["text"]
    metadata = mention["resolution"]["metadata"]
    assert metadata["match"] == "fuzzy_correction"
    assert metadata["understood_as"] == base
    correction = metadata["correction"]
    assert correction["original_base_text"] == raw
    assert correction["formal_base_name"] == base
    assert correction["method"] == "single_character_edit"
    assert correction["edit_distance"] == 1
    assert correction["character_score"] >= .8
    assert correction["margin"] >= .15
    assert correction["competition_scope"] == "all_enabled_catalog_terms"
    assert correction["dictionary_identity_count"] == 1
    assert correction["formal_metric"] == {
        "code": "SYNTH:当日数", "name": base + "当日数", "value_basis": "当日数",
    }
    # 执行层重扫原句认可同一纠错，不能换口径或多查一个指标。
    _verify_metric_coverage(question, ["SYNTH:当日数"], items)
    assert_coverage_rejected(question, ["SYNTH:较上期增幅"], items, None,
                             "METRIC_TARGETS_INCOMPLETE")


def test_high_confidence_typo_keeps_all_explicit_metrics_and_shared_bases():
    items = [
        *structured("A", "净利润金额", ["当日数", "较上期增幅"]),
        *structured("B", "客户活跃数量", ["当日数"]),
    ]
    question = "净利润金融当日数、较上期增幅；客户活跃数款当日数"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert summary(mentions) == [
        ("净利润金融当日数", "resolved", ["A:当日数"]),
        ("较上期增幅", "resolved", ["A:较上期增幅"]),
        ("客户活跃数款当日数", "resolved", ["B:当日数"]),
    ]
    assert mentions[0]["group"]["id"] == mentions[1]["group"]["id"]
    assert mentions[2]["group"]["id"] != mentions[0]["group"]["id"]
    codes = ["A:当日数", "A:较上期增幅", "B:当日数"]
    _verify_metric_coverage(question, codes, items)
    assert_coverage_rejected(question, codes[:-1], items, None, "METRIC_TARGETS_INCOMPLETE")


@pytest.mark.parametrize("base,raw", [
    ("合成12月期限金额", "合成13月期限金额"),
    ("合成十二月期限金额", "合成十三月期限金额"),
    ("合成不含税交易金额", "合成含税交易金额"),
    ("合成境内交易金额", "合成境外交易金额"),
    ("合成美元收入金额", "合成欧元收入金额"),
    ("合成日均交易金额", "合成月均交易金额"),
    ("合成交易占比金额", "合成交易占款金额"),
    ("合成万元交易金额", "合成万户交易金额"),
    ("合成百分之三金额", "合成百分之四金额"),
])
def test_base_typo_never_rewrites_explicit_semantic_qualifiers(base, raw):
    items = structured("SYNTH", base, ["当日数"])
    mentions = MetricCandidateIndex(items).mentions(raw + "当日数")
    assert mentions and all(m["resolution"]["status"] != "resolved" for m in mentions)
    assert_coverage_rejected(raw + "当日数", ["SYNTH:当日数"], items, None)


@pytest.mark.parametrize("base,raw,bases", [
    ("盈余金额", "盈余金件", ["当日数"]),
    ("合成交易金额", "合成交易金", ["当日数"]),
    ("合成交易收入金额", "合成交异收款金额", ["当日数"]),
    ("净利润金额", "净利润金融", ["较上期增幅", "较上期增量"]),
])
def test_base_typo_stays_pending_for_short_or_multiple_edits_or_partial_basis(base, raw, bases):
    suffix = "较上期增" if len(bases) > 1 else "当日数"
    mentions = MetricCandidateIndex(structured("SYNTH", base, bases)).mentions(raw + suffix)
    assert mentions and all(m["resolution"]["status"] != "resolved" for m in mentions)


def test_base_typo_competition_is_checked_before_basis_filter_and_candidate_truncation(monkeypatch):
    items = [
        *structured("A", "净利润金额", ["当日数"]),
        *structured("B", "净利润金数", ["较上期增幅"]),
    ]
    index = MetricCandidateIndex(items)
    original_recall = index.recall
    # 模拟检索截断后只见 A；不同口径的 B 仍参与完整目录身份竞争。
    monkeypatch.setattr(index, "recall", lambda *args, **kwargs: [
        hit for hit in original_recall(*args, **kwargs) if hit["key"] == ("base", "A")
    ])
    mention = index.mentions("净利润金融当日数")[0]
    assert mention["resolution"]["status"] == "needs_confirmation"
    assert [c["code"] for c in mention["resolution"]["candidates"]] == ["A:当日数"]
    assert_coverage_rejected("净利润金融当日数", ["A:当日数"], items, None)


def test_base_typo_close_runner_up_is_not_auto_selected():
    items = [
        *structured("A", "合成交易收入金额", ["当日数"]),
        *structured("B", "合成交易收入净金额", ["当日数"]),
    ]
    mentions = MetricCandidateIndex(items).mentions("合成交易收入金融当日数")
    assert mentions and all(m["resolution"]["status"] != "resolved" for m in mentions)


@pytest.mark.parametrize("conflict", ["same_name_source", "same_basis_code", "unstructured_name"])
def test_base_typo_rejects_conflicting_formal_identities(conflict):
    items = structured("A", "净利润金额", ["当日数"])
    if conflict == "same_name_source":
        items += structured("B", "净利润金额", ["当日数"])
    elif conflict == "same_basis_code":
        items.append(items[0].model_copy(update={"code": "DUPLICATE"}))
    else:
        items.append(MetricCatalogItem(code="PLAIN", name="净利润金额当日数"))
    mentions = MetricCandidateIndex(items).mentions("净利润金融当日数")
    assert mentions and all(m["resolution"]["status"] != "resolved" for m in mentions)


def test_homophone_of_two_different_codes_needs_confirmation():
    index = MetricCandidateIndex([
        MetricCatalogItem(code="A", name="合成客户余额"),
        MetricCatalogItem(code="B", name="合成客护余额"),
    ])
    resolution = index.mentions("合成客互余额")[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert {hit["code"] for hit in resolution["candidates"]} == {"A", "B"}


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


def test_base_without_value_basis_asks_for_value_basis():
    items = structured("G", "保证金存款利息支出金额", ["当日数", "较同期", "较上月增幅"])
    mentions = MetricCandidateIndex(items).mentions("保证金存款利息支出金额是多少")
    assert len(mentions) == 1
    assert mentions[0]["text"] == "保证金存款利息支出金额"
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert resolution["metadata"]["issue"] == "missing_value_basis"
    assert {c["code"] for c in resolution["candidates"]} == {item.code for item in items}
    # 候选带口径，用户只回答“当日数”时也能按原文确定。
    assert {c["metadata"]["value_basis"] for c in resolution["candidates"]} == {
        "当日数", "较同期", "较上月增幅",
    }
    # 目录只有一个口径时也不替用户默认口径。
    single = MetricCandidateIndex(structured("U", "特种单位协定存款余额", ["当日数"]))
    assert single.mentions("特种单位协定存款余额")[0]["resolution"]["status"] == (
        "needs_confirmation"
    )


def test_short_alias_inside_unfinished_specific_name_is_not_selected():
    items = [
        *structured("ACQ", "收单客户数量", ["当日数"]),
        MetricCatalogItem(code="CUST", name="其他客户数量", aliases=["客户数量"]),
        *structured("CARD", "个人贷记卡普通卡客户数量", ["当日数", "较上月"]),
    ]
    question = "紫金农商行4月末收单客户数量当日数、个人贷记卡普通卡客户数量是多少？"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert summary(mentions) == [
        ("收单客户数量当日数", "resolved", ["ACQ:当日数"]),
        ("个人贷记卡普通卡客户数量", "needs_confirmation", ["CARD:当日数", "CARD:较上月"]),
    ]


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


def test_unfinished_value_basis_is_confirmed_within_its_base():
    index = MetricCandidateIndex(deposit_catalog())
    unfinished = index.mentions("对公日均存款余额较同期增")
    assert summary(unfinished) == [("对公日均存款余额较同期增", "needs_confirmation", [
        "CORP:较同期增幅", "CORP:较同期增幅排名", "CORP:较同期增量排名",
    ])]
    assert unfinished[0]["resolution"]["metadata"]["issue"] == "value_basis_incomplete"
    # 口径说完后接着别的文字（“增加了多少”）不是没说完。
    assert summary(index.mentions("对公日均存款余额较同期增加了多少")) == [
        ("对公日均存款余额较同期", "resolved", ["CORP:较同期"]),
    ]
    with pytest.raises(ApplicationError) as unresolved:
        _verify_metric_coverage("对公日均存款余额较同期增", ["CORP:较同期增幅"], deposit_catalog())
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


def test_exact_and_homophone_in_same_question_keep_both():
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
    assert "D" not in {code for _, _, codes in summary(changed.mentions("贷款余额当日数"))
                       for code in codes}


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


def test_catalog_without_source_structure_does_not_guess_ellipsis():
    items = [
        MetricCatalogItem(code="A1", name="合成收入金额当日数"),
        MetricCatalogItem(code="A2", name="合成收入金额较上月增幅"),
    ]
    question = "合成收入金额当日数和较上月增幅"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert mentions[0]["resolution"]["value"]["codes"] == ["A1"]
    assert all(m["resolution"]["status"] != "resolved" for m in mentions[1:])
    with pytest.raises(ApplicationError) as unresolved:
        _verify_metric_coverage(question, ["A1", "A2"], items)
    assert unresolved.value.code in {"METRIC_TARGETS_UNRESOLVED", "METRIC_TARGETS_INCOMPLETE"}


@pytest.mark.parametrize("last_name,confirmed", [
    ("合成贷款余额当日数", True),
    ("合成贷款余当日数", False),
])
def test_four_metrics_keep_ellipsis_group_and_independent_last_metric(last_name, confirmed):
    items = [
        *structured("INCOME", "合成收入金额", ["当日数", "较上月增幅", "较去年同期增幅"]),
        *structured("LOAN", "合成贷款余额", ["当日数"]),
    ]
    question = f"查询合成收入金额当日数、较上月增幅、较去年同期增幅、{last_name}"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert [item["text"] for item in mentions] == [
        "合成收入金额当日数", "较上月增幅", "较去年同期增幅", last_name,
    ]
    assert [item["resolution"]["value"]["codes"] for item in mentions[:3]] == [
        ["INCOME:当日数"], ["INCOME:较上月增幅"], ["INCOME:较去年同期增幅"],
    ]
    codes = ["INCOME:当日数", "INCOME:较上月增幅", "INCOME:较去年同期增幅", "LOAN:当日数"]
    if confirmed:
        assert mentions[3]["resolution"]["value"]["codes"] == ["LOAN:当日数"]
        _verify_metric_coverage(question, codes, items)
    else:
        assert mentions[3]["resolution"]["status"] == "needs_confirmation"
        assert "LOAN:当日数" in {candidate.get("code") for candidate
                                 in mentions[3]["resolution"]["candidates"]}
        with pytest.raises(ApplicationError) as unresolved:
            _verify_metric_coverage(question, codes, items)
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
    assert mentions[2]["resolution"]["metadata"]["issue"] == "value_basis_not_found"


@pytest.mark.parametrize("question", [
    "对公日均存款余额当日数和较同期增幅",
    "对公日均存款余额的当日数和较同期增幅",
    "对公日均存款余额当日数、较同期增幅",
])
def test_shared_base_with_several_value_bases(question):
    mentions = MetricCandidateIndex(deposit_catalog()).mentions(question)
    assert [codes for _, _, codes in summary(mentions)] == [
        ["CORP:当日数"], ["CORP:较同期增幅"],
    ]
    assert len({mention["group"]["id"] for mention in mentions}) == 1
    assert all(question[m["start"]:m["end"]] == m["text"] for m in mentions)
    _verify_metric_coverage(question, ["CORP:当日数", "CORP:较同期增幅"], deposit_catalog())


def test_homophone_base_resolves_every_value_basis_of_the_group():
    index = MetricCandidateIndex(deposit_catalog())
    mentions = index.mentions("对工日均存款余额当日数和较同期增幅")
    assert summary(mentions) == [
        ("对工日均存款余额当日数", "resolved", ["CORP:当日数"]),
        ("较同期增幅", "resolved", ["CORP:较同期增幅"]),
    ]
    assert all(m["resolution"]["metadata"] == {
        "match": "homophone", "understood_as": "对公日均存款余额",
    } for m in mentions)


def test_uncertain_base_shares_one_candidate_group_across_value_bases():
    index = MetricCandidateIndex(deposit_catalog())
    mentions = index.mentions("对公日常存钱余额当日数和较同期增幅")
    assert [m["text"] for m in mentions] == ["对公日常存钱余额当日数", "较同期增幅"]
    assert all(m["resolution"]["status"] == "needs_confirmation" for m in mentions)
    assert len({m["group"]["id"] for m in mentions}) == 1
    first, second = (m["resolution"]["candidates"] for m in mentions)
    # 同一基础指标候选在各口径片段中一一对应，确认一次即可确定全部口径。
    assert [c["metadata"]["source_metric_code"] for c in first] == [
        c["metadata"]["source_metric_code"] for c in second
    ]
    assert "CORP" in {c["metadata"]["source_metric_code"] for c in first}
    assert {c["metadata"]["kind"] for c in first + second} == {"base"}
    by_source = {c["metadata"]["source_metric_code"]: c["code"] for c in second}
    assert by_source["CORP"] == "CORP:较同期增幅"


@pytest.mark.parametrize("prefix", ["", "乙机构2037年2月", "查询丙机构 2041 年 11 月 "])
@pytest.mark.parametrize("base,raw_base,auto_corrected", [
    ("净利润金额", "净利润金融", True),
    ("盈余金额", "盈余金件", False),
    ("债券投资余额", "债券投向余额", True),
    ("销售收入总额", "销售收入总款", True),
    ("服务收费金额", "服务费金额", True),
    ("客户签约数量", "客户签签约数量", True),
])
def test_fuzzy_span_uses_complete_catalog_term_and_basis_boundary(
    prefix, base, raw_base, auto_corrected,
):
    items = structured("SYNTH", base, ["期内累计", "较基期增幅"])
    question = prefix + raw_base + "期内累计进行比较"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert len(mentions) == 1
    mention = mentions[0]
    assert mention["text"] == raw_base + "期内累计"
    assert question[mention["start"]:mention["end"]] == mention["text"]
    assert mention["source"]["kind"] == "fuzzy_base_basis"
    if auto_corrected:
        assert mention["resolution"]["status"] == "resolved"
        assert mention["resolution"]["value"]["codes"] == ["SYNTH:期内累计"]
        _verify_metric_coverage(question, ["SYNTH:期内累计"], items)
    else:
        assert mention["resolution"]["status"] == "needs_confirmation"
        assert [candidate["code"] for candidate in mention["resolution"]["candidates"]] == [
            "SYNTH:期内累计",
        ]
        assert_coverage_rejected(question, ["SYNTH:期内累计"], items, None)
    _verify_metric_coverage(question, ["SYNTH:期内累计"], items, [
        binding(question, raw_base + "期内累计", ["SYNTH:期内累计"]),
    ])


def test_fuzzy_base_preserves_shared_bases_and_independent_metric():
    items = [
        *structured("A", "净利润金额", ["当日数", "较上月增幅"]),
        *structured("B", "服务收费金额", ["当日数"]),
    ]
    question = "2042年9月净利润金融当日数、较上月增幅；服务费金额当日数"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert [mention["text"] for mention in mentions] == [
        "净利润金融当日数", "较上月增幅", "服务费金额当日数",
    ]
    assert all(mention["resolution"]["status"] == "resolved" for mention in mentions)
    assert mentions[0]["group"]["id"] == mentions[1]["group"]["id"]
    assert mentions[2]["group"]["id"] != mentions[0]["group"]["id"]
    assert [mention["resolution"]["value"]["codes"] for mention in mentions] == [
        ["A:当日数"], ["A:较上月增幅"], ["B:当日数"],
    ]


def test_fuzzy_span_keeps_equal_candidates_and_original_unicode_whitespace():
    items = [
        *structured("A", "合成收入金额", ["期内累计"]),
        *structured("B", "合成收入金数", ["期内累计"]),
    ]
    question = "📈 甲机构 2035 年 4 月 合 成 收 入 金 件 期 内 累 计？"
    mentions = MetricCandidateIndex(items).mentions(question)
    assert len(mentions) == 1
    mention = mentions[0]
    assert mention["text"] == "合 成 收 入 金 件 期 内 累 计"
    assert question[mention["start"]:mention["end"]] == mention["text"]
    assert mention["resolution"]["status"] == "needs_confirmation"
    assert {candidate["code"] for candidate in mention["resolution"]["candidates"]} == {
        "A:期内累计", "B:期内累计",
    }


def test_alias_inside_longer_mistyped_text_uses_complete_corrected_identity():
    # “对公日均”是别名，但原文紧接着的“存钱余额”说明用户在说更长的名称。
    mentions = MetricCandidateIndex(deposit_catalog()).mentions("对公日均存钱余额当日数")
    assert summary(mentions) == [("对公日均存钱余额当日数", "resolved", ["CORP:当日数"])]
    assert mentions[0]["resolution"]["metadata"]["correction"]["formal_base_name"] == (
        "对公日均存款余额"
    )
    assert all("对公日均" != m["text"] for m in mentions)


def test_shared_tail_is_reported_instead_of_dropped():
    mentions = MetricCandidateIndex(deposit_catalog()).mentions("对公和个人日均存款余额当日数")
    assert summary(mentions) == [
        ("对公", "needs_confirmation", ["CORP:当日数"]),
        ("个人日均存款余额当日数", "resolved", ["PSON:当日数"]),
    ]
    assert mentions[0]["resolution"]["metadata"]["issue"] == "shared_tail"


def test_full_rank_value_basis_is_kept_as_metric_name():
    index = MetricCandidateIndex(deposit_catalog())
    assert summary(index.mentions("各家农商行对公日均存款余额较上月增幅排名前三")) == [
        ("对公日均存款余额较上月增幅排名", "resolved", ["CORP:较上月增幅排名"]),
    ]
    missing = index.mentions("各家农商行对公日均存款余额排名前三")
    assert missing[0]["resolution"]["metadata"]["issue"] == "missing_value_basis"


def test_base_and_value_basis_aliases_compose():
    assert summary(MetricCandidateIndex(deposit_catalog()).mentions("对公日均同比和环比增幅")) == [
        ("对公日均同比", "resolved", ["CORP:较同期"]),
        ("环比增幅", "resolved", ["CORP:较上月增幅"]),
    ]


def test_field_value_with_unrecognized_text_is_not_resolved():
    items = [MetricCatalogItem(code="A", name="甲乙丙丁")]
    result = resolve_catalog_field("metric", ["甲乙丙丁戊己"], items)
    assert result["status"] == "needs_confirmation"
    assert [candidate["code"] for candidate in result["candidates"]] == ["A"]
    missing = resolve_catalog_field("metric", ["对公日均存款余额"], deposit_catalog())
    assert missing["status"] == "needs_confirmation"
    assert len(missing["candidates"]) == 7


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


def test_catalog_snapshot_changes_when_source_structure_or_synonyms_change():
    plain = MetricCatalogItem(code="A", name="合成余额较上月增幅")
    structured_item = plain.model_copy(update={
        "source_metric_code": "S", "base_name": "合成余额", "value_basis": "较上月增幅",
    })
    assert metric_candidate_index([plain]) is not metric_candidate_index([structured_item])
    synonym = structured_item.model_copy(update={"aliases": ["合余环比增幅"]})
    assert metric_candidate_index([synonym]) is not metric_candidate_index([structured_item])


def test_aliases_are_derived_from_maintained_synonyms_only():
    # 只在“指标术语”维护同义词：改动同义词后别名随索引重新推导，没有第二处数据。
    index = MetricCandidateIndex(deposit_catalog())
    assert index.base_terms["对公日均"] == {"CORP"}
    assert index.basis_terms["同比"] == {"较同期"}
    without = [item.model_copy(update={"aliases": []}) if item.source_metric_code == "CORP"
               else item for item in deposit_catalog()]
    assert "对公日均" not in MetricCandidateIndex(without).base_terms
    # 两个基础指标共用的叫法不作为基础别名，只按完整同义词匹配，交用户确认。
    shared = deposit_catalog() + structured(
        "OTHER", "其他日均存款余额", ["当日数", "较同期"], synonym_bases=["对公日均"],
        writings={"较同期": "同比"},
    )
    assert "对公日均" not in MetricCandidateIndex(shared).base_terms


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
    with pytest.raises(ApplicationError) as basis_missing:
        _verify_metric_coverage("合成余额是多少", ["A1"], items)
    assert getattr(basis_missing.value, "code", None) == "METRIC_TARGETS_UNRESOLVED"


def binding(question, text, codes):
    start = question.index(text)
    return SourceMetricBinding(start=start, end=start + len(text), text=text, codes=codes)


def same_name_catalog():
    return [
        MetricCatalogItem(code="A", name="资产总额当日数", aliases=["资产总额"]),
        MetricCatalogItem(code="B", name="资产总额当日数", aliases=["总资产"]),
    ]


def assert_coverage_rejected(
    question, requested, items, bindings, code="METRIC_TARGETS_UNRESOLVED", *, exclusions=None,
):
    with pytest.raises(ApplicationError) as error:
        _verify_metric_coverage(question, requested, items, bindings, exclusions)
    assert (error.value.code, error.value.status_code) == (code, 409)


def test_original_alias_binding_survives_duplicate_formal_names():
    items = same_name_catalog()
    question = "那我需要查资产总额"
    _verify_metric_coverage(question, ["A"], items, [binding(question, "资产总额", ["A"])])
    # 旧的名称替换会把唯一别名变成同名歧义；新契约保持原文与已确认编码。
    assert_coverage_rejected("那我需要查资产总额当日数", ["A"], items, None)


def test_two_aliases_bind_two_same_name_metrics_without_losing_either_target():
    items = same_name_catalog()
    question = "资产总额和总资产"
    bindings = [binding(question, "资产总额", ["A"]), binding(question, "总资产", ["B"])]
    _verify_metric_coverage(question, ["A", "B"], items, bindings)
    assert_coverage_rejected(question, ["A"], items, bindings, "METRIC_TARGETS_INCOMPLETE")
    assert_coverage_rejected(question, ["A"], items, bindings[:1])


def test_swapped_resolved_bindings_cannot_hide_behind_same_requested_union():
    question = "资产总额和总资产"
    bindings = [binding(question, "资产总额", ["B"]), binding(question, "总资产", ["A"])]
    assert_coverage_rejected(question, ["A", "B"], same_name_catalog(), bindings)


@pytest.mark.parametrize("code", ["A", "B"])
def test_explicit_confirmation_can_choose_either_current_same_name_candidate(code):
    question = "资产总额当日数"
    _verify_metric_coverage(
        question, [code], same_name_catalog(), [binding(question, question, [code])],
    )


def test_missing_value_basis_requires_binding_even_if_requested_is_one_candidate():
    items = structured("ASSET", "资产总额", ["当日数", "较上月增幅"])
    question = "查询资产总额"
    chosen = "ASSET:当日数"
    assert_coverage_rejected(question, [chosen], items, None)
    _verify_metric_coverage(question, [chosen], items, [binding(question, "资产总额", [chosen])])


@pytest.mark.parametrize("basis", ["当日数", "较上月增幅"])
def test_fuzzy_base_confirmation_then_value_basis_can_bind_current_trusted_variant(basis):
    items = structured("MOB", "手机银行客户数量", ["当日数", "较上月增幅"])
    question = "手机银行客户数"
    resolution = MetricCandidateIndex(items).mentions(question)[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert any(candidate.get("metadata") == {
        "kind": "base_only", "source_metric_code": "MOB",
    } and "code" not in candidate for candidate in resolution["candidates"])
    chosen = f"MOB:{basis}"
    _verify_metric_coverage(question, [chosen], items, [binding(question, question, [chosen])])
    assert_coverage_rejected(question, [chosen], items, None)


def test_fuzzy_base_binding_does_not_trust_malformed_source_structure():
    items = [
        *structured("MOB", "手机银行客户数量", ["当日数", "较上月增幅"]),
        MetricCatalogItem(code="FAKE", name="其他业务指标", source_metric_code="MOB",
                          base_name="手机银行客户数量", value_basis="当日数"),
    ]
    question = "手机银行客户数"
    assert "FAKE" not in MetricCandidateIndex(items).source_by_code
    assert_coverage_rejected(question, ["FAKE"], items, [binding(question, question, ["FAKE"])])


@pytest.mark.parametrize("codes", [["OUTSIDE"], ["A", "B"]])
def test_confirmation_binding_cannot_choose_non_candidate_or_multiple_candidates(codes):
    question = "资产总额当日数"
    items = same_name_catalog() + [MetricCatalogItem(code="OUTSIDE", name="合成存款余额")]
    assert_coverage_rejected(question, codes, items, [binding(question, question, codes)])


def test_removed_catalog_code_is_rejected_even_when_original_frame_bound_it():
    question = "资产总额当日数"
    current_catalog = [same_name_catalog()[1]]
    assert_coverage_rejected(question, ["A"], current_catalog, [binding(question, question, ["A"])])


def test_unavailable_value_basis_cannot_bind_an_enabled_metric_with_another_basis():
    items = [
        *structured("ASSET", "资产总额", ["当日数"]),
        *structured("DEPOSIT", "存款余额", ["较上月增幅"]),
    ]
    question = "资产总额较上月增幅"
    assert MetricCandidateIndex(items).mentions(question)[0]["resolution"]["candidates"] == []
    assert_coverage_rejected(
        question, ["ASSET:当日数"], items, [binding(question, question, ["ASSET:当日数"])],
    )


@pytest.mark.parametrize("change", [
    {"start": 0},
    {"end": 100},
    {"text": "总资产"},
    {"start": 1, "end": 5, "text": "查询资产"},
])
def test_forged_or_out_of_bounds_binding_span_is_rejected(change):
    question = "📈查询资产总额"
    original = binding(question, "资产总额", ["A"])
    forged = SourceMetricBinding.model_validate(original.model_dump() | change)
    assert_coverage_rejected(question, ["A"], same_name_catalog(), [forged])


def test_binding_unicode_offsets_are_codepoints_and_preserve_original_whitespace():
    question = "📈查询资 产总额"
    _verify_metric_coverage(
        question, ["A"], same_name_catalog(), [binding(question, "资 产总额", ["A"])],
    )


def test_duplicate_overlapping_and_extra_non_metric_bindings_are_rejected():
    question = "查询资产总额和总资产"
    first, second = (binding(question, text, [code])
                     for text, code in [("资产总额", "A"), ("总资产", "B")])
    assert_coverage_rejected(question, ["A", "B"], same_name_catalog(), [first, first])
    overlap = binding(question, "总额和总资产", ["B"])
    assert_coverage_rejected(question, ["A", "B"], same_name_catalog(), [first, overlap])
    extra = binding(question, "查询", ["A"])
    assert_coverage_rejected(question, ["A", "B"], same_name_catalog(), [first, extra])
    assert_coverage_rejected(question, ["A", "B"], same_name_catalog(), [first, second, extra])


def test_binding_cannot_turn_non_metric_text_into_a_target():
    question = "你好"
    assert_coverage_rejected(
        question, ["A"], same_name_catalog(), [binding(question, question, ["A"])],
    )


def test_extra_requested_code_is_still_rejected_after_binding_validation():
    question = "资产总额"
    assert_coverage_rejected(
        question, ["A", "B"], same_name_catalog(), [binding(question, question, ["A"])],
        "METRIC_TARGETS_INCOMPLETE",
    )


def source_span(question, text):
    start = question.index(text)
    return SourceMetricSpan(start=start, end=start + len(text), text=text)


def test_excluding_first_metric_keeps_shared_base_for_following_value_basis():
    items = structured("LOAN", "贷款余额", ["当日数", "较上月增幅"])
    question = "贷款余额当日数和较上月增幅"
    bindings = [binding(question, "较上月增幅", ["LOAN:较上月增幅"])]
    exclusions = [source_span(question, "贷款余额当日数")]
    _verify_metric_coverage(question, ["LOAN:较上月增幅"], items, bindings, exclusions)
    assert_coverage_rejected(
        question, ["LOAN:当日数", "LOAN:较上月增幅"], items, bindings,
        "METRIC_TARGETS_INCOMPLETE", exclusions=exclusions,
    )
    # 真正删除首项会丢失基础指标上下文，不能识别剩余省略口径。
    assert MetricCandidateIndex(items).mentions("和较上月增幅") == []


def test_exclusion_can_drop_an_ambiguous_metric_without_forcing_confirmation():
    items = same_name_catalog() + [MetricCatalogItem(code="L", name="贷款余额当日数")]
    question = "资产总额当日数和贷款余额当日数"
    _verify_metric_coverage(question, ["L"], items, [binding(question, "贷款余额当日数", ["L"])],
                            [source_span(question, "资产总额当日数")])


@pytest.mark.parametrize("changes", [
    {"start": 1, "text": "款余额当日数"},
    {"text": "存款余额当日数"},
    {"end": 100},
    {"start": 7, "end": 8, "text": "和"},
])
def test_partial_forged_out_of_bounds_or_non_metric_exclusion_is_rejected(changes):
    items = structured("LOAN", "贷款余额", ["当日数", "较上月增幅"])
    question = "贷款余额当日数和较上月增幅"
    excluded = SourceMetricSpan.model_validate(
        source_span(question, "贷款余额当日数").model_dump() | changes,
    )
    assert_coverage_rejected(
        question, ["LOAN:较上月增幅"], items,
        [binding(question, "较上月增幅", ["LOAN:较上月增幅"])], exclusions=[excluded],
    )


def test_missing_duplicate_overlapping_or_extra_exclusion_is_rejected():
    items = structured("LOAN", "贷款余额", ["当日数", "较上月增幅"])
    question = "贷款余额当日数和较上月增幅"
    kept = binding(question, "较上月增幅", ["LOAN:较上月增幅"])
    excluded = source_span(question, "贷款余额当日数")
    for exclusions in [None, [excluded, excluded], [source_span(question, "较上月增幅")],
                       [excluded, source_span(question, "和")]]:
        assert_coverage_rejected(
            question, ["LOAN:较上月增幅"], items, [kept], exclusions=exclusions,
        )


def test_excluding_a_metric_does_not_join_surrounding_text_into_another_metric():
    items = [
        MetricCatalogItem(code="E", name="存款余额当日数"),
        MetricCatalogItem(code="L", name="贷款余额当日数"),
        MetricCatalogItem(code="JOINED", name="甲乙"),
    ]
    question = "甲存款余额当日数乙和贷款余额当日数"
    # 合成目录里的“甲乙”只在直接删除被放弃的指标片段后出现。
    deleted_mentions = MetricCandidateIndex(items).mentions(question.replace("存款余额当日数", ""))
    assert deleted_mentions[0]["resolution"]["value"]["codes"] == ["JOINED"]
    bindings = [binding(question, "贷款余额当日数", ["L"])]
    exclusions = [source_span(question, "存款余额当日数")]
    _verify_metric_coverage(question, ["L"], items, bindings, exclusions)
    assert_coverage_rejected(
        question, ["L", "JOINED"], items, bindings, "METRIC_TARGETS_INCOMPLETE",
        exclusions=exclusions,
    )


def test_exclusions_without_any_retained_binding_cannot_skip_legacy_verification():
    question = "资产总额"
    excluded = source_span(question, question)
    assert_coverage_rejected(question, ["A"], same_name_catalog(), None, exclusions=[excluded])
    assert_coverage_rejected(question, ["A"], same_name_catalog(), [], exclusions=[excluded])


@pytest.mark.parametrize("change", [
    {"start": "0"}, {"start": True}, {"start": -1}, {"end": 0}, {"end": 1},
    {"end": 5.0}, {"text": ""}, {"text": 123}, {"codes": []}, {"codes": [""]},
    {"codes": ["  "]}, {"codes": [1]}, {"codes": ["A", "A"]},
    {"codes": "A"}, {"unknown": "ignored"},
])
def test_binding_schema_rejects_coercion_empty_identity_and_extra_fields(change):
    with pytest.raises(ValidationError):
        SourceMetricBinding.model_validate({
            "start": 1, "end": 5, "text": "资产总额", "codes": ["A"],
        } | change)


def basic_query_body():
    return {
        "metric_codes": ["A"], "org_codes": ["ORG"],
        "time": {"start": "2026-07-31", "end": "2026-07-31"}, "selection": "exact",
    }


def test_request_requires_source_question_and_nonempty_binding_list():
    item = binding("资产总额", "资产总额", ["A"]).model_dump()
    with pytest.raises(ValidationError):
        BasicQueryRequest.model_validate(basic_query_body() | {"source_metric_bindings": [item]})
    with pytest.raises(ValidationError):
        BasicQueryRequest.model_validate(basic_query_body() | {
            "source_question": "资产总额", "source_metric_bindings": [],
        })


def test_request_requires_complete_binding_contract_for_exclusions():
    excluded = source_span("资产总额", "资产总额").model_dump()
    for fields in [{}, {"source_question": "资产总额"}, {"source_metric_bindings": [
        binding("资产总额", "资产总额", ["A"]).model_dump(),
    ]}]:
        with pytest.raises(ValidationError):
            BasicQueryRequest.model_validate(basic_query_body() | fields | {
                "source_metric_exclusions": [excluded],
            })
    with pytest.raises(ValidationError):
        SourceMetricSpan.model_validate(excluded | {"codes": ["A"]})


def test_route_verifies_binding_before_task_creation_and_keeps_it_out_of_query_spec():
    question = "资产总额当日数和总资产"
    payload = BasicQueryRequest.model_validate(basic_query_body() | {
        "source_question": question,
        "source_metric_bindings": [binding(question, "资产总额当日数", ["A"]).model_dump()],
        "source_metric_exclusions": [source_span(question, "总资产").model_dump()],
    })
    tasks = Mock()
    tasks.uow_factory.side_effect = lambda: nullcontext(SimpleNamespace(
        metric_catalog=SimpleNamespace(list_enabled=same_name_catalog),
    ))
    tasks.submit_question.return_value = SimpleNamespace(task_id="synthetic-task", version=1)
    execution = Mock()
    execution.execute.return_value = QueryExecutionResult(
        task_id="synthetic-task", status="succeeded", query_shape="metric_value",
    )
    arguments = {
        "request": SimpleNamespace(state=SimpleNamespace(request_id="synthetic-request")),
        "actor": ActorContext(subject="synthetic-user", authentication_method="test",
                              trust_level="authenticated"),
        "task_service": tasks, "execution_service": execution, "idempotency_key": "synthetic-key",
    }
    response = execute_basic_query(payload, **arguments)
    assert response.result.status == "succeeded"
    command = tasks.submit_question.call_args.args[0]
    assert command.basic_query.metric_codes == ["A"]
    assert "source_question" not in command.basic_query.model_dump()
    assert "source_metric_bindings" not in command.basic_query.model_dump()
    assert "source_metric_exclusions" not in command.basic_query.model_dump()
    assert response.query == command.basic_query

    # 不接受模型把另一个启用指标写进同一 span；失败发生在任务和取数之前。
    tasks.reset_mock()
    execution.reset_mock()
    invalid = payload.model_copy(update={
        "source_question": "资产总额",
        "source_metric_bindings": [binding("资产总额", "资产总额", ["B"])],
        "source_metric_exclusions": None,
    })
    with pytest.raises(ApplicationError):
        execute_basic_query(invalid, **arguments)
    tasks.submit_question.assert_not_called()
    execution.execute.assert_not_called()
