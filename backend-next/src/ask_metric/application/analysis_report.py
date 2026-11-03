"""通用报告交付：只读取已授权运行回执，事实数字与观察由服务端插入。"""

import re
from datetime import date
from typing import Literal, NoReturn, TypedDict

from pydantic import BaseModel, ConfigDict, Field

from ask_metric.application.analysis_calculation import (
    CalculationReference,
    attach_calculation_sources,
)
from ask_metric.application.analysis_report_view import (
    NarrativeCoverage,
    NarrativeParagraph,
    fact_narrative,
    focused_sources,
    report_rows,
    shared_date_text,
    unconfirmed_ratio,
    validated_report_atoms,
)
from ask_metric.application.data_availability import AvailabilityRequest, execute_availability
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.report_quantities import (
    QUANTITY_PATTERN,
    matches_quantity,
)
from ask_metric.application.verified_findings import analysis_comparison
from ask_metric.core.errors import ApplicationError

# 宿主每轮最多调查16次；每次最多100指标、按32项分批，最多产生4个运行。
# 此处容纳既有调查预算内的完整来源，不增加调查次数。
REPORT_SOURCE_LIMIT = 64


class ReportSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=2500)
    evidence_refs: list[str] = Field(min_length=1, max_length=40)


class RenderedReportSection(NarrativeParagraph):
    title: str


class BodyEvidence(TypedDict):
    paragraph: int
    evidence_refs: list[str]


class ReportFactBinding(BaseModel):
    """兼容已发出的坐标声明；事实身份以已授权运行的原子为准。"""

    model_config = ConfigDict(extra="forbid")
    ref: str = Field(min_length=1)
    org_code: str = Field(min_length=1)
    metric_code: str = Field(min_length=1)
    date: date


class PresentationRequest(BaseModel):
    """模型可建议表达风格，服务端只接受有限风格并根据证据生成最终布局。"""

    model_config = ConfigDict(extra="forbid")
    profile: Literal["brief", "snapshot", "trend", "diagnostic", "multi_topic"] | None = None
    density: Literal["compact", "medium", "detailed"] | None = None


class AnalysisReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_refs: list[str] = Field(min_length=1, max_length=REPORT_SOURCE_LIMIT)
    context_run_refs: list[str] = Field(default_factory=list, max_length=REPORT_SOURCE_LIMIT)
    focus_refs: list[str] = Field(default_factory=list, max_length=80)
    calculation_refs: list[CalculationReference] = Field(default_factory=list, max_length=16)
    summary: str = Field(default="", max_length=6000)
    fact_bindings: list[ReportFactBinding] = Field(default_factory=list, max_length=300)
    sections: list[ReportSection] = Field(default_factory=list, max_length=12)
    planning_gaps: list[str] = Field(default_factory=list, max_length=12)
    availability_requests: list[AvailabilityRequest] = Field(default_factory=list, max_length=3)
    presentation: PresentationRequest | None = None
    fallback: bool = False
    preview: bool = False


def _presentation_plan(
    request: AnalysisReportRequest,
    sources: list[dict],
    sections: list[RenderedReportSection],
    rows: list[dict],
) -> dict:
    """为报告选择可控的表达变化；事实、证据和安全边界不由风格决定。"""

    methods = {
        step.get("method")
        for source in sources
        for step in (source.get("plan") or {}).get("steps", [])
    }
    if request.presentation and request.presentation.profile:
        profile = request.presentation.profile
    elif "trend" in methods:
        profile = "trend"
    elif len(rows) <= 3 and len(sections) <= 1:
        profile = "snapshot"
    else:
        profile = "brief"

    if request.presentation and request.presentation.density:
        density = request.presentation.density
    elif len(rows) > 24 or len(sections) >= 4:
        density = "detailed"
    elif len(rows) <= 4 and len(sections) <= 1:
        density = "compact"
    else:
        density = "medium"

    labels: dict[str, dict[str, str]] = {
        "brief": {
            "summary": "核心判断",
            "data": "关键数据",
            "analysis": "分析重点",
            "gaps": "待跟进事项",
            "sources": "数据来源与口径",
        },
        "snapshot": {
            "summary": "结果摘要",
            "data": "数据结果",
            "analysis": "补充说明",
            "gaps": "需要留意",
            "sources": "口径与来源",
        },
        "trend": {
            "summary": "变化概览",
            "data": "对比数据",
            "analysis": "变化解读",
            "gaps": "待核查方向",
            "sources": "数据口径",
        },
        "diagnostic": {
            "summary": "问题判断",
            "data": "证据数据",
            "analysis": "重点分析",
            "gaps": "尚待验证",
            "sources": "证据与边界",
        },
        "multi_topic": {
            "summary": "总体观察",
            "data": "主题数据",
            "analysis": "分主题解读",
            "gaps": "综合关注点",
            "sources": "数据范围与口径",
        },
    }
    # 内容组织交给已核验正文，数据在正文之后按需展开；不靠散列轮换版式制造变化。
    layout = ["summary", "analysis", "data"]
    return {
        "profile": profile,
        "density": density,
        "body_mode": "narrative",
        "layout": layout,
        "labels": labels[profile],
    }


