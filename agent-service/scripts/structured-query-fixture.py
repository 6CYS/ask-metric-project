"""结构化查询验收：复用真实字段解析、机构范围和SQL builder，只在内存执行合成数据。"""
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

path = Path(__file__).with_name("clarification-acceptance-fixture.py")
spec = importlib.util.spec_from_file_location("structured_query_base", path)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

from pydantic import TypeAdapter
from ask_metric.api.routes.business_context import ResolveScopeRequest, resolve_scope
from ask_metric.domain.semantics import OrganizationCatalogItem

# 四月与六月的合成记录补齐对照维度，不连接任何实际业务库。
base._add("SYNTH_CREDIT:D", base._ALL_ORGS, ["2026-04-30", "2026-06-30"], 700)
base._add("SYNTH_DDA:D", base._ALL_ORGS, ["2026-04-30"], 8000)


def context():
    from ask_metric.domain.organization_scope import OrganizationHierarchyNode, OrganizationHierarchySnapshot
    nodes = (OrganizationHierarchyNode("SYNTH_ROOT", "合成省联社", None, "1"),
             *(OrganizationHierarchyNode(o.code, o.name, "SYNTH_ROOT", "3") for o in base.ORGS))
    snapshot = OrganizationHierarchySnapshot(nodes)
    permissions = base.ScopedOrganizationPermissionService(organization_scope_provider=SimpleNamespace(
        allowed_org_codes=snapshot.descendants_including, all_org_codes=lambda: {node.code for node in nodes},
    ))
    class Uow:
        metric_catalog = SimpleNamespace(list_enabled=lambda: base.METRICS)
        organization_catalog = SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code=n.code, name=n.name) for n in nodes])
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
    actor = base.ActorContext(subject="synthetic", user_id="synthetic", org_id="SYNTH_ROOT", role_code="USER",
                              trust_level="authenticated", authentication_method="test")
    return snapshot, permissions, Uow, actor


def query(payload):
    import re
    import sqlglot
    from sqlalchemy import bindparam, create_engine, event, text
    snapshot, permissions, Uow, actor = context()
    spec = base.BasicQuerySpec.model_validate({key: value for key, value in payload.items() if key in base.BasicQuerySpec.model_fields})
    execution = base.QueryExecutionApplicationService(
        planner=base.QueryPlanner(dialect="mysql"), data_source=base.Mock(), permission_service=permissions,
        uow_factory=Uow, sql_builder=base.SqlBuilder("mysql", {"fact_table": "synthetic_facts"}),
        org_hierarchy_provider=SimpleNamespace(strict_snapshot=lambda: snapshot))
    dsl, plan, sql = execution._build_governed_plan(uow=Uow(), actor=actor,
        logical_dsl=spec.to_logical_dsl().model_dump(mode="json"), query_shape=spec.query_shape, strict_codes=True)
    sqlite_sql = sqlglot.transpile(sql, read="mysql", write="sqlite")[0]
    engine = create_engine("sqlite://")
    @event.listens_for(engine, "connect")
    def regex(connection, record):
        connection.create_function("REGEXP_LIKE", 2, lambda value, pattern: bool(re.search(pattern, value or "")))
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("CREATE TABLE metric_values (metric_code TEXT, metric_name TEXT, org_code TEXT, org_name TEXT, metric_value NUMERIC, stat_date TEXT)")
            connection.exec_driver_sql("CREATE TABLE metric_terms (metric_code TEXT, metric_name TEXT, unit TEXT)")
            for metric in base.METRICS:
                connection.exec_driver_sql("INSERT INTO metric_terms VALUES (?,?,?)", (metric.code, metric.name, metric.unit))
            for metric, org, day, value in base.ROWS:
                connection.exec_driver_sql("INSERT INTO metric_values VALUES (?,?,?,?,?,?)", (metric, base.METRIC_NAMES[metric], org, base.ORG_NAMES[org], value, day))
            statement = text(sqlite_sql)
            for name, value in plan.parameters.items():
                if isinstance(value, list) and f":{name}" in sqlite_sql:
                    statement = statement.bindparams(bindparam(name, expanding=True))
            rows = [dict(row) for row in connection.execute(statement, plan.parameters).mappings()]
        # 与执行应用服务的公开结果投影一致：排名SQL的总体元数据不作为业务行返回。
        rows = [{key: value for key, value in row.items() if key not in {"rank_population", "rank_data_conflict", "rank_metadata"}}
                for row in rows if not row.get("rank_metadata")]
        return {"rows": rows, "query": spec.model_dump(mode="json"), "bound_organizations": dsl.orgs,
                "parameters": plan.parameters, "sql": sql}
    finally:
        engine.dispose()


def main(payload):
    if payload["action"] == "catalog":
        return {"organizations": [{"code": o.code, "name": o.name, "aliases": o.aliases} for o in base.ORGS],
                "metrics": [{"code": m.code, "name": m.name, "unit": m.unit} for m in base.METRICS]}
    if payload["action"] == "query":
        return query(payload["spec"])
    if payload["action"] != "scope":
        return base.main(payload)
    snapshot, permissions, Uow, actor = context()
    return resolve_scope(TypeAdapter(ResolveScopeRequest).validate_python(payload["scope"]), actor,
                         Uow(), permissions, SimpleNamespace(strict_snapshot=lambda: snapshot))


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "value": main(json.load(sys.stdin))}, ensure_ascii=False, default=str))
    except Exception as error:
        print(json.dumps({"ok": False, "error": getattr(error, "code", type(error).__name__), "message": str(error)}, ensure_ascii=False))
