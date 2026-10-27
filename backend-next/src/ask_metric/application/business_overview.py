"""经营概览复用基础查询与事实计算；模型选择目标，不提交 SQL、指标编码或公式。"""

import calendar
import hashlib
import json
from datetime import date, datetime
from decimal import Decimal, localcontext
from pathlib import Path
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field

from ask_metric.application.business_knowledge import BusinessKnowledgeStore
from ask_metric.application.commands import ExecuteQueryCommand, SubmitQuestionCommand
from ask_metric.application.data_availability import AvailabilityRequest, execute_availability
from ask_metric.application.requests import ActorContext, IncomingRequest
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import AnalysisInquiry
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.calculation import CalculationRequest, CalculationScope

CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"
Section = Literal["scale", "growth", "structure", "quality"]


class OverviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: Literal["loan", "deposit"] = "loan"
    method: Literal["business-overview-v1"] = "business-overview-v1"
    topic_version: str = Field(min_length=1, max_length=80)
    goal: Literal["overview", "growth", "structure", "quality"] = "overview"
    sections: list[Section] = Field(
        default_factory=lambda: [
            "scale",
            "growth",
            "structure",
            "quality",
        ],
        min_length=1,
        max_length=4,
    )
    objective: str = Field(default="", max_length=300)
    questions: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=6
    )
    metric_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] | None = Field(
        default=None, min_length=1, max_length=16
    )
    comparisons: list[Literal["mom", "yoy", "ytd"]] = Field(
        default_factory=lambda: ["mom", "yoy", "ytd"], max_length=3
    )
    rationale: str = Field(default="", max_length=500)
    inquiry: AnalysisInquiry | None = None
    org_codes: list[str] = Field(default_factory=list, max_length=1)
    date_selection: Literal["exact", "latest_snapshot", "available_in_range"] = "exact"
    # 由会话执行器固定同轮补查的快照；模型计划不能直接设置此字段。
    anchor_date: date | None = None
    # 同轮期间补查沿用初查的覆盖指标，使逐月快照与报告范围保持一致。
    coverage_metric_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] | None = Field(
        default=None, min_length=1, max_length=16
    )
    start: date | None = None
    end: date | None = None
    # 只有隐式当前月或原文“本月”可附最近完整月份参考；明确历史日期不回退。
    allow_latest_reference: bool = False
    conversation_id: str = Field(min_length=1, max_length=128)
    calculation_context: CalculationScope


def load_topic(topic_id="loan") -> dict:
    data = json.loads((CONFIG_DIR / "business-topics.json").read_text(encoding="utf-8"))
    topic = data["topics"].get(topic_id)
    if topic is None:
        raise ApplicationError("TOPIC_NOT_FOUND", "业务主题尚未配置。", status_code=404)
    return topic


def read_knowledge(topic_id: str, path: Path | None = None) -> list[dict]:
    # 保留 topic_id 调用兼容；知识统一读取，适用范围由正文说明。
    return BusinessKnowledgeStore(path or CONFIG_DIR / "business-knowledge.json").read(
        enabled_only=True,
    )["items"]


def bind_metrics(topic: dict, catalog) -> tuple[dict, list[dict]]:
    """整名/别名唯一匹配，并约束单位和取值口径；复合增幅/排名指标不会当成余额。"""
    bound, gaps = {}, []
    for definition in topic["metrics"]:
        if definition.get("disabled_reason"):
            gaps.append(
                {
                    "metric": definition["id"],
                    "label": definition["label"],
                    "reason": definition["disabled_reason"],
                }
            )
            continue
        candidates = [
            item
            for item in catalog
            if (
                item.code == definition["code"]
                if definition.get("code")
                else bool(set(definition["names"]) & {item.name, *item.aliases})
            )
            and item.unit in definition["units"]
            and (not item.value_basis or item.value_basis == definition["value_basis"])
        ]
        if len(candidates) == 1:
            bound[definition["id"]] = candidates[0]
        else:
            gaps.append(
                {
                    "metric": definition["id"],
                    "label": definition["label"],
                    "reason": "指标绑定冲突" if candidates else "正式目录未绑定指标",
                }
            )
    return bound, gaps


def month_end(value: date, shift=0) -> date:
    index = value.year * 12 + value.month - 1 + shift
    year, zero_month = divmod(index, 12)
    month = zero_month + 1
    return date(year, month, calendar.monthrange(year, month)[1])


