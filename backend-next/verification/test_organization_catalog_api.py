"""机构目录维护契约；仅使用隔离 SQLite，不访问业务库。"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes import catalogs
from ask_metric.application.requests import ActorContext
from ask_metric.infrastructure.db.models import OrgTerm
from ask_metric.infrastructure.db.org_hierarchy import SqlAlchemyOrgHierarchyProvider
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

BASE = "/api/v1/catalog/organizations"


@pytest.fixture
def organization_catalog():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    OrgTerm.__table__.create(engine)
    sessions = sessionmaker(engine)
    with sessions.begin() as session:
        session.add_all([
            OrgTerm(org_code="root", org_name="测试省级汇总", hierarchy_level="1"),
            OrgTerm(org_code="legal-a", org_name="测试甲法人", parent_org_code="root",
                    hierarchy_level="3"),
            OrgTerm(org_code="legal-b", org_name="测试乙法人", parent_org_code="root",
                    hierarchy_level="3"),
            OrgTerm(org_code="branch", org_name="测试分支机构", aliases=["原别名"],
                    parent_org_code="legal-a", hierarchy_level="2"),
            OrgTerm(org_code="leaf", org_name="测试末级机构", parent_org_code="branch",
                    hierarchy_level="2"),
            OrgTerm(org_code="disabled", org_name="停用测试机构", enabled=False,
                    parent_org_code="legal-b", hierarchy_level="2"),
            OrgTerm(org_code="unassigned", org_name="未分级测试机构", enabled=False),
        ])
    app = FastAPI()
    app.state.settings = SimpleNamespace(
        sit_org_head_office_hier_code="1", sit_org_legal_entity_hier_code="3",
        sit_org_branch_hier_code="2",
    )
    app.include_router(catalogs.router)
    app.dependency_overrides[catalogs.get_uow] = lambda: SqlAlchemyUnitOfWork(sessions)
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="catalog-test-admin", role_code="SYSTEM_ADMIN",
        authentication_method="test", trust_level="authenticated",
    )
    try:
        with TestClient(app) as client:
            yield client, sessions
    finally:
        engine.dispose()


def org_payload(client, code, **changes):
    item = next(item for item in client.get(BASE).json()["items"] if item["org_code"] == code)
    return {key: item[key] for key in ("org_code", "org_name", "aliases", "enabled")} | changes


def stored_organization(sessions, code):
    with sessions() as session:
        return session.scalar(select(OrgTerm).where(OrgTerm.org_code == code))


def test_list_returns_stored_relations_and_configured_level_codes(organization_catalog):
    client, _ = organization_catalog
    response = client.get(BASE)
    assert response.status_code == 200
    assert response.json()["hierarchy_levels"] == {"root": "1", "legal_entity": "3", "branch": "2"}
    items = {item["org_code"]: item for item in response.json()["items"]}
    assert items["root"]["parent_org_code"] is None
    assert items["branch"]["parent_org_code"] == "legal-a"
    assert items["disabled"]["enabled"] is False
    assert items["unassigned"]["hierarchy_level"] is None


def test_create_node_keeps_query_snapshot_valid(organization_catalog):
    client, sessions = organization_catalog
    response = client.post(BASE, json={
        "org_code": " new ", "org_name": " 新增测试机构 ", "aliases": [" 别名 ", "别名"],
        "parent_org_code": " legal-a ", "hierarchy_level": "2",
    })
    assert response.status_code == 201
    item = response.json()
    assert item["org_code"] == "new"
    assert item["org_name"] == "新增测试机构"
    assert item["aliases"] == ["别名"]
    assert item["parent_org_code"] == "legal-a"
    snapshot = SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()
    assert "new" in snapshot.descendants_including("legal-a")


def test_old_edit_payload_preserves_relations(organization_catalog):
    client, sessions = organization_catalog
    response = client.put(f"{BASE}/branch", json=org_payload(
        client, "branch", org_name="改名测试机构", aliases=["新别名"],
    ))
    assert response.status_code == 200
    item = response.json()
    assert item["parent_org_code"] == "legal-a"
    assert item["hierarchy_level"] == "2"
    stored = stored_organization(sessions, "branch")
    assert stored.org_name == "改名测试机构"
    assert stored.aliases == ["新别名"]


def test_reparent_moves_subtree_without_breaking_query_scope(organization_catalog):
    client, sessions = organization_catalog
    response = client.put(f"{BASE}/branch", json=org_payload(
        client, "branch", parent_org_code="legal-b", hierarchy_level="2",
    ))
    assert response.status_code == 200
    snapshot = SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()
    assert snapshot.descendants_including("legal-b") == {"legal-b", "branch", "leaf"}
    assert snapshot.descendants_including("legal-a") == {"legal-a"}


@pytest.mark.parametrize("changes", [
    {"parent_org_code": "branch"}, {"parent_org_code": "leaf"},
    {"parent_org_code": "missing"}, {"parent_org_code": "disabled"},
    {"parent_org_code": None}, {"parent_org_code": "root"},
    {"hierarchy_level": "3"}, {"hierarchy_level": "unknown"}, {"hierarchy_level": None},
])
def test_invalid_hierarchy_update_is_rejected_and_rolled_back(organization_catalog, changes):
    client, sessions = organization_catalog
    response = client.put(f"{BASE}/branch", json=org_payload(client, "branch", **changes))
    assert response.status_code == 422
    stored = stored_organization(sessions, "branch")
    assert stored.parent_org_code == "legal-a"
    assert stored.hierarchy_level == "2"
    SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()


@pytest.mark.parametrize("changes", [
    {}, {"parent_org_code": "legal-a"},
    {"parent_org_code": None, "hierarchy_level": "1"},
    {"parent_org_code": "branch", "hierarchy_level": "3"},
])
def test_create_cannot_add_unclassified_or_invalid_enabled_node(organization_catalog, changes):
    client, sessions = organization_catalog
    response = client.post(BASE, json={"org_code": "new", "org_name": "新增测试机构"} | changes)
    assert response.status_code == 422
    assert stored_organization(sessions, "new") is None


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_enabled_descendants_prevent_disabling_parent(organization_catalog, operation):
    client, sessions = organization_catalog
    response = client.delete(f"{BASE}/branch") if operation == "delete" else client.put(
        f"{BASE}/branch", json=org_payload(client, "branch", enabled=False),
    )
    assert response.status_code == 409
    assert "下级" in response.json()["detail"]
    assert stored_organization(sessions, "branch").enabled is True
    SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()


def test_soft_delete_and_restore_keep_original_hierarchy(organization_catalog):
    client, sessions = organization_catalog
    assert client.delete(f"{BASE}/leaf").status_code == 204
    stored = stored_organization(sessions, "leaf")
    assert stored.enabled is False
    assert stored.parent_org_code == "branch"
    duplicate = client.post(BASE, json={"org_code": "leaf", "org_name": "重复测试"})
    assert duplicate.status_code == 409
    assert "已存在" in duplicate.json()["detail"]
    response = client.put(f"{BASE}/leaf", json=org_payload(client, "leaf", enabled=True))
    assert response.status_code == 200
    SqlAlchemyOrgHierarchyProvider(sessions).strict_snapshot()


def test_legacy_invalid_tree_does_not_block_name_and_alias_edit(organization_catalog):
    client, sessions = organization_catalog
    with sessions.begin() as session:
        session.scalar(select(OrgTerm).where(OrgTerm.org_code == "unassigned")).enabled = True
    response = client.put(f"{BASE}/branch", json=org_payload(client, "branch", aliases=["改别名"]))
    assert response.status_code == 200
    assert response.json()["aliases"] == ["改别名"]


def test_duplicate_code_normalizes_whitespace_and_reports_conflict(organization_catalog):
    client, _ = organization_catalog
    response = client.post(BASE, json={"org_code": " branch ", "org_name": "重复测试"})
    assert response.status_code == 409
    assert "已存在" in response.json()["detail"]


@pytest.mark.parametrize("fields", [
    {"org_code": " "}, {"org_name": " "}, {"org_name": "名" * 256},
])
def test_invalid_identity_fields_are_rejected(organization_catalog, fields):
    client, _ = organization_catalog
    response = client.post(BASE, json={
        "org_code": "new", "org_name": "新增测试机构", "parent_org_code": "legal-a",
        "hierarchy_level": "2",
    } | fields)
    assert response.status_code == 422


@pytest.mark.parametrize("method,path", [("post", ""), ("put", "/branch"), ("delete", "/leaf")])
def test_only_system_admin_can_mutate_hierarchy(organization_catalog, method, path):
    client, _ = organization_catalog
    client.app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="catalog-test-user", role_code="USER", authentication_method="test",
        trust_level="authenticated",
    )
    kwargs = {} if method == "delete" else {"json": {"org_code": "branch", "org_name": "测试"}}
    assert getattr(client, method)(BASE + path, **kwargs).status_code == 403


def test_configured_codes_are_not_assumed_to_be_tree_depth(organization_catalog):
    client, sessions = organization_catalog
    client.app.state.settings = SimpleNamespace(
        sit_org_head_office_hier_code="R", sit_org_legal_entity_hier_code="L",
        sit_org_branch_hier_code="B",
    )
    with sessions.begin() as session:
        for term in session.scalars(select(OrgTerm)):
            term.hierarchy_level = {"1": "R", "3": "L", "2": "B"}.get(term.hierarchy_level)
    assert client.get(BASE).json()["hierarchy_levels"] == {
        "root": "R", "legal_entity": "L", "branch": "B",
    }
    response = client.post(BASE, json={
        "org_code": "new", "org_name": "新增测试机构", "parent_org_code": "legal-a",
        "hierarchy_level": "B",
    })
    assert response.status_code == 201
    SqlAlchemyOrgHierarchyProvider(sessions, root_level="R", cohort_level="L").strict_snapshot()


def test_concurrent_unique_conflict_is_reported_without_masking_other_errors(
    organization_catalog, monkeypatch,
):
    client, _ = organization_catalog
    duplicate = IntegrityError("INSERT", {}, Exception(
        1062, "Duplicate entry 'new' for key 'org_terms.org_terms_org_code_key'",
    ))

    def fail_commit(self):
        raise duplicate

    monkeypatch.setattr(SqlAlchemyUnitOfWork, "commit", fail_commit)
    payload = {"org_code": "new", "org_name": "新增测试", "parent_org_code": "legal-a",
               "hierarchy_level": "2"}
    response = client.post(BASE, json=payload)
    assert response.status_code == 409
    assert "已存在" in response.json()["detail"]
    duplicate = IntegrityError("INSERT", {}, Exception(1048, "Column cannot be null"))
    with pytest.raises(IntegrityError):
        client.post(BASE, json=payload)
