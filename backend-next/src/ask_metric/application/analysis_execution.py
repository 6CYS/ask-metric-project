"""通用分析运行器：校验有向计划，复用受治理查询和事实计算，保存可恢复回执。"""

import calendar
import json
import time
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal, localcontext
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ask_metric.application.catalog_references import explicit_catalog_references
from ask_metric.application.commands import ExecuteQueryCommand, SubmitQuestionCommand
from ask_metric.application.data_availability import AvailabilityRequest, execute_availability
from ask_metric.application.metric_semantics import METHOD_VERSION, MetricSemantics, digest
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.requests import IncomingRequest
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import AnalysisPlan
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.calculation import CalculationRequest, CalculationScope
from ask_metric.domain.organization_scope import OrganizationScopeSpec
from ask_metric.infrastructure.db.models import ChatConversation, ChatMessage


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan: AnalysisPlan
    org_codes: list[str] = Field(default_factory=list, max_length=100)
    organization_scope: OrganizationScopeSpec | None = None
    scope_fingerprint: str | None = None
    date_selection: str = Field(
        default="latest_snapshot", pattern=r"^(latest_snapshot|exact|available_in_range)$"
    )
    start: date | None = None
    end: date | None = None
    dates: list[date] | None = Field(default=None, max_length=36)
    anchor_date: date | None = None
    conversation_id: str = Field(min_length=1, max_length=128)
    calculation_context: CalculationScope

    @model_validator(mode="after")
    def validate_range(self):
        if self.date_selection != "latest_snapshot" and (not self.start or not self.end):
            raise ValueError("明确日期或期间必须提供起止日")
        if self.start and self.end and self.start > self.end:
            raise ValueError("起止日期顺序错误")
        if self.date_selection == "exact" and self.start != self.end and not self.dates:
            raise ValueError("精确日不能改成范围")
        if self.date_selection == "latest_snapshot" and (self.start or self.end or self.dates):
            raise ValueError("最近日期由实际覆盖决定，不能同时填写日期")
        if self.anchor_date and self.date_selection != "latest_snapshot":
            raise ValueError("仅最近快照补查可以固定截至日")
        if self.dates and (
            sorted(set(self.dates)) != self.dates
            or self.dates[0] != self.start
            or self.dates[-1] != self.end
        ):
            raise ValueError("离散日期必须升序去重且与起止日一致")
        return self