def coverage_selection(topic, payload, selected, bound):
    """覆盖围绕用户明确关注的指标；辅助总量和父级不遮挡较旧的目标数据。"""
    if payload.coverage_metric_ids is not None:
        return payload.coverage_metric_ids
    primary = list(selected)
    if payload.topic == "deposit" and payload.goal == "structure":
        for relation in topic["relationships"]:
            if relation["parent"] in primary and any(
                child in selected and child in bound for child in relation["children"]
            ):
                primary.remove(relation["parent"])
    if payload.topic == "deposit" and payload.date_selection == "latest_snapshot":
        question = "".join(payload.calculation_context.user_question.split())
        mentions = []
        for metric in topic["metrics"]:
            if metric["id"] not in primary or metric["id"] not in bound:
                continue
            for alias in [metric["label"], *metric.get("aliases", [])]:
                term = "".join(alias.split())
                if len(term) < 2:
                    continue
                start = question.find(term)
                if start >= 0:
                    mentions.append((start, start + len(term), metric["id"]))
        # 长别名优先；“存款”不能遮盖“存款市场份额”，分离提及的指标仍保留。
        kept = []
        for mention in sorted(mentions, key=lambda item: item[1] - item[0], reverse=True):
            if not any(mention[0] < other[1] and mention[1] > other[0] for other in kept):
                kept.append(mention)
        if kept:
            primary = list(dict.fromkeys(item[2] for item in kept))
    return primary


def _key(key: str, step: str) -> str:
    return hashlib.sha256(f"{key}:{step}".encode()).hexdigest()


