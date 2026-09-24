"""新查询合同贯穿范围、计划与发布复核；全部使用合成目录和本地桩。"""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from ask_metric.application.commands import ExecuteQueryCommand
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
)
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.query.sql_builder import SqlBuilder

COHORT = {"kind": "authorized_cohort", "cohort": "rural_commercial_banks"}
NODES = (
    OrganizationHierarchyNode("R", "合成省级", None, "1"),
    OrganizationHierarchyNode("A", "合成同名法人行", "R", "3"),
    OrganizationHierarchyNode("B", "合成同名法人行", "R", "3"),
    OrganizationHierarchyNode("A1", "合成支行", "A", "2"),
)


class Uow:
    def __init__(self, nodes=NODES):
        self.organization_catalog = SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code=n.code, name=n.name) for n in nodes
        ])
        self.metric_catalog = SimpleNamespace(list_enabled=lambda: [
            MetricCatalogItem(code="M", name="合成客户数", unit="户"),
        ])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def fixture(org="R"):
    actor = ActorContext(subject="synthetic", user_id="synthetic", org_id=org,
                         role_code="USER", trust_level="authenticated",
                         authentication_method="test")
    snapshot = OrganizationHierarchySnapshot(NODES)
    hierarchy = SimpleNamespace(strict_snapshot=lambda: snapshot)
    permissions = ScopedOrganizationPermissionService(organization_scope_provider=SimpleNamespace(
        allowed_org_codes=snapshot.descendants_including,
        all_org_codes=lambda: {n.code for n in NODES},
    ))
    uow = Uow()
    execution = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql"), data_source=Mock(),
        permission_service=permissions, uow_factory=lambda: uow,
        sql_builder=SqlBuilder("mysql"), org_hierarchy_provider=hierarchy,
    )
    scope = resolve_query_scope(scope=COHORT, actor=actor,
                                organizations=uow.organization_catalog.list_enabled(),
                                permissions=permissions, hierarchy=hierarchy)
    return actor, execution, uow, scope


def query(**changes):
    return BasicQuerySpec.model_validate({
        "metric_codes": ["M"], "org_codes": ["A"],
        "time": {"start": "2026-04-30", "end": "2026-04-30"}, "selection": "exact",
        **changes,
    })


def test_date_and_ranking_are_independent_and_codes_are_actual_targets():
    actor, execution, uow, _ = fixture()
    spec = query(org_codes=["A", "B"], operation={"kind": "ranking", "order": "desc", "top_n": 3})
    dsl, plan, sql = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    assert dsl.orgs == ["A", "B"]
    assert plan.parameters["org_codes"] == ["A", "B"]
    assert plan.parameters["limit"] == 3
    assert plan.template.value == "metric_ranking_exact_desc"
    assert "ROW_NUMBER" in sql
    # 同名机构不能按名称把未请求的B带进目录证据。
    single = query()
    _, plan, _ = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=single.to_logical_dsl().model_dump(mode="json"),
        query_shape=single.query_shape, strict_codes=True,
    )
    assert [item["code"] for item in plan.catalog["organizations"]] == ["A"]


@pytest.mark.parametrize("change", [
    {"selection": "ranking"}, {"top_n": 3}, {"order": "desc"}, {"org_codes": []},
    {"operation": {"kind": "value", "top_n": 3}},
    {"operation": {"kind": "ranking", "order": "desc", "top_n": True}},
    {"operation": {"kind": "ranking"}},
    {"operation": {"kind": "ranking", "top_n": 3}},
    {"selection": "all_in_range", "operation": {"kind": "ranking", "order": "desc", "top_n": 5}},
    {"organization_scope": COHORT, "scope_fingerprint": "a" * 64},
    {"org_codes": [], "organization_scope": COHORT},
    {"scope_fingerprint": "a" * 64},
])
def test_invalid_contract_never_silently_drops_query_conditions(change):
    with pytest.raises(ValidationError):
        query(**change)


@pytest.mark.parametrize("org,expected", [("R", ["A", "B"]), ("A", ["A"])])
def test_authorized_cohort_is_resolved_once_not_expanded_to_branches(org, expected):
    actor, execution, uow, scope = fixture(org)
    spec = query(org_codes=[], organization_scope=COHORT,
                 scope_fingerprint=scope["scope_fingerprint"],
                 operation={"kind": "ranking", "order": "desc", "top_n": 3})
    dsl, plan, _ = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    assert dsl.orgs == expected and plan.parameters["org_codes"] == expected
    assert [o["code"] for o in plan.catalog["organizations"]] == expected


def test_scope_change_is_rejected_before_query_and_before_publication():
    actor, execution, uow, scope = fixture()
    spec = query(org_codes=[], organization_scope=COHORT,
                 scope_fingerprint=scope["scope_fingerprint"],
                 operation={"kind": "ranking", "order": "desc", "top_n": 3})
    _, plan, sql = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    # 取数过程中合法目录更名，指纹变化；结果必须为空且不提交成功快照。
    changed = tuple(replace(n, name="合成更名") if n.code == "B" else n for n in NODES)
    def read(**kwargs):
        execution.org_hierarchy_provider.strict_snapshot = (
            lambda: OrganizationHierarchySnapshot(changed)
        )
        execution.uow_factory = lambda: Uow(changed)
        return SimpleNamespace(rows=[{"metric_code": "M", "org_code": "A",
                                     "metric_value": 10, "stat_date": "2026-04-30",
                                     "rank": 1}], latency_ms=1)
    execution.data_source.execute_readonly.side_effect = read
    execution._prepare = Mock(return_value=(1, plan, sql, 1, {}))
    execution._finish_success = Mock()
    execution._finish_failure = Mock()
    result = execution.execute(ExecuteQueryCommand(task_id="test", expected_version=0,
                                                    actor=actor, request_id="test"))
    assert result.status == "failed" and result.error_code == "SCOPE_CHANGED"
    assert not result.rows and not result.facts
    execution._finish_success.assert_not_called()
    execution._finish_failure.assert_called_once()
    with pytest.raises(ApplicationError, match="机构范围已变化"):
        execution._build_governed_plan(
            uow=Uow(changed), actor=actor,
            logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
            query_shape=spec.query_shape, strict_codes=True,
        )


