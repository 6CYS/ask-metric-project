"""经业务确认的指标简称与默认口径；只绑定当前启用目录，不生成指标编码。

结构化目录缺失时，仅对这里明确列出的业务概念兼容正式名称，不对全目录猜测结构。
普通净利润是未限定“净利润”的默认；考核、同比等限定必须保留。
"""

from dataclasses import dataclass

from ask_metric.domain.metric_matching import normalize_semantic_text as normalize
from ask_metric.domain.semantics import MetricCatalogItem


@dataclass(frozen=True)
class MetricDefaultFamily:
    variant: str
    bases: tuple[str, ...]
    terms: tuple[str, ...]


_FAMILIES = (
    MetricDefaultFamily("ordinary", ("净利润金额", "净利润"),
                        ("净利润", "净利润金额", "普通净利润", "普通净利润金额")),
    MetricDefaultFamily("assessment",
                        ("净利润金额_考核", "净利润_考核", "考核净利润金额", "考核净利润"),
                        ("考核净利润", "考核净利润金额", "净利润金额_考核", "净利润_考核")),
)
# 兼容旧目录时只接受完整的已知口径；不能把“净利润率”等其他业务含义拆成金额指标。
_BASES = {"当日数", "本年累计", "较同期", "较同期期末", "较上月", "较上季", "较年初",
          "全省均值", "较全省均值"}
_VALUE_BASES = {normalize(base + suffix) for base in _BASES
                for suffix in ("", "增幅", "排名", "增幅排名", "增量排名")}


@dataclass(frozen=True)
class MetricDefaultTerm:
    codes: frozenset[str]
    defaulted: bool
    variant: str
    # 泛称可继承同概念已确认口径；显式“考核/普通”仅允许在本家族内继承。
    context_codes: frozenset[str]


def business_metric_terms(items: list[MetricCatalogItem]) -> dict[str, MetricDefaultTerm]:
    families: dict[str, dict[str, set[str]]] = {family.variant: {} for family in _FAMILIES}
    bases = sorted(((normalize(base), family.variant) for family in _FAMILIES
                    for base in family.bases), key=lambda pair: -len(pair[0]))
    for item in items:
        name = normalize(item.name)
        for base, variant in bases:
            if not name.startswith(base):
                continue
            basis = name[len(base):]
            if basis in _VALUE_BASES:
                # 已有结构不能与业务规则冲突；不通过名称覆盖另一来源定义。
                if item.base_name and normalize(item.base_name) != base:
                    break
                if item.value_basis and normalize(item.value_basis) != basis:
                    break
                families[variant].setdefault(basis, set()).add(item.code)
                break
    all_codes = frozenset(code for members in families.values()
                          for codes in members.values() for code in codes)
    result = {}
    for family in _FAMILIES:
        members = families[family.variant]
        own_codes = frozenset(code for codes in members.values() for code in codes)
        for term in family.terms:
            for basis, codes in members.items():
                result[normalize(term) + basis] = MetricDefaultTerm(
                    frozenset(codes), False, family.variant, frozenset())
            defaults = members.get(normalize("当日数"))
            if defaults:
                result[normalize(term)] = MetricDefaultTerm(
                    frozenset(defaults), True, family.variant,
                    all_codes if term in ("净利润", "净利润金额") else own_codes)
    return result


def default_metadata(term: MetricDefaultTerm) -> dict:
    if not term.defaulted:
        return {}
    return {
        "default_value_basis": "当日数", "metric_concept": "net_profit",
        "metric_variant": term.variant, "resolution_source": "business_default",
        "context_codes": sorted(term.context_codes),
    }


def has_explicit_metric_qualifier(text: str, start: int, end: int) -> bool:
    """默认词不能吞掉紧邻的显式限定或尚未说完的口径；交回正常候选解析。"""
    before, after = text[:start], text[end:]
    return (any(before.endswith(term) for term in (
                "考核", "扣非", "人均", "归母", "税前", "税后", "日均", "月均", "年均",
                "累计", "美元", "欧元", "港元", "日元", "人民币", "境内", "境外",
            ))
            or any(after.startswith(term) for term in
                   ("较", "同比", "环比", "日均", "月均", "年均", "累计", "本年", "考核", "率")))
