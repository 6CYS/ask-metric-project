"""算法回归使用合成目录，不连接模型或业务数据库。"""
import pytest

from ask_metric.api.routes.tasks import _verify_metric_coverage
from ask_metric.application.catalog_sync import _build_metric_catalog
from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.metric_candidates import (
    MetricCandidateIndex,
    metric_candidate_index,
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
    # 只差一个字但读音不同：保守策略下一律交用户确认。
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
    mentions = index.mentions("对公日均存钱余额当日数和较同期增幅")
    assert [m["text"] for m in mentions] == ["对公日均存钱余额当日数", "较同期增幅"]
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


def test_alias_inside_longer_mistyped_text_is_not_silently_selected():
    # “对公日均”是别名，但原文紧接着的“存钱余额”说明用户在说更长的名称。
    mentions = MetricCandidateIndex(deposit_catalog()).mentions("对公日均存钱余额当日数")
    assert all(m["resolution"]["status"] != "resolved" for m in mentions)
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