class BusinessOverviewService:
    def __init__(self, tasks, execution, calculation, knowledge_path: Path | None = None):
        self.tasks, self.execution, self.calculation = tasks, execution, calculation
        self.knowledge_path = knowledge_path

    def describe(self, topic_id="loan") -> dict:
        topic = load_topic(topic_id)
        with self.tasks.uow_factory() as uow:
            catalog = uow.metric_catalog.list_enabled()
        bound, gaps = bind_metrics(topic, catalog)
        return {
            **topic,
            "topic": topic_id,
            "bindings": {key: item.model_dump() for key, item in bound.items()},
            "binding_gaps": gaps,
        }

    def execute(
        self, payload: OverviewRequest, actor: ActorContext, key: str, *, today: date | None = None
    ) -> dict:
        topic = load_topic(payload.topic)
        if payload.topic_version != topic["version"]:
            raise ApplicationError(
                "TOPIC_VERSION_CHANGED", "主题版本已更新，请重新读取。", status_code=409
            )
        required = topic["default_sections"] if payload.goal == "overview" else [payload.goal]
        if len(set(payload.sections)) != len(payload.sections) or not set(required) <= set(
            payload.sections
        ):
            raise ApplicationError(
                "ANALYSIS_PLAN_INCOMPLETE", "分析计划未覆盖所选目标。", status_code=422
            )
        today = today or datetime.now(ZoneInfo("Asia/Shanghai")).date()
        latest_snapshot = payload.date_selection == "latest_snapshot"
        period_selection = payload.date_selection == "available_in_range"
        if period_selection and (
            not payload.start or not payload.end or payload.allow_latest_reference
        ):
            raise ApplicationError(
                "ANALYSIS_DATE_INVALID",
                "期间分析需要明确起止日期，不能附加跨期间回退。",
                status_code=422,
            )
        if latest_snapshot and (payload.start or payload.end or payload.allow_latest_reference):
            raise ApplicationError(
                "ANALYSIS_DATE_INVALID",
                "最近截至日模式不能同时指定日期或月末回退。",
                status_code=422,
            )
        if payload.anchor_date and (not latest_snapshot or payload.anchor_date > today):
            raise ApplicationError("ANALYSIS_DATE_INVALID", "补查快照日期无效。", status_code=422)
        requested = today if latest_snapshot else payload.end or month_end(today)
        if payload.start and (payload.end is None or payload.start > payload.end):
            raise ApplicationError("ANALYSIS_DATE_INVALID", "分析日期范围无效。", status_code=422)
        if (
            not latest_snapshot
            and not period_selection
            and requested != month_end(requested)
            and payload.start != requested
        ):
            raise ApplicationError(
                "ANALYSIS_DATE_INVALID",
                "请指定单个日期或单个月份，不能把区间末日当作完整月份。",
                status_code=422,
            )
        if (
            not period_selection
            and payload.start
            and payload.start not in (requested, requested.replace(day=1))
        ):
            raise ApplicationError(
                "ANALYSIS_DATE_INVALID", "本方法仅支持单月概览。", status_code=422
            )
        # 最近月份参考限于当前月；模型参数不能将历史月份的缺数静默改成最新。
        if payload.allow_latest_reference and requested != month_end(today):
            raise ApplicationError(
                "ANALYSIS_FALLBACK_INVALID", "明确历史月份不能改用最新日期。", status_code=422
            )
        org_codes = payload.org_codes or ([actor.org_id] if actor.org_id else [])
        if not org_codes:
            raise ApplicationError("ANALYSIS_ORG_MISSING", "请明确要分析的机构。", status_code=422)
        with self.tasks.uow_factory() as uow:
            catalog = uow.metric_catalog.list_enabled()
            organizations = uow.organization_catalog.list_enabled()
        # 未知机构不能被权限裁剪成空结果或默认机构。
        orgs = {item.code: item.name for item in organizations}
        if set(org_codes) - orgs.keys():
            raise ApplicationError(
                "ANALYSIS_ORG_INVALID", "分析机构不在启用目录。", status_code=422
            )
        authorized = self.execution.permission_service.authorize_logical_dsl(
            actor=actor,
            logical_dsl={"orgs": org_codes},
        )
        if set(authorized.get("orgs", [])) != set(org_codes):
            raise ApplicationError("ANALYSIS_FORBIDDEN", "无权分析所选机构。", status_code=403)
        bound, binding_gaps = bind_metrics(topic, catalog)
        definitions = {item["id"]: item for item in topic["metrics"]}
        if payload.coverage_metric_ids and any(
            metric not in definitions for metric in payload.coverage_metric_ids
        ):
            raise ApplicationError(
                "ANALYSIS_METRIC_INVALID", "补查覆盖指标不属于当前主题。", status_code=422
            )
        selected = [item["id"] for item in topic["metrics"] if item["section"] in payload.sections]
        if payload.metric_ids is not None:
            if len(set(payload.metric_ids)) != len(payload.metric_ids) or any(
                metric not in definitions for metric in payload.metric_ids
            ):
                raise ApplicationError(
                    "ANALYSIS_METRIC_INVALID", "计划中的指标不属于当前主题。", status_code=422
                )
            selected = list(payload.metric_ids)
        # 聚焦分项按该分项覆盖选择日期，不能由不相关总量的较新记录挡住结果。
        if payload.topic == "loan" and "total" not in selected:
            selected.insert(0, "total")
        primary = coverage_selection(topic, payload, selected, bound)
        if period_selection:
            return self._execute_period(
                payload, actor, key, today, topic, bound, selected, org_codes
            )
        gaps = [gap for gap in binding_gaps if gap["metric"] in selected]
        result = {
            "status": "succeeded",
            "kind": "business_overview",
            "topic": payload.topic,
            "topic_version": topic["version"],
            "topic_name": topic["name"],
            "source_notice": topic.get(
                "data_source_notice", "数值来自项目当前配置的指标查询库，经现有基础查询接口读取。"
            ),
            "context_notice": "未指定机构，使用当前登录账户所属机构。"
            if not payload.org_codes
            else "",
            "metric_sources": {
                metric: definitions[metric].get("source", "正式指标目录") for metric in selected
            },
            "method": payload.method,
            "goal": payload.goal,
            "sections": payload.sections,
            "plan": {
                "objective": payload.objective,
                "questions": payload.questions,
                "metric_ids": selected,
                "comparisons": payload.comparisons,
                "rationale": payload.rationale,
                **({"inquiry": payload.inquiry.model_dump()} if payload.inquiry else {}),
            },
            "available_metric_ids": list(bound),
            "coverage_metric_ids": primary,
            "requested_date": str(requested),
            "date_selection": payload.date_selection,
            "analysis_date": None,
            "org_codes": org_codes,
            "org_name": orgs[org_codes[0]],
            "basis": topic["basis"],
            "facts": {},
            "calculations": [],
            "reported_comparisons": [],
            "reconciliations": [],
            "tasks": [],
            "gaps": gaps,
            "knowledge": [],
            "complete": False,
        }
        coverage_metrics = [bound[metric].code for metric in primary if metric in bound]
        if not coverage_metrics:
            return self._finish(result, "所选指标尚未完成正式绑定，无法形成数值概览。")
        coverage = execute_availability(
            AvailabilityRequest(
                metric_codes=coverage_metrics,
                org_codes=org_codes,
                end=min(requested, today),
                page_size=50,
            ),
            actor,
            self.execution,
            self.execution.planner.dialect,
            {item.code: item.name for item in catalog},
            orgs,
        )
        result["coverage"] = coverage
        latest = coverage["groups"][0]["latest"]
        if latest is None:
            return self._finish(result, "目标日期范围没有所选指标记录，无法形成数值概览。")
        effective = (
            (payload.anchor_date or date.fromisoformat(latest)) if latest_snapshot else requested
        )
        if not latest_snapshot and date.fromisoformat(latest) < requested:
            if not payload.allow_latest_reference:
                return self._finish(result, f"{requested}没有所选指标记录，不改用其他日期替代。")
            # 只在覆盖证据确认最新记录本身为完整月末时使用；不把月中记录当作月末。
            candidate = date.fromisoformat(latest)
            if candidate != month_end(candidate):
                return self._finish(result, "本月数据未齐，最新记录不是月末，无法作为完整月概览。")
            effective = candidate
            gaps.append({"reason": f"本月尚无完整月末数据，以下为{effective}参考分析"})
        result["analysis_date"] = str(effective)
        if latest_snapshot:
            lag_days = (today - effective).days
            focus_notice = (
                "本次用于确定日期的指标："
                + "、".join(definitions[metric]["label"] for metric in primary)
                + "；其他指标按同一截至日查询，缺数单独披露。"
                if primary != selected and payload.anchor_date is None
                else ""
            )
            notice = (
                f"未指定固定日期或使用最近日期，已按所选指标向前查询最近可用记录，数据截至{effective}；查询日期为{today}，相隔{lag_days}天。"
                + focus_notice
                + "以下是该截至日的余额及正式比较指标，不代表今天或完整月份的经营表现。"
            )
            result["data_freshness"] = {
                "checked_on": str(today),
                "as_of": str(effective),
                "lag_days": lag_days,
                "notice": notice,
            }
        prior_year = (
            month_end(effective, -12)
            if effective == month_end(effective)
            else date(
                effective.year - 1,
                effective.month,
                min(effective.day, calendar.monthrange(effective.year - 1, effective.month)[1]),
            )
        )
        dates = sorted(
            {
                effective,
                month_end(effective, -1),
                prior_year,
                date(effective.year - 1, 12, 31),
            }
        )
        for metric_id in selected:
            item = bound.get(metric_id)
            if not item:
                continue
            definition = definitions[metric_id]
            # 已发布复合比较指标按正式编码和口径绑定，不反推出缺失的历史余额。
            comparison_metrics = {}
            for comparison in payload.comparisons:
                for measure, suffix in (
                    topic.get("comparison_suffixes", {}).get(comparison, {}).items()
                ):
                    expected = (
                        definition.get("comparison_codes", {}).get(comparison, {}).get(measure)
                        or item.code + suffix["suffix"]
                    )
                    matches = [
                        entry
                        for entry in catalog
                        if entry.code == expected
                        and (
                            entry.value_basis == suffix["value_basis"]
                            or not entry.value_basis
                            and entry.name
                            == item.name.removesuffix(definition["value_basis"])
                            + suffix["value_basis"]
                        )
                        and entry.unit == ("%" if measure == "rate" else item.unit)
                    ]
                    if len(matches) == 1:
                        comparison_metrics[(comparison, measure)] = matches[0]
            if definition.get("frequency") == "quarterly" and effective.month % 3:
                gaps.append(
                    {
                        "metric": metric_id,
                        "label": definition["label"],
                        "reason": "季度指标，不能用上季度数据冒充本月",
                    }
                )
                continue
            # 每个指标独立查询：某项缺失不会令其他指标的完整事实失去计算资格。
            spec = BasicQuerySpec.model_validate(
                {
                    "metric_codes": [
                        item.code,
                        *[entry.code for entry in comparison_metrics.values()],
                    ],
                    "org_codes": org_codes,
                    "time": {
                        "start": str(dates[0]),
                        "end": str(dates[-1]),
                        "dates": [str(day) for day in dates],
                    },
                    "selection": "exact",
                }
            )
            step_key = _key(key, f"query:{metric_id}")
            if payload.metric_ids is not None:
                step_key = _key(
                    payload.calculation_context.scope_id,
                    json.dumps(
                        {
                            "metric": item.code,
                            "codes": spec.metric_codes,
                            "orgs": org_codes,
                            "dates": [str(day) for day in dates],
                        },
                        sort_keys=True,
                    ),
                )
            created = self.tasks.submit_question(
                SubmitQuestionCommand(
                    request=IncomingRequest(
                        request_id=step_key,
                        channel="basic_query",
                        conversation_id=payload.conversation_id,
                        text=f"{topic['name']}：{definition['label']}，{effective}",
                        channel_context={
                            "calculation_context": payload.calculation_context.model_dump(),
                            "analysis_method": payload.method,
                            "analysis_topic_version": topic["version"],
                        },
                    ),
                    actor=actor,
                    idempotency_key=step_key,
                    basic_query=spec,
                )
            )
            query = self.execution.execute(
                ExecuteQueryCommand(
                    task_id=created.task_id,
                    expected_version=created.version,
                    request_id=step_key,
                    actor=actor,
                )
            )
            result["tasks"].append(
                {"metric": metric_id, "task_id": query.task_id, "status": query.status}
            )
            if query.status != "succeeded" or query.truncated:
                gaps.append(
                    {
                        "metric": metric_id,
                        "label": definition["label"],
                        "reason": "取数失败或结果截断",
                        "error_code": query.error_code,
                    }
                )
                continue
            facts = {
                fact["date"]: fact
                for fact in query.facts
                if (
                    fact.get("metric_code") == item.code
                    and fact.get("org_code") == org_codes[0]
                    and fact.get("value") is not None
                )
            }
            result["facts"][metric_id] = facts
            current = facts.get(str(effective))
            if not current:
                gaps.append(
                    {
                        "metric": metric_id,
                        "label": definition["label"],
                        "reason": "目标日期无有效值",
                    }
                )
                continue
            comparisons = [
                ("mom", month_end(effective, -1)),
                ("yoy", prior_year),
                ("ytd", date(effective.year - 1, 12, 31)),
            ]
            if metric_id != "total" and payload.metric_ids is None:
                comparisons = comparisons[:1]
            comparisons = [pair for pair in comparisons if pair[0] in payload.comparisons]
            for comparison, baseline in comparisons:
                comparison_name = {"mom": "较上月", "yoy": "较同期", "ytd": "较年初"}[comparison]
                base = facts.get(str(baseline))
                if not base:
                    reported = {}
                    for measure in ("difference", "rate"):
                        official = comparison_metrics.get((comparison, measure))
                        receipt = next(
                            (
                                fact
                                for fact in query.facts
                                if official
                                and fact.get("metric_code") == official.code
                                and fact.get("date") == str(effective)
                                and fact.get("org_code") == org_codes[0]
                                and fact.get("value") is not None
                            ),
                            None,
                        )
                        if receipt:
                            reported[measure] = receipt
                    if reported:
                        if "difference" in reported and "rate" in reported:
                            # 只检查正式增量/增幅的数学一致性；不生成或持久化反推基期。
                            with localcontext() as decimal_context:
                                decimal_context.prec = 60
                                difference = Decimal(reported["difference"]["value"])
                                denominator = Decimal(current["value"]) - difference
                                rate = Decimal(reported["rate"]["value"])
                                tolerance = Decimal(
                                    topic["comparison_validation"]["rate_tolerance"]
                                )
                                inconsistent = (
                                    denominator == 0
                                    or abs(difference / denominator - rate) > tolerance
                                )
                            if inconsistent:
                                gaps.append(
                                    {
                                        "metric": metric_id,
                                        "label": definition["label"],
                                        "reason": (
                                            f"{comparison_name}正式比较指标的当前值、增量与增幅"
                                            "不一致或比较分母为零，暂停用于分析；"
                                            "原查询记录保留，需核验数据口径或质量"
                                        ),
                                    }
                                )
                                continue
                        result["reported_comparisons"].append(
                            {
                                "metric": metric_id,
                                "comparison": comparison,
                                "facts": reported,
                                "basis": (
                                    "正式复合指标；比较期间和统计口径沿用指标定义，不反推历史余额"
                                ),
                            }
                        )
                        continue
                    gaps.append(
                        {
                            "metric": metric_id,
                            "label": definition["label"],
                            "reason": f"缺少{baseline}基期，不能计算{comparison}",
                        }
                    )
                    continue
                expressions = [
                    {
                        "name": "difference",
                        "label": f"{definition['label']}变化额",
                        "expression": topic["formulas"]["difference"],
                        "display": "percent" if item.unit == "%" else "decimal",
                    }
                ]
                if item.unit != "%" and Decimal(base["value"]) > 0:
                    expressions.append(
                        {
                            "name": "growth_rate",
                            "label": f"{definition['label']}增长率",
                            "expression": topic["formulas"]["growth_rate"],
                            "display": "percent",
                        }
                    )
                elif item.unit != "%":
                    gaps.append(
                        {
                            "metric": metric_id,
                            "label": definition["label"],
                            "reason": f"{comparison}基期不为正，仅计算变化额，不推算增长率",
                        }
                    )
                calculation_payload = CalculationRequest.model_validate(
                    {
                        "conversation_id": payload.conversation_id,
                        "scope_id": payload.calculation_context.scope_id,
                        "scope_policy": "cross_date",
                        "expressions": expressions,
                        "bindings": {
                            "current": {"fact_id": current["fact_id"]},
                            "base": {"fact_id": base["fact_id"]},
                        },
                    }
                )
                try:
                    calculation = self.calculation.calculate(
                        calculation_payload, actor, _key(key, f"calculate:{metric_id}:{comparison}")
                    )
                except ApplicationError as exc:
                    if exc.status_code in {401, 403, 404}:
                        raise
                    gaps.append(
                        {
                            "metric": metric_id,
                            "label": definition["label"],
                            "reason": f"{comparison}计算未完成",
                            "error_code": exc.code,
                        }
                    )
                    continue
                result["calculations"].append(
                    {"metric": metric_id, "comparison": comparison, **calculation}
                )
        if "structure" in payload.sections:
            self._calculate_structure(result, payload, actor, key, topic)
        result["knowledge"] = read_knowledge(payload.topic, self.knowledge_path)
        result["complete"] = not gaps
        return self._finish(result)

    def _execute_period(self, payload, actor, key, today, topic, bound, selected, org_codes):
        """余额不可跨日期累加：每月取期间内最新实际记录，逐个快照复用现有查询。"""
        start, end = payload.start, payload.end
        primary = coverage_selection(topic, payload, selected, bound)
        month_count = (end.year - start.year) * 12 + end.month - start.month + 1
        if month_count > 24:
            raise ApplicationError(
                "ANALYSIS_PERIOD_LIMIT", "期间分析最多覆盖24个月，请分段查询。", status_code=422
            )
        coverage_metrics = [bound[metric].code for metric in primary if metric in bound]
        metrics = {item.code: item.name for item in bound.values()}
        orgs = {org_codes[0]: org_codes[0]}
        snapshots, months, tasks = [], [], []
        for offset in range(month_count):
            last = month_end(start, offset)
            first = max(start, last.replace(day=1))
            until = min(end, last, today)
            group = {"date_count": 0, "latest": None}
            if first <= until and coverage_metrics:
                coverage = execute_availability(
                    AvailabilityRequest(
                        metric_codes=coverage_metrics,
                        org_codes=org_codes,
                        start=first,
                        end=until,
                        page_size=1,
                    ),
                    actor,
                    self.execution,
                    self.execution.planner.dialect,
                    metrics,
                    orgs,
                )
                group = coverage["groups"][0]
            day = group["latest"]
            months.append({"month": str(last)[:7], "date_count": group["date_count"], "as_of": day})
            if day:
                exact = payload.model_copy(
                    update={
                        "date_selection": "exact",
                        "start": date.fromisoformat(day),
                        "end": date.fromisoformat(day),
                        "allow_latest_reference": False,
                    }
                )
                snapshot = self.execute(exact, actor, _key(key, f"snapshot:{day}"), today=today)
                snapshots.append(snapshot)
                tasks.extend(snapshot["tasks"])
        # 即使整个期间缺数，也保留授权机构、计划和明确期间，以便正常交付缺口。
        if snapshots:
            result = dict(snapshots[-1])
        else:
            exact = payload.model_copy(
                update={
                    "date_selection": "exact",
                    "start": start,
                    "end": start,
                    "allow_latest_reference": False,
                }
            )
            result = self.execute(exact, actor, _key(key, "empty-period"), today=today)
            result.update(analysis_date=None, facts={}, table_rows=[], tasks=[], evidence_items=[])
        period = {
            "start": str(start),
            "end": str(end),
            "checked_on": str(today),
            "sampling": "latest_record_per_month",
            "months": months,
            "snapshot_dates": [snapshot["analysis_date"] for snapshot in snapshots],
        }
        dates = period["snapshot_dates"]
        notice = (
            f"所问期间为{start}至{end}；按每个月在期间内的最新实际记录展示余额，"
            "月中记录不冒充月末，不累加各日或各月余额。"
            + (
                f"实际取得{len(dates)}个月的记录，最新截至{dates[-1]}。"
                if dates
                else "期间内未取得可用记录。"
            )
            + "缺数月份不填零；正式较上月、同比、较年初指标不等于所问整个期间的增量。"
        )
        result.update(
            date_selection="available_in_range",
            coverage_metric_ids=primary,
            requested_date=str(end),
            period=period,
            tasks=tasks,
            snapshots=snapshots,
            table_rows=[],
            evidence_items=[],
            gaps=[],
            data_freshness={
                "checked_on": str(today),
                "as_of": dates[-1] if dates else None,
                "lag_days": (today - date.fromisoformat(dates[-1])).days if dates else None,
                "notice": notice,
            },
        )
        for snapshot in snapshots:
            day = snapshot["analysis_date"]
            namespace = f"d{day.replace('-', '')}."
            result["table_rows"].extend({**row, "data_date": day} for row in snapshot["table_rows"])
            result["evidence_items"].extend(
                {**item, "ref": namespace + item["ref"],
                 **({"input_refs": [namespace + ref for ref in item["input_refs"]]}
                    if "input_refs" in item else {}),
                 **({"calculation": {**item["calculation"],
                                      "inputs": [namespace + ref for ref in item["calculation"]["inputs"]]}}
                    if "calculation" in item else {})}
                for item in snapshot["evidence_items"]
            )
            result["gaps"].extend(
                {**gap, "reason": f"{day}：{gap['reason']}"} for gap in snapshot["gaps"]
            )
        if snapshots:
            # 非限定前缀引用始终代表期间最新快照，便于模型按证据补查。
            result["evidence_items"].extend(snapshots[-1]["evidence_items"])
            # 快速判断只针对最新实际快照；完整期间的事实仍在命名空间原子中。
            result["verified_findings"] = snapshots[-1].get("verified_findings")
        missing = [month["month"] for month in months if not month["as_of"]]
        if missing:
            result["gaps"].append(
                {"reason": f"以下月份无可用记录：{'、'.join(missing)}，不能判断这些月份的变化"}
            )
        result["evidence_items"].append(
            {
                "ref": "scope.period",
                "label": "期间覆盖",
                "type": "observation",
                "display": notice,
            }
        )
        if len(snapshots) >= 2:
            self._calculate_period_change(result, snapshots, payload, actor, key, topic)
        result["complete"] = not result["gaps"]
        result["public_answer"] = notice
        return result

    def _calculate_period_change(self, result, snapshots, payload, actor, key, topic):
        from ask_metric.application.overview_evidence import display_value

        first, last = snapshots[0], snapshots[-1]
        definitions = {metric["id"]: metric for metric in topic["metrics"]}
        result["range_calculations"] = []
        for metric in result["plan"]["metric_ids"]:
            base = first["facts"].get(metric, {}).get(first["analysis_date"])
            current = last["facts"].get(metric, {}).get(last["analysis_date"])
            if not base or not current or base["unit"] != current["unit"]:
                continue
            expressions = [
                {
                    "name": "difference",
                    "label": "实际首末快照变化",
                    "expression": topic["formulas"]["difference"],
                    "display": "percent" if current["unit"] == "%" else "decimal",
                }
            ]
            if current["unit"] != "%" and Decimal(base["value"]) > 0:
                expressions.append(
                    {
                        "name": "rate",
                        "label": "实际首末快照增幅",
                        "expression": topic["formulas"]["growth_rate"],
                        "display": "percent",
                    }
                )
            request = CalculationRequest.model_validate(
                {
                    "conversation_id": payload.conversation_id,
                    "scope_id": payload.calculation_context.scope_id,
                    "scope_policy": "cross_date",
                    "expressions": expressions,
                    "bindings": {
                        "current": {"fact_id": current["fact_id"]},
                        "base": {"fact_id": base["fact_id"]},
                    },
                }
            )
            try:
                receipt = self.calculation.calculate(
                    request, actor, _key(key, f"period-change:{metric}")
                )
            except ApplicationError as exc:
                if exc.status_code in {401, 403, 404}:
                    raise
                result["gaps"].append(
                    {
                        "metric": metric,
                        "label": definitions[metric]["label"],
                        "reason": "期间首末快照比较计算未完成，已保留基础数据",
                        "error_code": exc.code,
                    }
                )
                continue
            result["range_calculations"].append({"metric": metric, **receipt})
            for output in receipt["results"]:
                points = current["unit"] == "%" and output["name"] == "difference"
                encoding = (
                    "calculated_ratio_difference"
                    if points and definitions[metric].get("value_encoding") == "ratio"
                    else None
                )
                result["evidence_items"].append(
                    {
                        "ref": f"period.{metric}.{output['name']}",
                        "label": f"{definitions[metric]['label']}实际首末快照变化",
                        "display": display_value(
                            output,
                            percentage_points=points,
                            encoding=encoding,
                            money_unit=topic.get("display_money_unit"),
                        ),
                        "value": output["value"],
                        "unit": output["unit"],
                        "start": first["analysis_date"],
                        "end": last["analysis_date"],
                    }
                )

    def _calculate_structure(self, result, payload, actor, key, topic):
        """分类占比与组成残差均由事实 ID 计算；不把交叉分类当成组成。"""
        effective = result["analysis_date"]
        for relation in topic["relationships"]:
            parent = result["facts"].get(relation["parent"], {}).get(effective)
            if not parent or Decimal(parent["value"]) <= 0:
                continue
            children = relation["children"]
            for child_id in children:
                child = result["facts"].get(child_id, {}).get(effective)
                if not child or child["unit"] != parent["unit"]:
                    continue
                calculated = self._structure_calculation(
                    payload,
                    actor,
                    _key(key, f"share:{child_id}"),
                    {"part": child, "total": parent},
                    {
                        "name": "share",
                        "label": "分类占比",
                        "expression": topic["formulas"]["share"],
                        "display": "percent",
                    },
                )
                result["calculations"].append(
                    {
                        "metric": child_id,
                        "comparison": "share",
                        "parent": relation["parent"],
                        **calculated,
                    }
                )
            if relation["type"] != "reconciliation":
                continue
            if not set(children) <= set(result["plan"]["metric_ids"]):
                # 局部补查不尝试全组成核对；未选择的指标不等于数据源缺数。
                continue
            for day in [effective, str(month_end(date.fromisoformat(effective), -1))]:
                facts = {
                    metric: result["facts"].get(metric, {}).get(day)
                    for metric in [relation["parent"], *children]
                }
                if (
                    any(not fact for fact in facts.values())
                    or len({fact["unit"] for fact in facts.values()}) != 1
                ):
                    result["gaps"].append(
                        {"reason": f"{day}组成数据不完整或单位不同，不能完整归因"}
                    )
                    continue
                calculated = self._structure_calculation(
                    payload,
                    actor,
                    _key(key, f"reconcile:{relation['id']}:{day}"),
                    facts,
                    {
                        "name": "residual",
                        "label": "贷款组成残差",
                        "expression": topic["formulas"]["loan_components_residual"],
                    },
                )
                receipt = calculated["results"][0]
                factors = {"元": Decimal("100000000"), "万元": Decimal("10000"), "亿元": Decimal(1)}
                tolerance = Decimal(relation["tolerance"]) * factors[receipt["unit"]]
                passed = abs(Decimal(receipt["value"])) <= tolerance
                result["reconciliations"].append({"date": day, "passed": passed, **calculated})
                if not passed:
                    value = receipt.get("reply_value", receipt["display_value"])
                    unit = receipt.get("reply_unit", receipt["unit"])
                    result["gaps"].append(
                        {
                            "reason": (
                                f"{day}总额与分项残差{value}{unit}，超过组成核对容差，不能完整归因"
                            )
                        }
                    )

    def _structure_calculation(self, payload, actor, key, facts, expression):
        request = CalculationRequest.model_validate(
            {
                "conversation_id": payload.conversation_id,
                "scope_id": payload.calculation_context.scope_id,
                "expressions": [expression],
                "bindings": {name: {"fact_id": fact["fact_id"]} for name, fact in facts.items()},
            }
        )
        return self.calculation.calculate(request, actor, key)

    def _finish(self, result: dict, notice="") -> dict:
        """文字仅引用不可变事实和计算回执；增长来源与因果解释明确区分。"""
        current = result["analysis_date"]
        lines = [
            f"{result['org_name']}{result['topic_name']}"
            f"（{current or result['requested_date']}）。",
            f"分析口径：{result['basis']}。",
        ]
        lines.extend(
            text for text in [result.get("context_notice"), result.get("source_notice")] if text
        )
        if notice:
            lines.append(notice)
            result["gaps"].append({"reason": notice})
        if result.get("data_freshness"):
            lines.append(result["data_freshness"]["notice"])
        elif current and current != result["requested_date"]:
            lines.append(
                f"用户询问月份为{result['requested_date']}所在月份，尚无完整月末数据；"
                f"以下使用{current}作为参考，不代表所问月份的实际表现。"
            )
        comparisons = {"mom": "较上月", "yoy": "同比", "ytd": "较年初"}
        for metric_id, facts in result["facts"].items():
            fact = facts.get(current)
            if not fact:
                continue
            label = next(
                item["label"]
                for item in load_topic(result["topic"])["metrics"]
                if item["id"] == metric_id
            )
            amount = fact.get("reply_value", fact["value"])
            unit = fact.get("reply_unit", fact["unit"])
            sentence = f"{label}为{amount}{unit}"
            for calculation in result["calculations"]:
                if calculation["metric"] != metric_id:
                    continue
                if calculation["comparison"] == "share":
                    share = calculation["results"][0]
                    parent_label = next(
                        item["label"]
                        for item in load_topic(result["topic"])["metrics"]
                        if item["id"] == calculation["parent"]
                    )
                    sentence += (
                        f"，占{parent_label}{share['display_value']}{share['unit']}（据余额计算）"
                    )
                    continue
                difference = calculation["results"][0]
                value = Decimal(difference["value"])
                displayed = difference.get("reply_value", difference["display_value"])
                displayed_unit = difference.get("reply_unit", difference["unit"])
                if fact["unit"] == "%":
                    # Decimal 百分比事实以比例存储；回执 display_value 的单位为%，差值解释为百分点。
                    sentence += f"，{comparisons[calculation['comparison']]}变化{displayed}个百分点"
                else:
                    direction = "增加" if value >= 0 else "减少"
                    sentence += (
                        f"，{comparisons[calculation['comparison']]}{direction}"
                        f"{str(displayed).lstrip('-')}{displayed_unit}"
                    )
                    if len(calculation["results"]) > 1:
                        rate = calculation["results"][1]
                        sentence += f"，增幅{rate['display_value']}{rate['unit']}"
            lines.append(sentence + "。")
        # 方向性结论由已有分项变化回执支持，避免模型凭内部知识编造业务原因。
        changes = {}
        for item in result["calculations"]:
            if item["comparison"] == "mom" and item["metric"] in {
                "personal",
                "company",
                "discount",
            }:
                changes[item["metric"]] = Decimal(item["results"][0]["value"])
        if (
            result["topic"] == "loan"
            and changes
            and "structure" in result["sections"]
            and len(result["reconciliations"]) == 2
            and all(item["passed"] for item in result["reconciliations"])
        ):
            labels = {
                "personal": "个人贷款",
                "company": "对公贷款（剔除贴现）",
                "discount": "贴现及买断式转贴现",
            }
            positive = [key for key, value in changes.items() if value > 0]
            negative = [key for key, value in changes.items() if value < 0]
            total_change = next(
                (
                    Decimal(item["results"][0]["value"])
                    for item in result["calculations"]
                    if item["metric"] == "total" and item["comparison"] == "mom"
                ),
                None,
            )
            if positive:
                leader = labels[max(positive, key=changes.get)]
                lines.append(
                    f"已取得的分项中，本月增长主要由{leader}推动。"
                    if total_change is not None and total_change > 0
                    else f"已取得的分项中，{leader}增加，对总量变化形成正向贡献。"
                )
            if negative:
                effect = (
                    "对总贷款增长形成拖累"
                    if total_change is not None and total_change > 0
                    else "对总量变化形成负向贡献"
                )
                lines.append(f"{'、'.join(labels[key] for key in negative)}下降，{effect}。")
        if result["gaps"]:
            lines.append(
                "数据与分析缺口："
                + "；".join(f"{gap.get('label', '')}{gap['reason']}" for gap in result["gaps"])
                + "。"
            )
        lines.append(
            "余额变化可说明分项变化；客户流失、付息成本等原因需更多业务证据验证。"
            if result["topic"] == "deposit"
            else "余额变化可说明分项增长来源；投放、还款、核销及客户原因需更多业务证据验证。"
        )
        result["public_answer"] = "\n\n".join(lines)
        from ask_metric.application.overview_evidence import overview_evidence

        result.update(overview_evidence(result, load_topic(result["topic"])))
        return result
