"""正式范围、权限及目录同步回归；仅合成目录和可丢弃 SQLite。"""

from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.business_context import get_scope_hierarchy, router
from ask_metric.api.routes.catalogs import get_overview_permissions, get_uow
from ask_metric.application.catalog_sync import SitCatalogSyncService
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import install_exception_handlers
from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
    OrganizationScopeError,
    OrganizationScopeSpec,
    is_authorized_cohort_source,
)
from ask_metric.domain.semantics import OrganizationCatalogItem
from ask_metric.infrastructure.db.models import OrgTerm
from ask_metric.infrastructure.db.org_hierarchy import SqlAlchemyOrgHierarchyProvider

COHORT = {"kind": "authorized_cohort", "cohort": "rural_commercial_banks"}
NODES = (
    OrganizationHierarchyNode("R", "合成省级", None, "1"),
    OrganizationHierarchyNode("A", "合成甲农商行", "R", "3"),
    OrganizationHierarchyNode("B", "合成乙农商行汇总", "R", "3"),
    OrganizationHierarchyNode("A1", "合成甲支行", "A", "2"),
    OrganizationHierarchyNode("A2", "合成甲第二支行", "A", "2"),
)


@pytest.mark.parametrize("source", [
    "各家农商行", "各农商行", "所有农商银行", "全部农村商业银行", "全省各行",
    "全省的各家农商行", "省内农商行", "我有权限查看的各家农商行",
    "账号可查看的农商行范围内", "在账号可查看的农商行范围内",
    "账号权限内各家农商行", "当前账号权限范围内的农商行", "可见的各行",
    " 各 家 农 商 行 ",
])
def test_cohort_source_requires_explicit_collective_expression(source):
    assert is_authorized_cohort_source("rural_commercial_banks", source)


@pytest.mark.parametrize("source", [
    "合成不存在农商行", "甲农商行", "南京农村商业银行", "农商行", "各家",
    "各家农商行支行", "甲农商行的所有支行", "各家农商行除甲行", "各家农商行和甲支行",
    "不是所有农商行", "仅甲农商行", "甲行或所有农商行", "权限内甲农商行",
    "所有机构", "全省汇总", "",
])
def test_concrete_unknown_partial_or_qualified_sources_cannot_expand_to_cohort(source):
    assert not is_authorized_cohort_source("rural_commercial_banks", source)


def test_cohort_source_does_not_support_unknown_cohort():
    assert not is_authorized_cohort_source("unknown", "各家农商行")


def actor(org="R", role="USER", trust="authenticated"):
    return ActorContext(
        subject="synthetic", user_id="synthetic", org_id=org, role_code=role,
        authentication_method="test", trust_level=trust,
    )


def resolve(scope=COHORT, *, identity=None, nodes=NODES, permissions=None, organizations=None):
    snapshot = OrganizationHierarchySnapshot(nodes=nodes)
    return resolve_query_scope(
        scope=scope, actor=identity or actor(),
        organizations=organizations if organizations is not None else [
            OrganizationCatalogItem(code=node.code, name=node.name) for node in nodes
        ],
        permissions=permissions or ScopedOrganizationPermissionService(),
        hierarchy=SimpleNamespace(strict_snapshot=lambda: snapshot),
    )


@pytest.mark.parametrize("identity,expected", [
    (actor(), ["A", "B"]), (actor(role="SYSTEM_ADMIN"), ["A", "B"]),
    (actor("A"), ["A"]),
])
def test_cohort_keeps_only_authorized_legal_entities(identity, expected):
    result = resolve(identity=identity)
    assert result["codes"] == expected
    assert result["scope"] == COHORT
    assert len(result["scope_fingerprint"]) == 64


