"""澄清与多轮续接验收桥：真实目录匹配、日历、来源对账与内存 SQL。

机构/指标/数值全部为隔离合成数据；固定业务日 2026-10-17，与验收方案一致。
只操作内存 SQLite，不加载运行配置、不连接业务数据库。
统一语义入口后不再有独立准入/票据校验：query 直接接受规范化 BasicQuerySpec。
"""
import json
import re
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend-next" / "src"))

from ask_metric.api.routes.business_context import _resolve_organization_field
from ask_metric.application.field_resolution import (
    resolve_catalog_field,
    resolve_date_field,
    source_calendar_constraints,
)
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.metric_candidates import MetricCandidateIndex
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import (
    QueryExecutionApplicationService,
)
from ask_metric.application.requests import ActorContext
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.organization_scope import (
    OrganizationHierarchyNode,
    OrganizationHierarchySnapshot,
)
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.infrastructure.query.sql_builder import SqlBuilder

BUSINESS_DATE = date(2026, 10, 17)

METRICS = [
    MetricCatalogItem(code="SYNTH_DEP:D", name="对公协定存款余额当日数", base_name="对公协定存款余额",
                      source_metric_code="SYNTH_DEP", value_basis="当日数", unit="元"),
    MetricCatalogItem(code="SYNTH_DEP:M", name="对公协定存款余额较上月", base_name="对公协定存款余额",
                      source_metric_code="SYNTH_DEP", value_basis="较上月", unit="元"),
    MetricCatalogItem(code="SYNTH_PROFIT:D", name="净利润金额当日数", base_name="净利润金额",
                      source_metric_code="SYNTH_PROFIT", value_basis="当日数", unit="元"),
    MetricCatalogItem(code="SYNTH_DDA:D", name="个人活期存款余额当日数", base_name="个人活期存款余额",
                      source_metric_code="SYNTH_DDA", value_basis="当日数", unit="元"),
    MetricCatalogItem(code="SYNTH_CREDIT:D", name="信贷客户数量当日数", base_name="信贷客户数量",
                      source_metric_code="SYNTH_CREDIT", value_basis="当日数", unit="户"),
]

ORGS = [
    OrganizationCatalogItem(code="SYNTH_WX", name="无锡农商行", aliases=["无锡"]),
    OrganizationCatalogItem(code="SYNTH_JY", name="江阴农商行", aliases=["江阴"]),
    OrganizationCatalogItem(code="SYNTH_QD", name="启东农商行", aliases=["启东"]),
    OrganizationCatalogItem(code="SYNTH_HA", name="海安农商行", aliases=["海安"]),
    OrganizationCatalogItem(code="SYNTH_HM", name="海门农商行", aliases=["海门"]),
    OrganizationCatalogItem(code="SYNTH_TX", name="泰兴农商行", aliases=["泰兴"]),
    OrganizationCatalogItem(code="SYNTH_TZ", name="泰州农商行", aliases=["泰州"]),
    OrganizationCatalogItem(code="SYNTH_ZJG", name="张家港行", aliases=["张家港", "张家港农商行"]),
    OrganizationCatalogItem(code="SYNTH_DF", name="大丰农商行", aliases=["大丰"]),
    OrganizationCatalogItem(code="SYNTH_ZJ", name="紫金农商行", aliases=["紫金"]),
    # 候选收敛回归专用：同一前缀 5 个候选，验证展示上限 4 与未展示项独立解析。
    OrganizationCatalogItem(code="SYNTH_HU1", name="华宁农商行", aliases=["华宁"]),
    OrganizationCatalogItem(code="SYNTH_HU2", name="华兴农商行", aliases=["华兴"]),
    OrganizationCatalogItem(code="SYNTH_HU3", name="华安农商行", aliases=["华安"]),
    OrganizationCatalogItem(code="SYNTH_HU4", name="华丰农商行", aliases=["华丰"]),
    OrganizationCatalogItem(code="SYNTH_HU5", name="华通农商行", aliases=["华通"]),
]
ALLOWED = {item.code for item in ORGS}
ORG_NAMES = {item.code: item.name for item in ORGS}

# 数据桩：只用例需要的日期出数；未列出的 (指标, 机构, 日期) 组合无行，即明确缺数。
ROWS: list[tuple[str, str, str, float]] = []


