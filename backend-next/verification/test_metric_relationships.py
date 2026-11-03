"""关系维护使用隔离配置，验证与现有语义文件的兼容及写入边界。"""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ask_metric.api.dependencies import require_actor
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError, install_exception_handlers
from ask_metric.domain.semantics import MetricCatalogItem

URL = "/api/v1/catalog/metric-relationships"


@pytest.fixture
def environment(tmp_path):
    from ask_metric.api.routes import metric_relationships as routes
    from ask_metric.application.metric_relationships import MetricRelationshipStore

    path = tmp_path / "analysis-semantics.json"
    path.write_text(json.dumps({
        "schema_version": 1, "version": "preserved-version", "metrics": {"A": {"source": "旧值"}},
        "relations": [{"id": "legacy", "status": "approved", "parent": "A",
                       "children": ["B"], "source": "原有分类"}],
    }), encoding="utf-8")
    topics = tmp_path / "business-topics.json"
    topics.write_text(json.dumps({"schema_version": 1, "topics": {"sample": {
        "name": "测试主题", "default_sections": ["structure"],
        "metrics": [
            {"id": "total", "code": "B", "names": ["乙"], "units": ["元"],
             "label": "乙", "value_basis": "当日数"},
            {"id": "part", "code": "C", "names": ["丙"], "units": ["元"],
             "label": "丙", "value_basis": "当日数"},
        ],
        "relationships": [{"id": "parts", "type": "classification", "parent": "total",
                           "children": ["part"], "note": "仅按业务分类，不表示完整组成"}],
    }}}), encoding="utf-8")
    catalog = [MetricCatalogItem(code=code, name=code, unit=unit)
               for code, unit in [("A", "元"), ("B", "元"), ("C", "元"),
                                  ("D", "户"), ("R", "%")]]
    store = MetricRelationshipStore(path, topics)
    app = FastAPI()
    app.include_router(routes.router)
    install_exception_handlers(app)
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="test-user", role_code="SYSTEM_ADMIN", authentication_method="test",
        trust_level="authenticated",
    )
    app.dependency_overrides[routes.relationship_store] = lambda: store
    app.dependency_overrides[routes.relationship_catalog] = lambda: catalog
    return TestClient(app), store, catalog, path, topics, app


def write_payload(revision, **changes):
    return {"revision": revision, "kind": "classification", "status": "approved",
            "parent": "A", "children": ["C"], "source": "经确认的业务分类", **changes}


def test_read_preserves_legacy_and_projects_only_formally_bound_topic_codes(environment):
    client, _, _, path, topics, _ = environment
    before = path.read_bytes()
    response = client.get(URL)
    assert response.status_code == 200
    snapshot = response.json()
    legacy, preset = snapshot["items"]
    assert (legacy["kind"], legacy["origin"], legacy["editable"]) == (
        "classification", "managed", True,
    )
    assert (preset["parent"], preset["children"], preset["origin"], preset["editable"]) == (
        "B", ["C"], "topic", False,
    )
    assert snapshot["warnings"] == []
    assert snapshot["issues"] == []
    assert path.read_bytes() == before
    data = json.loads(topics.read_text())
    data["topics"]["sample"]["metrics"][1]["code"] = "UNKNOWN"
    topics.write_text(json.dumps(data))
    missing = client.get(URL).json()
    assert len(missing["items"]) == 1
    assert missing["warnings"]


@pytest.mark.parametrize("metric_changes, expected_codes, reason", [
    ({"code": "UNKNOWN"}, ["B", "UNKNOWN"], "正式目录未绑定指标"),
    ({"units": ["户"]}, ["B", "C"], "正式目录未绑定指标"),
    ({"disabled_reason": "统计口径待业务确认"}, ["B", "C"], "统计口径待业务确认"),
])
def test_topic_issues_identify_business_metrics_without_weakening_binding(
    environment, metric_changes, expected_codes, reason,
):
    client, _, _, path, topics, _ = environment
    data = json.loads(topics.read_text())
    data["topics"]["sample"]["metrics"][1].update(metric_changes)
    topics.write_text(json.dumps(data), encoding="utf-8")
    before = (path.read_bytes(), topics.read_bytes())

    snapshot = client.get(URL).json()

    assert len(snapshot["items"]) == 1
    issue, = snapshot["issues"]
    assert issue["id"] == "topic:sample:parts"
    assert "测试主题" in issue["title"] and "乙" in issue["title"]
    assert "丙" in issue["message"] and reason in issue["message"]
    assert "parts" not in issue["title"] + issue["message"]
    assert issue["metric_codes"] == expected_codes
    assert "A" not in issue["metric_codes"]
    assert snapshot["warnings"] == [f"{issue['title']}：{issue['message']}"]
    assert (path.read_bytes(), topics.read_bytes()) == before