def test_configured_all_org_grant_and_explicit_requests_share_permissions():
    snapshot = OrganizationHierarchySnapshot(NODES)
    provider = SimpleNamespace(
        allowed_org_codes=snapshot.descendants_including,
        all_org_codes=lambda: {node.code for node in NODES},
    )
    permissions = ScopedOrganizationPermissionService(
        organization_scope_provider=provider, all_organization_org_codes={"A"},
    )
    assert resolve(identity=actor("A"), permissions=permissions)["codes"] == ["A", "B"]
    assert permissions.authorize_logical_dsl(
        actor=actor("A"), logical_dsl={"orgs": ["B"]},
    )["orgs"] == ["B"]
    permissions = ScopedOrganizationPermissionService(organization_scope_provider=provider)
    with pytest.raises(PermissionDeniedError):
        permissions.authorize_logical_dsl(actor=actor("A"), logical_dsl={"orgs": ["B"]})
    assert permissions.authorize_logical_dsl(actor=actor("A"), logical_dsl={})["orgs"] == ["A"]
    assert permissions.authorize_logical_dsl(actor=actor("A"), logical_dsl={
        "orgs": ["A", "B"], "options": {"organization_scope": "synchronized_catalog"},
    })["orgs"] == ["A"]


def test_children_is_direct_not_recursive_and_allows_permission_intersection():
    scope = {"kind": "children_of", "parent_code": "A"}
    assert resolve(scope)["codes"] == ["A1", "A2"]
    assert resolve(scope, identity=actor("A1"))["codes"] == ["A1"]


@pytest.mark.parametrize("identity,code", [
    (actor("A1"), "EMPTY_AUTHORIZED_SCOPE"),
    (actor("missing"), "PERMISSION_DENIED"),
    (actor(trust="anonymous"), "PERMISSION_DENIED"),
])
def test_scope_failures_are_explicit(identity, code):
    with pytest.raises(OrganizationScopeError) as error:
        resolve(identity=identity)
    assert error.value.code == code


@pytest.mark.parametrize("nodes", [
    (),
    tuple(replace(node, parent_code=None, hierarchy_level=None) for node in NODES),
    (replace(NODES[0], parent_code="A"), *NODES[1:]),
    (*NODES[:2], replace(NODES[2], parent_code=None), *NODES[3:]),
    (*NODES[:3], replace(NODES[3], parent_code="missing"), NODES[4]),
    (*NODES[:3], replace(NODES[3], parent_code="A2"), replace(NODES[4], parent_code="A1")),
    (*NODES[:3], replace(NODES[3], parent_code="A1"), NODES[4]),
    (NODES[0], replace(NODES[1], hierarchy_level="2"), *NODES[2:]),
    (NODES[0], replace(NODES[1], hierarchy_level=None), *NODES[2:]),
    (*NODES, NODES[1]),
])
def test_incomplete_inconsistent_and_cyclic_hierarchy_never_falls_back(nodes):
    with pytest.raises(OrganizationScopeError) as error:
        resolve(nodes=nodes)
    assert error.value.code == "CONFIGURATION_ERROR"


def test_catalog_snapshot_change_fails_closed_and_fingerprint_is_stable():
    result = resolve()
    assert resolve(nodes=tuple(reversed(NODES)))["scope_fingerprint"] == result["scope_fingerprint"]
    assert resolve(identity=actor("A"))["scope_fingerprint"] != result["scope_fingerprint"]
    changed = (*NODES[:2], replace(NODES[2], name="合成更名"), *NODES[3:])
    assert resolve(nodes=changed)["scope_fingerprint"] != result["scope_fingerprint"]
    with pytest.raises(OrganizationScopeError):
        resolve(organizations=[OrganizationCatalogItem(code="A", name=NODES[1].name)])


@pytest.mark.parametrize("scope", [
    {**COHORT, "codes": ["A"]}, {"kind": "children_of", "parent_code": " "},
    {"kind": "authorized_cohort", "cohort": "unknown"},
    {"kind": "children_of", "parent_code": "A", "source_text": "任意"},
])
def test_scope_contract_rejects_extra_and_invalid_fields(scope):
    with pytest.raises(ValidationError):
        TypeAdapter(OrganizationScopeSpec).validate_python(scope)


