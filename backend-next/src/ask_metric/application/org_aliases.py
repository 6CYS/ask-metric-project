"""机构别名派生：法人行正式名称 → 常用短称变体。

正式名称结构为「江苏 + 地名 + 农村商业银行等银行形式 + 公司形式后缀」，
派生只按这个封闭结构剥离，不猜测专有名词；省级联合银行/汇总节点等
非“地名 + 农商行”结构不派生。派生别名与人工别名合并时人工优先
（合并处用 dict.fromkeys 保留先出现的人工词条）。
"""

_COMPANY_SUFFIXES = ("股份有限公司", "有限责任公司", "有限公司", "公司")
# 银行形式只覆盖法人农商行系列；“银行”过宽（会误中联合银行等非派生对象），不纳入。
_BANK_FORMS = ("农村商业银行", "农商银行", "农商行", "农商")
_PROVINCE_PREFIX = "江苏"
_ALIAS_FORMS = ("", "农商", "农商行", "农商银行", "农村商业银行")


def derive_org_aliases(name: str) -> list[str]:
    text = name.strip()
    body = text
    for suffix in _COMPANY_SUFFIXES:
        if body.endswith(suffix) and len(body) > len(suffix):
            body = body[: -len(suffix)]
            break
    short = None
    for form in _BANK_FORMS:
        if body.endswith(form) and len(body) > len(form):
            short = body[: -len(form)]
            break
    if short is None:
        # 省级根节点（如“江苏农商联合银行（全省汇总）”）等非派生结构。
        return []
    provincial = short.startswith(_PROVINCE_PREFIX)
    if provincial:
        short = short[len(_PROVINCE_PREFIX):]
    if len(short) < 2:
        return []
    variants = [short + form for form in _ALIAS_FORMS]
    if provincial:
        variants += [_PROVINCE_PREFIX + variant for variant in variants]
    return list(dict.fromkeys(variants))


def org_core_form(text: str) -> str:
    """反复剥离组织形式后缀与省前缀的核心名。

    只用于零命中时澄清候选的打分，不参与解析判定（解析走目录字面与别名）。
    """
    core = text.strip()
    changed = True
    while changed:
        changed = False
        for suffix in (*_COMPANY_SUFFIXES, *_BANK_FORMS):
            if core.endswith(suffix) and len(core) > len(suffix):
                core = core[: -len(suffix)]
                changed = True
                break
    if core.startswith(_PROVINCE_PREFIX) and len(core) > len(_PROVINCE_PREFIX):
        core = core[len(_PROVINCE_PREFIX):]
    return core
