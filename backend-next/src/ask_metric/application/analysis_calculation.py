"""复用已授权分析事实作同指标比较；计算和存储仍由现有计算服务负责。"""

from copy import deepcopy
from decimal import Decimal, localcontext

from pydantic import BaseModel, ConfigDict, Field

from ask_metric.application.analysis_execution import display_number
from ask_metric.application.analysis_report_view import validated_report_atoms
from ask_metric.application.metric_semantics import digest
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.calculation import CalculationScope
from ask_metric.domain.value_presentation import money_reply_fields


class CalculationReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str = Field(min_length=1, max_length=128)
    calculation_id: str = Field(min_length=1, max_length=128)


class AnalysisCalculationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=128)
    run_refs: list[str] = Field(min_length=1, max_length=6)
    current_ref: str = Field(min_length=1, max_length=200)
    base_ref: str = Field(min_length=1, max_length=200)
    calculation_context: CalculationScope


def reject(message):
    raise ApplicationError("ANALYSIS_CALCULATION_SOURCE", message, status_code=422)


def comparison_inputs(service, actor, sources, atoms, current_ref, base_ref):
    current, base = atoms.get(current_ref), atoms.get(base_ref)
    if any(not item or item.get("type") != "fact" or not item.get("fact_id") or item.get("value") is None
           for item in (current, base)):
        reject("比较须使用有原始数值的两条事实引用，不能使用缺数、手填数值或派生判断。")
    metrics = [metric for source in sources for metric in source["metric_descriptors"]
               if metric["code"] == current["metric_code"]]
    if (current["metric_code"] != base["metric_code"] or not metrics
            or len({metric["binding_ref"] for metric in metrics}) != 1):
        reject("两条事实须为相同正式指标及口径；跨指标计算需要另外确认业务关系。")
    metric = metrics[0]
    service.semantics(actor).resolve(metric["binding_ref"])
    if (not metric.get("unit") or current.get("unit") != metric["unit"]
            or base.get("unit") != metric["unit"]
            or metric["unit"] == "%" and metric.get("value_encoding") not in {"ratio", "percent"}):
        reject("指标单位或百分比编码未确认，不能据名称或显示文字计算。")
    if current["org_code"] != base["org_code"] and current["date"] != base["date"]:
        reject("两条事实同时改变机构和日期，不能直接作为同口径差异；请先对齐其中一个维度。")
    return metric, current, base


def comparison_atoms(result, metric, current, base):
    expected = {"difference": "current-base", "change_rate": "(current-base)/base"}
    items = result.get("results", [])
    if (not items or len({item["name"] for item in items}) != len(items)
            or "difference" not in {item["name"] for item in items}
            or any(expected.get(item["name"]) != item["expression"] for item in items)):
        reject("所选计算不是完整的同指标比较回执。")
    atoms = []
    for item in items:
        difference = item["name"] == "difference"
        with localcontext() as precision:
            precision.prec = 60
            value = str(Decimal(item["value"]) * (100 if difference and metric["unit"] == "%" else 1))
        money = money_reply_fields(Decimal(value), metric["unit"]) if difference else {}
        display = (f"{money['reply_value']}{money['reply_unit']}" if money else
                   display_number(value, metric, difference=True) if difference else
                   f"{item['display_value']}{item['unit']}")
        atoms.append({
            "ref": f"calculation.{result['calculation_id']}.{item['name']}", "type": "calculation",
            "name": item["name"], "value": value,
            "display": display,
            "unit": metric["unit"] if difference else item["unit"],
            "value_encoding": metric.get("value_encoding") if difference else "ratio",
            "metric_code": metric["code"], "metric_name": metric["name"],
            "org_code": current["org_code"], "date": current["date"],
            "calculation_id": result["calculation_id"], "formula": item["expression"],
            "input_refs": [current["ref"], base["ref"]],
            "input_fact_refs": [current["fact_id"], base["fact_id"]],
        })
    return atoms


def calculate_analysis_results(service, actor, request: AnalysisCalculationRequest, key: str):
    sources = [service.authorized_evidence(actor, ref) for ref in request.run_refs]
    if any(source["conversation_id"] != request.conversation_id for source in sources):
        reject("计算来源不属于当前会话，请重新读取本会话结果。")
    atoms = validated_report_atoms(sources)
    metric, current, base = comparison_inputs(
        service, actor, sources, atoms, request.current_ref, request.base_ref,
    )
    result = service._calculate(
        {"payload": request, "actor": actor}, metric, current, base, "所选事实",
        snapshots=True,
        scope_policy="cross_date" if current["org_code"] == base["org_code"] else "cross_org",
        request_key=digest({"actor": actor.user_id or actor.subject,
                            "conversation": request.conversation_id, "key": key, "kind": "inquiry-comparison"}),
    )
    return {"kind": "metric_calculate", "status": "succeeded",
            "calculation_ref": {"task_id": result["task_id"], "calculation_id": result["calculation_id"]},
            "run_refs": request.run_refs, "evidence_items": comparison_atoms(result, metric, current, base),
            "inputs": {name: {**result["inputs"][name], "ref": fact["ref"], "display": fact["display"]}
                       for name, fact in (("current", current), ("base", base))},
            "limitations": ["差额或增幅是算术比较，不代表业务原因或机构贡献。"]
            + ([] if any(item["name"] == "change_rate" for item in result["results"])
               else ["本次仅提供取值差额，未计算相对增幅。"])}


def attach_calculation_sources(service, actor, sources, references: list[CalculationReference]):
    if not references:
        return sources
    sources = deepcopy(sources)
    atoms = validated_report_atoms(sources)
    facts = {item["fact_id"]: item for item in atoms.values() if item.get("type") == "fact"}
    tasks = {task["task_id"] for source in sources for task in source["tasks"]}
    for reference in references:
        if reference.task_id not in tasks:
            reject("计算所在任务不属于本次报告来源。")
        with service.tasks.uow_factory() as uow:
            task = uow.tasks.get_owned_for_update(reference.task_id, actor.user_id or "")
            if not task or task.conversation_id != sources[0]["conversation_id"]:
                reject("计算来源不可访问或不属于当前会话。")
            result = next((item["result"] for item in task.state_json.get("calculations", [])
                           if item["result"].get("calculation_id") == reference.calculation_id), None)
            result = deepcopy(result)
        if not result or set(result.get("inputs", {})) != {"current", "base"}:
            reject("所选计算回执不存在或缺少原始输入。")
        selected = []
        for name in ("current", "base"):
            original = result["inputs"][name]
            fact = facts.get(original.get("fact_id"))
            if not fact or any(fact.get(field) != original.get(field) for field in (
                "value", "unit", "metric_code", "org_code", "date",
            )):
                reject("计算输入与本次已授权事实不一致，不能引用其他数值。")
            selected.append(fact)
        metric, current, base = comparison_inputs(
            service, actor, sources, atoms, selected[0]["ref"], selected[1]["ref"],
        )
        owner = next(source for source in sources if current in source["evidence_items"])
        for atom in comparison_atoms(result, metric, current, base):
            if atom["ref"] not in atoms:
                owner["evidence_items"].append(atom)
                atoms[atom["ref"]] = atom
    return sources