def test_history_permission_revocation_rejects_entire_ranking_snapshot():
    actor, execution, _, _ = fixture("A")
    service = QueryTaskApplicationService(permission_service=execution.permission_service)
    with pytest.raises(ApplicationError) as error:
        service._authorize_saved_result(actor, {
            "orgs": ["A", "B"], "options": {"organization_scope": "synchronized_catalog"},
        })
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"
    service._authorize_saved_result(actor, {"orgs": ["A"]})


@pytest.mark.parametrize("conflict", [False, True])
def test_ranking_population_is_not_top_n_length_and_conflicts_do_not_publish(conflict):
    actor, execution, uow, _ = fixture()
    spec = query(org_codes=["A", "B"], operation={"kind": "ranking", "order": "desc", "top_n": 1})
    _, plan, sql = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    execution.data_source.execute_readonly.return_value = SimpleNamespace(rows=[{
        "metric_code": "M", "org_code": "A", "metric_value": 10,
        "stat_date": "2026-04-30", "rank": 1,
        "rank_population": 2, "rank_data_conflict": int(conflict),
    }], latency_ms=1)
    execution._prepare = Mock(return_value=(1, plan, sql, 1, {}))
    execution._finish_success = Mock()
    execution._finish_failure = Mock()
    result = execution.execute(ExecuteQueryCommand(task_id="test", expected_version=0,
                                                    actor=actor, request_id="test"))
    if conflict:
        assert result.error_code == "DATA_CONFLICT" and not result.rows
        execution._finish_success.assert_not_called()
    else:
        assert result.status == "succeeded"
        assert result.evidence["ranking"][0]["with_data"] == 2
        assert result.evidence["ranking"][0]["without_data"] == 0
        assert result.evidence["ranking"][0]["returned"] == 1
        assert "rank_population" not in result.rows[0]
        assert "rank_data_conflict" not in result.rows[0]


def test_account_revoked_during_sql_prevents_result_publication():
    actor, execution, uow, _ = fixture()
    spec = query(operation={"kind": "ranking", "order": "desc", "top_n": 3})
    _, plan, sql = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    execution.data_source.execute_readonly.return_value = SimpleNamespace(rows=[{
        "metric_code": "M", "org_code": "A", "metric_value": 10,
        "stat_date": "2026-04-30", "rank": 1, "rank_population": 1,
    }], latency_ms=1)
    execution.actor_validator = Mock(side_effect=ApplicationError(
        "AUTH_USER_DISABLED", "账号已停用", status_code=401,
    ))
    execution._prepare = Mock(return_value=(1, plan, sql, 1, {}))
    execution._finish_success = Mock()
    execution._finish_failure = Mock()
    result = execution.execute(ExecuteQueryCommand(task_id="test", expected_version=0,
                                                   actor=actor, request_id="test"))
    assert result.status == "failed" and result.error_code == "AUTH_USER_DISABLED"
    assert not result.rows and not result.facts
    execution.actor_validator.assert_called_once_with(actor)
    execution._finish_success.assert_not_called()


def test_empty_exact_ranking_keeps_requested_date_in_evidence():
    actor, execution, uow, _ = fixture()
    spec = query(operation={"kind": "ranking", "order": "desc", "top_n": 3})
    _, plan, sql = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    execution.data_source.execute_readonly.return_value = SimpleNamespace(rows=[], latency_ms=1)
    execution._prepare = Mock(return_value=(1, plan, sql, 1, {}))
    execution._finish_success = Mock()
    result = execution.execute(ExecuteQueryCommand(task_id="test", expected_version=0,
                                                   actor=actor, request_id="test"))
    assert result.status == "succeeded"
    assert result.evidence["ranking"][0]["date"] == "2026-04-30"
    assert result.evidence["ranking"][0]["with_data"] == 0


def test_single_day_latest_range_is_canonical_exact_without_date_fallback():
    spec = query(selection="latest_in_range")
    assert spec.selection == "exact"
    assert spec.time.start == spec.time.end
    actor, execution, uow, _ = fixture()
    _, plan, _ = execution._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    assert plan.template.value == "metric_value_exact"


@pytest.mark.parametrize("raw,expected", [
    ("2025年末", "2025-12-31"), ("2025年底", "2025-12-31"),
    ("2025年初", "2025-01-01"), ("去年末", "2025-12-31"),
    ("年末", "2024-12-31"), ("今年底", "2026-12-31"),
])
def test_year_boundaries_are_single_days_and_relative_year_ignores_history(raw, expected):
    from datetime import date

    from ask_metric.application.field_resolution import resolve_date_field

    result = resolve_date_field(raw, date(2026, 9, 22), reference_year=2024)
    assert result["status"] == "resolved"
    assert result["value"] == {"start": expected, "end": expected}