def public_analysis_gap(text: str, metric_names: dict[str, str]) -> str:
    """规划原文保留在回执中；缺口展示去除本轮临时引用，正式编码按目录显示名称。"""
    # 先保护正式名称，避免误删名称中恰好包含的k编号或编码片段。
    names = sorted(set(metric_names.values()), key=len, reverse=True)
    protected = {}
    for index, name in enumerate(names):
        if name and name in text:
            key = f"\x00metric-name-{index}\x00"
            text = text.replace(name, key)
            protected[key] = name

    def protect_metric_name(code):
        if code not in metric_names:
            return code
        key = f"\x00metric-name-{len(names) + len(protected)}\x00"
        protected[key] = metric_names[code]
        return key

    text = re.sub(
        r"(?<![A-Za-z0-9_])ORG_[A-Za-z0-9_]+(?![A-Za-z0-9_])",
        lambda match: protect_metric_name(match[0]),
        text,
    )
    text = re.sub(r"[（(]\s*k\d+(?:\s*[/、,，]\s*k\d+)*\s*[)）]", "", text)
    text = re.sub(r"(?<![A-Za-z0-9_])k\d+(?![A-Za-z0-9_])", "", text)
    for key, name in protected.items():
        text = text.replace(key, name)
    return text.strip()


def report_table_rows(text: str):
    """只识别带分隔行的管道表；保留单元格位置，不改写正文或引用。"""
    header, previous, offset = None, None, 0
    for line in text.splitlines(keepends=True):
        borders = [match.start() for match in re.finditer(r"(?<!\\)\|(?!cite\}\})", line)]
        cells = []
        if borders:
            # Markdown 表格的首尾管道可省略，单元格边界与完整写法一致。
            if line[: borders[0]].strip():
                borders.insert(0, -1)
            if line[borders[-1] + 1 :].strip():
                borders.append(len(line))
            cells = [
                (line[left + 1 : right].strip(), offset + left + 1, offset + right)
                for left, right in zip(borders, borders[1:], strict=False)
            ]
        if cells and all(re.fullmatch(r":?-+:?", cell[0]) for cell in cells):
            header = previous if previous and len(previous) == len(cells) else None
        elif header and cells:
            # 与前端 Markdown 表格一致：缺列补空格，多余列不进入可见单元格。
            empty_cell = ("", offset + len(line), offset + len(line))
            yield header, (cells + [empty_cell] * max(0, len(header) - len(cells)))[:len(header)]
        else:
            header = None
        previous = cells
        offset += len(line)


def _empty_inquiry_narrative(service, actor, sources, coverages):
    """只用已授权零行或日期覆盖快照说明缺数，不把未执行视为无记录。"""

    def reject():
        raise ApplicationError(
            "ANALYSIS_REPORT_EMPTY_UNCONFIRMED",
            "尚不能确认是无记录结果，不能按缺数交付。",
            status_code=422,
        )

    paragraphs, read_tasks = [], set()
    for source in sources:
        empty_coverages = source.get("empty_coverages", [])
        if (
            source.get("execution_mode") != "inquiry"
            or not source["tasks"]
            and not empty_coverages
            or any(atom.get("type") in {"fact", "calculation"} for atom in source["evidence_items"])
        ):
            reject()
        metrics = {item["code"]: item["name"] for item in source["metric_descriptors"]}
        organizations = dict(zip(source["org_codes"], source["org_names"], strict=True))
        for coverage in empty_coverages:
            try:
                spec = AvailabilityRequest.model_validate(coverage.get("request"))
            except ValueError:
                reject()
            if (
                coverage.get("date_count") != 0
                or coverage.get("dates")
                or coverage.get("latest")
                or coverage.get("earliest")
                or coverage.get("has_more")
                or coverage.get("gaps")
                or spec.dimension != "dates"
                or spec.match != "any"
                or not spec.end
                or not spec.metric_codes
                or set(spec.metric_codes) - metrics.keys()
                or set(spec.org_codes) != organizations.keys()
            ):
                reject()
            names = "、".join(metrics[code] for code in spec.metric_codes)
            scope = (
                "、".join(organizations.values())
                if len(organizations) <= 5
                else f"所查{len(organizations)}家机构"
            )
            period = f"在{spec.start}至{spec.end}" if spec.start else f"截至{spec.end}"
            paragraphs.append(f"{scope}的{names}{period}没有查到记录，暂时无法提供该期间的结果。")
        for task in source["tasks"]:
            if task["status"] != "succeeded":
                reject()
            if task["task_id"] in read_tasks:
                continue
            try:
                result = service.tasks.get_task_result(task["task_id"], actor, limit=1)
            except PermissionDeniedError as exc:
                raise ApplicationError(
                    "ANALYSIS_FORBIDDEN",
                    "无权读取查询结果。",
                    status_code=403,
                ) from exc
            if (
                result.status != "succeeded"
                or result.truncated
                or result.row_count != 0
                or result.rows
                or result.facts
            ):
                reject()
            dsl = result.evidence.get("logical_dsl") or {}
            codes, orgs, period = dsl.get("metrics", []), dsl.get("orgs", []), dsl.get("time", {})
            if (
                not codes
                or not orgs
                or set(codes) - metrics.keys()
                or set(orgs) - organizations.keys()
            ):
                reject()
            days = (dsl.get("options") or {}).get("target_dates")
            start, end = period.get("start"), period.get("end")
            if not days and not (start and end):
                reject()
            dates = "、".join(days) if days else start if start == end else f"{start}至{end}"
            names = "、".join(metrics[code] for code in codes)
            scope = (
                "、".join(organizations[code] for code in orgs)
                if len(orgs) <= 5
                else f"所查{len(orgs)}家机构"
            )
            paragraphs.append(f"{scope}的{names}在{dates}没有查到记录，暂时无法提供该期间的结果。")
            read_tasks.add(task["task_id"])
    for coverage in coverages:
        for group in coverage["groups"]:
            if group.get("latest"):
                names = "、".join(coverage["metric_names"])
                paragraphs.append(
                    f"在所查机构与日期范围内，{names}有记录的最新日期为{group['latest']}。"
                    "这仅表示该日有记录，不能代替原统计期的数据。"
                )
    return "\n\n".join(dict.fromkeys(paragraphs))


