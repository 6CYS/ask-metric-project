"""主题导航不能替代当前检索词的相关性；目录样本仅用于隔离测试。"""

import pytest

from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.domain.semantics import MetricCatalogItem


@pytest.fixture
def semantics():
    catalog = [
        MetricCatalogItem(code="balance", name="各项存款余额当日数", unit="元"),
        MetricCatalogItem(code="monthly", name="各项存款月日均余额均值当日数", unit="元"),
        MetricCatalogItem(code="yearly", name="各项存款年日均余额当日数", unit="元"),
        MetricCatalogItem(code="change", name="各项存款余额较同期", unit="元"),
        MetricCatalogItem(code="rate", name="各项存款余额较同期增幅", unit="%"),
        MetricCatalogItem(code="personal", name="个人存款余额当日数", unit="元"),
    ]
    service = MetricSemantics(catalog, secret="test", actor_id="user", topics={})
    service.topic_groups = {
        "deposit": {
            "name": "存款", "default_sections": ["scale", "growth"],
            "codes": ["balance", "change", "personal"],
        },
    }
    return service


@pytest.mark.parametrize(("keyword", "code"), [
    ("各项存款月日均余额", "monthly"),
    ("各项存款年日均余额", "yearly"),
    ("各项存款余额较同期增幅", "rate"),
    ("monthly", "monthly"),
])
def test_specific_basis_is_not_displaced_by_topic_members(semantics, keyword, code):
    result = semantics.search(keyword, page_size=1)

    assert result["items"][0]["code"] == code
    assert semantics.resolve(result["items"][0]["binding_ref"])["code"] == code


def test_topic_hint_is_navigation_without_injecting_unmatched_members(semantics):
    result = semantics.search("各项存款", page_size=2)
    rest = semantics.search("各项存款", page=2, page_size=2)

    assert result["topic_hints"][0]["topic"] == "deposit"
    assert result["total"] == 5
    assert len({item["code"] for item in result["items"] + rest["items"]}) == 4
    assert result["has_more"] is True
    assert "personal" not in [
        item["code"] for item in semantics.search("各项存款")["items"]
    ]


def test_topic_members_are_not_treated_as_matches_for_an_exact_code(semantics):
    result = semantics.search("balance")

    assert [item["code"] for item in result["items"]] == ["balance"]
    assert result["total"] == 1
    assert result["has_more"] is False
    assert result["topic_hints"][0]["topic"] == "deposit"