def shift_month(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def month_ranges(start: date, end: date):
    cursor = start.replace(day=1)
    result = []
    while cursor <= end:
        following = shift_month(cursor, 1)
        result.append((max(start, cursor), min(end, date.fromordinal(following.toordinal() - 1))))
        cursor = following
        if len(result) > 36:
            raise ApplicationError(
                "ANALYSIS_RANGE_LIMIT", "单轮最多分析36个月，请缩小期间。", status_code=422
            )
    return result


def display_number(value: str, metric: dict, *, difference=False) -> str:
    with localcontext() as context:
        context.prec = 60
        amount = Decimal(value)
        unit = metric.get("unit") or "（单位未提供）"
        if unit in {"元", "万元", "亿元"}:
            amount *= {"元": Decimal("0.00000001"), "万元": Decimal("0.0001"), "亿元": Decimal(1)}[
                unit
            ]
            unit = "亿元"
        elif unit == "%":
            encoding = metric.get("value_encoding")
            if encoding not in {"ratio", "percent"}:
                return f"原始值 {value}（目录单位%，数值编码待确认）"
            if encoding == "ratio":
                amount *= 100
            # 领域绑定已明确为比例的差额；不能把百分点差额展示成相对增幅。
            hint = metric.get("analysis_hint") or {}
            unit = "个百分点" if difference or hint.get("comparison_role") == "difference" else "%"
        amount = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if not amount:
            amount = abs(amount)
        return f"{amount:.2f}{unit}"


class GeneralAnalysisService:
    def __init__(self, tasks, execution, calculation, *, secret):
        self.tasks, self.execution, self.calculation, self.secret = (
            tasks,
            execution,
            calculation,
            secret,
        )

    def semantics(self, actor):
        with self.tasks.uow_factory() as uow:
            # 签发和复核绑定必须读取真实元数据；秒级updated_at缓存键可能漏掉同秒修改。
            catalog = uow.metric_catalog.list_enabled(refresh=True)
        return MetricSemantics(catalog, secret=self.secret, actor_id=actor.user_id or actor.subject)

    def validate_plan(self, plan, actor, question=""):
        semantics = self.semantics(actor)
        bindings = {ref: semantics.resolve(ref) for step in plan.steps for ref in step.metric_refs}
        explicit = explicit_catalog_references(
            question,
            metrics=list(semantics.items.values()),
            organizations=[],
            organization_aliases={},
        )["metrics"]
        selected = {item["code"] for item in bindings.values()}
        if explicit - selected:
            raise ApplicationError(
                "ANALYSIS_EXPLICIT_METRIC_MISSING",
                "计划遗漏了原文明示的正式指标，请补齐后再执行。",
                status_code=422,
            )
        for step in plan.steps:
            if step.method == "structure":
                relation = next(
                    (
                        item
                        for item in semantics.relations(list(bindings.values()))
                        if item.get("id") == step.relation_id
                    ),
                    None,
                )
                if not relation or not {relation["parent"], *relation["children"]} <= {
                    bindings[ref]["code"] for ref in step.metric_refs
                }:
                    raise ApplicationError(
                        "ANALYSIS_RELATION_REQUIRED",
                        "结构分析缺少审核后的完整分母与分项绑定，不能根据名称推断。",
                        status_code=422,
                    )
        return semantics, bindings

    def _authorize(self, actor, codes):
        try:
            authorized = self.execution.permission_service.authorize_logical_dsl(
                actor=actor, logical_dsl={"orgs": codes}
            )
        except PermissionDeniedError as exc:
            raise ApplicationError(
                "ANALYSIS_FORBIDDEN", "无权读取分析范围。", status_code=403
            ) from exc
        if set(authorized.get("orgs", [])) != set(codes):
            raise ApplicationError("ANALYSIS_FORBIDDEN", "无权读取分析范围。", status_code=403)

    def _read_run(self, actor, run_id, *, lock=False):
        with self.tasks.uow_factory() as uow:
            query = select(ChatMessage).where(ChatMessage.id == run_id)
            record = uow.session.scalar(query.with_for_update() if lock else query)
            if (
                not record
                or record.payload.get("kind") != "general_analysis_run_v1"
                or record.payload.get("owner") != (actor.user_id or actor.subject)
            ):
                raise ApplicationError(
                    "ANALYSIS_RUN_NOT_FOUND", "分析运行不存在或无权读取。", status_code=404
                )
            value = json.loads(json.dumps(record.payload))
        self._authorize(actor, value["org_codes"])
        return value

    def _save(self, run_id, lease, state):
        with self.tasks.uow_factory() as uow:
            record = uow.session.scalar(
                select(ChatMessage).where(ChatMessage.id == run_id).with_for_update()
            )
            if not record or record.payload.get("lease") != lease:
                raise ApplicationError(
                    "ANALYSIS_LEASE_CHANGED",
                    "分析状态已由其他请求推进，请读取真实回执。",
                    status_code=409,
                )
            record.payload = {**state, "updated_at": datetime.now(UTC).isoformat()}
            uow.commit()

    def _claim(self, payload, actor, key, org_codes):
        run_id = "analysis:" + digest({"actor": actor.user_id or actor.subject, "key": key})[:56]
        fingerprint = digest(payload.model_dump(mode="json"))
        lease = uuid4().hex
        try:
            with self.tasks.uow_factory() as uow:
                conversation = uow.session.get(ChatConversation, payload.conversation_id)
                if not conversation or conversation.owner_user_id != actor.user_id:
                    raise ApplicationError(
                        "ANALYSIS_FORBIDDEN", "无权使用分析会话。", status_code=403
                    )
                record = uow.session.scalar(
                    select(ChatMessage).where(ChatMessage.id == run_id).with_for_update()
                )
                if record:
                    state = record.payload
                    if state["fingerprint"] != fingerprint:
                        raise ApplicationError(
                            "ANALYSIS_IDEMPOTENCY_CONFLICT",
                            "同一分析请求键不能更换计划。",
                            status_code=409,
                        )
                    if state["status"] == "completed":
                        return run_id, None, state
                    if (
                        state["status"] == "running"
                        and (
                            datetime.now(UTC) - datetime.fromisoformat(state["updated_at"])
                        ).total_seconds()
                        < 150
                    ):
                        raise ApplicationError(
                            "ANALYSIS_RUNNING",
                            "分析仍在执行，请稍后按原请求键回查。",
                            status_code=409,
                        )
                    state = {**state, "lease": lease, "status": "running"}
                    record.payload = state
                else:
                    state = {
                        "kind": "general_analysis_run_v1",
                        "owner": actor.user_id or actor.subject,
                        "fingerprint": fingerprint,
                        "lease": lease,
                        "status": "running",
                        "org_codes": org_codes,
                        "updated_at": datetime.now(UTC).isoformat(),
                        "completed_steps": {},
                        "coverage": {},
                        "query_results": {},
                        "query_count": 0,
                        "request": payload.model_dump(mode="json"),
                    }
                    uow.session.add(
                        ChatMessage(
                            id=run_id,
                            conversation_id=payload.conversation_id,
                            role="assistant",
                            content="通用经营分析运行记录",
                            payload=state,
                            created_at=datetime.now(UTC),
                        )
                    )
                uow.commit()
        except IntegrityError as exc:
            raise ApplicationError(
                "ANALYSIS_RUNNING", "同一分析请求正在登记，请稍后回查。", status_code=409
            ) from exc
        return run_id, lease, state

    def execute(self, payload: AnalysisRequest, actor, key):
        semantics, bindings = self.validate_plan(
            payload.plan, actor, payload.calculation_context.user_question
        )
        today = self.execution.today_provider()
        if payload.anchor_date and payload.anchor_date > today:
            raise ApplicationError(
                "ANALYSIS_DATE_INVALID", "补查截至日不能晚于业务日期。", status_code=422
            )
        with self.tasks.uow_factory() as uow:
            organizations = uow.organization_catalog.list_enabled()
        org_names = {item.code: item.name for item in organizations}
        org_codes = payload.org_codes or ([actor.org_id] if actor.org_id else [])
        if payload.organization_scope:
            resolved = resolve_query_scope(
                scope=payload.organization_scope,
                actor=actor,
                organizations=organizations,
                permissions=self.execution.permission_service,
                hierarchy=self.execution.organization_scope_provider
                or self.execution.org_hierarchy_provider,
            )
            if resolved["scope_fingerprint"] != payload.scope_fingerprint or payload.org_codes:
                raise ApplicationError(
                    "ANALYSIS_SCOPE_CHANGED", "机构集合已变化，请重新解析范围。", status_code=409
                )
            org_codes = resolved["codes"]
        if not org_codes or set(org_codes) - org_names.keys():
            raise ApplicationError(
                "ANALYSIS_ORG_INVALID", "缺少唯一默认机构，或机构不在正式目录。", status_code=422
            )
        self._authorize(actor, org_codes)
        run_id, lease, state = self._claim(payload, actor, key, org_codes)
        if lease is None:
            return self.authorized_evidence(actor, run_id)
        deadline = time.monotonic() + 120
        context = {
            "payload": payload,
            "actor": actor,
            "key": key,
            "run_id": run_id,
            "lease": lease,
            "state": state,
            "deadline": deadline,
            "org_codes": org_codes,
            "org_names": org_names,
            "semantics": semantics,
            "bindings": bindings,
            "today": today,
        }
        try:
            for step in payload.plan.steps:
                if step.id in state["completed_steps"]:
                    continue
                result = self._execute_step(context, step)
                state["completed_steps"][step.id] = result
                self._save(run_id, lease, state)
            evidence = self._finish(context)
            from ask_metric.application.verified_findings import attach_analysis_findings

            attach_analysis_findings(evidence)
            state.update(status="completed", result=evidence)
            self._save(run_id, lease, state)
            return evidence
        except Exception:
            # 已登记任务与覆盖保留；进程重启或临时错误后可按同一计划恢复。
            state["status"] = "interrupted"
            state["updated_at"] = datetime.fromtimestamp(0, UTC).isoformat()
            self._save(run_id, lease, state)
            raise

    def _coverage(self, context, code, start, end):
        state = context["state"]
        signature = digest({"code": code, "orgs": context["org_codes"], "start": start, "end": end})
        if signature not in state["coverage"]:
            if time.monotonic() >= context["deadline"]:
                return None
            result = execute_availability(
                AvailabilityRequest(
                    metric_codes=[code],
                    org_codes=context["org_codes"],
                    start=start,
                    end=end,
                    page_size=1,
                ),
                context["actor"],
                self.execution,
                self.execution.planner.dialect,
                {code: context["semantics"].items[code].name},
                context["org_names"],
            )
            state["coverage"][signature] = result["groups"][0]
            self._save(context["run_id"], context["lease"], state)
        return state["coverage"][signature].get("latest")

    def _query(self, context, metric, dates, *, selection="exact", start=None, end=None):
        if not dates:
            return {"facts": [], "tasks": [], "gaps": ["指定范围没有有效日期记录。"]}
        codes = context["org_codes"]
        spec = BasicQuerySpec(
            metric_codes=[metric["code"]],
            org_codes=codes,
            time={
                "start": start or min(dates),
                "end": end or max(dates),
                **(
                    {"dates": sorted(set(dates))}
                    if len(set(dates)) > 1 and selection == "exact"
                    else {}
                ),
            },
            selection=selection,
        )
        signature = digest(spec.model_dump(mode="json"))
        state = context["state"]
        if signature in state["query_results"]:
            return state["query_results"][signature]
        if state["query_count"] >= 40 or time.monotonic() >= context["deadline"]:
            return {"facts": [], "tasks": [], "gaps": ["达到本轮查询或时间预算，本项尚未执行。"]}
        state["query_count"] += 1
        self._save(context["run_id"], context["lease"], state)
        step_key = digest({"run": context["run_id"], "query": signature})
        created = self.tasks.submit_question(
            SubmitQuestionCommand(
                request=IncomingRequest(
                    request_id=step_key,
                    channel="basic_query",
                    conversation_id=context["payload"].conversation_id,
                    text=context["payload"].calculation_context.user_question,
                    channel_context={
                        "calculation_context": context["payload"].calculation_context.model_dump(),
                        "analysis_method": METHOD_VERSION,
                        "analysis_run": context["run_id"],
                    },
                ),
                actor=context["actor"],
                idempotency_key=step_key,
                basic_query=spec,
            )
        )
        query = self.execution.execute(
            ExecuteQueryCommand(
                task_id=created.task_id,
                expected_version=created.version,
                request_id=step_key,
                actor=context["actor"],
            )
        )
        valid = query.status == "succeeded" and not query.truncated
        facts = [fact for fact in query.facts if fact.get("value") is not None] if valid else []
        result = {
            "facts": facts,
            "tasks": [{"task_id": query.task_id, "status": query.status}],
            "gaps": []
            if valid
            else [f"查询未取得完整可核验结果：{query.error_code or query.status}"],
        }
        if valid and not facts:
            result["gaps"].append("该范围未取得有效数值；不能将缺失当作零。")
        state["query_results"][signature] = result
        self._save(context["run_id"], context["lease"], state)
        return result

    def _calculate(self, context, metric, current, base, label, *, share=False):
        if (
            not metric.get("unit")
            or metric["unit"] == "%"
            and metric.get("value_encoding") not in {"ratio", "percent"}
        ):
            return None
        # 既有计算器将目录百分数除100后计算；还原原始差值后再按审核编码展示百分点。
        expressions = [
            {
                "name": "difference",
                "label": f"{label}取值差额",
                "expression": "(current-base)*100" if metric["unit"] == "%" else "current-base",
            }
        ]
        if share:
            expressions = [
                {
                    "name": "share",
                    "label": "分项占比",
                    "expression": "current/base",
                    "display": "percent",
                }
            ]
        elif metric["unit"] in {"元", "万元", "亿元"} and Decimal(base["value"]) > 0:
            expressions.append(
                {
                    "name": "change_rate",
                    "label": f"{label}取值变化率",
                    "expression": "(current-base)/base",
                    "display": "percent",
                }
            )
        response = self.calculation.calculate(
            CalculationRequest(
                conversation_id=context["payload"].conversation_id,
                scope_id=context["payload"].calculation_context.scope_id,
                scope_policy="same_org_date" if share else "cross_date",
                expressions=expressions,
                bindings={
                    "current": {"fact_id": current["fact_id"]},
                    "base": {"fact_id": base["fact_id"]},
                },
            ),
            context["actor"],
            digest(
                {
                    "run": context["run_id"],
                    "current": current["fact_id"],
                    "base": base["fact_id"],
                    "share": share,
                }
            ),
        )
        return {**response, "metric_descriptor": metric, "comparison": label,
                "org_code": current["org_code"], "date": current["date"]}

    def _latest_valid_date(self, context, metric, start, end, result):
        """覆盖只说明存在记录；有限回查实际数值，精确日期不会进入本方法。"""
        for attempt in range(5):
            latest = self._coverage(context, metric["code"], start, end)
            if not latest:
                return None
            day = date.fromisoformat(latest)
            checked = self._query(context, metric, [day])
            result["tasks"].extend(checked["tasks"])
            if checked["facts"]:
                if attempt:
                    result["notices"].append(f"{metric['name']}较新记录无有效值，回查至{day}。")
                return day
            # 服务失败和预算耗尽不能伪装成无数据，保留真实错误。
            if any(item["status"] != "succeeded" for item in checked["tasks"]) or any(
                "未取得完整" in gap or "预算" in gap for gap in checked["gaps"]
            ):
                result["gaps"].extend(checked["gaps"])
                return None
            end = date.fromordinal(day.toordinal() - 1)
            if start and end < start:
                return None
        result["gaps"].append(f"{metric['name']}连续记录无有效值，达到回查预算。")
        return None

    def _execute_step(self, context, step):
        result = {
            "step_id": step.id,
            "method": step.method,
            "answers": step.answers,
            "facts": [],
            "calculations": [],
            "observations": [],
            "tasks": [],
            "gaps": [],
            "notices": [],
        }
        payload, today = context["payload"], context["today"]
        for reference in step.metric_refs:
            metric = context["bindings"][reference]
            if time.monotonic() >= context["deadline"]:
                result["gaps"].append(f"{metric['name']}：执行时间预算已用尽。")
                continue
            end = min(payload.end or payload.anchor_date or today, today)
            start = payload.start
            latest = None
            if payload.date_selection == "latest_snapshot" or step.method == "trend" and not start:
                latest = self._latest_valid_date(context, metric, None, end, result)
            if payload.date_selection == "exact":
                dates = payload.dates or [payload.end]
            elif step.method == "trend" or payload.date_selection == "available_in_range":
                if not start:
                    end = latest or end
                    start = shift_month(end.replace(day=1), -2)
                    result["notices"].append(
                        "未指定趋势窗口，采用截至可用日期所在月的最近三个月；每月仅展示最后有效观测。"
                    )
                dates = [
                    value
                    for first, last in month_ranges(start, end)
                    if (value := self._latest_valid_date(context, metric, first, last, result))
                ]
                covered_months = {day.strftime("%Y-%m") for day in dates}
                absent = [
                    first.strftime("%Y-%m")
                    for first, _ in month_ranges(start, end)
                    if first.strftime("%Y-%m") not in covered_months
                ]
                if absent:
                    result["gaps"].append(
                        f"{metric['name']}缺少月份：{'、'.join(absent)}；未补零或插值。"
                    )
            else:
                dates = [latest] if latest else []
            if not dates:
                result["gaps"].append(f"{metric['name']}在目标范围没有可用记录。")
                continue
            query_dates = set(dates)
            comparison_dates = {}
            if step.method == "compare":
                for current in dates:
                    for comparison in step.comparisons:
                        base = (
                            shift_month(current, -1 if comparison == "mom" else -12)
                            if comparison != "ytd"
                            else date(current.year - 1, 12, 31)
                        )
                        comparison_dates[(current, comparison)] = base
                        query_dates.add(base)
            query = self._query(context, metric, sorted(query_dates))
            result["tasks"].extend(query["tasks"])
            result["gaps"].extend(query["gaps"])
            result["facts"].extend(
                [
                    {
                        **fact,
                        "binding_ref": reference,
                        "role": "current" if date.fromisoformat(fact["date"]) in dates else "base",
                    }
                    for fact in query["facts"]
                ]
            )
            current_facts = [
                fact for fact in query["facts"] if date.fromisoformat(fact["date"]) in dates
            ]
            for fact in current_facts:
                result["observations"].append(
                    {
                        "type": "value",
                        "metric": metric["code"],
                        "fact_refs": [fact["fact_id"]],
                        "text": (
                            f"{fact['org_name']}，{fact['date']}，{metric['name']}为"
                            f"{display_number(fact['value'], metric)}。"
                        ),
                    }
                )
            if len(context["org_codes"]) > 1:
                for day in dates:
                    missing = set(context["org_codes"]) - {
                        fact["org_code"] for fact in current_facts if fact["date"] == str(day)
                    }
                    if missing:
                        result["gaps"].append(
                            f"{metric['name']}在{day}有{len(missing)}家机构未取得有效值；排名仅覆盖实际有数据的机构。"
                        )
            if step.method == "ranking":
                if len(context["org_codes"]) < 2:
                    result["gaps"].append(
                        "排名需要明确多个机构或授权集合；当前只有单一机构，已展示取值。"
                    )
                for day in dates:
                    rows = [fact for fact in current_facts if fact["date"] == str(day)]
                    reverse = step.position == "top"
                    if metric["unit"] == "名":
                        reverse = not reverse
                    ranked = sorted(
                        rows,
                        key=lambda fact: (Decimal(fact["value"]), fact["org_code"]),
                        reverse=reverse,
                    )[: step.top_n]
                    for index, fact in enumerate(ranked, 1):
                        result["observations"].append(
                            {
                                "type": "ranking",
                                "metric": metric["code"],
                                "fact_refs": [fact["fact_id"]],
                                "text": (
                                    f"{day}，本次有数据的机构集合内"
                                    f"{'前' if step.position == 'top' else '后'}序第{index}位："
                                    f"{fact['org_name']}，取值"
                                    f"{display_number(fact['value'], metric)}；不代表业务好坏。"
                                ),
                            }
                        )
            if step.method == "compare":
                facts = {(fact["org_code"], fact["date"]): fact for fact in query["facts"]}
                for current in current_facts:
                    for comparison in step.comparisons:
                        base_day = comparison_dates[
                            (date.fromisoformat(current["date"]), comparison)
                        ]
                        base = facts.get((current["org_code"], str(base_day)))
                        if not base:
                            result["gaps"].append(
                                f"{metric['name']}缺少{base_day}比较基期，不能完成该项比较。"
                            )
                            continue
                        calculation = self._calculate(context, metric, current, base, comparison)
                        if not calculation:
                            result["gaps"].append(
                                f"{metric['name']}单位或百分比数值编码不明，未计算差额或变化率。"
                            )
                            continue
                        result["calculations"].append(calculation)
                        difference = next(
                            item for item in calculation["results"] if item["name"] == "difference"
                        )
                        direction = (
                            "增加"
                            if Decimal(difference["value"]) > 0
                            else "减少"
                            if Decimal(difference["value"]) < 0
                            else "持平"
                        )
                        difference_text = display_number(
                            difference["value"], metric, difference=True
                        )
                        result["observations"].append(
                            {
                                "type": "comparison",
                                "metric": metric["code"],
                                "fact_refs": [current["fact_id"], base["fact_id"]],
                                "calculation_id": calculation["calculation_id"],
                                "direction": direction,
                                "text": (
                                    f"{current['org_name']}的{metric['name']}，"
                                    f"{current['date']}相对{base_day}观测值{direction}，差额"
                                    f"{difference_text}。"
                                    "这是同指标取值比较，未据此认定单月业务发生额或业务原因。"
                                ),
                            }
                        )
        if step.method == "structure":
            relation = next(
                item
                for item in context["semantics"].relations(list(context["bindings"].values()))
                if item["id"] == step.relation_id
            )
            facts = {
                (fact["metric_code"], fact["org_code"], fact["date"]): fact
                for fact in result["facts"]
                if fact["role"] == "current"
            }
            for (code, org, day), parent in list(facts.items()):
                if code != relation["parent"]:
                    continue
                for child_code in relation["children"]:
                    child = facts.get((child_code, org, day))
                    if (
                        not child
                        or parent["unit"] != child["unit"]
                        or Decimal(parent["value"]) <= 0
                    ):
                        result["gaps"].append("分项与分母缺少同日同单位正值，未计算占比。")
                        continue
                    metric = next(
                        item for item in context["bindings"].values() if item["code"] == child_code
                    )
                    calculation = self._calculate(
                        context, metric, child, parent, "share", share=True
                    )
                    if calculation:
                        result["calculations"].append(calculation)
                        share = calculation["results"][0]
                        result["observations"].append(
                            {
                                "type": "structure",
                                "metric": child_code,
                                "fact_refs": [child["fact_id"], parent["fact_id"]],
                                "calculation_id": calculation["calculation_id"],
                                "text": (
                                    f"{org}，{day}，{metric['name']}按审核关系"
                                    f"占分母的{share['display_value']}%；未假定分项互斥或完整。"
                                ),
                            }
                        )
        return result

    def _finish(self, context):
        state, payload = context["state"], context["payload"]
        prefix = context["run_id"].split(":")[1][:10]
        atoms, rows, observations, tasks, gaps = [], [], [], [], []
        seen = set()
        for step in state["completed_steps"].values():
            gaps.extend(step["gaps"])
            tasks.extend(step["tasks"])
            for fact in step["facts"]:
                if fact["fact_id"] in seen:
                    continue
                seen.add(fact["fact_id"])
                metric = context["bindings"][fact["binding_ref"]]
                ref = f"{prefix}.f{len(atoms) + 1}"
                display = display_number(fact["value"], metric)
                atoms.append(
                    {
                        "ref": ref,
                        "type": "fact",
                        "display": display,
                        "fact_id": fact["fact_id"],
                        "metric_code": fact["metric_code"],
                        "metric_name": metric["name"],
                        "org_name": fact["org_name"],
                        "org_code": fact["org_code"],
                        "date": fact["date"],
                        "value": fact["value"],
                        "unit": fact["unit"],
                        "metadata_version": metric["metadata_version"],
                    }
                )
                rows.append(
                    {
                        "metric_name": metric["name"],
                        "org_name": fact["org_name"],
                        "stat_date": fact["date"],
                        "metric_value": display,
                        "value_role": "分析时点" if fact["role"] == "current" else "比较基期",
                    }
                )
            for calculation in step["calculations"]:
                for item in calculation["results"]:
                    ref = f"{prefix}.c{len(atoms) + 1}"
                    display = (
                        display_number(
                            item["value"], calculation["metric_descriptor"], difference=True
                        )
                        if item["name"] == "difference"
                        else f"{item['display_value']}{item['unit']}"
                    )
                    atoms.append(
                        {
                            "ref": ref,
                            "type": "calculation",
                            "display": display,
                            "calculation_id": calculation["calculation_id"],
                            "name": item["name"],
                            "value": item["value"],
                            "unit": item["unit"],
                            # 升级前已完成的节点可重放；缺少新比较元数据时仅保留旧事实。
                            "date": calculation.get("date") or calculation["inputs"].get("current", {}).get("date"),
                            "org_code": calculation.get("org_code") or calculation["inputs"].get("current", {}).get("org_code"),
                            "comparison": calculation.get("comparison"),
                            "comparison_role": {"difference": "difference", "change_rate": "rate"}.get(item["name"]),
                            "metric_code": calculation["metric_descriptor"]["code"],
                            "metric_name": calculation["metric_descriptor"]["name"],
                            "input_fact_refs": [
                                fact["fact_id"] for fact in calculation["inputs"].values()
                            ],
                        }
                    )
            for observation in step["observations"]:
                ref = f"{prefix}.o{len(observations) + 1}"
                observations.append({**observation, "ref": ref, "step_id": step["step_id"]})
                atoms.append({"ref": ref, "type": "observation", "display": observation["text"]})
        dispositions = []
        for requirement in payload.plan.requirements:
            related = [
                step
                for step in state["completed_steps"].values()
                if requirement.id in step["answers"]
            ]
            status = (
                "gap"
                if not related
                else "partial"
                if any(step["gaps"] for step in related)
                else "completed"
            )
            dispositions.append(
                {
                    "id": requirement.id,
                    "question": requirement.question,
                    "status": status,
                    "reason": requirement.gap_reason,
                    "step_ids": [step["step_id"] for step in related],
                }
            )
            if requirement.gap_reason:
                gaps.append(requirement.gap_reason)
        # 缺数也是已经执行覆盖检查后形成的证据，空表仍应能交付有引用的说明。
        for index, gap in enumerate(dict.fromkeys(gaps), 1):
            atoms.append({"ref": f"{prefix}.g{index}", "type": "gap", "display": gap})
        metrics = list({item["code"]: item for item in context["bindings"].values()}.values())
        limitations = list(
            dict.fromkeys(note for metric in metrics for note in metric["limitations"])
        )
        actual_dates = sorted({row["stat_date"] for row in rows if row["value_role"] == "分析时点"})
        return {
            "kind": "analysis_evidence",
            "status": "succeeded",
            "delivery": "business_evidence_v1",
            "run_ref": context["run_id"],
            "scope_id": payload.calculation_context.scope_id,
            "conversation_id": payload.conversation_id,
            "method_version": METHOD_VERSION,
            "plan": payload.plan.model_dump(),
            "org_codes": context["org_codes"],
            "org_names": [context["org_names"][code] for code in context["org_codes"]],
            "date_selection": payload.date_selection,
            "requested_start": str(payload.start) if payload.start else None,
            "requested_end": str(payload.end) if payload.end else None,
            "actual_dates": actual_dates,
            "analysis_date": max(actual_dates) if actual_dates else None,
            "checked_on": str(context["today"]),
            "defaults_applied": (
                ["用户未指定机构，采用当前认证账户所属机构。"]
                if not payload.org_codes and not payload.organization_scope
                else []
            )
            + list(
                dict.fromkeys(
                    notice
                    for step in state["completed_steps"].values()
                    for notice in step.get("notices", [])
                )
            )
            + (
                [
                    "用户未指定日期或询问最近，按所选指标的实际覆盖选择最新观测；不同指标可能有不同截至日。"
                ]
                if payload.date_selection == "latest_snapshot"
                else []
            ),
            "metric_descriptors": metrics,
            # 从既有语义绑定提供后续入口；模型仍需规划，取数权限与实际覆盖照常校验。
            "followup_metrics": context["semantics"].comparison_candidates(
                [metric for metric in metrics if any(
                    atom.get("metric_code") == metric["code"] and atom["type"] == "fact"
                    for atom in atoms
                )]
            ),
            "evidence_items": atoms,
            "observations": observations,
            "rows": rows,
            "row_count": len(rows),
            "columns": ["metric_name", "org_name", "stat_date", "metric_value", "value_role"],
            "tasks": list({item["task_id"]: item for item in tasks}.values()),
            "requirement_dispositions": dispositions,
            "gaps": list(dict.fromkeys(gaps)),
            "limitations": limitations,
            "complete": all(item["status"] == "completed" for item in dispositions),
            "query_count": state["query_count"],
            "source_notice": (
                "数值来自项目当前配置的实际指标查询库，由既有基础查询与计算服务取得；"
                "指标定义来自正式目录。上游生产来源与批次一致性需另行核实。"
            ),
            "snapshot_notice": (
                "本次各查询回执不可变；查询库未提供统一批次标识，不能据此宣称跨查询为同一物理快照。"
            ),
            "public_answer": (
                f"已完成{len(rows)}条事实记录的查询，正在依据事实组织分析；请查看数据明细和缺口。"
            ),
        }

    def authorized_evidence(self, actor, run_ref):
        state = self._read_run(actor, run_ref)
        if state["status"] != "completed":
            raise ApplicationError(
                "ANALYSIS_RUNNING", "分析尚未完成，不能读取为成功结果。", status_code=409
            )
        evidence = state["result"]
        for task in evidence["tasks"]:
            self.tasks.get_task(task["task_id"], actor=actor)
        return evidence

    def run_status(self, actor, key, conversation_id):
        run_id = "analysis:" + digest({"actor": actor.user_id or actor.subject, "key": key})[:56]
        state = self._read_run(actor, run_id)
        if state["request"]["conversation_id"] != conversation_id:
            raise ApplicationError(
                "ANALYSIS_RUN_NOT_FOUND", "分析运行不存在或无权读取。", status_code=404
            )
        if state["status"] == "completed":
            return {"status": "succeeded", "evidence": self.authorized_evidence(actor, run_id)}
        return {"status": state["status"], "run_ref": run_id}
