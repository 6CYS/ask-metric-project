"""机构别名派生：法人行正式名剥前缀与形式后缀生成短称变体；根节点不派生。"""

from ask_metric.application.org_aliases import derive_org_aliases


def test_legal_entity_name_derives_short_and_form_variants():
    aliases = derive_org_aliases("江苏江阴农村商业银行股份有限公司")
    assert "江阴" in aliases
    assert "江阴农商" in aliases
    assert "江阴农商行" in aliases
    assert "江阴农商银行" in aliases
    assert "江阴农村商业银行" in aliases
    # 带省前缀的写法同样覆盖，正式名未带前缀时不额外生成。
    assert "江苏江阴农商行" in aliases


def test_provincial_root_does_not_derive():
    assert derive_org_aliases("江苏农商联合银行（全省汇总）") == []
    assert derive_org_aliases("江苏农商联合银行") == []


def test_name_without_company_suffix_still_derives():
    aliases = derive_org_aliases("江苏紫金农村商业银行")
    assert "紫金" in aliases
    assert "紫金农商行" in aliases


def test_name_without_province_prefix_has_no_prefixed_variants():
    aliases = derive_org_aliases("江南农村商业银行")
    assert "江南" in aliases
    assert "江南农商行" in aliases
    assert not any(alias.startswith("江苏") for alias in aliases)


def test_non_legal_entity_structures_do_not_derive():
    # 空串、纯形式词、剥空后无短名的结构都不派生。
    for name in ("", "银行", "江苏", "江苏农商银行", "农商银行"):
        assert derive_org_aliases(name) == []
