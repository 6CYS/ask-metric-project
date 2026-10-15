"""合成目录验证，不连接模型、数据库或生产环境。"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.business_context import router
from ask_metric.api.routes.catalogs import get_overview_permissions, get_uow
from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.requests import ActorContext
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem


@pytest.mark.parametrize("raw", ["合成指标甲", "Ｍ１", "测试别名", " 合成 指标甲 "])
def test_exact_alias_and_normalized(raw):
    items = [MetricCatalogItem(code="M1", name="合成指标甲", aliases=["测试别名"])]
    assert resolve_catalog_field("metric", [raw], items) == {
        "status": "resolved", "value": {"codes": ["M1"], "names": ["合成指标甲"]},
    }


def test_duplicate_alias_is_ambiguous_even_with_many_candidates():
    items = [MetricCatalogItem(code=f"M{i}", name=f"合成指标{i}", aliases=["重复别名"])
             for i in range(80)]
    result = resolve_catalog_field("metric", ["重复别名"], items)
    assert result["status"] == "ambiguous"
    assert result["metadata"]["candidate_count"] == 80
    assert "value" not in result


def test_partial_match_requires_confirmation_and_missing_does_not_drop_filter():
    items = [MetricCatalogItem(code="M1", name="合成经营统计值")]
    assert resolve_catalog_field("metric", ["经营统计"], items)["status"] == "needs_confirmation"
    result = resolve_catalog_field("metric", ["合成经营统计值", "不存在的内容xyz"], items)
    assert result["status"] == "not_found"
    assert "value" not in result


def test_metric_raw_field_unchanged_and_org_unique_contains_resolves():
    items = [MetricCatalogItem(code="M", name="存款余额月日均")]
    result = resolve_catalog_field("metric", ["存款余鹅月日均"], items)
    assert result["status"] == "resolved"
    assert result["value"]["codes"] == ["M"]
    mixed = resolve_catalog_field("metric", ["存款余鹅月日均", "未知xyz"], items)
    assert mixed["status"] == "not_found"
    orgs = [OrganizationCatalogItem(code="O", name="合成机构甲")]
    result = resolve_catalog_field("organization", ["合成机构"], orgs)
    assert result["status"] == "resolved"
    assert result["value"]["codes"] == ["O"]
    assert result["metadata"]["resolution_source"] == "contains"


def test_resolver_endpoint_enforces_identity_permission_and_contract():
    from types import SimpleNamespace

    class Uow:
        organization_catalog = SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code="O1", name="合成机构甲"),
            OrganizationCatalogItem(code="O2", name="另一家村镇银行"),
        ])
        metric_catalog = SimpleNamespace(list_enabled=lambda: [
            MetricCatalogItem(code="M1", name="合成指标全称", aliases=["合成指标"]),
        ])

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_uow] = Uow
    app.dependency_overrides[get_overview_permissions] = lambda: SimpleNamespace(
        authorize_logical_dsl=lambda **kwargs: {"orgs": ["O1"]},
    )
    client = TestClient(app)
    from ask_metric.core.security import AuthenticationError

    with pytest.raises(AuthenticationError):
        client.post("/api/v1/business-context/resolve-field", json={
            "entity": "organization", "raw_values": ["另一家村镇银行"],
        })
    with pytest.raises(AuthenticationError):
        client.post("/api/v1/business-context/metric-mentions", json={"question": "合成指标"})
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="synthetic", user_id="synthetic", org_id="O1", role_code="USER",
        authentication_method="local_jwt", trust_level="authenticated",
    )
    assert client.post("/api/v1/business-context/resolve-field", json={
        "entity": "organization", "raw_values": ["另一家村镇银行"],
    }).json()["status"] == "needs_confirmation"
    # 建议候选只来自权限过滤后的目录，不泄露越权机构。
    body = client.post("/api/v1/business-context/resolve-field", json={
        "entity": "organization", "raw_values": ["另一家村镇银行"],
    }).json()
    assert {candidate["code"] for candidate in body["candidates"]} == {"O1"}
    assert body["candidates"][0]["metadata"]["match_kind"] == "fuzzy_suggestion"
    assert client.post("/api/v1/business-context/resolve-field", json={
        "entity": "organization", "raw_values": ["合成机构甲"],
    }).json()["value"]["codes"] == ["O1"]
    assert client.post("/api/v1/business-context/resolve-field", json={
        "entity": "organization", "raw_values": ["合成机构甲"], "code": "O2",
    }).status_code == 422
    response = client.post("/api/v1/business-context/metric-mentions", json={
        "question": "查合成指标全称",
    })
    assert response.json()["mentions"][0]["resolution"]["value"]["codes"] == ["M1"]
    assert client.post("/api/v1/business-context/metric-mentions", json={
        "question": "合成指标", "code": "invented",
    }).status_code == 422


def test_org_catalog_endpoint_enforces_identity_and_permission_filter():
    from types import SimpleNamespace

    class Uow:
        organization_catalog = SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code="O1", name="合成机构甲", aliases=["机构甲"]),
            OrganizationCatalogItem(code="O2", name="合成机构乙", aliases=["机构乙"]),
        ])

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_uow] = Uow
    app.dependency_overrides[get_overview_permissions] = lambda: SimpleNamespace(
        authorize_logical_dsl=lambda **kwargs: {"orgs": ["O1"]},
    )
    client = TestClient(app)
    from ask_metric.core.security import AuthenticationError

    with pytest.raises(AuthenticationError):
        client.get("/api/v1/business-context/org-catalog")
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="synthetic", user_id="synthetic", org_id="O1", role_code="USER",
        authentication_method="local_jwt", trust_level="authenticated",
    )
    response = client.get("/api/v1/business-context/org-catalog")
    assert response.status_code == 200
    # 只返回当前账号授权的机构；别名完整透传（运行时已合并派生短称）。
    assert response.json() == {"items": [
        {"code": "O1", "name": "合成机构甲", "aliases": ["机构甲"]},
    ]}


@pytest.mark.parametrize("raw,start,end", [
    ("2024年2月", "2024-02-01", "2024-02-29"),
    ("2026年2月末", "2026-02-28", "2026-02-28"),
    ("上个月", "2026-08-01", "2026-08-31"),
    ("昨天", "2026-09-20", "2026-09-20"),
    ("去年", "2025-01-01", "2025-12-31"),
    ("今年", "2026-01-01", "2026-09-21"),
    ("2026年第二季度", "2026-04-01", "2026-06-30"),
    ("2026年上半年", "2026-01-01", "2026-06-30"),
    ("3月末", "2026-03-31", "2026-03-31"),
    ("近3天", "2026-09-19", "2026-09-21"),
    ("2026-01-01至2026-02-28", "2026-01-01", "2026-02-28"),
])
def test_date_resolver_reuses_existing_calendar_rules(raw, start, end):
    from datetime import date

    from ask_metric.application.field_resolution import resolve_date_field

    result = resolve_date_field(raw, date(2026, 9, 21))
    assert result["status"] == "resolved"
    assert result["value"] == {"start": start, "end": end}


@pytest.mark.parametrize("raw,start,end", [
    ("2026年4月范围内最后一个有数据日期", "2026-04-01", "2026-04-30"),
    ("2026年第二季度期间最后有值日", "2026-04-01", "2026-06-30"),
    ("2026-01-01至2026-02-28范围内最后一个有记录的日期", "2026-01-01", "2026-02-28"),
    ("4月内最后有数据日", "2024-04-01", "2024-04-30"),
    ("上月范围内最新有数据日", "2026-08-01", "2026-08-31"),
    ("2026年4月30日范围内最后有数据日期", "2026-04-30", "2026-04-30"),
    ("2026年4月末范围内最后一个有数据日", "2026-04-30", "2026-04-30"),
    ("2026年4月份 范围内 的 最后一个 有记录 的 日期", "2026-04-01", "2026-04-30"),
])
def test_bounded_latest_data_date_preserves_calendar_range(raw, start, end):
    from datetime import date

    from ask_metric.application.field_resolution import resolve_date_field
    from ask_metric.domain.time_expression import parse_time_expression

    today = date(2026, 9, 21)
    result = resolve_date_field(raw, today, reference_year=2024)
    assert result["status"] == "resolved"
    # 解析器不推测最后有数日；月份/季度/区间仍返回原始日历边界。
    assert result["value"] == {"start": start, "end": end}
    parsed = parse_time_expression(raw, today=today, reference_year=2024)
    assert parsed.start.isoformat() == start
    assert parsed.end.isoformat() == end


@pytest.mark.parametrize("raw", [
    "范围内最后一个有数据日期",
    "最新范围内最后一个有数据日期",
    "2026年2月30日范围内最后一个有数据日期",
    "2025年2月29日范围内最后一个有数据日期",
    "2099年2月30日范围内最后一个有数据日期",
    "2026年13月范围内最后一个有数据日期",
    "2026年4月和5月范围内最后一个有数据日期",
    "2026年4月或2026年5月范围内最后一个有数据日期",
    "2026-05-01至2026-04-30范围内最后一个有数据日期",
    "不含月初的2026年4月范围内最后一个有数据日期",
    "2026年4月范围内最后一个有数据日期，不含4月15日",
    "2026年4月范围内第一个有数据日期",
    "2026年4月范围内最后一个交易日期",
    "2026年4月范围内最后有数据日期范围内最后有数据日期",
    "2026年4月1日、2026年4月2日范围内最后有数据日期",
    "2026年4月1日范围内最后有数据日期、2026年4月2日",
    "2026年4月1日范围内最后有数据日期、2026年4月2日范围内最后有数据日期",
    "2026年4月末较3月末范围内最后有数据日",
    "2026年4月末比3月末范围内最后有数据日",
    "2026年4月末对比3月末范围内最后有数据日",
    "2026年4月末比较3月末范围内最后有数据日",
])
def test_latest_data_date_qualifier_does_not_discard_other_conditions(raw):
    from datetime import date

    from ask_metric.application.field_resolution import resolve_date_field

    result = resolve_date_field(raw, date(2026, 9, 21))
    assert result["status"] == "invalid"
    assert result["metadata"]["reason"] in {"invalid_calendar", "unsupported_expression"}


@pytest.mark.parametrize("raw", ["2025-02-29", "2026-13-01", "上个业务结算日", "最新"])
def test_date_unresolved_does_not_guess(raw):
    from datetime import date

    from ask_metric.application.field_resolution import resolve_date_field

    result = resolve_date_field(raw, date(2026, 9, 21))
    assert result["status"] == "invalid"
    assert result["metadata"]["reason"] in {"invalid_calendar", "unsupported_expression"}


@pytest.mark.parametrize("raw,start,end", [
    ("4 月份", "2024-04-01", "2024-04-30"),
    ("2月末", "2024-02-29", "2024-02-29"),
    ("3月15日", "2024-03-15", "2024-03-15"),
    ("第二季度", "2024-04-01", "2024-06-30"),
    ("今年4月", "2026-04-01", "2026-04-30"),
    ("去年4月", "2025-04-01", "2025-04-30"),
    ("上月", "2026-08-01", "2026-08-31"),
    ("昨天", "2026-09-20", "2026-09-20"),
])
def test_yearless_calendar_inherits_but_relative_dates_use_today(raw, start, end):
    from datetime import date

    from ask_metric.application.field_resolution import resolve_date_field

    result = resolve_date_field(raw, date(2026, 9, 21), reference_year=2024)
    assert result["status"] == "resolved"
    assert result["value"] == {"start": start, "end": end}


@pytest.mark.parametrize("year", [0, 10000, "invalid"])
def test_reference_year_contract_rejects_invalid_values(year):
    from pydantic import ValidationError

    from ask_metric.api.routes.business_context import ResolveFieldRequest

    with pytest.raises(ValidationError):
        ResolveFieldRequest(entity="date", raw_values=["4月"], reference_year=year)
