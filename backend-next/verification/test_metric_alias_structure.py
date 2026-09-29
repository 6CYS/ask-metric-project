"""组合同义词拆分建议：合成目录，不连接数据库。"""

from ask_metric.application.metric_alias_structure import (
    StructuredMetric,
    derive_alias_structure,
    propose_alias_structure,
)

BASES = {"当日数": "当日值", "较上月增幅": "环比增幅", "较上季增幅": "季度环比增幅"}


def catalog(base_writings: dict[str, tuple[str, list[str]]]):
    metrics, synonyms = [], {}
    for source, (base, writings) in base_writings.items():
        for basis, writing in BASES.items():
            code = f"{source}:{basis}"
            metrics.append(StructuredMetric(code, source, base, basis))
            synonyms[code] = [prefix + writing for prefix in writings]
    return metrics, synonyms


def test_split_uses_prefix_shared_by_most_value_bases():
    metrics, synonyms = catalog({
        "CORP": ("对公日均存款余额", ["对公日均", "单位日均"]),
        "PSON": ("个人日均存款余额", ["个人日均"]),
        "MOBILE": ("手机银行客户数量", ["手机银行客户"]),
    })
    proposal = propose_alias_structure(metrics, synonyms)
    # “环比增幅”虽是“季度环比增幅”的结尾，按基础别名拆分后仍各归其口径。
    assert {(item["value_basis"], item["alias"]) for item in proposal["value_basis_aliases"]} == {
        ("当日数", "当日值"), ("较上月增幅", "环比增幅"), ("较上季增幅", "季度环比增幅"),
    }
    assert {(item["source_metric_code"], item["alias"])
            for item in proposal["base_aliases"]} == {
        ("CORP", "对公日均"), ("CORP", "单位日均"), ("PSON", "个人日均"),
        ("MOBILE", "手机银行客户"),
    }
    assert proposal["undecomposed"] == []


def test_alias_shared_by_two_bases_is_not_auto_approved():
    metrics, synonyms = catalog({
        "A": ("活期存款余额占比", ["活期比例"]),
        "B": ("个人活期存款余额占比", ["活期比例", "个人活期比例"]),
    })
    proposal = propose_alias_structure(metrics, synonyms)
    shared = [item for item in proposal["base_aliases"] if item["alias"] == "活期比例"]
    assert {item["source_metric_code"] for item in shared} == {"A", "B"}
    assert all(item["approved"] is False for item in shared)
    base, basis = derive_alias_structure(metrics, synonyms)
    # 冲突的“活期比例”不作为任何一方的基础别名。
    assert dict(base) == {"B": {"个人活期比例"}}
    assert len(basis) == 3


def test_synonym_without_value_basis_is_left_for_review():
    metrics = [StructuredMetric("LOAN:当日数", "LOAN", "各项贷款余额", "当日数")]
    proposal = propose_alias_structure(metrics, {"LOAN:当日数": ["贷款余额", "总贷款"]})
    assert proposal["base_aliases"] == []
    assert {item["synonym"] for item in proposal["undecomposed"]} == {"贷款余额", "总贷款"}