def test_ambiguous_name_binding_does_not_guess_issue_metric_codes(environment):
    client, _, catalog, _, topics, _ = environment
    catalog.extend([
        MetricCatalogItem(code=code, name="丙", unit="元") for code in ["C1", "C2"]
    ])
    data = json.loads(topics.read_text())
    data["topics"]["sample"]["metrics"][1].pop("code")
    topics.write_text(json.dumps(data), encoding="utf-8")

    snapshot = client.get(URL).json()

    issue, = snapshot["issues"]
    assert issue["metric_codes"] == ["B"]
    assert "丙" in issue["message"] and "指标绑定冲突" in issue["message"]
    assert len(snapshot["items"]) == 1


def test_managed_issues_are_scoped_to_their_own_relation(environment):
    client, _, catalog, _, _, _ = environment
    catalog[:] = [item for item in catalog if item.code != "A"]

    snapshot = client.get(URL).json()

    issue, = snapshot["issues"]
    assert issue["id"] == "managed:legacy"
    assert issue["metric_codes"] == ["A", "B"]
    assert "已停用或不在当前目录" in issue["message"]
    assert "legacy" not in issue["title"] + issue["message"]
    assert len(snapshot["items"]) == 2


def test_create_update_delete_share_config_and_leave_unrelated_fields_intact(environment):
    client, _, _, path, _, _ = environment
    original = json.loads(path.read_text())
    initial = client.get(URL).json()
    created = client.post(URL, json=write_payload(initial["revision"]))
    assert created.status_code == 201
    result = created.json()
    relation_id = result["item"]["id"]
    assert relation_id and relation_id != "legacy"
    edited = client.put(f"{URL}/{relation_id}", json=write_payload(
        result["revision"], kind="ratio", parent="R", children=["B", "A"],
    ))
    assert edited.status_code == 200
    persisted = json.loads(path.read_text())
    assert persisted["metrics"] == original["metrics"]
    assert persisted["version"] == original["version"]
    assert persisted["relations"][0] == original["relations"][0]
    assert persisted["relations"][1]["children"] == ["B", "A"]
    deleted = client.delete(f"{URL}/{relation_id}", params={"revision": edited.json()["revision"]})
    assert deleted.status_code == 200
    assert json.loads(path.read_text()) == original
    assert client.get(URL).json()["revision"] == deleted.json()["revision"]


@pytest.mark.parametrize("changes", [
    {"children": ["UNKNOWN"]},
    {"parent": "UNKNOWN"},
    {"children": ["A"]},
    {"children": ["B", "B"]},
    {"kind": "composition", "children": ["B", "D"]},
    {"kind": "ratio", "parent": "R", "children": ["B"]},
    {"kind": "ratio", "parent": "A", "children": ["B", "C"]},
    {"kind": "ratio", "parent": "R", "children": ["B", "D"]},
    {"parent": "C", "children": ["A"]},
])
def test_invalid_identity_units_members_or_cycle_never_persist(environment, changes):
    client, _, _, path, _, _ = environment
    before = path.read_bytes()
    revision = client.get(URL).json()["revision"]
    response = client.post(URL, json=write_payload(revision, **changes))
    assert response.status_code == 422
    assert path.read_bytes() == before


def test_stale_revision_cannot_overwrite_another_admin_change(environment):
    client, _, _, path, _, _ = environment
    revision = client.get(URL).json()["revision"]
    first = client.post(URL, json=write_payload(revision))
    assert first.status_code == 201
    before = path.read_bytes()
    response = client.put(URL + "/legacy", json=write_payload(revision))
    assert response.status_code == 409
    assert path.read_bytes() == before
    deleted = client.delete(URL + "/legacy", params={"revision": revision})
    assert deleted.status_code == 409


def test_classification_can_include_a_ratio_that_depends_on_the_classification_parent(environment):
    client, _, _, _, _, _ = environment
    revision = client.get(URL).json()["revision"]
    classified = client.put(URL + "/legacy", json=write_payload(
        revision, parent="A", children=["B", "R"],
    ))
    assert classified.status_code == 200
    ratio = client.post(URL, json=write_payload(
        classified.json()["revision"], kind="ratio", parent="R", children=["B", "A"],
    ))
    assert ratio.status_code == 201
    assert ratio.json()["item"]["children"] == ["B", "A"]


@pytest.mark.parametrize("kind, children", [("ratio", ["R", "R3"]), ("composition", ["R"])])
def test_recursive_numeric_dependencies_are_rejected(environment, kind, children):
    client, _, catalog, path, _, _ = environment
    catalog.extend([MetricCatalogItem(code=code, name=code, unit="%") for code in ["R2", "R3"]])
    revision = client.get(URL).json()["revision"]
    initial = client.post(URL, json=write_payload(
        revision, kind="ratio", parent="R", children=["R2", "R3"],
    ))
    assert initial.status_code == 201
    before = path.read_bytes()
    recursive = client.post(URL, json=write_payload(
        initial.json()["revision"], kind=kind, parent="R2", children=children,
    ))
    assert recursive.status_code == 422
    assert recursive.json()["code"] == "METRIC_RELATION_CYCLE"
    assert path.read_bytes() == before


