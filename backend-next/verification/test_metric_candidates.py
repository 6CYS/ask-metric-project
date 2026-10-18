"""算法回归使用合成目录，不连接模型或业务数据库。"""
import pytest

from ask_metric.application.catalog_sync import _build_metric_catalog
from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.metric_candidates import (
    MetricCandidateIndex,
    metric_candidate_index,
)
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


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


def test_unique_full_base_name_defaults_to_current_day_basis():
    # 验收 A1 首轮：完整基础名称精确且唯一命中、仅省略口径，默认当日数，不追问口径。
    items = structured("G", "保证金存款利息支出金额", ["当日数", "较同期", "较上月增幅"])
    mentions = MetricCandidateIndex(items).mentions("保证金存款利息支出金额是多少")
    assert len(mentions) == 1
    assert mentions[0]["text"] == "保证金存款利息支出金额"
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "resolved"
    assert resolution["value"] == {
        "codes": ["G:当日数"], "names": ["保证金存款利息支出金额当日数"],
    }
    assert resolution["metadata"] == {
        "match": "exact", "default_value_basis": "当日数",
        "source_metric_code": "G", "base_name": "保证金存款利息支出金额",
    }
    # 目录只有一个口径且为当日数时同样默认。
    single = MetricCandidateIndex(structured("U", "特种单位协定存款余额", ["当日数"]))
    resolution = single.mentions("特种单位协定存款余额")[0]["resolution"]
    assert resolution["status"] == "resolved"
    assert resolution["value"]["codes"] == ["U:当日数"]


def test_missing_value_basis_still_asks_when_no_unique_current_day_member():
    # 目录无当日数成员、或当日数成员不唯一时才追问；候选仍是目录实际存在的指标。
    items = structured("G", "保证金存款利息支出金额", ["较同期", "较上月增幅"])
    mentions = MetricCandidateIndex(items).mentions("保证金存款利息支出金额是多少")
    assert len(mentions) == 1
    assert mentions[0]["text"] == "保证金存款利息支出金额"
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert resolution["metadata"]["issue"] == "missing_value_basis"
    assert {c["code"] for c in resolution["candidates"]} == {item.code for item in items}
    # 候选带口径，用户只回答“较同期”时也能按原文确定。
    assert {c["metadata"]["value_basis"] for c in resolution["candidates"]} == {
        "较同期", "较上月增幅",
    }
    duplicated = [
        *structured("H", "特种单位协定存款余额", ["当日数", "较上月"]),
        MetricCatalogItem(code="H-alt:当日数", name="特种单位协定存款余额当日数",
                          source_metric_code="H", base_name="特种单位协定存款余额",
                          value_basis="当日数"),
    ]
    resolution = MetricCandidateIndex(duplicated).mentions("特种单位协定存款余额")[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert resolution["metadata"]["issue"] == "missing_value_basis"


def test_homophone_or_multi_source_base_is_not_defaulted():
    # 同音待确认项不直接默认口径。
    resolution = MetricCandidateIndex(deposit_catalog()).mentions(
        "对工日均存款余额"
    )[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert resolution["metadata"]["issue"] == "missing_value_basis"
    assert resolution["metadata"]["understood_as"] == "对公日均存款余额"
    # 同一基础名称对应多个源指标时不默认，候选保留各源完整目录解析。
    shared = MetricCandidateIndex([
        *structured("A", "合成余额", ["当日数", "较上月"]),
        *structured("B", "合成余额", ["当日数"]),
    ])
    resolution = shared.mentions("合成余额")[0]["resolution"]
    assert resolution["status"] == "needs_confirmation"
    assert {c["code"] for c in resolution["candidates"]} == {
        "A:当日数", "A:较上月", "B:当日数",
    }


def test_explicit_basis_and_formal_name_are_not_redefaulted():
    # 验收 A1：首轮默认当日数；次轮明确口径优先；已含口径的正式名称不重套默认。
    index = MetricCandidateIndex(structured("AGR", "对公协定存款余额", ["当日数", "较上月"]))
    cases = [
        ("查询无锡2026年5月31日的对公协定存款余额。", ["AGR:当日数"], True),
        ("对公协定存款余额较上月", ["AGR:较上月"], False),
        ("对公协定存款余额当日数", ["AGR:当日数"], False),
    ]
    for question, expected, defaulted in cases:
        mentions = index.mentions(question)
        assert len(mentions) == 1
        resolution = mentions[0]["resolution"]
        assert resolution["status"] == "resolved"
        assert resolution["value"]["codes"] == expected
        assert ("default_value_basis" in resolution["metadata"]) == defaulted


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
        ("个人贷记卡普通卡客户数量", "resolved", ["CARD:当日数"]),
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
    if confirmed:
        assert mentions[3]["resolution"]["value"]["codes"] == ["LOAN:当日数"]
    else:
        assert mentions[3]["resolution"]["status"] == "needs_confirmation"
        assert "LOAN:当日数" in {candidate.get("code") for candidate
                                 in mentions[3]["resolution"]["candidates"]}


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
    else:
        assert mention["resolution"]["status"] == "needs_confirmation"
        assert [candidate["code"] for candidate in mention["resolution"]["candidates"]] == [
            "SYNTH:期内累计",
        ]


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
    # 排名操作与口径分别处理：省略口径时默认当日数，排名由下游单独处理。
    missing = index.mentions("各家农商行对公日均存款余额排名前三")
    resolution = missing[0]["resolution"]
    assert resolution["status"] == "resolved"
    assert resolution["value"]["codes"] == ["CORP:当日数"]
    assert resolution["metadata"]["default_value_basis"] == "当日数"


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
    # 完整基础名称唯一命中、仅省略口径：字段解析与原问 mentions 共用默认当日数规则。
    defaulted = resolve_catalog_field("metric", ["对公日均存款余额"], deposit_catalog())
    assert defaulted["status"] == "resolved"
    assert defaulted["value"] == {
        "codes": ["CORP:当日数"], "names": ["对公日均存款余额当日数"],
    }


def test_metric_zero_hit_only_requests_the_metric_field():
    # 零命中只请求补充指标：状态 not_found、无候选；机构等其它字段的独立解析不受影响。
    result = resolve_catalog_field("metric", ["完全不存在的指标甲乙丙"], deposit_catalog())
    assert result["status"] == "not_found"
    assert result["candidates"] == []
    orgs = [OrganizationCatalogItem(code="O1", name="无锡农商行")]
    org = resolve_catalog_field("organization", ["无锡农商行"], orgs)
    assert org["status"] == "resolved"
    assert org["value"]["codes"] == ["O1"]


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
