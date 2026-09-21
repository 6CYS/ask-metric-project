"""从受治理查询快照解析数据引用；在应用库事务内校验权限并保存计算证据。"""

import json
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from uuid import uuid4

from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.calculation import (
    CalculationError,
    CalculationRequest,
    Quantity,
    decimal_value,
    evaluate_expression,
    quantity,
    validate_constant,
)
from ask_metric.domain.query_execution import UnsupportedQueryError, json_safe
from ask_metric.domain.value_presentation import money_reply_fields
from ask_metric.infrastructure.db.models import ChatMessage


def build_calculation_facts(task_id: str, rows: list[dict], catalog: dict) -> list[dict]:
    """仅为精确原始数值分配引用；不把浮点、空值和旧舍入数据包装为可信值。"""
    facts = []
    metrics = {item["code"]: item for item in catalog.get("metrics", [])}
    organizations = catalog.get("organizations", [])
    # MySQL 旧取值模板仅返回机构名；只能用本次正式目录中的唯一同名项补齐编码。
    # 不用模型猜测，也不在同名机构间取第一项。
    codes_by_name: dict[str, set[str]] = {}
    for organization in organizations:
        codes_by_name.setdefault(organization["name"], set()).add(organization["code"])
    for index, row in enumerate(rows):
        metric = metrics.get(row.get("metric_code"))
        if not metric or not metric.get("unit"):
            continue
        org_code = row.get("org_code")
        if not org_code:
            candidates = codes_by_name.get(row.get("org_name"), set())
            if len(candidates) != 1:
                continue
            org_code = next(iter(candidates))
        for field in ("metric_value", "current_value", "base_value"):
            if row.get(field) is None:
                continue
            try:
                value = decimal_value(row[field])
            except CalculationError:
                continue
            facts.append(
                {
                    "fact_id": f"fact:{task_id}:{index}:{field}",
                    "task_id": task_id,
                    "field": field,
                    "value": str(value),
                    "unit": metric["unit"],
                    **money_reply_fields(value, metric["unit"]),
                    "metric_code": metric["code"],
                    "metric_name": metric["name"],
                    "org_name": row.get("org_name"),
                    "org_code": org_code,
                    "date": json_safe(
                        row.get("stat_date")
                        or row.get("base_date" if field == "base_value" else "current_date")
                    ),
                }
            )
    return facts