def compose_analysis_report(service, actor, request: AnalysisReportRequest):
    if request.preview and (request.fallback or request.sections):
        raise ApplicationError(
            "ANALYSIS_REPORT_FORMAT",
            "正文预览只接受原始正文，不执行报告恢复或章节交付。",
            status_code=422,
        )
    sources = [service.authorized_evidence(actor, reference) for reference in request.run_refs]
    # 跨轮追问只能显式带入已重新鉴权的同会话背景；计算仍受原scope约束。
    context_refs = set(request.context_run_refs)
    current = [source for source in sources if source["run_ref"] not in context_refs]
    current_queries = current
    coverage_sources = None
    reuse_view = bool(request.focus_refs) and not current
    if (
        (not current and not reuse_view)
        or len(context_refs) != len(request.context_run_refs)
        or not context_refs.issubset(request.run_refs)
    ):
        raise ApplicationError(
            "ANALYSIS_REPORT_SCOPE",
            "背景引用必须属于已选运行，且保留本轮分析运行。",
            status_code=422,
        )
    if request.focus_refs and not reuse_view and not request.fallback:
        raise ApplicationError(
            "ANALYSIS_REPORT_SCOPE",
            "本轮新分析必须保留原始目标，不能用追问视图缩减覆盖。",
            status_code=422,
        )
    first = (current or sources)[0]

    def compatible_source(source):
        is_current = source["run_ref"] not in context_refs
        if (
            source["conversation_id"] != first["conversation_id"]
            or is_current
            and source["scope_id"] != first["scope_id"]
        ):
            return False
        # 问数可并列已授权的异期、异机构事实；可比性由计算与图表各自核验。
        if all(item.get("execution_mode") == "inquiry" for item in (first, source)):
            return True
        source_orgs, first_orgs = set(source["org_codes"]), set(first["org_codes"])
        return (source_orgs <= first_orgs if is_current else source_orgs == first_orgs) and all(
            source[field] == first[field]
            for field in ("date_selection", "requested_start", "requested_end")
        )

    if len(set(request.run_refs)) != len(request.run_refs) or not all(
        compatible_source(source) for source in sources
    ):
        raise ApplicationError(
            "ANALYSIS_REPORT_SCOPE",
            "报告来源的会话、回合或统计范围不匹配。",
            status_code=422,
        )
    # 预览只复核本轮来源及必要映射依赖；最终交付保留完整目录，供未查询的
    # 规划缺口与正式指标名称转换使用，不把正文匹配规则带进目录取数。
    semantics = (
        service.semantics(actor, metric_codes={
            metric["code"] for source in sources for metric in source["metric_descriptors"]
        })
        if request.preview else service.semantics(actor)
    )
    for source in sources:
        for metric in source["metric_descriptors"]:
            semantics.resolve(metric["binding_ref"])
    original_refs = {atom["ref"] for source in sources for atom in source["evidence_items"]}
    sources = attach_calculation_sources(
        service,
        actor,
        sources,
        request.calculation_refs,
        semantics=semantics,
    )
    atoms = validated_report_atoms(sources)

    def expanded_refs(references):
        """判断引用展开为原始依据；引用判断不能绕过用户子问题的覆盖校验。"""
        result, visiting = set(), set()

        def visit(ref):
            if ref not in atoms or ref in visiting:
                raise ApplicationError(
                    "ANALYSIS_REPORT_REFERENCE", "判断证据链不完整，请重新取数。", status_code=422
                )
            if ref in result:
                return
            visiting.add(ref)
            for parent in atoms[ref].get("input_refs", []):
                visit(parent)
            visiting.remove(ref)
            result.add(ref)

        for ref in references:
            visit(ref)
        return result

    # 先核对全部来源和运算，再投影恢复范围；不能靠裁剪隐藏坏的依据链。
    if request.fallback or reuse_view:
        expanded_refs(atoms)
    if request.fallback:
        selected = expanded_refs(request.focus_refs)
        for source in sources:
            source["evidence_items"] = [
                atom for atom in source["evidence_items"]
                if atom["ref"] in original_refs or atom["ref"] in selected
            ]
        if current:
            current = [source for source in sources if source["run_ref"] not in context_refs]
            history_refs = {
                atom["ref"] for source in sources if source["run_ref"] in context_refs
                for atom in source["evidence_items"]
            }
            # 跨运行计算在完整来源中展开父链；本轮目标保持完整，历史只保留所选依据。
            history = []
            if selected & history_refs and any(
                atom["type"] == "fact" and atom.get("value") is not None
                for source in current for atom in source["evidence_items"]
            ):
                history = [
                    source for source in focused_sources(sources, request.focus_refs)
                    if source["run_ref"] in context_refs
                ]
            sources = [*current, *history]
            # 正文已选到本轮事实时，恢复只交付这些事实及其完整依赖。
            # 没有本轮事实的旧请求仍保留原目标，不能用历史数值替换目标期缺数。
            if any(
                atom["ref"] in selected and atom["type"] in {"fact", "calculation"}
                for source in current for atom in source["evidence_items"]
            ):
                # 展示选择不改变执行覆盖：缺数、未完成项和查询权限仍来自原始来源。
                coverage_sources = sources
                empty_current = [
                    source for source in current
                    if not any(atom["type"] == "fact" for atom in source["evidence_items"])
                ]
                sources = [
                    *empty_current,
                    *focused_sources(sources, request.focus_refs),
                ]
                current = [source for source in sources if source["run_ref"] not in context_refs]
                first = (current or sources)[0]
    if reuse_view:
        sources = focused_sources(sources, request.focus_refs)
        first = sources[0]
    if coverage_sources is None:
        coverage_sources = sources
    atoms = {item["ref"]: item for source in sources for item in source["evidence_items"]}
    metrics = {item["code"]: item for source in sources for item in source["metric_descriptors"]}
    unconfirmed_codes = {code for code, metric in metrics.items() if unconfirmed_ratio(metric)}
    expanded_refs(atoms)
    unconfirmed_refs = (
        {
            ref
            for ref in atoms
            if any(
                atoms[parent].get("metric_code") in unconfirmed_codes
                for parent in expanded_refs([ref])
            )
        }
        if unconfirmed_codes
        else set()
    )
    fact_ids = {atom["fact_id"] for atom in atoms.values() if atom.get("fact_id")}
    if any(set(atom.get("input_fact_refs", [])) - fact_ids for atom in atoms.values()):
        raise ApplicationError(
            "ANALYSIS_REPORT_REFERENCE", "计算依据不完整，请重新取数。", status_code=422
        )
    verified_coverages = []
    if request.availability_requests and not request.preview:
        with service.tasks.uow_factory() as uow:
            org_names = {item.code: item.name for item in uow.organization_catalog.list_enabled()}
        for spec in request.availability_requests:
            if (
                spec.dimension != "dates"
                or (spec.start is None) != (spec.end is None)
                or not spec.metric_codes
                or not spec.org_codes
                or set(spec.org_codes) - org_names.keys()
                or not any(
                    set(spec.org_codes) <= set(source["org_codes"])
                    and set(spec.metric_codes)
                    <= {metric["code"] for metric in source["metric_descriptors"]}
                    for source in current_queries
                )
            ):
                raise ApplicationError(
                    "ANALYSIS_REPORT_SCOPE",
                    "日期覆盖须限定本轮指标与机构，日期边界须成对提供。",
                    status_code=422,
                )
            try:
                coverage = execute_availability(
                    spec,
                    actor,
                    service.execution,
                    service.execution.planner.dialect,
                    {code: semantics.items[code].name for code in spec.metric_codes},
                    {code: org_names[code] for code in spec.org_codes},
                )
            except PermissionDeniedError as exc:
                raise ApplicationError(
                    "ANALYSIS_FORBIDDEN",
                    "无权读取日期覆盖范围。",
                    status_code=403,
                ) from exc
            if coverage["org_count"] != len(spec.org_codes):
                raise ApplicationError(
                    "ANALYSIS_FORBIDDEN",
                    "日期覆盖范围的权限已变化。",
                    status_code=403,
                )
            verified_coverages.append(coverage)

    def prose_refs(text):
        remaining = re.sub(r"\{\{([^{}]+)\}\}", "", text)
        if "{{" in remaining or "}}" in remaining:
            raise ApplicationError(
                "ANALYSIS_REPORT_FORMAT",
                "事实引用必须完整闭合且非空，请检查 {{...}} 格式。",
                status_code=422,
            )
        return [ref.removesuffix("|cite") for ref in re.findall(r"\{\{([^{}]+)\}\}", text)]

    # 名次沿用执行器的排序结果，不按报告文字重新排序；历史回执缺字段时不猜名次。
    rankings_by_fact: dict[str, list[dict]] = {}
    for source in sources:
        source_atoms = {atom["ref"]: atom for atom in source["evidence_items"]}
        facts_by_id = {
            atom["fact_id"]: atom
            for atom in source_atoms.values()
            if atom["type"] == "fact" and atom.get("fact_id")
        }
        ranking_steps = {step["id"]: step for step in source["plan"]["steps"]}
        for observation in source["observations"]:
            atom = source_atoms.get(observation.get("ref"), {})
            step = ranking_steps.get(observation.get("step_id"), {})
            rank = observation.get("rank")
            fact_refs = observation.get("fact_refs", [])
            fact = facts_by_id.get(fact_refs[0], {}) if len(fact_refs) == 1 else {}
            metric = metrics.get(fact.get("metric_code"), {})
            if (
                observation.get("type") != "ranking"
                or atom.get("judgment_kind") != "ranking"
                or type(rank) is not int
                or not 1 <= rank <= step.get("top_n", 0)
                or step.get("method") != "ranking"
                or not fact
                or fact.get("value") is None
                or observation.get("position") != step.get("position")
                or atom.get("rank") != rank
                or atom.get("position") != step.get("position")
                or observation.get("metric") != fact.get("metric_code")
                or metric.get("binding_ref") not in step.get("metric_refs", [])
                or fact["ref"] not in atom.get("input_refs", [])
                or fact["fact_id"] not in observation.get("comparison_fact_refs", [])
                or any(
                    observation.get(key) != fact.get(key) or atom.get(key) != fact.get(key)
                    for key in ("org_code", "date")
                )
            ):
                continue
            rankings_by_fact.setdefault(fact["ref"], []).append(atom)

    for binding in request.fact_bindings:
        atom = atoms.get(binding.ref)
        if (
            not atom
            or atom["type"] != "fact"
            or any(
                atom.get(key) != value
                for key, value in {
                    "org_code": binding.org_code,
                    "metric_code": binding.metric_code,
                    "date": binding.date.isoformat(),
                }.items()
            )
        ):
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE",
                "声明的机构、指标或统计日与事实引用不一致，请核对引用坐标。",
                status_code=422,
            )

    def plain_cell(text):
        return text.replace("**", "").replace("__", "").strip()

    def validate_references(text, references=None):
        refs = prose_refs(text)
        if set(refs) - atoms.keys() or references is not None and set(references) - atoms.keys():
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE",
                "报告包含不存在的事实引用，请使用回执中的原子ref。",
                status_code=422,
            )
        expanded_refs([*refs, *(references or [])])
        return refs

    def render(text, references=None, location="主要判断", used_refs=None):
        def reject_number(value: str) -> NoReturn:
            raise ApplicationError(
                "ANALYSIS_REPORT_NUMBER",
                f"{location}的结构化展示值与引用不一致：{value}。"
                "请核对引用的指标、机构、统计期、数值和单位；直接用{{ref}}展示已有结果。"
                "新增差额、增幅或倍数须先调用analysis_calculate取得计算结果；"
                "{{ref|cite}}仅关联依据，不能使不匹配或未经计算的数值通过核验。"
                "保留已正确的内容，只修正所指出的数值表达。",
                status_code=422,
            )

        refs = validate_references(text, references)
        displayed = [match[1] for match in re.finditer(r"\{\{([^{}|]+)\}\}", text)]
        if unconfirmed_refs.intersection(displayed):
            raise ApplicationError(
                "ANALYSIS_REPORT_NUMBER",
                f"{location}引用了数值口径尚未确认的比率，请说明暂不用于分析，原始记录保留在明细中。",
                status_code=422,
            )
        literal_refs: set[str] = set()
        for header, cells in report_table_rows(text):
            row_refs = {ref for cell in cells for ref in prose_refs(cell[0])}
            for index, column in enumerate(header):
                cell = cells[index][0]
                cell_refs = prose_refs(cell)
                # 表格的精确展示值有明确单元格边界，只核对本格显式关联的事实。
                literal = re.sub(r"\{\{[^{}]+\}\}", lambda match: " " * len(match[0]), cell)
                for quantity in re.finditer(QUANTITY_PATTERN, literal):
                    citation = re.match(
                        r"(?:\*\*|__|\*|_)?[ \t]*(?:[（(][ \t]*)?\{\{([^{}|]+)\|cite\}\}",
                        cell[quantity.end() :],
                    )
                    # 紧邻引用绑定本个值；无紧邻引用时仅接受本格唯一的明确来源。
                    bound = [citation[1]] if citation else cell_refs if len(cell_refs) == 1 else []
                    matching = [
                        atoms[ref] for ref in bound
                        if ref not in unconfirmed_refs
                        and atoms[ref]["type"] in {"fact", "calculation"}
                        and matches_quantity(quantity[0], atoms[ref]["display"])
                    ]
                    if not matching:
                        reject_number(quantity[0])
                label = re.fullmatch(
                    r"(?:排名|名次|序号)(?:[（(](前序|后序)[）)])?", plain_cell(column[0])
                )
                # cite只关联依据，不为同一单元格中手写的裸数字授信。
                ordinal = plain_cell(re.sub(r"\{\{[^{}|]+\|cite\}\}", "", cells[index][0]))
                if plain_cell(column[0]) in {"日期", "统计日期", "数据日期"} and re.fullmatch(
                    r"(?:\d{4}-)?\d{2}-\d{2}",
                    ordinal,
                ):
                    continue  # 统计日期属于来源身份，不按无单位金额处理。
                if not re.fullmatch(r"[+-]?\d[\d.,eE+-]*", ordinal):
                    continue
                if not label or not re.fullmatch(r"[1-9]\d{0,2}", ordinal):
                    # 数据单元格没有单位时无法推断量纲；事实使用引用，排名使用已执行名次。
                    reject_number(ordinal)
                position = {"前序": "top", "后序": "bottom"}.get(label[1])
                candidates = [
                    ranking
                    for ref in row_refs
                    for ranking in rankings_by_fact.get(ref, [])
                    if ranking["rank"] == int(ordinal)
                    and (position is None or ranking["position"] == position)
                ]
                identities = {
                    (item["date"], item["position"], item["rank"], tuple(item["input_refs"]))
                    for item in candidates
                }
                if len(identities) == 1:
                    literal_refs.update(item["ref"] for item in candidates)
                else:
                    reject_number(ordinal)
        # 自然正文由模型依据来源组织；不解析数词、比较词或指代来判定整段真伪。
        # 只记录显式引用，不因措辞或数字碰巧相同就给段落补上证据。
        if references is not None and not refs and not references:
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE", "分析段落必须关联真实证据。", status_code=422
            )

        def display_reference(match):
            if match[2]:
                return ""
            atom = atoms[match[1]]
            display = atom["display"]
            # 减量可用正幅度排版；余额等其他负值不能因此丢失自身符号。
            if (
                display.startswith("-")
                and analysis_comparison(atom, metrics.get(atom.get("metric_code"), {}))
                and re.search(
                    r"(?:减少|下降|降低|回落|降|减)\s*(?:了|约为|约|为)?\s*(?:\*\*|__)?\s*$",
                    value_text[: match.start()],
                )
            ):
                return display[1:]
            return display

        # 引用是一个值片段，括号内同值仅是它的重复展示；在展开前按真实原子核对。
        # 不按整段文字去重，不移除其他事实、解释或冲突数值。
        inline_value = (
            rf"(?:\*\*|__|\*|_)?(?:\{{\{{[^{{}}]+\}}\}}|{QUANTITY_PATTERN})"
            r"(?:\*\*|__|\*|_)?"
        )

        def single_value(match):
            first, second = match["first"], match["second"]
            left, right = (value.strip().strip("*_").strip() for value in (first, second))
            left_ref = re.fullmatch(r"\{\{([^{}|]+)\}\}", left)
            right_ref = re.fullmatch(r"\{\{([^{}|]+)\}\}", right)
            if left_ref is not None and right_ref is None:
                ref, value = left_ref[1], right
            elif right_ref is not None and left_ref is None:
                ref, value = right_ref[1], left
            else:
                return match[0]
            if not matches_quantity(value, atoms[ref]["display"]):
                reject_number(value)
            return first if left_ref else first + "{{" + ref + "|cite}}"

        value_text = re.sub(
            rf"(?P<first>{inline_value})[ \t]*[（(][ \t]*(?P<second>{inline_value})[ \t]*[）)]",
            single_value,
            text,
        )
        rendered = re.sub(r"\{\{([^{}]+?)(\|cite)?\}\}", display_reference, value_text)
        # 显示值自带单位；处理模型在引用后再次添加单位的排版重复。
        rendered = re.sub(r"(亿元|万元|元|个百分点|%|名|户|笔|倍)(?:\1)+", r"\1", rendered)
        if used_refs is not None:
            used_refs.update(expanded_refs([*refs, *literal_refs, *(references or [])]))
        return rendered

    summary_refs: set[str] = set()
    body_evidence: list[BodyEvidence] = []
    sections: list[RenderedReportSection]
    # 引用与依据链是硬边界，正常、恢复和部分交付都不得跳过。
    validate_references(request.summary)
    for section in request.sections:
        validate_references(section.title)
        validate_references(section.text, section.evidence_refs)
    repaired: NarrativeCoverage | None = None
    empty_inquiry = (
        request.fallback
        and any(source.get("execution_mode") == "inquiry" for source in sources)
        and not any(atom.get("type") in {"fact", "calculation"} for atom in atoms.values())
    )
    if request.fallback:
        # 重写仍失败时只从已授权事实重建；不能拼接草稿残句改变原来的指代和因果。
        if empty_inquiry:
            summary = _empty_inquiry_narrative(service, actor, sources, verified_coverages)
            sections = []
            repaired = {"missing_count": 1, "replaced_gaps": [], "coverage": []}
        else:
            repaired = fact_narrative(sources, exact_run_refs=context_refs)
            paragraphs = []
            for recovered_paragraph in repaired["paragraphs"]:
                recovered_refs = sorted(expanded_refs(recovered_paragraph["evidence_refs"]))
                paragraphs.append(render(recovered_paragraph["text"], recovered_refs or None))
                summary_refs.update(recovered_refs)
                body_evidence.append(
                    {"paragraph": len(paragraphs), "evidence_refs": recovered_refs}
                )
            summary, sections = "\n\n".join(paragraphs), []
    else:
        if not request.summary:
            raise ApplicationError(
                "ANALYSIS_REPORT_SUMMARY", "请根据目标与事实提交核心判断。", status_code=422
            )
        failures = []

        def validate_render(text, references=None, location="主要判断", used_refs=None):
            try:
                return render(text, references, location, used_refs)
            except ApplicationError as error:
                failures.append(error)
                return ""

        paragraphs = []
        for paragraph in re.split(r"\n\s*\n", request.summary):
            if not paragraph.strip():
                continue
            paragraph_refs: set[str] = set()
            paragraphs.append(
                validate_render(
                    paragraph, location=f"正文第{len(paragraphs) + 1}段", used_refs=paragraph_refs
                )
            )
            summary_refs.update(paragraph_refs)
            body_evidence.append(
                {"paragraph": len(paragraphs), "evidence_refs": sorted(paragraph_refs)}
            )
        summary = "\n\n".join(paragraphs)
        sections = []
        for section in request.sections:
            section_refs: set[str] = set()
            sections.append(
                {
                    "title": validate_render(section.title, location="章节标题"),
                    "text": validate_render(
                        section.text, section.evidence_refs,
                        location=section.title, used_refs=section_refs,
                    ),
                    "evidence_refs": sorted(section_refs),
                }
            )
        if failures:
            # 一次指出各段问题，避免模型逐段试错耗尽有界纠错预算。
            raise ApplicationError(
                failures[0].code,
                "请同时修正以下文案问题：\n"
                + "\n".join(dict.fromkeys(error.message for error in failures)),
                status_code=422,
            )
    if request.preview:
        # 流式前缀共用来源、引用和结构化展示校验；全题覆盖与正式展示等正文完成后再处理。
        return {
            "kind": "analysis_report_preview",
            "status": "succeeded",
            "preview_text": summary,
        }
    # 原始子问题不会因最后一次补查缩小而消失；报告必须实际引用各子问题的证据。
    for rendered_section in sections:
        rendered_section["evidence_refs"] = sorted(expanded_refs(rendered_section["evidence_refs"]))
    # 事实展示可聚焦，原计划和已执行范围仍从完整来源计算，避免把未展示当成未查询。
    coverage_current = [
        source for source in coverage_sources if source["run_ref"] not in context_refs
    ]
    coverage_first = (coverage_current or coverage_sources)[0]
    requirement_coverage = []
    for requirement in coverage_first["plan"]["requirements"]:
        # 各批次的q1可以指不同问题；只按完整问题关联后续取证，不凭编号并入。
        codes, related_atoms = set(), set()
        for source in coverage_current or coverage_sources:
            ids = {
                item["id"]
                for item in source["plan"]["requirements"]
                if item["question"] == requirement["question"]
            }
            requirement_steps = [
                step for step in source["plan"]["steps"] if ids.intersection(step["answers"])
            ]
            step_ids = {step["id"] for step in requirement_steps}
            binding_refs = {ref for step in requirement_steps for ref in step["metric_refs"]}
            source_codes = {
                metric["code"]
                for metric in source["metric_descriptors"]
                if metric["binding_ref"] in binding_refs
            }
            codes.update(source_codes)
            source_atoms = {atom["ref"]: atom for atom in source["evidence_items"]}
            fact_refs = {
                atom["fact_id"]: ref for ref, atom in source_atoms.items() if atom.get("fact_id")
            }
            # 新回执按实际步骤归属；旧回执只在本批来源内按步骤绑定兼容。
            pending = [
                ref
                for ref, atom in source_atoms.items()
                if (
                    step_ids.intersection(atom["step_ids"])
                    if "step_ids" in atom
                    else atom.get("metric_code") in source_codes
                )
            ]
            pending.extend(
                item["ref"]
                for item in source["observations"]
                if item.get("step_id") in step_ids and item["ref"] in source_atoms
            )
            visited = set()
            while pending:
                ref = pending.pop()
                if ref in visited or ref not in source_atoms:
                    continue
                visited.add(ref)
                atom = source_atoms[ref]
                pending.extend(atom.get("input_refs", []))
                pending.extend(
                    fact_refs[fact_id]
                    for fact_id in atom.get("input_fact_refs", [])
                    if fact_id in fact_refs
                )
            related_atoms.update(visited)
        if reuse_view and not codes:
            continue  # 历史追问只核对本次所选指标，不将旧主题冒充本轮任务。
        titles = [
            section["title"]
            for section in sections
            if related_atoms.intersection(section["evidence_refs"])
        ]
        # 一个自然回答可以同时回应多个目标，无须为通过覆盖校验拆成固定栏目。
        if related_atoms.intersection(summary_refs):
            titles.insert(0, "正文开篇")
        if (
            len(coverage_first["plan"]["requirements"]) > 1
            and related_atoms
            and not titles
            and not request.fallback
        ):
            raise ApplicationError(
                "ANALYSIS_REPORT_PROSE_COVERAGE",
                f"报告遗漏原始子问题：{requirement['question']}。请在正文开篇或展开段落中回应，并引用实际证据；不要求每个子问题单独成章。",
                status_code=422,
            )
        requirement_coverage.append(
            {
                "id": requirement["id"],
                "question": requirement["question"],
                "status": "covered"
                if titles
                else "pending"
                if requirement.get("deferred_reason") and not related_atoms
                else "gap"
                if not related_atoms
                else "facts_only",
                "sections": titles,
            }
        )
    rows = report_rows(sources)
    metric_names = {code: item.name for code, item in semantics.items.items()}
    gaps = list(
        dict.fromkeys(
            cleaned
            for item in [
                *(item for source in coverage_sources for item in source["gaps"]),
                *request.planning_gaps,
                *(
                    f"尚未完成：{item['question']}。"
                    for item in requirement_coverage
                    if item["status"] == "pending"
                ),
                *(
                    f"{metrics[code]['name']}的数值口径尚待确认，暂不用于分析。"
                    for code in sorted(unconfirmed_codes)
                ),
            ]
            if (cleaned := public_analysis_gap(item, metric_names))
        )
    )
    limitations = list(
        dict.fromkeys(item for source in coverage_sources for item in source["limitations"])
    )
    defaults = list(
        dict.fromkeys(item for source in sources for item in source["defaults_applied"])
    )
    dates = sorted({day for source in sources for day in source["actual_dates"]})
    # 文案先通过原事实校验，再精简共同时点；不同截至日不能相互替代。
    summary = shared_date_text(summary, dates)
    sections = [
        {**section, "text": shared_date_text(section["text"], dates)} for section in sections
    ]
    report_orgs = dict(zip(first["org_codes"], first["org_names"], strict=False))
    if all(source.get("execution_mode") == "inquiry" for source in sources):
        # 保留本轮原始目标；历史宽范围仅并入正文实际使用的机构。
        report_orgs = {
            code: name
            for source in current or sources
            for code, name in zip(source["org_codes"], source["org_names"], strict=False)
        }
        cited_refs = summary_refs | {
            ref for section in sections for ref in section["evidence_refs"]
        }
        for source in sources:
            if source["run_ref"] not in context_refs:
                continue
            cited_orgs = {
                atom.get("org_code")
                for atom in source["evidence_items"]
                if atom["ref"] in cited_refs
            }
            report_orgs.update(
                (code, name)
                for code, name in zip(source["org_codes"], source["org_names"], strict=False)
                if code in cited_orgs
            )
    scope = f"{len(report_orgs)}家机构" if len(report_orgs) > 5 else "、".join(report_orgs.values())
    requested_start, requested_end = first["requested_start"], first["requested_end"]
    separate_snapshots = len(dates) > 1 and all(
        source.get("execution_mode") == "inquiry" for source in sources
    )
    if (
        requested_start
        and not separate_snapshots
        and (dates != [requested_start] or requested_start != requested_end)
    ):
        scope += f" · 查询期间：{requested_start}至{requested_end}"
        scope += f" · 实际数据日期：{'、'.join(dates) if dates else '暂无数据'}"
    else:
        date_label = "最新可用数据：" if first["date_selection"] == "latest_snapshot" else ""
        scope += f" · {date_label}{'、'.join(dates) if dates else '暂无数据'}"
    if len(dates) > 1:
        scope += "（各指标截至日不同）"
    # 范围由服务端统一展示；只去除完全相同且不承载事实的重复首段。
    # 不推断自然语言中的机构或日期，更不能删去与实际范围冲突的表述。
    opening, separator, remainder = summary.partition("\n\n")
    if (
        separator
        and opening.strip() == scope
        and body_evidence
        and not body_evidence[0]["evidence_refs"]
    ):
        summary = remainder
        body_evidence = [{**item, "paragraph": item["paragraph"] - 1} for item in body_evidence[1:]]
    plans = [
        {
            **source["plan"],
            "questions": [
                public_analysis_gap(item["question"], metric_names)
                for item in source["plan"]["requirements"]
            ],
        }
        for source in coverage_sources
    ]
    presentation = _presentation_plan(request, sources, sections, rows)
    # 缺口只补入正式可见正文一次，复制和历史展示复用同一正文。
    visible_body = "\n".join([summary, *(item["text"] for item in sections)])
    visible_gaps = gaps
    if repaired:
        replaced = set(repaired["replaced_gaps"])
        visible_gaps = [gap for gap in gaps if gap not in replaced] + repaired["coverage"]
    if empty_inquiry or all(
        source.get("execution_mode") == "inquiry"
        and not any(
            atom.get("type") in {"fact", "calculation"} for atom in source["evidence_items"]
        )
        for source in sources
    ):
        # 无数值的问数由已核验正文解释，覆盖计数留在回执中；部分有值的缺口仍照常披露。
        visible_gaps = []
    missing_gaps = [gap for gap in dict.fromkeys(visible_gaps) if gap not in visible_body]
    if missing_gaps:
        summary = "\n\n".join(
            filter(
                None,
                [
                    summary,
                    f"**{presentation['labels']['gaps']}**\n\n"
                    + "\n".join(f"- {gap}" for gap in missing_gaps),
                ],
            )
        )
    answer = "\n\n".join(
        [
            scope,
            # 内部口径与来源保留在回执中，公共正文仅交付业务内容与实际范围。
            summary,
            *[f"**{item['title']}**\n\n{item['text']}" for item in sections],
        ]
    )
    return {
        "kind": "business_report",
        "status": "succeeded",
        "delivery": "business_evidence_v1",
        "answer_policy": "verified_report_v1",
        "analysis_protocol": "general-analysis-v1",
        "public_answer": answer,
        "partial_analysis": bool(request.fallback and current and context_refs)
        or bool(request.planning_gaps)
        or bool(unconfirmed_codes)
        or bool(repaired and repaired["missing_count"])
        or any(
            not source["complete"]
            and (
                not source.get("requirement_dispositions")
                or any(
                    item["status"] not in {"completed", "pending"}
                    for item in source["requirement_dispositions"]
                )
            )
            for source in coverage_sources
        )
        or any(item["status"] != "covered" for item in requirement_coverage),
        "narrative_repaired": bool(repaired),
        "run_refs": [source["run_ref"] for source in coverage_sources],
        "evidence_view": {"kind": "focused_reuse", "focus_refs": request.focus_refs}
        if reuse_view
        else None,
        "org_codes": list(report_orgs),
        "tasks": list(
            {
                item["task_id"]: item for source in coverage_sources for item in source["tasks"]
            }.values()
        ),
        "analysis_date": max(dates) if dates else None,
        "rows": rows,
        "row_count": len(rows),
        "columns": first["columns"],
        "gaps": gaps,
        "report": {
            "summary": summary,
            "body_evidence": body_evidence,
            "sections": sections,
            # 页面按结构展示，完整 public_answer 继续供旧客户端、复制和导出使用。
            "presentation": {
                "version": 1,
                "scope": scope,
                "source_notices": list(dict.fromkeys([*defaults, first["source_notice"]])),
                "limitations": limitations,
                **presentation,
            },
            "plans": plans,
            "evidence_refs": [source["run_ref"] for source in coverage_sources],
            "requirement_coverage": requirement_coverage,
        },
        "requirement_dispositions": [
            item for source in coverage_sources for item in source["requirement_dispositions"]
        ],
        "evidence_items": list(atoms.values()),
        "source_notice": first["source_notice"],
    }
