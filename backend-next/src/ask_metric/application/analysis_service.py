"""LangGraph is the sole analysis scheduler; QueryTask stores its API projection."""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from time import time
from typing import TypedDict
from uuid import uuid4

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic import ValidationError
from sqlalchemy import or_, update

from ask_metric.application.analysis_access import authorize_analysis
from ask_metric.application.analysis_tools import AnalysisToolError, AnalysisTools
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.result_repository import ResultRepository
from ask_metric.application.task_service import _task_result
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis import (
    AnalysisAction,
    AnalysisBudget,
    AnalysisIntent,
    AnalysisSkill,
    AnalysisTarget,
)
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.analysis_checkpoint import SqlAlchemyAnalysisSaver
from ask_metric.infrastructure.db.models import AnalysisThread, ChatMessage
from ask_metric.infrastructure.model.provider import InvalidModelResponse, ModelServiceUnavailable


class GraphState(TypedDict, total=False):
    intent: dict
    feedback: str
    target: dict
    action: dict
    evidence: list[str]
    stop_reason: str
    question: str


class AnalysisStopped(RuntimeError):
    pass


class AnalysisApplicationService:
    def __init__(
        self,
        *,
        model,
        execution,
        uow_factory,
        skill_path: Path,
        relations_path: Path,
        budget: AnalysisBudget | None = None,
        token_codec=None,
    ):
        self.model, self.execution, self.uow_factory = model, execution, uow_factory
        self.skill_path, self.relations_path = skill_path, relations_path
        self.budget = budget or AnalysisBudget()
        self.token_codec = token_codec

    def _owned(self, uow, task_id, actor):
        task = uow.tasks.get_owned(task_id, actor.user_id or "")
        if (
            task is None
            or (task.state_json or {}).get("actor_context", {}).get("tenant_id") != actor.tenant_id
        ):
            raise ApplicationError("TASK_NOT_FOUND", "分析任务不存在", status_code=404)
        return task

    def progress(self, task_id, actor):
        with self.uow_factory() as uow:
            task = self._owned(uow, task_id, actor)
            authorize_analysis(task.state_json or {}, actor, self.execution.permission_service)
            target = (task.state_json or {}).get("analysis_target")
            if target:
                self.execution.permission_service.authorize_logical_dsl(
                    actor=actor, logical_dsl=AnalysisTarget.model_validate(target).dsl()
                )
            row = uow.session.get(AnalysisThread, task_id)
            return {
                "analysis_id": task_id,
                "status": task.status,
                "version": task.version,
                "events": row.progress if row else [],
                "usage": row.usage if row else {},
                "cancel_requested": row.cancelled if row else False,
            }

    def cancel(self, task_id, actor, expected_version):
        idle_token = None
        with self.uow_factory() as uow:
            task = self._owned(uow, task_id, actor)
            if task.version != expected_version:
                raise ApplicationError("TASK_VERSION_CONFLICT", "任务版本已变化", status_code=409)
            row = uow.session.get(AnalysisThread, task_id)
            if row is None:
                raise ApplicationError("ANALYSIS_NOT_STARTED", "分析尚未启动", status_code=409)
            if task.status in {"SUCCEEDED", "FAILED", "CANCELLED"}:
                return self.progress(task_id, actor)
            row.cancelled = True
            if task.status == "WAITING_USER" and (
                row.lease_token is None or row.lease_until < time()
            ):
                idle_token = uuid4().hex
                row.lease_token, row.lease_until = idle_token, time() + 120
                factory = uow.session_factory
            uow.commit()
        if idle_token:
            runtime = _AnalysisRuntime(self, task_id, actor, factory, idle_token)
            try:
                checkpoint = runtime.saver.get_tuple(runtime.config)
                state = checkpoint.checkpoint["channel_values"] if checkpoint else {}
                runtime.project(state, "CANCELLED", "CANCELLED")
            finally:
                with factory() as session:
                    session.execute(
                        update(AnalysisThread)
                        .where(
                            AnalysisThread.id == task_id,
                            AnalysisThread.lease_token == idle_token,
                        )
                        .values(lease_token=None, lease_until=0)
                    )
                    session.commit()
        return self.progress(task_id, actor)

    def run(self, command):
        actor, task_id = command.actor, command.task_id
        if actor is None:
            raise ApplicationError("AUTH_REQUIRED", "分析需要可信用户身份", status_code=401)
        with self.uow_factory() as uow:
            task = self._owned(uow, task_id, actor)
            raw = dict(task.state_json or {})
            if raw.get("analysis_started") and task.status in {"SUCCEEDED", "FAILED", "CANCELLED"}:
                authorize_analysis(raw, actor, self.execution.permission_service)
                if raw.get("analysis_target"):
                    self.execution.permission_service.authorize_logical_dsl(
                        actor=actor,
                        logical_dsl=AnalysisTarget.model_validate(raw["analysis_target"]).dsl(),
                    )
                return _task_result(task, idempotent_replay=True)
            if task.version != command.expected_version or task.status != "RUNNING":
                raise ApplicationError(
                    "TASK_VERSION_CONFLICT", "任务版本或状态已变化", status_code=409
                )
            row = uow.session.get(AnalysisThread, task_id)
            if row is None:
                row = AnalysisThread(id=task_id, task_id=task_id, usage={}, progress=[])
                uow.session.add(row)
            if not raw.get("analysis_started"):
                governance = json.loads(self.relations_path.read_text(encoding="utf-8"))
                raw.update(
                    analysis_started=True,
                    analysis_skill=AnalysisSkill.model_validate_json(
                        self.skill_path.read_text(encoding="utf-8")
                    ).model_dump(mode="json"),
                    graph_version="analysis-v1",
                    analysis_relations=governance["relations"],
                    analysis_organization_relations=governance.get("organization_relations", []),
                    analysis_tools={},
                )
                task.state_json = raw
                task.intent = "attribution_analysis"
            factory = uow.session_factory
            if raw.get("graph_version") != "analysis-v1":
                raise ApplicationError(
                    "ANALYSIS_GRAPH_VERSION", "分析图版本不兼容，请使用原版本恢复", status_code=409
                )
            uow.commit()
        token = uuid4().hex
        with factory() as session:
            acquired = session.execute(
                update(AnalysisThread)
                .where(
                    AnalysisThread.id == task_id,
                    or_(AnalysisThread.lease_token.is_(None), AnalysisThread.lease_until < time()),
                )
                .values(lease_token=token, lease_until=time() + self.budget.seconds + 120)
            )
            if acquired.rowcount != 1:
                raise ApplicationError("ANALYSIS_BUSY", "分析正在执行，请读取进度", status_code=409)
            session.commit()
        runtime = _AnalysisRuntime(self, task_id, actor, factory, token)
        try:
            return runtime.run(raw.get("analysis_resume"))
        finally:
            with factory() as session:
                session.execute(
                    update(AnalysisThread)
                    .where(
                        AnalysisThread.id == task_id,
                        AnalysisThread.lease_token == token,
                    )
                    .values(lease_token=None, lease_until=0)
                )
                session.commit()