def _add(metric: str, orgs: list[str], days: list[str], base: float) -> None:
    for org_index, org in enumerate(orgs):
        for day_index, day in enumerate(days):
            ROWS.append((metric, org, day, round(base + org_index * 7.13 + day_index * 3.01, 2)))


_ALL_ORGS = [item.code for item in ORGS]
_add("SYNTH_DEP:D", _ALL_ORGS, ["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"], 1000)
_add("SYNTH_DEP:M", _ALL_ORGS, ["2026-05-31", "2026-06-30"], 2000)
_add("SYNTH_PROFIT:D", _ALL_ORGS, ["2026-03-31"], 3000)
_add("SYNTH_CREDIT:D", _ALL_ORGS, ["2026-05-31"], 400)
_DDA_ZJG_DAYS = [
    "2021-12-31",
    "2022-03-31", "2022-06-30", "2022-09-30", "2022-12-31",
    "2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31",
    "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31",
    "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31",
    "2026-03-31", "2026-05-31", "2026-06-30", "2026-09-30",
]
_add("SYNTH_DDA:D", ["SYNTH_ZJG"], _DDA_ZJG_DAYS, 5000)
_add("SYNTH_DDA:D", [code for code in _ALL_ORGS if code != "SYNTH_ZJG"], ["2026-05-31"], 6000)


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
    nodes = (OrganizationHierarchyNode("SYNTH_ROOT", "合成省联社", None, "1"),
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
            for metric_code, org_code, day, value in ROWS:
                connection.exec_driver_sql("INSERT INTO metric_values VALUES (?,?,?,?,?,?)",
                                           (metric_code, METRIC_NAMES[metric_code], org_code,
                                            ORG_NAMES[org_code], value, day))
            statement = text(sqlite_sql)
            for name, value in plan.parameters.items():
                if isinstance(value, list) and f":{name}" in sqlite_sql:
                    statement = statement.bindparams(bindparam(name, expanding=True))
            rows = [dict(row) for row in connection.execute(statement, plan.parameters).mappings()]
        return {"rows": rows, "query": raw, "plan": plan.model_dump(mode="json"),
                "parameters": plan.parameters, "sql": sql}
    finally:
        engine.dispose()


METRIC_NAMES = {item.code: item.name for item in METRICS}


def main(payload):
    action = payload["action"]
    if action == "inspect":
        return inspect_goal(payload["question"], date.fromisoformat(payload["business_date"]),
                            METRICS, ORGS, reference_year=payload.get("reference_year"))
    if action == "mentions":
        return {"mentions": MetricCandidateIndex(METRICS).mentions(payload["question"])}
    if action == "resolve":
        entity = payload["entity"]
        raw = payload.get("raw") or []
        source = payload.get("source") or {}
        today = date.fromisoformat(source.get("business_date") or BUSINESS_DATE.isoformat())
        if entity == "date":
            result = resolve_date_field(raw[0], today, reference_year=payload.get("year"),
                                        model_value=payload.get("model_value"))
            result.setdefault("metadata", {})["source_calendar"] = source_calendar_constraints(
                source.get("source_question", raw[0]), today, reference_year=payload.get("year"))
            return result
        if entity == "organization":
            # 与 HTTP resolve-field 共用同一实现：槽位错字依据、建议绑定和权限投影
            # 必须在验收桥中保持一致，否则真实模型路径会绕过本轮修复。
            return _resolve_organization_field(
                list(raw),
                suggested=payload.get("suggested"),
                source_question=source.get("source_question"),
                all_items=ORGS,
                items=ORGS,
            )
        return resolve_catalog_field(entity, raw, METRICS, suggested=payload.get("suggested"))
    if action == "query":
        # 规范化 BasicQuerySpec 是唯一入参；旧票据/来源覆盖校验已随准入链删除。
        query_spec = payload["spec"]
        return query({key: value for key, value in query_spec.items() if key in BasicQuerySpec.model_fields})
    raise ValueError("UNKNOWN_FIXTURE_ACTION")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "value": main(json.load(sys.stdin))}, ensure_ascii=False, default=str))
    except Exception as error:
        print(json.dumps({"ok": False, "error": getattr(error, "code", type(error).__name__),
                          "message": str(error)}, ensure_ascii=False))
