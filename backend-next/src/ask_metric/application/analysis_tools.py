"""Structured tools reuse QueryTask/QueryRun and immutable ResultRepository evidence."""

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

from ask_metric.application.commands import ExecuteQueryCommand
from ask_metric.application.result_repository import ResultRepository
from ask_metric.domain.analysis import (
    AnalysisTarget,
    MetricRelation,
    OrganizationRelation,
    change,
    decompose,
)
from ask_metric.domain.analysis_calculation import (
    CALCULATION_VERSION,
    CalculationError,
    convert_fact,
)
from ask_metric.domain.semantics import LogicalDSL
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import QueryTask


class AnalysisToolError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class AnalysisTools:
    def __init__(
        self, *, task_id, actor, uow_factory, execution, relations, guard, organization_relations=()
    ):
        self.task_id, self.actor = task_id, actor
        self.uow_factory, self.execution = uow_factory, execution
        self.relations = [MetricRelation.model_validate(r) for r in relations]
        self.organization_relations = [
            OrganizationRelation.model_validate(r) for r in organization_relations
        ]
        self.guard = guard

    def relation(self, target, code):
        candidates = [
            r
            for r in self.relations
            if r.parent == code
            and r.valid_from <= target.base_date <= target.report_date <= r.valid_to
            and target.org_code in r.org_codes
        ]
        if len(candidates) > 1:
            raise AnalysisToolError("RELATION_AMBIGUOUS", "同一范围存在多个分项口径")
        return candidates[0] if candidates else None

    def allowed(self, target):
        depths = {target.metric_code: 0}
        pending = [target.metric_code]
        while pending:
            code = pending.pop(0)
            if relation := self.relation(target, code):
                for child in relation.children:
                    if child not in depths:
                        depths[child] = depths[code] + 1
                        pending.append(child)
                    else:
                        raise AnalysisToolError(
                            "INVALID_METRIC_HIERARCHY", "指标关系有环或重复汇总路径"
                        )
        return depths

    def org_relation(self, target, code):
        candidates = [
            r
            for r in self.organization_relations
            if r.parent == code
            and target.metric_code in r.metric_codes
            and r.valid_from <= target.base_date <= target.report_date <= r.valid_to
        ]
        if len(candidates) > 1:
            raise AnalysisToolError("RELATION_AMBIGUOUS", "同一期间存在多个机构汇总口径")
        return candidates[0] if candidates else None

    def allowed_orgs(self, target):
        depths = {target.org_code: 0}

        def visit(code, path):
            if relation := self.org_relation(target, code):
                for child in relation.children:
                    if child in path or child in depths:
                        raise AnalysisToolError(
                            "INVALID_ORG_HIERARCHY", "机构关系有环或重复汇总路径"
                        )
                    depths[child] = depths[code] + 1
                    visit(child, {*path, child})

        visit(target.org_code, {target.org_code})
        return depths

    def validate_target(self, target):
        with self.uow_factory() as uow:
            metrics = {m.code: m for m in uow.metric_catalog.list_enabled()}
            orgs = {o.code: o for o in uow.organization_catalog.list_enabled()}
            if target.metric_code not in metrics or target.org_code not in orgs:
                raise AnalysisToolError("CATALOG_UNAVAILABLE", "指标或机构未绑定有效目录")
            dsl = target.dsl()
            authorized = self.execution.permission_service.authorize_logical_dsl(
                actor=self.actor, logical_dsl=dsl
            )
            if authorized.get("orgs") != dsl["orgs"]:
                raise AnalysisToolError("PERMISSION_DENIED", "分析机构范围已变化")
            self.execution.planner.build(
                LogicalDSL.model_validate(authorized),
                "metric_period_compare",
            )
            return metrics[target.metric_code].unit, orgs[target.org_code].name

    def compare(self, target, code):
        self.guard("check")
        self.validate_target(target.model_copy(update={"metric_code": code}))
        dsl = target.dsl(code)
        self.execution.permission_service.authorize_logical_dsl(actor=self.actor, logical_dsl=dsl)
        historical = self._historical_comparison(target, code)
        if historical is not None:
            return historical
        key = hashlib.sha256(json.dumps(dsl, sort_keys=True).encode()).hexdigest()
        query_id = str(uuid5(NAMESPACE_URL, f"analysis:{self.task_id}:{key}"))
        with self.uow_factory() as uow:
            owner = uow.tasks.get(self.task_id)
            query = uow.tasks.get(query_id)
            if query is None:
                state = QueryTaskState(
                    logical_dsl=dsl, actor_context=self.actor.model_dump(mode="json")
                )
                state.internal_analysis_id = self.task_id
                state.tool_call_id = key
                query = QueryTask(
                    id=query_id,
                    conversation_id=owner.conversation_id,
                    original_question=f"分析证据：{code} 两期比较",
                    intent="metric_query",
                    status="RUNNING",
                    current_stage="LOGICAL_DSL",
                    query_shape="metric_period_compare",
                    state_json=state.model_dump(mode="json"),
                    version=0,
                    idempotency_key=f"analysis:{query_id}",
                    created_at=datetime.now(UTC),
                )
                uow.tasks.add(query)
                uow.commit()
            version, status, stage = query.version, query.status, query.current_stage
            conversation_id = query.conversation_id
        if status == "RUNNING" and stage == "LOGICAL_DSL":
            self.guard("queries")
            result = self.execution.execute(
                ExecuteQueryCommand(
                    task_id=query_id,
                    expected_version=version,
                    request_id=key,
                    actor=self.actor,
                )
            )
            if result.status != "succeeded":
                raise AnalysisToolError(result.error_code or "QUERY_FAILED", "受控数据查询未成功")
        elif status != "SUCCEEDED":
            # A crash with no committed result has uncertain evidence. Never silently requery.
            raise AnalysisToolError("QUERY_INCOMPLETE", "原查询尚无已提交证据，不能以重查替换")
        self.guard("check")
        with self.uow_factory() as uow:
            repo = ResultRepository(
                uow=uow,
                conversation_id=conversation_id,
                actor=self.actor,
                permission_service=self.execution.permission_service,
            )
            artifact = repo.get(f"result:{query_id}")
            result = artifact.result
            if result.get("truncated"):
                raise AnalysisToolError("TRUNCATED", "比较结果截断，不能作完整归因证据")
            rows = result.get("rows", [])
            if not rows:
                raise AnalysisToolError("NO_RECORDS", "请求期间没有记录（不等于数值为零）")
            if len(rows) != 1:
                raise AnalysisToolError("SCOPE_MISMATCH", "比较结果不是单指标单机构")
            row = rows[0]
            if row.get("metric_code") != code or (
                row.get("org_code") is not None and row["org_code"] != target.org_code
            ):
                raise AnalysisToolError("SCOPE_MISMATCH", "证据指标或机构与分析范围不一致")
            if row.get("base_value") is None or row.get("current_value") is None:
                raise AnalysisToolError("MISSING_PERIOD", "比较期间有缺失值（不补零）")
            if str(row.get("base_date")) != str(target.base_date) or str(
                row.get("current_date")
            ) != str(target.report_date):
                raise AnalysisToolError("DATE_MISMATCH", "证据日期与分析日期不一致")
            with_code = next((m for m in uow.metric_catalog.list_enabled() if m.code == code), None)
            if with_code is None or not with_code.unit or row.get("unit") != with_code.unit:
                raise AnalysisToolError("UNIT_MISMATCH", "证据单位与指标目录不一致或缺少单位")
            return {
                "status": "OK",
                "metric_code": code,
                "metric_name": with_code.name,
                "unit": row["unit"],
                "result_id": artifact.result_id,
                "source_run_id": artifact.source_run_id,
                "base_date": str(target.base_date),
                "report_date": str(target.report_date),
                "org_code": target.org_code,
                "calculation_version": CALCULATION_VERSION,
                **change(Decimal(str(row["base_value"])), Decimal(str(row["current_value"]))),
            }

    def _historical_comparison(self, target, code):
        """A reference to a saved result must not silently become a fresh query."""
        if not target.source_task_ids and not target.source_analysis_id:
            return None
        with self.uow_factory() as uow:
            owner = uow.tasks.get(self.task_id)
            repo = ResultRepository(
                uow=uow,
                conversation_id=owner.conversation_id,
                actor=self.actor,
                permission_service=self.execution.permission_service,
            )
            refs = [f"result:{task_id}" for task_id in target.source_task_ids]
            if target.source_analysis_id:
                source = next((t for t in repo.tasks if t.id == target.source_analysis_id), None)
                if source is None:
                    raise AnalysisToolError("SOURCE_UNAVAILABLE", "被引用分析已不存在")
                previous = (source.state_json or {}).get("analysis_target") or {}
                if all(
                    previous.get(k) == target.model_dump(mode="json").get(k)
                    for k in ("org_code", "base_date", "report_date")
                ):
                    for item in (source.state_json or {}).get("analysis_tools", {}).values():
                        refs.extend(item.get("result_ids", []))
                        if item.get("result_id"):
                            refs.append(item["result_id"])
            values, evidence, unit, label = {}, [], None, code
            relevant = False
            for ref in dict.fromkeys(refs):
                artifact = repo.get(ref)
                dsl = artifact.logical_dsl
                if dsl.get("metrics") != [code] or dsl.get("orgs") != [target.org_code]:
                    continue
                relevant = True
                if artifact.result.get("truncated"):
                    raise AnalysisToolError("TRUNCATED", "所指历史结果截断，不能替换为新查询")
                for row in artifact.result.get("rows", []):
                    if unit is not None and row.get("unit") != unit:
                        raise AnalysisToolError("UNIT_MISMATCH", "历史两期单位不一致")
                    unit = row.get("unit")
                    label = row.get("metric_name") or code
                    pairs = [(row.get("stat_date"), row.get("metric_value"))]
                    if "base_value" in row:
                        pairs = [
                            (row.get("base_date"), row.get("base_value")),
                            (row.get("current_date"), row.get("current_value")),
                        ]
                    for day, value in pairs:
                        day = str(day)
                        if (
                            day not in {str(target.base_date), str(target.report_date)}
                            or value is None
                        ):
                            continue
                        value = Decimal(str(value))
                        if day in values and values[day] != value:
                            raise AnalysisToolError(
                                "SOURCE_AMBIGUOUS", "同日期存在不同历史快照，请明确来源"
                            )
                        values[day] = value
                        evidence.append(ref)
            if not relevant:
                return None
            if len(values) != 2 or not unit:
                raise AnalysisToolError(
                    "MISSING_PERIOD", "所指历史结果缺少完整两期证据，不能以新查询替换"
                )
            return {
                "status": "OK",
                "metric_code": code,
                "metric_name": label,
                "unit": unit,
                "result_id": evidence[-1],
                "result_ids": list(dict.fromkeys(evidence)),
                "source": "saved_results",
                "base_date": str(target.base_date),
                "report_date": str(target.report_date),
                "org_code": target.org_code,
                **change(values[str(target.base_date)], values[str(target.report_date)]),
            }

    def execute(self, target: AnalysisTarget, action):
        self.validate_target(target)
        code = action.metric_code or target.metric_code
        depths = self.allowed(target)
        if code not in depths:
            raise AnalysisToolError("INVALID_METRIC", "指标不在已治理下钻范围")
        self.guard("depth", depths[code])
        org_depths = self.allowed_orgs(target)
        org = action.org_code or target.org_code
        if org not in org_depths:
            raise AnalysisToolError("INVALID_ORG", "机构不在已治理下钻范围")
        if org != target.org_code and code != target.metric_code:
            scoped_metrics = self.allowed(target.model_copy(update={"org_code": org}))
            scoped_orgs = self.allowed_orgs(target.model_copy(update={"metric_code": code}))
            if code not in scoped_metrics or org not in scoped_orgs:
                raise AnalysisToolError(
                    "INVALID_CROSS_DIMENSION", "该指标与机构组合尚无已治理下钻关系"
                )
        self.guard("depth", depths[code] + org_depths[org])
        selected = target.model_copy(update={"org_code": org, "metric_code": code})
        self.validate_target(selected)
        if action.tool == "capabilities":
            relation = self.relation(selected, code)
            org_relation = self.org_relation(selected, org)
            return {
                "status": "OK" if relation or org_relation else "NO_GOVERNED_COMPONENTS",
                "metric_code": code,
                "org_code": org,
                "dimensions": (["指标结构"] if relation else [])
                + (["机构"] if org_relation else []),
                "date_coverage": "由compare的实际两期结果验证",
                "relation": relation.model_dump(mode="json") if relation else None,
                "organization_relation": org_relation.model_dump(mode="json")
                if org_relation
                else None,
                "calculation_version": CALCULATION_VERSION,
                "gap": None
                if relation or org_relation
                else (
                    "当前未配置有效分项关系，无法确认指标结构或下级机构变化来源；"
                    "不代表数据库没有明细"
                ),
            }
        if action.tool == "compare":
            return self.compare(selected, code)
        if action.tool == "calculate":
            if not action.target_unit:
                raise AnalysisToolError("UNIT_REQUIRED", "换算工具必须指定目标单位")
            # Inputs are resolved from trusted query artifacts, never numbers invented by the model.
            fact = self.compare(selected, code)
            try:
                return {
                    **convert_fact(fact, action.target_unit),
                    "operation": "unit_conversion",
                    "source_unit": fact["unit"],
                    "calculation_version": CALCULATION_VERSION,
                }
            except CalculationError as exc:
                raise AnalysisToolError("UNIT_CONVERSION_UNSUPPORTED", str(exc)) from exc
        if action.tool == "decompose_org":
            return self.decompose_organizations(selected, org_depths[org] + depths[code])
        if action.tool == "decompose":
            relation = self.relation(selected, code)
            if not relation:
                return {"status": "NO_GOVERNED_COMPONENTS", "gap": "缺少范围内已治理分项关系"}
            if relation.method != "additive_balance" or not relation.mutually_exclusive:
                return decompose({}, {}, relation)
            total = self.normalized_compare(selected, code, relation.unit)
            components, refs, gaps = {}, list(total.get("result_ids", [total["result_id"]])), []
            for child in relation.children:
                self.guard("depth", depths.get(child, depths[code] + 1) + org_depths[org])
                try:
                    item = self.normalized_compare(selected, child, relation.unit)
                    components[child] = item
                    refs.extend(item.get("result_ids", [item["result_id"]]))
                except AnalysisToolError as exc:
                    if exc.code not in {"NO_RECORDS", "MISSING_PERIOD"}:
                        raise
                    components[child] = None
                    gaps.append({"metric_code": child, "code": exc.code})
            return {
                "metric_code": code,
                "org_code": org,
                "dimension": "metric",
                "calculation_version": CALCULATION_VERSION,
                "available_child_relations": [
                    r.model_dump(mode="json")
                    for child in relation.children
                    if (r := self.relation(selected, child)) is not None
                ],
                "total": total,
                "result_ids": refs,
                **decompose(total, components, relation),
                "gaps": gaps,
            }
        raise AnalysisToolError("INVALID_ACTION", "不支持的工具动作")

    def normalized_compare(self, target, code, unit):
        try:
            return convert_fact(self.compare(target, code), unit)
        except CalculationError as exc:
            raise AnalysisToolError("UNIT_MISMATCH", str(exc)) from exc

    def decompose_organizations(self, target, depth):
        relation = self.org_relation(target, target.org_code)
        if relation is None:
            return {"status": "NO_GOVERNED_ORGS", "gap": "缺少期间内有效的机构汇总关系"}
        if relation.method != "additive_balance" or not relation.mutually_exclusive:
            return decompose({}, {}, relation)
        # Authorize every member before querying. A partial permission set cannot masquerade
        # as the complete population, and hierarchy membership never grants permission.
        self.guard("depth", depth + 1)
        targets = {org: target.model_copy(update={"org_code": org}) for org in relation.children}
        for child_target in targets.values():
            self.validate_target(child_target)
        total = self.normalized_compare(target, target.metric_code, relation.unit)
        components, refs, gaps = {}, list(total.get("result_ids", [total["result_id"]])), []
        with self.uow_factory() as uow:
            labels = {o.code: o.name for o in uow.organization_catalog.list_enabled()}
        for org, child_target in targets.items():
            try:
                item = self.normalized_compare(child_target, target.metric_code, relation.unit)
                components[org] = {**item, "org_name": labels[org]}
                refs.extend(item.get("result_ids", [item["result_id"]]))
            except AnalysisToolError as exc:
                if exc.code not in {"NO_RECORDS", "MISSING_PERIOD"}:
                    raise
                components[org] = None
                gaps.append({"org_code": org, "code": exc.code})
        result = decompose(total, components, relation)
        result["rows"].sort(key=lambda r: (-abs(Decimal(r["difference"])), r["org_code"]))
        return {
            **result,
            "dimension": "organization",
            "metric_code": target.metric_code,
            "org_code": target.org_code,
            "org_name": labels[target.org_code],
            "total": total,
            "result_ids": refs,
            "gaps": gaps,
            "calculation_version": CALCULATION_VERSION,
            "available_child_relations": [
                r.model_dump(mode="json")
                for org in relation.children
                if (r := self.org_relation(target, org)) is not None
            ],
        }