class _AnalysisRuntime:
    def __init__(self, service, task_id, actor, factory, token):
        self.service, self.task_id, self.actor = service, task_id, actor
        self.factory, self.token = factory, token
        self.started = time()
        self.accounted_at = self.started
        with service.uow_factory() as uow:
            task = service._owned(uow, task_id, actor)
            self.raw = dict(task.state_json)
            self.question, self.conversation_id = task.original_question, task.conversation_id
        self.tools = AnalysisTools(
            task_id=task_id,
            actor=actor,
            uow_factory=service.uow_factory,
            execution=service.execution,
            relations=self.raw["analysis_relations"],
            organization_relations=self.raw.get("analysis_organization_relations", []),
            guard=self.guard,
        )
        self.saver = SqlAlchemyAnalysisSaver(factory, task_id, token)
        self.config = {"configurable": {"thread_id": task_id}, "recursion_limit": 100}

    def guard(self, kind, value=1):
        with self.factory() as session:
            row = session.get(AnalysisThread, self.task_id)
            if row.lease_token != self.token or row.lease_until <= time():
                raise AnalysisStopped("LEASE_LOST")
            if row.cancelled:
                raise AnalysisStopped("CANCELLED")
            usage = dict(row.usage or {})
            now = time()
            usage["seconds"] = usage.get("seconds", 0) + max(0, now - self.accounted_at)
            self.accounted_at = now
            row.usage = usage
            session.commit()
            if usage["seconds"] >= self.service.budget.seconds:
                raise AnalysisStopped("TIME_BUDGET")
            usage = dict(usage)
            if kind == "depth":
                if value > self.service.budget.depth:
                    raise AnalysisStopped("DEPTH_BUDGET")
                usage["depth"] = max(value, usage.get("depth", 0))
            if kind in {"model_calls", "queries"}:
                if usage.get(kind, 0) + value > getattr(self.service.budget, kind):
                    raise AnalysisStopped(kind.upper() + "_BUDGET")
                usage[kind] = usage.get(kind, 0) + value
            row.usage = usage
            session.commit()
            return usage

    def event(self, text):
        with self.factory() as session:
            row = session.get(AnalysisThread, self.task_id)
            row.progress = [
                *(row.progress or []),
                {
                    "sequence": len(row.progress or []) + 1,
                    "message": text,
                    "at": datetime.now(UTC).isoformat(),
                },
            ][-40:]
            session.commit()

    def model(self, prompt, context):
        self.guard("model_calls")
        value = self.service.model.analyze(prompt=prompt, context=context)
        self.guard("check")
        return value

    def history(self):
        with self.service.uow_factory() as uow:
            repo = ResultRepository(
                uow=uow,
                conversation_id=self.conversation_id,
                actor=self.actor,
                permission_service=self.service.execution.permission_service,
            )
            items = []
            for task in repo.tasks:
                raw = task.state_json or {}
                if (
                    task.id == self.task_id
                    or task.created_at > uow.tasks.get(self.task_id).created_at
                ):
                    continue
                if raw.get("actor_context", {}).get("tenant_id") != self.actor.tenant_id:
                    continue
                if raw.get("internal_analysis_id"):
                    continue
                if raw.get("analysis_target"):
                    target = AnalysisTarget.model_validate(raw["analysis_target"])
                    self.service.execution.permission_service.authorize_logical_dsl(
                        actor=self.actor, logical_dsl=target.dsl()
                    )
                    items.append({"analysis_id": task.id, "target": target.model_dump(mode="json")})
                elif artifact := raw.get("result_artifact"):
                    artifact = repo.get(artifact["result_id"])
                    items.append(
                        {
                            "task_id": task.id,
                            "question": task.original_question,
                            "result_id": artifact.result_id,
                            "dsl": artifact.logical_dsl,
                        }
                    )
            from datetime import date

            from ask_metric.application.conversation_context_service import (
                _explicit_catalog_matches,
            )

            matches = _explicit_catalog_matches(
                self.question,
                metrics=uow.metric_catalog.list_enabled(),
                organizations=uow.organization_catalog.list_enabled(),
                today=date.today(),
            )
            catalog = {"metrics": matches["metrics"][:30], "orgs": matches["orgs"][:20]}
            return items[-12:], catalog

    def resolve_target(self, state):
        self.event("正在确认分析对象与比较期间")
        history, catalog = self.history()
        shadow = self.raw.get("debug", {}).get("multiturn_shadow", {})
        hint = shadow.get("analysis_intent")
        feedback = "；".join(shadow.get("understanding", {}).get("ambiguities", []))
        if hint is None:
            hint = self.model(
                "analysis_target",
                {
                    "question": self.question,
                    "intent_json": "{}",
                    "history_json": _json(history),
                    "catalog_json": _json(catalog),
                    "feedback": "不得猜测缺失条件",
                },
            )
        if not hint.get("metric_code") and hint.get("metric_text"):
            from ask_metric.domain.semantic_engine import _lexical_metric_candidates

            with self.service.uow_factory() as uow:
                candidates = _lexical_metric_candidates(
                    hint["metric_text"], uow.metric_catalog.list_enabled(), limit=30
                )
            if candidates:
                catalog["metrics"] = [
                    {
                        "code": c.item.code,
                        "name": c.item.name,
                        "unit": c.item.unit,
                        "aliases": c.item.aliases[:5],
                        "score": c.score,
                    }
                    for c in candidates
                ]
                hint = self.model(
                    "analysis_target",
                    {
                        "question": self.question,
                        "intent_json": _json(hint),
                        "history_json": _json(history),
                        "catalog_json": _json(catalog),
                        "feedback": (
                            "根据已提取指标短语从候选确认基础指标，不选择预计算增量/增幅/排名口径。"
                            "用户没有限定监管、银保监或特殊统计范围时，不擅自添加这些口径，"
                            "优先匹配普通余额当日数。不能创造编号；真正同名歧义留空。"
                        ),
                    },
                )
        return {"intent": hint, "feedback": feedback}

    def prepare(self, state):
        from datetime import date

        from ask_metric.application.conversation_context_service import (
            _invalid_explicit_calendar_date,
        )

        history, catalog = self.history()
        hint, feedback = state["intent"], state.get("feedback", "")
        input_text = self.question
        while True:
            try:
                invalid_date = _invalid_explicit_calendar_date(
                    input_text, base=None, today=date.today()
                )
                if invalid_date:
                    raise ValueError(f"{invalid_date}不是有效日期，请明确日期")
                intent = AnalysisIntent.model_validate(hint)
                if intent.ambiguities:
                    raise ValueError("；".join(intent.ambiguities))
                if intent.source_analysis_id:
                    source = next(
                        (
                            h["target"]
                            for h in history
                            if h.get("analysis_id") == intent.source_analysis_id
                        ),
                        None,
                    )
                    if source is None:
                        raise ValueError("分析引用不存在或不在授权历史中")
                    hint = {**source, **intent.model_dump(mode="json", exclude_none=True)}
                target = AnalysisTarget.model_validate(hint)
                if feedback:
                    raise ValueError(feedback)
                known = {h["task_id"] for h in history if h.get("task_id")}
                if not set(target.source_task_ids) <= known:
                    raise ValueError("来源查询不在已确认历史中")
                self.tools.validate_target(target)
                return {"target": target.model_dump(mode="json"), "evidence": [], "stop_reason": ""}
            except (ValueError, ValidationError) as exc:
                if isinstance(exc, PermissionDeniedError):
                    raise
                choices = "\n".join(
                    f"{index}. {h.get('question') or _json(h.get('target'))}"
                    for index, h in enumerate(history, 1)
                )
                answer = interrupt(
                    {
                        "question": "请明确指标、机构、基期和报告期，"
                        "或按序号选择历史记录并补充比较基准。"
                        + ("\n可参考的历史记录：\n" + choices if choices else ""),
                        "detail": str(exc)[:500],
                    }
                )
                input_text = answer if isinstance(answer, str) else _json(answer)
                self.question += "\n用户补充：" + input_text
                history, catalog = self.history()
                hint = self.model(
                    "analysis_target",
                    {
                        "question": _json({"original": self.question, "answer": answer}),
                        "intent_json": _json(hint),
                        "history_json": _json(history),
                        "catalog_json": _json(catalog),
                        "feedback": str(exc)[:500],
                    },
                )
                feedback = ""

    def decide(self, state):
        self.guard("check")
        authorize_analysis(
            {**self.raw, "analysis_target": state["target"]},
            self.actor,
            self.service.execution.permission_service,
        )
        self.tools.validate_target(AnalysisTarget.model_validate(state["target"]))
        evidence = self.evidence(state)
        self.event("正在检查证据并选择下一步分析")
        feedback = ""
        attempts = 3 if self.raw["analysis_skill"]["version"] == "1.1.0" else 1
        for attempt in range(attempts):
            action = AnalysisAction.model_validate(
                self.model(
                    "analysis_action",
                    {
                        "skill_json": _json(self.raw["analysis_skill"]),
                        "target_json": _json(
                            {
                                **state["target"],
                                "user_clarification": state.get("question"),
                                "action_feedback": feedback,
                                "pending_governed_drills": self.pending_drills(state),
                            }
                        ),
                        "evidence_json": _json(evidence),
                        "usage_json": _json(
                            {
                                "used": self.guard("check"),
                                "limits": self.service.budget.model_dump(mode="json"),
                            }
                        ),
                    },
                )
            )
            if action.tool not in self.raw["analysis_skill"]["tools"]:
                raise InvalidModelResponse("Skill不允许该工具")
            if attempts > 1 and action.tool not in {"finish", "clarify"}:
                action = action.model_copy(
                    update={
                        "metric_code": action.metric_code or state["target"]["metric_code"],
                        "org_code": action.org_code or state["target"]["org_code"],
                        "question": None,
                        "target_unit": action.target_unit if action.tool == "calculate" else None,
                    }
                )
            key = hashlib.sha256(
                _json(
                    {"target": state["target"], "action": action.model_dump(mode="json")}
                ).encode()
            ).hexdigest()
            if key in state.get("evidence", []) and attempt < attempts - 1:
                feedback = (
                    "该目标与动作已有证据，省略机构与显式根机构是同一动作。请选择尚未完成的动作。"
                )
                continue
            if action.tool == "finish" and self.pending_drills(state) and attempt < attempts - 1:
                feedback = (
                    "仍有预算允许的已治理下级关系尚未取证，请检查目标要求并继续；"
                    "确需结束可再次finish，报告保留缺口。"
                )
                continue
            break
        return {"action": action.model_dump(mode="json")}

    def pending_drills(self, state):
        if self.raw["analysis_skill"]["version"] != "1.1.0":
            return []
        target = AnalysisTarget.model_validate(state["target"])
        entries, pending = self.evidence(state), {}
        metrics, orgs = self.tools.allowed(target), self.tools.allowed_orgs(target)
        used = self.guard("check")
        for item in entries:
            relations = [
                (r, item.get("dimension")) for r in item.get("available_child_relations", [])
            ]
            relations.extend(
                (item[k], dimension)
                for k, dimension in [
                    ("relation", "metric"),
                    ("organization_relation", "organization"),
                ]
                if item.get(k)
            )
            for relation, dimension in relations:
                metric = relation["parent"] if dimension == "metric" else item.get("metric_code")
                org = relation["parent"] if dimension == "organization" else item.get("org_code")
                tool = "decompose" if dimension == "metric" else "decompose_org"
                depth = metrics.get(metric, 999) + orgs.get(org, 999) + 1
                done = any(
                    e.get("tool") == tool
                    and e.get("metric_code") == metric
                    and e.get("org_code") == org
                    for e in entries
                )
                if (
                    not done
                    and depth <= self.service.budget.depth
                    and (
                        used.get("queries", 0) + len(relation["children"])
                        <= self.service.budget.queries
                    )
                ):
                    pending[(tool, metric, org)] = {
                        "tool": tool,
                        "metric_code": metric,
                        "org_code": org,
                    }
        return list(pending.values())

    def execute(self, state):
        self.guard("check")
        action = AnalysisAction.model_validate(state["action"])
        key = hashlib.sha256(
            _json({"target": state["target"], "action": state["action"]}).encode()
        ).hexdigest()
        if key in state["evidence"]:
            return {"stop_reason": "NO_PROGRESS"}
        cache = self.raw.get("analysis_tools", {})
        self.event(
            {
                "compare": "正在查询并核对两期数值",
                "capabilities": "正在检查可用分项与统计口径",
                "decompose": "正在计算分项贡献并核对总分差额",
                "decompose_org": "正在比较下级机构变化并核对汇总范围",
                "calculate": "正在按统一口径计算并换算单位",
            }[action.tool]
        )
        if key not in cache:
            try:
                observation = self.tools.execute(
                    AnalysisTarget.model_validate(state["target"]), action
                )
            except AnalysisToolError as exc:
                observation = {"status": exc.code, "gap": str(exc)}
            cache = {
                **cache,
                key: {
                    "tool": action.tool,
                    "metric_code": action.metric_code,
                    "org_code": action.org_code,
                    **observation,
                },
            }
            if len(_json(cache).encode()) > self.service.budget.evidence_bytes:
                return {"stop_reason": "EVIDENCE_BUDGET"}
            # Persist a tool outcome before graph checkpoint. Recovery reuses this exact outcome.
            with self.service.uow_factory() as uow:
                task = self.service._owned(uow, self.task_id, self.actor)
                raw = dict(task.state_json)
                raw["analysis_tools"] = cache
                task.state_json = raw
                uow.commit()
            self.raw["analysis_tools"] = cache
        return {"evidence": [*state["evidence"], key]}

    def clarify(self, state):
        action = AnalysisAction.model_validate(state["action"])
        answer = interrupt({"question": action.question or "请补充希望继续分析的方向"})
        # A semantic continuation within the fixed target; new targets use a new user task.
        self.question += "\n补充：" + _json(answer)
        return {"question": self.question}

    def evidence(self, state):
        return [
            {"evidence_id": key, **self.raw.get("analysis_tools", {}).get(key, {})}
            for key in state.get("evidence", [])
        ]

    def run(self, resume):
        graph = StateGraph(GraphState)
        graph.add_node("resolve_target", self.resolve_target)
        graph.add_node("prepare", self.prepare)
        graph.add_node("decide", self.decide)
        graph.add_node("execute", self.execute)
        graph.add_node("clarify", self.clarify)
        graph.add_edge(START, "resolve_target")
        graph.add_edge("resolve_target", "prepare")
        graph.add_edge("prepare", "decide")
        graph.add_conditional_edges(
            "decide",
            lambda s: (
                END
                if s["action"]["tool"] == "finish"
                else "clarify"
                if s["action"]["tool"] == "clarify"
                else "execute"
            ),
        )
        graph.add_conditional_edges("execute", lambda s: END if s.get("stop_reason") else "decide")
        graph.add_edge("clarify", "decide")
        compiled = graph.compile(checkpointer=self.saver)
        previous = compiled.get_state(self.config)
        value = Command(resume=resume) if resume is not None else (None if previous.values else {})
        reason = ""
        try:
            self.guard("check")
            state = compiled.invoke(value, self.config, durability="sync")
        except AnalysisStopped as exc:
            reason = str(exc)
            state = compiled.get_state(self.config).values
        except PermissionDeniedError:
            reason, state = "PERMISSION_DENIED", compiled.get_state(self.config).values
        except (ValidationError, InvalidModelResponse, ModelServiceUnavailable) as exc:
            reason = (
                "MODEL_INVALID"
                if isinstance(exc, (ValidationError, InvalidModelResponse))
                else "MODEL_UNAVAILABLE"
            )
            state = compiled.get_state(self.config).values
        snapshot = compiled.get_state(self.config)
        pending = [i for task in snapshot.tasks for i in task.interrupts]
        if pending and not reason:
            return self.project(state, "WAITING_USER", "CLARIFICATION", pending[0].value)
        reason = reason or state.get("stop_reason") or "EVIDENCE_COMPLETE"
        return self.project(state, "CANCELLED" if reason == "CANCELLED" else "SUCCEEDED", reason)

    def project(self, graph_state, status, reason, clarification=None):
        with self.factory() as session:
            row = session.get(AnalysisThread, self.task_id)
            if row.lease_token != self.token or row.lease_until <= time():
                raise ApplicationError("ANALYSIS_LEASE_LOST", "分析执行归属已变化", status_code=409)
            if row.cancelled:
                status, reason, clarification = "CANCELLED", "CANCELLED", None
        evidence = self.evidence(graph_state)
        if reason in {"PERMISSION_DENIED", "LEASE_LOST"}:
            evidence = []
        target = graph_state.get("target")
        if target and reason not in {"PERMISSION_DENIED", "LEASE_LOST"}:
            try:
                authorize_analysis(
                    {**self.raw, "analysis_target": target},
                    self.actor,
                    self.service.execution.permission_service,
                )
                self.tools.validate_target(AnalysisTarget.model_validate(target))
            except PermissionDeniedError:
                reason, evidence = "PERMISSION_DENIED", []
        display_target = dict(target) if target else None
        if target and reason != "PERMISSION_DENIED":
            with self.service.uow_factory() as uow:
                display_target["org_name"] = next(
                    (
                        o.name
                        for o in uow.organization_catalog.list_enabled()
                        if o.code == target["org_code"]
                    ),
                    target["org_code"],
                )
        if self.raw["analysis_skill"]["version"] == "1.1.0":
            from ask_metric.application.analysis_report import render_multidimensional

            message, rows, gaps = render_multidimensional(display_target, evidence, reason)
        else:
            message, rows, gaps = render_analysis(display_target, evidence, reason)
        if reason == "EVIDENCE_COMPLETE" and gaps:
            reason = "DATA_GAP"
        if reason in {"MODEL_INVALID", "MODEL_UNAVAILABLE", "PERMISSION_DENIED", "LEASE_LOST"}:
            status = "FAILED"
        with self.service.uow_factory() as uow:
            task = self.service._owned(uow, self.task_id, self.actor)
            state = QueryTaskState.model_validate(task.state_json)
            state.analysis_target = target
            state.analysis_stop_reason = reason
            state.analysis_resume = None
            state.logical_dsl = None
            state.debug["execution_route"] = {"selected_pipeline": "ANALYSIS_LANGGRAPH"}
            row = uow.session.get(AnalysisThread, self.task_id)
            usage = dict(row.usage or {})
            usage["seconds"] = usage.get("seconds", 0) + max(0, time() - self.accounted_at)
            row.usage = usage
            if clarification:
                state.clarification = {
                    "id": str(uuid4()),
                    "type": "analysis",
                    "question": clarification["question"],
                    "prompt": clarification["question"],
                    "missing": ["analysis"],
                    "options": [],
                    "missing_slots": ["analysis"],
                    "analysis_id": self.task_id,
                }
                if self.service.token_codec:
                    from ask_metric.application.continuation_tokens import ContinuationTarget

                    state.clarification["continuation_token"] = self.service.token_codec.encode(
                        ContinuationTarget(
                            task_id=task.id,
                            expected_version=task.version + 1,
                            clarification_id=state.clarification["id"],
                            channel=state.channel_context.get("channel", "web"),
                            channel_context=state.channel_context,
                        )
                    )
                state.missing_slots = ["analysis"]
                content = clarification["question"]
                payload = {"kind": "clarification", "clarification": state.clarification}
            else:
                state.clarification = None
                state.missing_slots = []
                result = {
                    "task_id": task.id,
                    "status": "failed" if status in {"FAILED", "CANCELLED"} else "succeeded",
                    "error_code": reason if status in {"FAILED", "CANCELLED"} else None,
                    "error_message": message if status in {"FAILED", "CANCELLED"} else None,
                    "query_shape": "attribution_analysis",
                    "columns": list(rows[0]) if rows else [],
                    "rows": rows,
                    "row_count": len(rows),
                    "comparisons": [],
                    "truncated": False,
                    "message": message,
                    "analysis": {
                        "analysis_id": task.id,
                        "target": target,
                        "skill_version": self.raw["analysis_skill"]["version"],
                        "evidence": evidence,
                        "gaps": gaps,
                        "stop_reason": reason,
                        "usage": usage,
                        "events": row.progress,
                    },
                    "task_status": status,
                    "task_version": task.version + 1,
                }
                state.execution = {"result": result, "status": result["status"]}
                content, payload = (
                    message,
                    {"kind": "query_result", "status": result["status"], "result": result},
                )
            uow.messages.add(
                ChatMessage(
                    id=str(uuid4()),
                    task_id=task.id,
                    conversation_id=task.conversation_id,
                    role="assistant",
                    content=content,
                    payload=payload,
                    created_at=datetime.now(UTC),
                )
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=task.version,
                status=status,
                current_stage="CLARIFICATION" if clarification else "RESULT_FORMATTING",
                state_json=state.model_dump(mode="json"),
                intent="attribution_analysis",
                query_shape="attribution_analysis",
                completed_at=None if clarification else datetime.now(UTC),
            )
            if updated is None:
                raise ApplicationError("TASK_VERSION_CONFLICT", "分析提交版本冲突", status_code=409)
            uow.commit()
            return _task_result(updated)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def render_analysis(target, evidence, reason):
    from decimal import Decimal

    def number(value):
        return format(Decimal(str(value)).normalize(), "f")

    lines, rows, gaps = [], [], []
    for item in evidence:
        fact = item.get("total") if item.get("tool") == "decompose" else item
        if (
            fact
            and fact.get("status") == "OK"
            and "difference" in fact
            and fact.get("metric_code") not in {r["metric_code"] for r in rows}
        ):
            saved_item = item
            item = fact
            rate = item.get("change_rate")
            lines.append(
                f"{item['metric_name']}：{item['base_date']}为{number(item['base_value'])}{item['unit']}，"
                f"{item['report_date']}为{number(item['current_value'])}{item['unit']}，"
                f"变化{number(item['difference'])}{item['unit']}，变化率"
                + (f"{Decimal(rate):.2f}%。" if rate is not None else "因基期为零未定义。")
            )
            rows.append(
                {
                    k: item[k]
                    for k in (
                        "metric_code",
                        "metric_name",
                        "unit",
                        "base_value",
                        "current_value",
                        "difference",
                        "change_rate",
                    )
                }
            )
            rows[-1]["change_rate"] = f"{Decimal(rate):.2f}%" if rate is not None else None
            item = saved_item
        if item.get("tool") == "decompose" and item.get("rows"):
            lines.append(
                "分项变化来源："
                + "；".join(
                    f"{r.get('metric_name', r['metric_code'])}变化{r['difference']}，贡献"
                    + (
                        f"{Decimal(r['contribution_pct']):.2f}%"
                        if r["contribution_pct"] is not None
                        else "率因总变化为零未定义"
                    )
                    for r in item["rows"]
                )
                + "。"
            )
            lines.append(
                f"基期未分解差额{item['base_residual']}，报告期未分解差额"
                f"{item['current_residual']}，未解释变化{item['unexplained_change']}。"
            )
            if not item.get("reconciled"):
                gaps.append("分项覆盖或总分核对未完整通过，保留差额")
        if item.get("gap"):
            gaps.append(item["gap"])
    if not rows:
        gaps.append("尚无完整的总量两期比较证据")
    if not any(e.get("tool") in {"capabilities", "decompose"} for e in evidence):
        gaps.append("尚未检查分项数据能力")
    lines.append("分项贡献说明数据变化来源。当前证据未包含业务事件或明细，不能证明具体业务动因。")
    labels = {
        "CANCELLED": "分析已取消，后续步骤已停止",
        "PERMISSION_DENIED": "分析权限已变化，停止展示证据",
        "NO_PROGRESS": "重复动作没有新证据，已停止",
        "MODEL_INVALID": "模型动作不符合契约，已停止",
        "MODEL_UNAVAILABLE": "分析模型暂不可用",
        "LEASE_LOST": "执行租约失效，已停止",
    }
    if reason not in {"EVIDENCE_COMPLETE", "CLARIFICATION"}:
        lines.append(labels.get(reason, "分析已达到运行限制，已停止后续取证") + "。")
    if target:
        lines.insert(
            0,
            f"{target.get('org_name', target['org_code'])}，"
            f"{target['base_date']}至{target['report_date']}的变化分析。",
        )
    lines.extend("证据缺口：" + gap + "。" for gap in dict.fromkeys(gaps))
    return "\n\n".join(lines), rows, list(dict.fromkeys(gaps))
