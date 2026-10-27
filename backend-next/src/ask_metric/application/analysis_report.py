"""通用报告交付：只读取已授权运行回执，事实数字与观察由服务端插入。"""

import re
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ask_metric.application.analysis_calculation import (
    CalculationReference,
    attach_calculation_sources,
)
from ask_metric.application.analysis_report_view import (
    fact_narrative,
    focused_sources,
    report_rows,
    shared_date_text,
    unconfirmed_ratio,
    validated_report_atoms,
)
from ask_metric.application.data_availability import AvailabilityRequest, execute_availability
from ask_metric.application.org_aliases import derive_org_aliases
from ask_metric.application.ports import PermissionDeniedError
from ask_metric.application.verified_findings import analysis_comparison
from ask_metric.core.errors import ApplicationError


class ReportSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=2500)
    evidence_refs: list[str] = Field(min_length=1, max_length=40)


class PresentationRequest(BaseModel):
    """模型可建议表达风格，服务端只接受有限风格并根据证据生成最终布局。"""

    model_config = ConfigDict(extra="forbid")
    profile: Literal["brief", "snapshot", "trend", "diagnostic", "multi_topic"] | None = None
    density: Literal["compact", "medium", "detailed"] | None = None


class AnalysisReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_refs: list[str] = Field(min_length=1, max_length=6)
    context_run_refs: list[str] = Field(default_factory=list, max_length=6)
    focus_refs: list[str] = Field(default_factory=list, max_length=80)
    calculation_refs: list[CalculationReference] = Field(default_factory=list, max_length=16)
    summary: str = Field(default="", max_length=6000)
    sections: list[ReportSection] = Field(default_factory=list, max_length=12)
    planning_gaps: list[str] = Field(default_factory=list, max_length=12)
    availability_requests: list[AvailabilityRequest] = Field(default_factory=list, max_length=3)
    presentation: PresentationRequest | None = None
    fallback: bool = False


def _presentation_plan(
    request: AnalysisReportRequest,
    first: dict,
    sources: list[dict],
    sections: list[dict],
    rows: list[dict],
) -> dict:
    """为报告选择可控的表达变化；事实、证据和安全边界不由风格决定。"""

    plan = first.get("plan") or {}
    objective = " ".join(
        str(plan.get(key) or "")
        for key in ("objective", "scope_notice", "questions")
    )
    methods = " ".join(
        str(step.get("method") or "")
        for source in sources
        for step in (source.get("plan") or {}).get("steps", [])
    )
    text = f"{objective} {methods}"
    if request.presentation and request.presentation.profile:
        profile = request.presentation.profile
    elif re.search(r"存贷款|存款和贷款|贷款和存款|利润.*贷款|贷款.*利润", text):
        profile = "multi_topic"
    elif re.search(r"为什么|原因|质量|风险|异常|诊断|解释", text):
        profile = "diagnostic"
    elif re.search(r"趋势|走势|连续|近几|变化", text) or "trend" in methods:
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
        "brief": {"summary": "核心判断", "data": "关键数据", "analysis": "分析重点", "gaps": "待跟进事项", "sources": "数据来源与口径"},
        "snapshot": {"summary": "结果摘要", "data": "数据结果", "analysis": "补充说明", "gaps": "需要留意", "sources": "口径与来源"},
        "trend": {"summary": "变化概览", "data": "对比数据", "analysis": "变化解读", "gaps": "待核查方向", "sources": "数据口径"},
        "diagnostic": {"summary": "问题判断", "data": "证据数据", "analysis": "重点分析", "gaps": "尚待验证", "sources": "证据与边界"},
        "multi_topic": {"summary": "总体观察", "data": "主题数据", "analysis": "分主题解读", "gaps": "综合关注点", "sources": "数据范围与口径"},
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
        if len(borders) >= 2 and not line[:borders[0]].strip() and not line[borders[-1] + 1:].strip():
            cells = [(line[left + 1:right].strip(), offset + left + 1, offset + right)
                     for left, right in zip(borders, borders[1:], strict=False)]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell[0]) for cell in cells):
            header = previous if previous and len(previous) == len(cells) else None
        elif header and cells and len(cells) == len(header):
            yield header, cells
        else:
            header = None
        previous = cells
        offset += len(line)