def test_resolve_scope_http_contract_permissions_and_parent_candidates():
    items = [OrganizationCatalogItem(code=node.code, name=node.name) for node in NODES]
    class Uow:
        organization_catalog = SimpleNamespace(list_enabled=lambda: items)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    app = FastAPI()
    app.include_router(router)
    install_exception_handlers(app)
    app.dependency_overrides[get_uow] = Uow
    app.dependency_overrides[get_overview_permissions] = (
        lambda: ScopedOrganizationPermissionService()
    )
    app.dependency_overrides[get_scope_hierarchy] = lambda: SimpleNamespace(
        strict_snapshot=lambda: OrganizationHierarchySnapshot(NODES),
    )
    app.dependency_overrides[require_actor] = lambda: actor()
    client = TestClient(app)
    url = "/api/v1/business-context/resolve-scope"
    response = client.post(url, json={**COHORT, "source_text": "各家农商行"})
    assert response.status_code == 200
    assert response.json()["value"]["codes"] == ["A", "B"]
    response = client.post(url, json={**COHORT, "source_text": "合成不存在农商行"})
    assert response.status_code == 422
    assert response.json()["code"] == "SCOPE_SOURCE_INVALID"
    assert "value" not in response.json()
    response = client.post(url, json={
        "kind": "children_of", "parent_name": "A", "source_text": "甲行下属支行",
    })
    assert response.json()["value"]["codes"] == ["A1", "A2"]
    response = client.post(url, json={
        "kind": "children_of", "parent_name": "合成", "source_text": "合成下属支行",
    })
    assert response.json()["status"] == "needs_confirmation"
    invalid = client.post(url, json={**COHORT, "source_text": "各家", "actor": "admin"})
    assert invalid.status_code == 422
    app.dependency_overrides[require_actor] = lambda: actor("A1")
    response = client.post(url, json={**COHORT, "source_text": "各家农商行"})
    assert response.status_code == 403
    assert response.json()["code"] == "EMPTY_AUTHORIZED_SCOPE"


@pytest.fixture
def sync_databases():
    source = create_engine("sqlite://")
    app = create_engine("sqlite://")
    OrgTerm.__table__.create(app)
    with source.begin() as connection:
        connection.execute(text("CREATE TABLE source_org (org_no TEXT, org_chn_nm TEXT, "
                                "corpt_no TEXT, org_hier_code TEXT, data_dt TEXT, parent_no TEXT)"))
        connection.execute(text("INSERT INTO source_org VALUES "
                                "('R','合成省级','000','1','2026-04-30',NULL),"
                                "('A','合成甲农商行','001','3','2026-04-30','R'),"
                                "('B','合成乙农商行','002','3','2026-04-30','R'),"
                                "('A1','合成支行','001','2','2026-04-30','A')"))
    yield source, sessionmaker(app)
    source.dispose()
    app.dispose()


def test_default_sync_saves_governed_levels_and_dry_run_does_not_write(sync_databases):
    source, sessions = sync_databases
    service = SitCatalogSyncService(sessions)
    result = service.sync_organizations(
        source_engine=source, source_table="source_org", expected_count=3, dry_run=True,
    )
    assert result.created == 3
    with sessions() as session:
        assert list(session.scalars(select(OrgTerm))) == []
    service.sync_organizations(source_engine=source, source_table="source_org", expected_count=3)
    snapshot = SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()
    assert snapshot.validated_root() == "R"
    assert {(node.code, node.parent_code, node.hierarchy_level) for node in snapshot.nodes} == {
        ("R", None, "1"), ("A", "R", "3"), ("B", "R", "3"),
    }


def test_branch_sync_preserves_actual_parents(sync_databases):
    source, sessions = sync_databases
    SitCatalogSyncService(sessions).sync_organizations(
        source_engine=source, source_table="source_org", expected_count=3,
        include_branch_level=True, parent_field="parent_no",
    )
    snapshot = SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()
    assert snapshot.descendants_including("A") == {"A", "A1"}


@pytest.mark.parametrize("mutation", [
    "DELETE FROM source_org WHERE org_no = 'R'",
    "INSERT INTO source_org VALUES ('R2','另一根','000','1','2026-04-30',NULL)",
    "INSERT INTO source_org VALUES ('A','合成甲农商行','000','1','2026-04-30',NULL)",
])
def test_invalid_sync_snapshot_never_writes_partial_catalog(sync_databases, mutation):
    source, sessions = sync_databases
    with source.begin() as connection:
        connection.execute(text(mutation))
    with pytest.raises((ValueError, OrganizationScopeError)):
        SitCatalogSyncService(sessions).sync_organizations(
            source_engine=source, source_table="source_org", expected_count=3,
        )
    with sessions() as session:
        assert list(session.scalars(select(OrgTerm))) == []