@pytest.mark.parametrize("kind, parent, children", [
    ("ratio", "R", ["B", "A"]), ("classification", "D", ["B"]),
])
def test_existing_unrelated_hierarchy_cycle_does_not_block_new_relation(
    environment, kind, parent, children,
):
    client, _, _, path, _, _ = environment
    document = json.loads(path.read_text())
    document["relations"].append({"id": "existing-cycle", "status": "draft", "parent": "C",
                                  "children": ["A"], "source": "原有待修正分类"})
    path.write_text(json.dumps(document), encoding="utf-8")
    revision = client.get(URL).json()["revision"]
    created = client.post(URL, json=write_payload(
        revision, kind=kind, parent=parent, children=children,
    ))
    assert created.status_code == 201


def test_parallel_writes_accept_only_one_revision(environment):
    from ask_metric.domain.metric_relationships import MetricRelationFields

    _, store, catalog, _, _, _ = environment
    revision = store.read(catalog)["revision"]

    def create(parent):
        fields = MetricRelationFields(kind="ratio", parent="R", children=[parent, "C"],
                                      source="测试比例", status="approved")
        try:
            store.create(fields, revision, catalog)
            return "created"
        except ApplicationError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(create, ["A", "B"]))
    assert sorted(results) == ["METRIC_RELATION_CONFLICT", "created"]


@pytest.mark.parametrize("catalog_change", ["disabled_member", "changed_unit"])
def test_existing_relation_can_retire_after_catalog_changes_but_cannot_reenable(
    environment, catalog_change,
):
    client, _, catalog, path, _, _ = environment
    revision = client.get(URL).json()["revision"]
    composed = client.put(URL + "/legacy", json=write_payload(
        revision, kind="composition", children=["B"],
    ))
    assert composed.status_code == 200
    if catalog_change == "disabled_member":
        catalog[:] = [item for item in catalog if item.code != "B"]
    else:
        catalog[:] = [item.model_copy(update={"unit": "户"}) if item.code == "B" else item
                      for item in catalog]
    retired = client.put(URL + "/legacy", json=write_payload(
        composed.json()["revision"], kind="composition", children=["B"], status="retired",
    ))
    assert retired.status_code == 200
    assert retired.json()["item"]["status"] == "retired"
    assert retired.json()["item"]["children"] == ["B"]
    before = path.read_bytes()
    reenabled = client.put(URL + "/legacy", json=write_payload(
        retired.json()["revision"], kind="composition", children=["B"], status="approved",
    ))
    assert reenabled.status_code == 422
    assert path.read_bytes() == before


@pytest.mark.parametrize("operation, changes", [
    ("post", {}), ("put", {"children": ["B", "C"]}), ("put", {"kind": "classification"}),
])
def test_retired_status_does_not_bypass_catalog_checks_for_new_or_changed_relations(
    environment, operation, changes,
):
    client, _, catalog, path, _, _ = environment
    revision = client.get(URL).json()["revision"]
    composed = client.put(URL + "/legacy", json=write_payload(
        revision, kind="composition", children=["B"],
    ))
    assert composed.status_code == 200
    catalog[:] = [item for item in catalog if item.code != "B"]
    before = path.read_bytes()
    fields = {"kind": "composition", "children": ["B"], "status": "retired", **changes}
    response = getattr(client, operation)(URL + ("/legacy" if operation == "put" else ""),
                                         json=write_payload(composed.json()["revision"], **fields))
    assert response.status_code == 422
    assert path.read_bytes() == before


def test_preset_relations_cannot_be_overwritten(environment):
    client, _, _, path, topics, _ = environment
    snapshot = client.get(URL).json()
    preset = snapshot["items"][1]
    before = (path.read_bytes(), topics.read_bytes())
    updated = client.put(f"{URL}/{preset['id']}", json=write_payload(snapshot["revision"]))
    deleted = client.delete(f"{URL}/{preset['id']}", params={"revision": snapshot["revision"]})
    assert updated.status_code == deleted.status_code == 409
    assert (path.read_bytes(), topics.read_bytes()) == before


def test_non_admin_cannot_read_or_write_relationships(environment):
    client, _, _, path, _, app = environment
    revision = client.get(URL).json()["revision"]
    before = path.read_bytes()
    app.dependency_overrides[require_actor] = lambda: ActorContext(
        subject="ordinary-user", role_code="USER", authentication_method="test",
        trust_level="authenticated",
    )
    assert client.get(URL).status_code == 403
    assert client.post(URL, json=write_payload(revision)).status_code == 403
    assert client.put(URL + "/legacy", json=write_payload(revision)).status_code == 403
    assert client.delete(URL + "/legacy", params={"revision": revision}).status_code == 403
    assert path.read_bytes() == before


def test_atomic_write_failure_preserves_original_configuration(environment, monkeypatch):
    from ask_metric.application import metric_relationships

    client, _, _, path, _, _ = environment
    revision = client.get(URL).json()["revision"]
    before = path.read_bytes()

    def unavailable(*_args):
        raise OSError("isolated write failure")

    monkeypatch.setattr(metric_relationships.os, "replace", unavailable)
    response = client.post(URL, json=write_payload(revision))
    assert response.status_code == 503
    assert path.read_bytes() == before
    assert list(path.parent.glob("*.tmp")) == []