def _empty_inquiry_narrative(service, actor, sources, coverages):
    """只用已授权零行或日期覆盖快照说明缺数，不把未执行视为无记录。"""

    def reject():
        raise ApplicationError(
            "ANALYSIS_REPORT_EMPTY_UNCONFIRMED", "尚不能确认是无记录结果，不能按缺数交付。",
            status_code=422,
        )

    paragraphs, read_tasks = [], set()
    for source in sources:
        empty_coverages = source.get("empty_coverages", [])
        if (source.get("execution_mode") != "inquiry"
                or not source["tasks"] and not empty_coverages
                or any(atom.get("type") in {"fact", "calculation"}
                       for atom in source["evidence_items"])):
            reject()
        metrics = {item["code"]: item["name"] for item in source["metric_descriptors"]}
        organizations = dict(zip(source["org_codes"], source["org_names"], strict=True))
        for coverage in empty_coverages:
            try:
                spec = AvailabilityRequest.model_validate(coverage.get("request"))
            except ValueError:
                reject()
            if (coverage.get("date_count") != 0 or coverage.get("dates")
                    or coverage.get("latest") or coverage.get("earliest")
                    or coverage.get("has_more") or coverage.get("gaps")
                    or spec.dimension != "dates" or spec.match != "any" or not spec.end
                    or not spec.metric_codes or set(spec.metric_codes) - metrics.keys()
                    or set(spec.org_codes) != organizations.keys()):
                reject()
            names = "、".join(metrics[code] for code in spec.metric_codes)
            scope = ("、".join(organizations.values()) if len(organizations) <= 5
                     else f"所查{len(organizations)}家机构")
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
                    "ANALYSIS_FORBIDDEN", "无权读取查询结果。", status_code=403,
                ) from exc
            if (result.status != "succeeded" or result.truncated or result.row_count != 0
                    or result.rows or result.facts):
                reject()
            dsl = result.evidence.get("logical_dsl") or {}
            codes, orgs, period = dsl.get("metrics", []), dsl.get("orgs", []), dsl.get("time", {})
            if (not codes or not orgs or set(codes) - metrics.keys()
                    or set(orgs) - organizations.keys()):
                reject()
            days = (dsl.get("options") or {}).get("target_dates")
            start, end = period.get("start"), period.get("end")
            if not days and not (start and end):
                reject()
            dates = "、".join(days) if days else start if start == end else f"{start}至{end}"
            names = "、".join(metrics[code] for code in codes)
            scope = ("、".join(organizations[code] for code in orgs) if len(orgs) <= 5
                     else f"所查{len(orgs)}家机构")
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
    sources = [service.authorized_evidence(actor, reference) for reference in request.run_refs]
    # 跨轮追问只能显式带入已重新鉴权的同会话背景；计算仍受原scope约束。
    context_refs = set(request.context_run_refs)
    current = [source for source in sources if source["run_ref"] not in context_refs]
    reuse_view = bool(request.focus_refs) and not current
    if (not current and not reuse_view) or len(context_refs) != len(request.context_run_refs) or not context_refs.issubset(request.run_refs):
        raise ApplicationError("ANALYSIS_REPORT_SCOPE", "背景引用必须属于已选运行，且保留本轮分析运行。", status_code=422)
    if request.focus_refs and not reuse_view:
        raise ApplicationError("ANALYSIS_REPORT_SCOPE", "本轮新分析必须保留原始目标，不能用追问视图缩减覆盖。", status_code=422)
    first = (current or sources)[0]

    def compatible_source(source):
        is_current = source["run_ref"] not in context_refs
        if (source["conversation_id"] != first["conversation_id"]
                or is_current and source["scope_id"] != first["scope_id"]):
            return False
        # 问数可并列已授权的异期、异机构事实；可比性由计算与图表各自核验。
        if all(item.get("execution_mode") == "inquiry" for item in (first, source)):
            return True
        source_orgs, first_orgs = set(source["org_codes"]), set(first["org_codes"])
        return ((source_orgs <= first_orgs if is_current else source_orgs == first_orgs)
                and all(source[field] == first[field] for field in (
                    "date_selection", "requested_start", "requested_end")))

    if len(set(request.run_refs)) != len(request.run_refs) or not all(
        compatible_source(source) for source in sources
    ):
        raise ApplicationError(
            "ANALYSIS_REPORT_SCOPE",
            "报告来源的会话、回合或统计范围不匹配。",
            status_code=422,
        )
    semantics = service.semantics(actor)
    for source in sources:
        for metric in source["metric_descriptors"]:
            semantics.resolve(metric["binding_ref"])
    sources = attach_calculation_sources(service, actor, sources, request.calculation_refs)
    validated_report_atoms(sources)
    if reuse_view:
        sources = focused_sources(sources, request.focus_refs)
        first = sources[0]
    atoms = {item["ref"]: item for source in sources for item in source["evidence_items"]}
    metrics = {item["code"]: item for source in sources for item in source["metric_descriptors"]}
    unconfirmed_codes = {code for code, metric in metrics.items() if unconfirmed_ratio(metric)}

    def expanded_refs(references):
        """判断引用展开为原始依据；引用判断不能绕过用户子问题的覆盖校验。"""
        result, visiting = set(), set()

        def visit(ref):
            if ref not in atoms or ref in visiting:
                raise ApplicationError("ANALYSIS_REPORT_REFERENCE", "判断证据链不完整，请重新取数。", status_code=422)
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

    expanded_refs(atoms)
    unconfirmed_refs = {
        ref for ref in atoms if any(atoms[parent].get("metric_code") in unconfirmed_codes
                                    for parent in expanded_refs([ref]))
    } if unconfirmed_codes else set()
    fact_ids = {atom["fact_id"] for atom in atoms.values() if atom.get("fact_id")}
    if any(set(atom.get("input_fact_refs", [])) - fact_ids for atom in atoms.values()):
        raise ApplicationError("ANALYSIS_REPORT_REFERENCE", "计算依据不完整，请重新取数。", status_code=422)
    known_dates = (
        {source["checked_on"] for source in sources}
        | {day for source in sources for day in source["actual_dates"]}
        | {atom["date"] for atom in atoms.values() if atom.get("date")}
        | {
            day
            for source in sources
            for day in [source["requested_start"], source["requested_end"]]
            if day
        }
    )
    verified_coverages = []
    if request.availability_requests:
        with service.tasks.uow_factory() as uow:
            org_names = {item.code: item.name for item in uow.organization_catalog.list_enabled()}
        for spec in request.availability_requests:
            if (spec.dimension != "dates" or (spec.start is None) != (spec.end is None)
                    or not spec.metric_codes or not spec.org_codes
                    or set(spec.org_codes) - org_names.keys()
                    or not any(
                        set(spec.org_codes) <= set(source["org_codes"])
                        and set(spec.metric_codes) <= {
                            metric["code"] for metric in source["metric_descriptors"]}
                        for source in current
                    )):
                raise ApplicationError(
                    "ANALYSIS_REPORT_SCOPE", "日期覆盖须限定本轮指标与机构，日期边界须成对提供。",
                    status_code=422,
                )
            try:
                coverage = execute_availability(
                    spec, actor, service.execution, service.execution.planner.dialect,
                    {code: semantics.items[code].name for code in spec.metric_codes},
                    {code: org_names[code] for code in spec.org_codes},
                )
            except PermissionDeniedError as exc:
                raise ApplicationError(
                    "ANALYSIS_FORBIDDEN", "无权读取日期覆盖范围。", status_code=403,
                ) from exc
            if coverage["org_count"] != len(spec.org_codes):
                raise ApplicationError(
                    "ANALYSIS_FORBIDDEN", "日期覆盖范围的权限已变化。", status_code=403,
                )
            # 覆盖只证明有记录的日期，不改变查询目标，也不生成数值或排名依据。
            known_dates.update(
                day for group in coverage["groups"]
                for day in [*group["dates"], group["earliest"], group["latest"]]
                if day
            )
            verified_coverages.append(coverage)
    # 缺数日期也是执行器已经检查的范围；允许报告解释缺失基期与月份。
    for source in sources:
        for gap in source["gaps"]:
            known_dates.update(re.findall(r"\d{4}-\d{2}(?:-\d{2})?", gap))
    known_days = set()
    for day in known_dates:
        try:
            known_days.add(date.fromisoformat(day))
        except ValueError:
            continue  # 仅有月份的范围不构成已确认的具体日期。
    def prose_refs(text):
        return [ref.removesuffix("|cite") for ref in re.findall(r"\{\{([^{}]+)\}\}", text)]

    # 名次沿用执行器的排序结果，不按报告文字重新排序；历史回执缺字段时不猜名次。
    rankings_by_fact = {}
    for source in sources:
        source_atoms = {atom["ref"]: atom for atom in source["evidence_items"]}
        facts_by_id = {atom["fact_id"]: atom for atom in source_atoms.values()
                       if atom["type"] == "fact" and atom.get("fact_id")}
        steps = {step["id"]: step for step in source["plan"]["steps"]}
        for observation in source["observations"]:
            atom = source_atoms.get(observation.get("ref"), {})
            step = steps.get(observation.get("step_id"), {})
            rank = observation.get("rank")
            fact_refs = observation.get("fact_refs", [])
            fact = facts_by_id.get(fact_refs[0], {}) if len(fact_refs) == 1 else {}
            metric = metrics.get(fact.get("metric_code"), {})
            if (observation.get("type") != "ranking" or atom.get("judgment_kind") != "ranking"
                    or type(rank) is not int or not 1 <= rank <= step.get("top_n", 0)
                    or step.get("method") != "ranking" or not fact or fact.get("value") is None
                    or observation.get("position") != step.get("position")
                    or atom.get("rank") != rank or atom.get("position") != step.get("position")
                    or observation.get("metric") != fact.get("metric_code")
                    or metric.get("binding_ref") not in step.get("metric_refs", [])
                    or fact["ref"] not in atom.get("input_refs", [])
                    or fact["fact_id"] not in observation.get("comparison_fact_refs", [])
                    or any(observation.get(key) != fact.get(key) or atom.get(key) != fact.get(key)
                           for key in ("org_code", "date"))):
                continue
            rankings_by_fact.setdefault(fact["ref"], []).append(atom)

    institution_names = {atom["org_name"]: atom["org_code"] for atom in atoms.values()
                         if atom["type"] == "fact" and atom.get("org_name")}
    institution_codes = set(institution_names.values())
    catalog_names = None
    resolved_names = dict(institution_names)

    def institution_catalog():
        nonlocal catalog_names
        if catalog_names is None:
            with service.tasks.uow_factory() as uow:
                organizations = uow.organization_catalog.list_enabled()
            catalog_names = {}
            for organization in organizations:
                for name in [organization.name, *organization.aliases]:
                    if name.strip():
                        catalog_names.setdefault(name.strip(), set()).add(organization.code)
        return catalog_names

    def institution_code(name):
        if name not in resolved_names:
            catalog = institution_catalog()
            # 复用目录已有的银行名称变体，先在全目录消歧，再限制到已授权事实机构。
            # 不用子串或模糊匹配，避免把陌生机构名称中的地名当成已知银行。
            candidates = set().union(*(catalog.get(term, set())
                                       for term in [name, *derive_org_aliases(name)]))
            resolved_names[name] = (
                next(iter(candidates))
                if len(candidates) == 1 and candidates <= institution_codes else None
            )
        return resolved_names[name]

    def plain_cell(text):
        return text.replace("**", "").replace("__", "").strip()

    def table_owner(header, cells):
        for index, cell in enumerate(header):
            if plain_cell(cell[0]) in {"机构", "机构名称", "银行", "银行名称", "农商行"}:
                name = plain_cell(cells[index][0])
                return name, institution_code(name)
        named = {plain_cell(cell[0]) for cell in cells if institution_code(plain_cell(cell[0]))}
        name = next(iter(named)) if len(named) == 1 else None
        return name, institution_code(name) if name is not None else None

    def table_cell_matches(atom, header, cells, column_index):
        column = plain_cell(header[column_index][0])
        date_cells = [re.sub(r"[ \t]+", "", plain_cell(cells[index][0]))
                      for index, cell in enumerate(header)
                      if plain_cell(cell[0]) in {"日期", "统计日期", "数据日期"}]
        date_pattern = (r"(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|"
                        r"(?:\d{4}年)?\d{1,2}月\d{1,2}日)")
        # 正式日期字段须完整表达观测日；无法解析不能等同于没有指定日期。
        if any(not re.fullmatch(date_pattern, value) for value in date_cells):
            return False
        date_text = re.sub(r"[ \t]+", "", " ".join([*date_cells, column]))
        tokens = set(re.findall(
            rf"(?<![\d-]){date_pattern}(?!\d)", date_text,
        ))
        dates = set()
        for token in tokens:
            parts = re.fullmatch(r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日", token)
            if parts and parts[1]:
                try:
                    dates.add(date(*(int(part) for part in parts.groups())).isoformat())
                except ValueError:
                    return False
            elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", token):
                try:
                    dates.add(date.fromisoformat(token).isoformat())
                except ValueError:
                    return False
            else:
                month, day = (map(int, parts.groups()[1:]) if parts
                              else map(int, token.split("-")))
                candidates = {value.isoformat() for value in known_days
                              if value.month == month and value.day == day}
                if len(candidates) != 1:
                    return False
                dates.update(candidates)
        named_metrics = [metric for metric in metrics.values() if metric["name"] in column]
        metric = max(named_metrics, key=lambda item: len(item["name"])) if named_metrics else None
        return (not metric or atom.get("metric_code") == metric["code"]) \
            and (not tokens or dates == {atom.get("date")})

    def list_owner(prefix):
        # 单一机构开头的列表项明确归属该机构；多机构比较、普通段落不据词序猜归属。
        line = prefix.rsplit("\n", 1)[-1]
        marker = re.match(r"^[ \t]{0,3}(?:[1-9][0-9]?|100)[.)][ \t]+", line)
        if not marker:
            return None
        content = line[marker.end():].replace("**", "").replace("__", "")
        names = institution_names.keys() | (catalog_names or {}).keys()
        leading = [name for name in names if content.startswith(name)]
        if not leading:
            names |= institution_catalog().keys()
            leading = [name for name in names if content.startswith(name)]
        if not leading:
            return None
        name = max(leading, key=len)
        code = institution_code(name)
        if code is None:
            return ""
        other_codes = {institution_code(term) for term in names if term in content[len(name):]}
        return None if other_codes - {None, code} else code

    def validate_references(text, references=None):
        refs = prose_refs(text)
        if set(refs) - atoms.keys() or references is not None and set(references) - atoms.keys():
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE", "报告包含不存在的事实引用，请使用回执中的原子ref。", status_code=422
            )
        for match in re.finditer(r"\{\{([^{}]+?)(\|cite)?\}\}", text):
            if match[2]:
                continue
            atom = atoms[match[1]]
            owner = list_owner(text[: match.start()])
            if owner is not None and atom["type"] == "fact" and atom.get("org_code") != owner:
                raise ApplicationError(
                    "ANALYSIS_REPORT_REFERENCE",
                    f"报告将其他机构的事实引用用于当前机构：{atom.get('org_name', '')}，"
                    f"{atom['display']}。请按机构核对引用，不交换数值。",
                    status_code=422,
                )
        for header, cells in report_table_rows(text):
            name, owner = table_owner(header, cells)
            for index, cell in enumerate(cells):
                for ref in re.findall(r"\{\{([^{}|]+)\}\}", cell[0]):
                    atom = atoms[ref]
                    if name is not None and atom["type"] == "fact" and (not owner or atom.get("org_code") != owner):
                        raise ApplicationError(
                            "ANALYSIS_REPORT_REFERENCE", "表格机构与事实引用不对应，请按每行机构核对数值。",
                            status_code=422,
                        )
                    if atom["type"] == "fact" and not table_cell_matches(atom, header, cells, index):
                        raise ApplicationError(
                            "ANALYSIS_REPORT_REFERENCE", "表格指标或日期与事实引用不对应，请核对列标题和统计日。",
                            status_code=422,
                        )
        expanded_refs([*refs, *(references or [])])
        return refs

    def render(text, references=None, location="主要判断", used_refs=None):
        def reject_number(value):
            raise ApplicationError(
                "ANALYSIS_REPORT_NUMBER",
                f"{location}存在未获本段证据支持的数值：{value}。"
                "使用{{原子ref}}，或逐字引用证据显示值；"
                "同时修改summary和各段落，不保留错误数字。",
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
        literal_refs = set()
        checked_text = text
        original_table_rows = {text.count("\n", 0, cells[0][1]): (header, cells)
                               for header, cells in report_table_rows(text)}
        ordinal_spans = []
        for header, cells in report_table_rows(text):
            _, owner = table_owner(header, cells)
            row_refs = {ref for cell in cells for ref in prose_refs(cell[0])}
            for index, column in enumerate(header):
                label = re.fullmatch(r"(?:排名|名次|序号)(?:[（(](前序|后序)[）)])?", plain_cell(column[0]))
                # cite只关联依据，不为同一单元格中手写的裸数字授信。
                ordinal = plain_cell(re.sub(r"\{\{[^{}|]+\|cite\}\}", "", cells[index][0]))
                if plain_cell(column[0]) in {"日期", "统计日期", "数据日期"} and re.fullmatch(
                    r"(?:\d{4}-)?\d{2}-\d{2}", ordinal,
                ):
                    continue  # 日期单元格通过引用或量值的table_cell_matches与观测日绑定。
                if not re.fullmatch(r"[+-]?\d[\d.,eE+-]*", ordinal):
                    continue
                if not label or not re.fullmatch(r"[1-9]\d{0,2}", ordinal):
                    # 数据单元格没有单位时无法推断量纲；事实使用引用，排名使用已执行名次。
                    reject_number(ordinal)
                position = {"前序": "top", "后序": "bottom"}.get(label[1])
                candidates = [ranking for ref in row_refs for ranking in rankings_by_fact.get(ref, [])
                              if ranking["org_code"] == owner and ranking["rank"] == int(ordinal)
                              and (position is None or ranking["position"] == position)]
                identities = {(item["date"], item["position"], item["rank"],
                               tuple(item["input_refs"])) for item in candidates}
                if len(identities) == 1:
                    ordinal_spans.append(cells[index][1:])
                    literal_refs.update(item["ref"] for item in candidates)
                else:
                    reject_number(ordinal)
        for start, end in reversed(ordinal_spans):
            checked_text = checked_text[:start] + " " * (end - start) + checked_text[end:]
        remaining = re.sub(r"\{\{[^{}]+\}\}", "", checked_text)
        # 模型可引用原子，也可原样引用已显示值；数值必须逐字匹配本段证据。
        # 不接受仅因数字相同就通过的裸数字，也不让本段借用未引用的其他段落数值。
        selected_atoms = [atom for atom in ([atoms[ref] for ref in references]
                                           if references else atoms.values())
                          if atom["ref"] not in unconfirmed_refs]

        # 引用数值仍须符合量纲，金额不能当作增速。
        def check_quantity_kind(prefix, atom):
            clause = re.split(r"[，。；;!?\n]", prefix)[-1][-35:].replace("**", "").replace("__", "")
            # 金额可以说明增量，不能因数字引用合法就把亿元写成增幅/增速。
            if re.search(r"(?:增幅|增速)\s*[（(:：]?\s*(?:为|是|约)?\s*$", clause) and re.search(
                r"(?:亿元|万元|元)$", atom.get("display", "")
            ) and not re.search(r"不能|无法|不等于|不代表|是否", clause):
                raise ApplicationError(
                    "ANALYSIS_REPORT_NUMBER",
                    f"{location}把金额写成了增幅或增速：{atom['display']}。金额应称增量或差额；增幅必须引用正式比率或已核验计算。",
                    status_code=422,
                )

        for match in re.finditer(r"\{\{([^{}]+?)(\|cite)?\}\}", text):
            if not match[2]:
                atom = atoms[match[1]]
                check_quantity_kind(text[: match.start()], atom)
        exact_values = {
            value
            for atom in selected_atoms
            for value in re.findall(
                r"[+-]?\d+(?:\.\d+)?(?:亿元|万元|元|个百分点|%|名|户|笔|倍|家|位)",
                atom["display"],
            )
            if not (atom.get("judgment_kind") == "ranking" and value.endswith(("名", "位")))
        }
        checked = remaining
        for metric in (metric for source in sources for metric in source["metric_descriptors"]):
            checked = checked.replace(metric["name"], "")

        def ranking_ordinal(match):
            # “位列第1”与程序的“前序第1位”是同一名次，只接受本段已引用的排序判断。
            if re.match(
                r"[\d.]|次|期|年|月|日|亿元|万元|元|个百分点|%|户|笔|倍|家",
                checked[match.end():],
            ):
                return match[0]
            if not re.fullmatch(r"[1-9]\d{0,2}", match[1]):
                reject_number(match[0])
            rankings = [ranking for ref in expanded_refs([*refs, *(references or [])])
                        for ranking in rankings_by_fact.get(ref, [])]
            paragraph = checked[: match.start()].rsplit("\n\n", 1)[-1]
            owners = {
                atom["org_code"] for atom in selected_atoms
                if atom.get("org_code") and atom.get("org_name")
                and atom["org_name"] in paragraph
            }
            if len(owners) > 1 or not owners and len(rankings) != 1:
                reject_number(match[0])
            matched = [atom for atom in rankings
                if atom["rank"] == int(match[1])
                and (not owners or atom.get("org_code") in owners)
            ]
            if matched:
                literal_refs.update(atom["ref"] for atom in matched)
                return ""
            reject_number(match[0])

        checked = re.sub(
            r"(?:位列|位居|排名(?:为)?|排在|排)第([+-]?\d(?:[\d.,eE/+-]*\d)?)(?:名|位)?",
            ranking_ordinal,
            checked,
        )

        def literal_value(match):
            # “53 家”与“53家”只差排版空格，仍须逐字匹配规范后的完整数值和单位。
            value = re.sub(r"[ \t]+", "", match[0])
            in_table = any(cells[0][1] <= match.start() < cells[-1][2]
                           for _header, cells in report_table_rows(checked))
            if value.endswith(("名", "位")) and not in_table:
                # 散文中的名/位可能描述候选数量；实际名次由排名引用或上面的名次格式核对。
                return match[0]
            canonical_value = (
                value[1:] if value.startswith("+") and value[1:] in exact_values else value
            )
            # 仅在原有减量表达中绑定负值；不能把数值后缀相同当成同一事实。
            if value not in exact_values and not value.startswith(("-", "+")) \
                    and "-" + value in exact_values and any(
                        re.sub(r"[ \t]+", "", atom["display"]) == "-" + value
                        and analysis_comparison(
                            atom, metrics.get(atom.get("metric_code"), {})
                        ) for atom in selected_atoms
                    ):
                prefix = re.split(r"[，。；;!?\n]", checked[: match.start()])[-1][-20:]
                if re.search(r"(?:减少|下降|降低|回落|降|减)\s*(?:了|约|为)?\s*$", prefix):
                    canonical_value = "-" + value
            matches = [
                atom
                for atom in selected_atoms
                if atom["type"] in {"fact", "calculation"}
                and re.sub(r"[ \t]+", "", atom["display"]) == canonical_value
            ]
            owner = list_owner(checked[: match.start()])
            for header, cells in report_table_rows(checked):
                if cells[0][1] <= match.start() < cells[-1][2]:
                    name, table_org = table_owner(header, cells)
                    if name is not None:
                        owner = table_org or ""
                    original = original_table_rows.get(checked.count("\n", 0, cells[0][1]))
                    column = next(index for index, cell in enumerate(cells)
                                  if cell[1] <= match.start() < cell[2])
                    if original:
                        matches = [atom for atom in matches
                                   if table_cell_matches(atom, *original, column)]
                        if not matches:
                            reject_number(value)
                    break
            if owner is not None and matches and not any(
                atom.get("org_code") == owner or atom["type"] == "calculation"
                for atom in matches
            ):
                reject_number(value)
            if canonical_value in exact_values:
                if len(matches) == 1:
                    check_quantity_kind(checked[: match.start()], matches[0])
                    literal_refs.add(matches[0]["ref"])
                return ""
            # “减少0.20亿元”可表达已核验的-0.20亿元，不能无方向地丢弃负号。
            if canonical_value != value:
                if len(matches) == 1:
                    literal_refs.add(matches[0]["ref"])
                return ""
            reject_number(value)

        # 只核对有明确单位的量值；期限、编号和候选条数不由数字本身决定业务含义。
        # 连续的数字、符号按完整词元核对，防止只匹配错误量值的一段后缀。
        checked = re.sub(
            r"[+-]?\d(?:[\d.,eE/+-]*\d)?[ \t]*(?:亿元|万元|元|个百分点|%|名|户|笔|倍|家|位)",
            literal_value,
            checked,
        )
        raw_values = {
            Decimal(atom["value"])
            for atom in selected_atoms
            if atom["type"] == "fact" and atom.get("value") is not None
        }
        if any(
            "数值编码未审核" in item for source in sources for item in source["limitations"]
        ) and re.search(r"原始值\s*(?:为|是)?\s*[+-]?\d+(?:\.\d+)?\s*%", checked):
            raise ApplicationError(
                "ANALYSIS_REPORT_NUMBER",
                f"{location}为未审核的原始小数附加了百分号；请引用完整原子显示值，不自行换算。",
                status_code=422,
            )
        for match in re.finditer(r"原始值\s*(?:为|是)?\s*([+-]?\d+(?:\.\d+)?)", checked):
            if Decimal(match[1]) not in raw_values:
                reject_number(match[0])
        chinese_number = re.search(
            r"百分之[零一二三四五六七八九十百两]+|"
            r"[零一二三四五六七八九十百两]+分之[零一二三四五六七八九十百两]+|"
            r"[零一二三四五六七八九十百千万两]+(?:成|倍|个百分点|亿元|万元)",
            checked,
        )
        if chinese_number:
            reject_number(chinese_number[0])
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
            if display.startswith("-") and analysis_comparison(
                atom, metrics.get(atom.get("metric_code"), {})
            ) and re.search(
                r"(?:减少|下降|降低|回落|降|减)\s*(?:了|约为|约|为)?\s*(?:\*\*|__)?\s*$",
                text[:match.start()],
            ):
                return display[1:]
            return display

        rendered = re.sub(r"\{\{([^{}]+?)(\|cite)?\}\}", display_reference, text)
        # 显示值自带单位；处理模型在引用后再次添加单位的排版重复。
        rendered = re.sub(r"(亿元|万元|元|个百分点|%|名|户|笔|倍)(?:\1)+", r"\1", rendered)
        # 原样数值紧邻同值引用时仅清除括号内的重复展示，不改写业务文字或事实。
        rendered = re.sub(r"(?P<value>[+-]?\d+(?:\.\d+)?(?:亿元|万元|元|个百分点|%|名|户|笔|倍))[（(]\s*(?P=value)\s*[）)]", r"\g<value>", rendered)
        if used_refs is not None:
            used_refs.update(expanded_refs([*refs, *literal_refs, *(references or [])]))
        return rendered

    summary_refs = set()
    body_evidence = []
    # 引用与依据链是硬边界，正常、恢复和部分交付都不得跳过。
    validate_references(request.summary)
    for section in request.sections:
        validate_references(section.title)
        validate_references(section.text, section.evidence_refs)
    repaired = None
    empty_inquiry = request.fallback and any(
        source.get("execution_mode") == "inquiry" for source in sources
    ) and not any(
        atom.get("type") in {"fact", "calculation"} for atom in atoms.values()
    )
    if request.fallback:
        # 重写仍失败时只从已授权事实重建；不能拼接草稿残句改变原来的指代和因果。
        if empty_inquiry:
            summary = _empty_inquiry_narrative(service, actor, sources, verified_coverages)
            sections = []
            repaired = {"missing_count": 1, "replaced_gaps": [], "coverage": []}
        else:
            repaired = fact_narrative(sources)
            paragraphs = []
            for paragraph in repaired["paragraphs"]:
                refs = sorted(expanded_refs(paragraph["evidence_refs"]))
                paragraphs.append(render(paragraph["text"], refs or None))
                summary_refs.update(refs)
                body_evidence.append({"paragraph": len(paragraphs), "evidence_refs": refs})
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
            refs = set()
            paragraphs.append(validate_render(
                paragraph, location=f"正文第{len(paragraphs) + 1}段", used_refs=refs
            ))
            summary_refs.update(refs)
            body_evidence.append({"paragraph": len(paragraphs), "evidence_refs": sorted(refs)})
        summary = "\n\n".join(paragraphs)
        sections = []
        for section in request.sections:
            refs = set()
            sections.append({
                "title": validate_render(section.title, location="章节标题"),
                "text": validate_render(
                    section.text, section.evidence_refs, location=section.title, used_refs=refs
                ),
                "evidence_refs": sorted(refs),
            })
        if failures:
            # 一次指出各段问题，避免模型逐段试错耗尽有界纠错预算。
            raise ApplicationError(
                failures[0].code,
                "请同时修正以下文案问题：\n"
                + "\n".join(dict.fromkeys(error.message for error in failures)),
                status_code=422,
            )
    # 原始子问题不会因最后一次补查缩小而消失；报告必须实际引用各子问题的证据。
    for section in sections:
        section["evidence_refs"] = sorted(expanded_refs(section["evidence_refs"]))
    requirement_coverage = []
    for requirement in first["plan"]["requirements"]:
        # 各批次的q1可以指不同问题；只按完整问题关联后续取证，不凭编号并入。
        codes, related_atoms = set(), set()
        for source in current or sources:
            ids = {item["id"] for item in source["plan"]["requirements"]
                   if item["question"] == requirement["question"]}
            steps = [step for step in source["plan"]["steps"]
                     if ids.intersection(step["answers"])]
            step_ids = {step["id"] for step in steps}
            refs = {ref for step in steps for ref in step["metric_refs"]}
            source_codes = {metric["code"] for metric in source["metric_descriptors"]
                            if metric["binding_ref"] in refs}
            codes.update(source_codes)
            source_atoms = {atom["ref"]: atom for atom in source["evidence_items"]}
            fact_refs = {atom["fact_id"]: ref for ref, atom in source_atoms.items()
                         if atom.get("fact_id")}
            # 新回执按实际步骤归属；旧回执只在本批来源内按步骤绑定兼容。
            pending = [ref for ref, atom in source_atoms.items()
                       if (step_ids.intersection(atom["step_ids"]) if "step_ids" in atom
                           else atom.get("metric_code") in source_codes)]
            pending.extend(item["ref"] for item in source["observations"]
                           if item.get("step_id") in step_ids and item["ref"] in source_atoms)
            visited = set()
            while pending:
                ref = pending.pop()
                if ref in visited or ref not in source_atoms:
                    continue
                visited.add(ref)
                atom = source_atoms[ref]
                pending.extend(atom.get("input_refs", []))
                pending.extend(fact_refs[fact_id] for fact_id in atom.get("input_fact_refs", [])
                               if fact_id in fact_refs)
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
            len(first["plan"]["requirements"]) > 1
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
                "status": "covered" if titles else "pending" if requirement.get("deferred_reason")
                and not related_atoms else "gap" if not related_atoms else "facts_only",
                "sections": titles,
            }
        )
    rows = report_rows(sources)
    metric_names = {code: item.name for code, item in semantics.items.items()}
    gaps = list(
        dict.fromkeys(
            cleaned
            for item in [
                *(item for source in sources for item in source["gaps"]),
                *request.planning_gaps,
                *(f"尚未完成：{item['question']}。" for item in requirement_coverage
                  if item["status"] == "pending"),
                *(f"{metrics[code]['name']}的数值口径尚待确认，暂不用于分析。"
                  for code in sorted(unconfirmed_codes)),
            ]
            if (cleaned := public_analysis_gap(item, metric_names))
        )
    )
    limitations = list(dict.fromkeys(item for source in sources for item in source["limitations"]))
    defaults = list(
        dict.fromkeys(item for source in sources for item in source["defaults_applied"])
    )
    dates = sorted({day for source in sources for day in source["actual_dates"]})
    # 文案先通过原事实校验，再精简共同时点；不同截至日不能相互替代。
    summary = shared_date_text(summary, dates)
    sections = [{**section, "text": shared_date_text(section["text"], dates)} for section in sections]
    report_orgs = dict(zip(first["org_codes"], first["org_names"], strict=False))
    if all(source.get("execution_mode") == "inquiry" for source in sources):
        # 保留本轮原始目标；历史宽范围仅并入正文实际使用的机构。
        report_orgs = {
            code: name for source in current or sources
            for code, name in zip(source["org_codes"], source["org_names"], strict=False)
        }
        cited_refs = summary_refs | {
            ref for section in sections for ref in section["evidence_refs"]}
        for source in sources:
            if source["run_ref"] not in context_refs:
                continue
            cited_orgs = {atom.get("org_code") for atom in source["evidence_items"]
                          if atom["ref"] in cited_refs}
            report_orgs.update(
                (code, name)
                for code, name in zip(source["org_codes"], source["org_names"], strict=False)
                if code in cited_orgs
            )
    scope = f"{len(report_orgs)}家机构" if len(report_orgs) > 5 else "、".join(report_orgs.values())
    requested_start, requested_end = first["requested_start"], first["requested_end"]
    separate_snapshots = (len(dates) > 1 and all(
        source.get("execution_mode") == "inquiry" for source in sources))
    if (requested_start and not separate_snapshots
            and (dates != [requested_start] or requested_start != requested_end)):
        scope += f" · 查询期间：{requested_start}至{requested_end}"
        scope += f" · 实际数据日期：{'、'.join(dates) if dates else '暂无数据'}"
    else:
        date_label = "最新可用数据：" if first["date_selection"] == "latest_snapshot" else ""
        scope += f" · {date_label}{'、'.join(dates) if dates else '暂无数据'}"
    if len(dates) > 1:
        scope += "（各指标截至日不同）"
    plans = [
        {
            **source["plan"],
            "questions": [
                public_analysis_gap(item["question"], metric_names)
                for item in source["plan"]["requirements"]
            ],
        }
        for source in sources
    ]
    presentation = _presentation_plan(request, first, sources, sections, rows)
    # 缺口只补入正式可见正文一次，复制和历史展示复用同一正文。
    visible_body = "\n".join([summary, *(item["text"] for item in sections)])
    visible_gaps = gaps
    if repaired:
        replaced = set(repaired["replaced_gaps"])
        visible_gaps = [gap for gap in gaps if gap not in replaced] + repaired["coverage"]
    if empty_inquiry or all(
        source.get("execution_mode") == "inquiry"
        and not any(atom.get("type") in {"fact", "calculation"}
                    for atom in source["evidence_items"])
        for source in sources
    ):
        # 无数值的问数由已核验正文解释，覆盖计数留在回执中；部分有值的缺口仍照常披露。
        visible_gaps = []
    missing_gaps = [gap for gap in dict.fromkeys(visible_gaps) if gap not in visible_body]
    if missing_gaps:
        summary = "\n\n".join(filter(None, [
            summary, f"**{presentation['labels']['gaps']}**\n\n"
            + "\n".join(f"- {gap}" for gap in missing_gaps),
        ]))
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
        "partial_analysis": bool(request.planning_gaps) or bool(unconfirmed_codes)
        or bool(repaired and repaired["missing_count"])
        or any(not source["complete"] and (not source.get("requirement_dispositions")
               or any(item["status"] not in {"completed", "pending"}
                      for item in source["requirement_dispositions"])) for source in sources)
        or any(item["status"] != "covered" for item in requirement_coverage),
        "narrative_repaired": bool(repaired),
        "run_refs": request.run_refs,
        "evidence_view": {"kind": "focused_reuse", "focus_refs": request.focus_refs} if reuse_view else None,
        "org_codes": list(report_orgs),
        "tasks": list(
            {item["task_id"]: item for source in sources for item in source["tasks"]}.values()
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
            "evidence_refs": request.run_refs,
            "requirement_coverage": requirement_coverage,
        },
        "requirement_dispositions": [
            item for source in sources for item in source["requirement_dispositions"]
        ],
        "evidence_items": list(atoms.values()),
        "source_notice": first["source_notice"],
    }
