"""隔离 SQLite 应用库、合成指标数据源；使用真实任务、SQL builder 和 Decimal 计算。"""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from ask_metric.application.business_overview import (
    BusinessOverviewService,
    OverviewRequest,
    bind_metrics,
    load_topic,
)
from ask_metric.application.calculation_service import CalculationApplicationService
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.db.base import Base
from ask_metric.infrastructure.db.models import ChatConversation, MetricTerm, OrgTerm, QueryTask
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork


class SampleDataSource:
    """仅按 builder 参数读取隔离样本，记录调用；不连接配置中的业务数据库。"""

    def __init__(self, metrics, observations):
        self.metrics = metrics
        self.observations = observations
        self.calls = []

    def execute_readonly(self, *, sql, parameters):
        self.calls.append((sql, parameters))
        codes = parameters["metric_codes"]
        if "require_all" in parameters:
            start, end = parameters.get("start_date"), parameters.get("end_date")
            dates = sorted(
                {
                    day
                    for code, day, value in self.observations
                    if code in codes
                    and value is not None
                    and (not start or day >= start)
                    and (not end or day <= end)
                },
                reverse=True,
            )
            rows = [
                {
                    "scope": "any",
                    "org_code": "",
                    "metric_code": "",
                    "date_count": len(dates),
                    "earliest": min(dates),
                    "latest": max(dates),
                    "stat_date": day,
                }
                for day in dates[: parameters["page_end"]]
            ]
        else:
            dates = parameters.get("stat_dates") or parameters.get("target_dates")
            start = parameters.get("start_date") or parameters.get("stat_date")
            end = parameters.get("end_date") or start
            rows = [
                {
                    "metric_code": code,
                    "metric_name": self.metrics[code]["name"],
                    "org_code": parameters["org_codes"][0],
                    "org_name": "合成机构",
                    "stat_date": day,
                    "metric_value": value,
                    "unit": self.metrics[code]["unit"],
                }
                for code, day, value in self.observations
                if code in codes
                and (
                    day in dates
                    if dates
                    else (not start or day >= start) and (not end or day <= end)
                )
            ]
        return SimpleNamespace(rows=rows, latency_ms=1)


def make_environment(db_path, *, source_metrics=None, observations=None):
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    actor = ActorContext(
        subject="overview-test",
        user_id="overview-user",
        org_id="O1",
        authentication_method="test",
        trust_level="authenticated",
    )
    topic = load_topic()
    metrics = source_metrics or {
        item["id"]: {"name": item["names"][-1], "unit": item["units"][-1]}
        for item in topic["metrics"]
    }
    with sessions() as session:
        session.add_all(
            [
                MetricTerm(
                    metric_code=code,
                    metric_name=item["name"],
                    unit=item["unit"],
                    value_basis="当日数",
                )
                for code, item in metrics.items()
            ]
        )
        session.add_all(
            [
                OrgTerm(org_code="O1", org_name="合成机构"),
                OrgTerm(org_code="O2", org_name="无权机构"),
            ]
        )
        session.add(
            ChatConversation(
                id="overview-conversation",
                owner_user_id=actor.user_id,
                title="隔离测试",
                preview="",
            )
        )
        session.commit()
    permissions = ScopedOrganizationPermissionService(
        organization_scope_provider=SimpleNamespace(
            allowed_org_codes=lambda org: {org},
            all_org_codes=lambda: {"O1", "O2"},
        )
    )
    source = SampleDataSource(
        metrics,
        observations
        or [
            (
                code,
                date(2026, month, 30 if month == 6 else 31),
                Decimal("120" if code == "total" else "20"),
            )
            for code in metrics
            for month in [6, 7]
        ],
    )
    execution = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql"),
        data_source=source,
        permission_service=permissions,
        uow_factory=lambda: SqlAlchemyUnitOfWork(sessions),
    )
    tasks = QueryTaskApplicationService(
        lambda: SqlAlchemyUnitOfWork(sessions), permission_service=permissions
    )
    service = BusinessOverviewService(tasks, execution, CalculationApplicationService(execution))
    return service, actor, sessions, source, engine


@pytest.fixture
def environment(tmp_path):
    env = make_environment(tmp_path / "overview.sqlite")
    yield env
    env[-1].dispose()


def request(**changes):
    return OverviewRequest.model_validate(
        {
            "topic_version": "loan-pilot-v1",
            "start": "2026-07-01",
            "end": "2026-07-31",
            "conversation_id": "overview-conversation",
            "calculation_context": {
                "scope_id": "overview-operation",
                "user_question": "7月贷款情况",
            },
            **changes,
        }
    )