class CalculationApplicationService:
    def __init__(self, execution_service):
        self.execution_service = execution_service
        self.uow_factory = execution_service.uow_factory

    def calculate(self, payload: CalculationRequest, actor, request_id: str) -> dict:
        try:
            return self._calculate(payload, actor, request_id)
        except CalculationError as exc:
            raise ApplicationError("CALCULATION_INVALID", str(exc), status_code=422) from exc
        except PermissionDeniedError as exc:
            raise ApplicationError(
                "CALCULATION_FORBIDDEN", "当前无权访问参与计算的数据。", status_code=403
            ) from exc
        except UnsupportedQueryError as exc:
            raise ApplicationError(
                "CALCULATION_CATALOG_CHANGED", "目录已变化，请重新查询。", status_code=422
            ) from exc

    def _calculate(self, payload: CalculationRequest, actor, request_id: str) -> dict:
        if len({item.name for item in payload.expressions}) != len(payload.expressions):
            raise CalculationError("计算结果名称不能重复。")
        if set(payload.constants) & set(payload.bindings):
            raise CalculationError("常数和数据变量名称不能重复。")
        if (set(payload.constants) | set(payload.bindings)) & {"sum", "avg", "min", "max", "abs"}:
            raise CalculationError("变量名称不能覆盖数学函数。")
        fingerprint = sha256(
            json.dumps(payload.model_dump(), sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        with self.uow_factory() as uow:
            # 与删除和同会话计算共用行锁；计算不访问模型或查询库，事务时长有界。
            conversation = uow.conversations.get_owned_for_update(
                payload.conversation_id, actor.user_id or ""
            )
            if conversation is None:
                raise ApplicationError(
                    "CALCULATION_CONTEXT_NOT_FOUND", "会话已删除或无权访问。", status_code=404
                )
            tasks = {}
            inputs = {}
            values = {}
            questions = set()
            for name, binding in payload.bindings.items():
                parts = binding.fact_id.split(":")
                if len(parts) != 4 or parts[0] != "fact":
                    raise CalculationError("数据引用无效，请重新查询。")
                task_id = parts[1]
                if task_id not in tasks:
                    task = uow.tasks.get_owned_for_update(task_id, actor.user_id or "")
                    if task is None or task.conversation_id != payload.conversation_id:
                        raise CalculationError("数据引用不存在或不属于当前会话。")
                    state = task.state_json or {}
                    context = state.get("channel_context", {}).get("calculation_context", {})
                    if context.get("scope_id") != payload.scope_id:
                        raise CalculationError(
                            "只能计算当前提问或当前待澄清任务的数据。请按本轮机构、指标、日期"
                            "重新查询，再使用新回执的 fact_id 计算；历史回读不会变成本轮取数。"
                        )
                    if task.status != "SUCCEEDED":
                        raise CalculationError("查询尚未成功，不能用于计算。")
                    if task.expires_at and task.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
                        raise CalculationError("查询结果已过期，请重新查询。")
                    artifact = state.get("result_artifact") or {}
                    result = artifact.get("result") or {}
                    if result.get("truncated"):
                        raise CalculationError(
                            "查询结果已截断，请缩小范围后再计算，避免不完整汇总。"
                        )
                    if (result.get("evidence") or {}).get("missing_metric_notice"):
                        raise CalculationError("查询缺少部分指标数据，请补齐或缩小范围后再计算。")
                    original_dsl = artifact.get("logical_dsl")
                    if not original_dsl:
                        raise CalculationError("查询结果缺少证据，请重新查询。")
                    authorized, current_metrics, _ = self.execution_service._authorize_query(
                        uow=uow, actor=actor, logical_dsl=original_dsl, strict_codes=True
                    )
                    if set(authorized.orgs) != set(original_dsl.get("orgs") or []):
                        raise CalculationError("查询结果权限范围已变化，请重新查询。")
                    tasks[task_id] = (task, result, {item.code: item for item in current_metrics})
                    questions.add(context.get("user_question", ""))
                _, result, metric_catalog = tasks[task_id]
                fact = next(
                    (
                        item
                        for item in result.get("facts", [])
                        if item.get("fact_id") == binding.fact_id
                    ),
                    None,
                )
                if fact is None:
                    raise CalculationError("数据引用不存在或原始值精度不满足要求，请重新查询。")
                current_metric = metric_catalog.get(fact.get("metric_code"))
                if current_metric is None or current_metric.unit != fact.get("unit"):
                    raise CalculationError("指标单位或启用状态已变化，请重新查询后计算。")
                inputs[name] = deepcopy(fact)
                values[name] = quantity(fact["value"], fact["unit"])
            if len(questions) != 1:
                raise CalculationError("数据必须来自同一个明确的用户问题。")
            question = questions.pop()
            for name, constant in payload.constants.items():
                values[name] = Quantity(
                    validate_constant(constant.source_text, constant.value, question)
                )
                inputs[name] = {"kind": "user_constant", **constant.model_dump()}
            # 重试仍先复核数据和当前权限，不能直接用幂等命中绕过授权。
            anchor = tasks[sorted(tasks)[0]][0]
            saved = list((anchor.state_json or {}).get("calculations", []))
            replay = next((entry for entry in saved if entry["request_id"] == request_id), None)
            if replay:
                if replay["fingerprint"] != fingerprint:
                    raise ApplicationError(
                        "CALCULATION_CONFLICT", "同一请求不能更换计算内容。", status_code=409
                    )
                return replay["result"]
            if len(saved) >= 50:
                raise CalculationError("当前任务计算记录已达上限，请重新提问。")
            results = []
            for expression in payload.expressions:
                result = evaluate_expression(expression, values)
                selected = [
                    inputs[name] for name in result["variables"] if name in payload.bindings
                ]
                if any(not fact.get("org_code") or not fact.get("date") for fact in selected):
                    raise CalculationError("数据缺少机构或日期证据，请重新查询。")
                if (
                    payload.scope_policy in {"same_org_date", "cross_date"}
                    and len({f["org_code"] for f in selected}) > 1
                ):
                    raise CalculationError("参与计算的机构不同，请明确跨机构计算口径。")
                if (
                    payload.scope_policy in {"same_org_date", "cross_org"}
                    and len({f["date"] for f in selected}) > 1
                ):
                    raise CalculationError("参与计算的日期不同，请明确跨日期计算口径。")
                # 回复金额复用查询的展示规则；计算原值、原单位及来源保持不变。
                result.update(money_reply_fields(decimal_value(result["value"]), result["unit"]))
                if not set(result["variables"]) & set(payload.bindings):
                    raise CalculationError("每个表达式必须引用查询数据。")
                results.append(result)
            # 引用完整性是双向的：声明了却未被任何表达式使用的变量/常数一律拒绝，
            # 不给"夹带无关参数做形式合规"留口子。
            unused = (set(payload.bindings) | set(payload.constants)) - set().union(
                *(set(item["variables"]) for item in results)
            )
            if unused:
                raise CalculationError(f"声明的变量或常数未被任何表达式引用：{sorted(unused)}。")
            response = {
                "calculation_id": str(uuid4()),
                "status": "succeeded",
                "scope_id": payload.scope_id,
                "task_id": anchor.id,
                "results": results,
                "scope_policy": payload.scope_policy,
                "public_answer": "\n".join(
                    f"计算结果「{item['label']}」（{item['expression']}）："
                    f"{item['display_value']}{item['unit']}。" for item in results
                ),
                "inputs": inputs,
                "precision": 60,
                "rounding": "ROUND_HALF_UP",
                "created_at": datetime.now(UTC).isoformat(),
            }
            saved.append({"request_id": request_id, "fingerprint": fingerprint, "result": response})
            # 重新赋值 JSON 使 ORM 感知更改；不覆盖结果快照，也不修改原始数值。
            anchor.state_json = {**anchor.state_json, "calculations": saved}
            uow.messages.add(
                ChatMessage(
                    id=str(uuid4()),
                    conversation_id=conversation.id,
                    task_id=anchor.id,
                    role="assistant",
                    content="计算完成。",
                    payload={"kind": "calculation_result", "result": response},
                    created_at=datetime.now(UTC),
                )
            )
            uow.commit()
            return response
