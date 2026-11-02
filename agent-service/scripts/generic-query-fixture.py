"""配对验收的隔离目录及 SQL 数据；调用当前版本的真实解析器、契约、planner、builder。

只操作内存 SQLite，不加载运行配置、不连接业务数据库。
"""
import json
import re
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend-next" / "src"))

from ask_metric.application.field_resolution import resolve_catalog_field, resolve_date_field
from ask_metric.application.metric_candidates import MetricCandidateIndex
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.organization_scope import OrganizationHierarchyNode, OrganizationHierarchySnapshot
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.query.sql_builder import SqlBuilder

METRICS = [
    MetricCatalogItem(code="SYNTH_M:D", name="经营收益金额当日数", base_name="经营收益金额",
                      source_metric_code="SYNTH_M", value_basis="当日数", unit="元"),
    MetricCatalogItem(code="SYNTH_M:Y", name="经营收益金额较同期", base_name="经营收益金额",
                      source_metric_code="SYNTH_M", value_basis="较同期", unit="元"),
]
ORGS = [OrganizationCatalogItem(code=f"SYNTH_O{i}", name=f"合成机构{label}")
        for i, label in enumerate("甲乙丙丁", 1)]
ORGS.append(OrganizationCatalogItem(code="SYNTH_PENDING", name="待确认机构正式全称"))
ALLOWED = {item.code for item in ORGS}


def query(payload):
    import sqlglot
    from sqlalchemy import bindparam, create_engine, event, text

    spec = BasicQuerySpec.model_validate(payload)
    raw = spec.model_dump(mode="json")
    compared = (raw.get("comparison_scope") or {}).get("org_codes", [])
    if not set(spec.org_codes).union(compared) <= ALLOWED:
        raise ValueError("PERMISSION_DENIED")
    if compared and not set(spec.org_codes) <= set(compared):
        raise ValueError("SUBJECT_OUTSIDE_COMPARISON")
    nodes = (OrganizationHierarchyNode("SYNTH_ROOT", "合成集团", None, "1"),
             *(OrganizationHierarchyNode(o.code, o.name, "SYNTH_ROOT", "3") for o in ORGS))
    snapshot = OrganizationHierarchySnapshot(nodes)
    permissions = ScopedOrganizationPermissionService(organization_scope_provider=SimpleNamespace(
        allowed_org_codes=snapshot.descendants_including,
        all_org_codes=lambda: {node.code for node in nodes},
    ))
    actor = ActorContext(subject="synthetic", user_id="synthetic", org_id="SYNTH_ROOT",
                         role_code="USER", trust_level="authenticated", authentication_method="test")

    class Uow:
        metric_catalog = SimpleNamespace(list_enabled=lambda: METRICS)
        organization_catalog = SimpleNamespace(list_enabled=lambda: ORGS)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    execution = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql"), data_source=Mock(), permission_service=permissions,
        uow_factory=Uow, sql_builder=SqlBuilder("mysql", {"fact_table": "synthetic_facts"}),
        org_hierarchy_provider=SimpleNamespace(strict_snapshot=lambda: snapshot),
    )
    dsl, plan, sql = execution._build_governed_plan(
        uow=Uow(), actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    sqlite_sql = sqlglot.transpile(sql, read="mysql", write="sqlite")[0]
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def regex(connection, record):
        connection.create_function("REGEXP_LIKE", 2,
                                   lambda value, pattern: bool(re.search(pattern, value or "")))

    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("CREATE TABLE metric_values (metric_code TEXT, "
                                       "metric_name TEXT, org_code TEXT, org_name TEXT, "
                                       "metric_value NUMERIC, stat_date TEXT)")
            connection.exec_driver_sql("CREATE TABLE metric_terms (metric_code TEXT, "
                                       "metric_name TEXT, unit TEXT)")
            for metric in METRICS:
                connection.exec_driver_sql("INSERT INTO metric_terms VALUES (?,?,?)",
                                           (metric.code, metric.name, metric.unit))
                for org, value in zip(ORGS, [30, 50, 40, None, 25], strict=True):
                    for day in ["2026-05-30", "2026-05-31", "2026-06-30"]:
                        connection.exec_driver_sql("INSERT INTO metric_values VALUES (?,?,?,?,?,?)",
                                                  (metric.code, metric.name, org.code, org.name,
                                                   value, day))
            statement = text(sqlite_sql)
            for name, value in plan.parameters.items():
                if isinstance(value, list) and f":{name}" in sqlite_sql:
                    statement = statement.bindparams(bindparam(name, expanding=True))
            rows = [dict(row) for row in connection.execute(statement, plan.parameters).mappings()]
        return {"rows": rows, "query": raw, "plan": plan.model_dump(mode="json"),
                "parameters": plan.parameters, "sql": sql}
    finally:
        engine.dispose()


def main(payload):
    action = payload["action"]
    if action == "mentions":
        return {"mentions": MetricCandidateIndex(METRICS).mentions(payload["question"])}
    if action == "resolve":
        if payload["entity"] == "date":
            return resolve_date_field(payload["raw"][0], date(2026, 10, 13))
        items = METRICS if payload["entity"] == "metric" else ORGS
        return resolve_catalog_field(payload["entity"], payload["raw"], items)
    if action == "query":
        return query(payload["spec"])
    raise ValueError("UNKNOWN_FIXTURE_ACTION")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "value": main(json.load(sys.stdin))}, ensure_ascii=False,
                         default=str))
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)},
                         ensure_ascii=False))