def test_complete_plan_executes_existing_tasks_and_calculations(environment):
    service, actor, sessions, source, _ = environment
    result = service.execute(request(), actor, "test-overview", today=date(2026, 8, 1))
    assert result["status"] == "succeeded"
    assert result["analysis_date"] == "2026-07-31"
    assert result["calculations"]
    assert "季度指标" in result["public_answer"]
    assert "缺少2025" in result["public_answer"]
    assert "百分点" in result["public_answer"]
    with sessions() as session:
        assert session.scalars(select(QueryTask)).all()
    # 基础查询计划由正式 builder 生成，模型没有 SQL 输入。
    assert all("SELECT" in sql.upper() for sql, _ in source.calls)


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"sections": ["scale"]}, "ANALYSIS_PLAN_INCOMPLETE"),
        ({"topic_version": "obsolete"}, "TOPIC_VERSION_CHANGED"),
        ({"allow_latest_reference": True}, "ANALYSIS_FALLBACK_INVALID"),
        ({"end": "2026-07-15"}, "ANALYSIS_DATE_INVALID"),
        ({"org_codes": ["unknown"]}, "ANALYSIS_ORG_INVALID"),
    ],
)
def test_invalid_plan_never_executes_data_source(environment, changes, code):
    service, actor, _, source, _ = environment
    with pytest.raises(ApplicationError) as error:
        service.execute(request(**changes), actor, "invalid", today=date(2026, 10, 12))
    assert error.value.code == code
    assert not source.calls


def test_explicit_missing_month_is_not_replaced_by_latest(environment):
    service, actor, _, _, _ = environment
    result = service.execute(
        request(start="2026-08-01", end="2026-08-31"),
        actor,
        "missing-month",
        today=date(2026, 10, 12),
    )
    assert result["analysis_date"] is None
    assert not result["tasks"]
    assert "不改用其他日期" in result["public_answer"]


def test_current_month_discloses_latest_reference(environment):
    service, actor, _, _, _ = environment
    result = service.execute(
        request(start=None, end=None, allow_latest_reference=True),
        actor,
        "current-month",
        today=date(2026, 10, 12),
    )
    assert result["requested_date"] == "2026-10-31"
    assert result["analysis_date"] == "2026-07-31"
    assert "本月尚无完整月末数据" in result["public_answer"]


def test_ambiguous_binding_and_compound_indicators_are_not_selected():
    topic = load_topic()
    catalog = [
        MetricCatalogItem(code="a", name="各项贷款", unit="亿元"),
        MetricCatalogItem(code="b", name="各项贷款", unit="亿元"),
        MetricCatalogItem(code="c", name="个人贷款同比增幅", unit="%"),
    ]
    bound, gaps = bind_metrics(topic, catalog)
    assert "total" not in bound and "personal" not in bound
    assert any(gap["reason"] == "指标绑定冲突" for gap in gaps)


def test_same_request_reuses_task_and_calculation_ids(environment):
    service, actor, sessions, _, _ = environment
    first = service.execute(request(), actor, "replay", today=date(2026, 8, 1))
    second = service.execute(request(), actor, "replay", today=date(2026, 8, 1))
    assert first["tasks"] == second["tasks"]
    assert [x["calculation_id"] for x in first["calculations"]] == [
        x["calculation_id"] for x in second["calculations"]
    ]
    with sessions() as session:
        assert len(session.scalars(select(QueryTask)).all()) == len(first["tasks"])


def test_unauthorized_organization_never_queries(environment):
    service, actor, _, source, _ = environment
    with pytest.raises((PermissionDeniedError, ApplicationError)):
        service.execute(request(org_codes=["O2"]), actor, "forbidden")
    assert not source.calls


def test_wrong_composition_is_disclosed_without_attribution(environment):
    service, actor, _, _, _ = environment
    result = service.execute(request(), actor, "bad-composition", today=date(2026, 8, 1))
    assert any(not item["passed"] for item in result["reconciliations"])
    assert "超过组成核对容差" in result["public_answer"]
    assert "推动" not in result["public_answer"]


def test_consistent_composition_and_shares_use_fact_receipts(environment):
    service, actor, _, source, _ = environment
    source.observations = [
        (code, day, Decimal("60") if code == "company" else value)
        for code, day, value in source.observations
    ]
    source.observations += [
        ("total", date(2025, 7, 31), Decimal("100")),
        ("total", date(2025, 12, 31), Decimal("110")),
    ]
    # total=120, company=60, personal=20, discount=20 仍有20残差；修正合成组成。
    source.observations = [
        (code, day, Decimal("40") if code == "discount" else value)
        for code, day, value in source.observations
    ]
    result = service.execute(request(), actor, "consistent", today=date(2026, 8, 1))
    assert len(result["reconciliations"]) == 2
    assert all(item["passed"] for item in result["reconciliations"])
    share = next(
        item
        for item in result["calculations"]
        if item["metric"] == "company" and item["comparison"] == "share"
    )
    assert share["results"][0]["display_value"] == "50.00"
    assert all(item["fact_id"] for item in share["inputs"].values())


def test_quality_missing_is_not_zero_filled(environment):
    service, actor, _, source, _ = environment
    source.observations = [
        (code, day, value) for code, day, value in source.observations if not code.startswith("npl")
    ]
    result = service.execute(
        request(goal="quality", sections=["quality"]),
        actor,
        "missing-quality",
        today=date(2026, 8, 1),
    )
    assert not result["facts"].get("npl_ratio")
    assert "目标日期无有效值" in result["public_answer"]
    assert "不良贷款率为0" not in result["public_answer"]


def test_zero_baseline_preserves_delta_without_invented_growth(environment):
    service, actor, _, source, _ = environment
    source.observations = [
        (code, day, Decimal("0") if code == "total" and day.month == 6 else value)
        for code, day, value in source.observations
    ]
    result = service.execute(
        request(goal="growth", sections=["growth"]), actor, "zero-base", today=date(2026, 8, 1)
    )
    mom = next(item for item in result["calculations"] if item["comparison"] == "mom")
    assert len(mom["results"]) == 1
    assert mom["results"][0]["value"] == "120"


def test_mid_month_latest_cannot_be_used_as_complete_month(environment):
    service, actor, _, source, _ = environment
    source.observations = [
        (code, date(2026, 10, 10), value) for code, _, value in source.observations
    ]
    result = service.execute(
        request(start=None, end=None, allow_latest_reference=True),
        actor,
        "mid-month",
        today=date(2026, 10, 12),
    )
    assert result["analysis_date"] is None
    assert not result["tasks"]
    assert "最新记录不是月末" in result["public_answer"]


def test_api_contract_authentication_plan_and_permissions(environment):
    from ask_metric.api.dependencies import require_actor
    from ask_metric.api.query_readiness import require_query_ready
    from ask_metric.api.routes.business_overview import get_overview_service, router
    from ask_metric.core.errors import install_exception_handlers

    service, actor, _, source, _ = environment
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)

    def sample_identity(authorization: str | None = Header(default=None)):
        if authorization != "Bearer isolated-test":
            raise HTTPException(401, "测试登录无效")
        return actor

    app.dependency_overrides.update(
        {
            require_actor: sample_identity,
            require_query_ready: lambda: None,
            get_overview_service: lambda: service,
        }
    )
    with TestClient(app) as client:
        assert client.get("/api/v1/business-topics/loan").status_code == 401
        headers = {"Authorization": "Bearer isolated-test", "Idempotency-Key": "api-test"}
        topic = client.get("/api/v1/business-topics/loan", headers=headers).json()
        assert topic["version"] == "loan-pilot-v1"
        assert "total" in topic["bindings"]
        payload = request(topic_version="obsolete").model_dump(mode="json")
        denied = client.post("/api/v1/business-overviews", headers=headers, json=payload)
        assert denied.status_code == 409 and denied.json()["code"] == "TOPIC_VERSION_CHANGED"
        payload = request(org_codes=["O2"]).model_dump(mode="json")
        denied = client.post("/api/v1/business-overviews", headers=headers, json=payload)
        assert denied.status_code == 403
        assert not source.calls
        payload = request().model_dump(mode="json")
        response = client.post("/api/v1/business-overviews", headers=headers, json=payload)
        assert response.status_code == 200
        assert response.json()["status"] == "succeeded"
        assert "public_answer" in response.json()


def test_falling_total_is_not_described_as_growth(environment):
    service, actor, _, source, _ = environment
    periods = {
        date(2026, 6, 30): {"total": "120", "company": "60", "personal": "20", "discount": "40"},
        date(2026, 7, 31): {"total": "100", "company": "70", "personal": "10", "discount": "20"},
    }
    source.observations = [
        (code, day, Decimal(value))
        for day, metrics in periods.items()
        for code, value in metrics.items()
    ]
    result = service.execute(request(), actor, "negative-total", today=date(2026, 8, 1))
    assert all(item["passed"] for item in result["reconciliations"])
    assert "减少20.00" in result["public_answer"]
    assert "本月增长主要由" not in result["public_answer"]
    assert "正向贡献" in result["public_answer"] and "负向贡献" in result["public_answer"]
