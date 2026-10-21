"""通用报告交付：只读取已授权运行回执，事实数字与观察由服务端插入。"""

import calendar
import re
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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
    context_run_refs: list[str] = Field(default_factory=list, max_length=5)
    summary: str = Field(default="", max_length=6000)
    sections: list[ReportSection] = Field(default_factory=list, max_length=12)
    planning_gaps: list[str] = Field(default_factory=list, max_length=12)
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


def compose_analysis_report(service, actor, request: AnalysisReportRequest):
    sources = [service.authorized_evidence(actor, reference) for reference in request.run_refs]
    # 跨轮追问只能显式带入已重新鉴权的同会话背景；计算仍受原scope约束。
    context_refs = set(request.context_run_refs)
    current = [source for source in sources if source["run_ref"] not in context_refs]
    if not current or len(context_refs) != len(request.context_run_refs) or not context_refs.issubset(request.run_refs):
        raise ApplicationError("ANALYSIS_REPORT_SCOPE", "背景引用必须属于已选运行，且保留本轮分析运行。", status_code=422)
    first = current[0]
    if len(set(request.run_refs)) != len(request.run_refs) or any(
        (source in current and source["scope_id"] != first["scope_id"])
        or source["conversation_id"] != first["conversation_id"]
        or source["org_codes"] != first["org_codes"]
        or source["date_selection"] != first["date_selection"]
        or source["requested_start"] != first["requested_start"]
        or source["requested_end"] != first["requested_end"]
        for source in sources
    ):
        raise ApplicationError(
            "ANALYSIS_REPORT_SCOPE",
            "报告必须汇总同一用户回合、机构与日期目标的真实运行。",
            status_code=422,
        )
    semantics = service.semantics(actor)
    for source in sources:
        for metric in source["metric_descriptors"]:
            semantics.resolve(metric["binding_ref"])
    atoms = {item["ref"]: item for source in sources for item in source["evidence_items"]}

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
    # 缺数日期也是执行器已经检查的范围；允许报告解释缺失基期与月份。
    for source in sources:
        for gap in source["gaps"]:
            known_dates.update(re.findall(r"\d{4}-\d{2}(?:-\d{2})?", gap))
    # 同一已核验日期可用 ISO 或中文写法，不能因格式变化误拒绝正常报告。
    known_dates |= {
        f"{int(day[:4])}年{int(day[5:7])}月{int(day[8:10])}日"
        for day in list(known_dates)
        if len(day) == 10
    }
    scope_dates = {
        day
        for source in sources
        for day in [source["requested_start"], source["requested_end"]]
        if day
    }
    for day in list(known_dates) + list(scope_dates):
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            known_dates.update(
                {
                    day[:7],
                    f"{int(day[:4])}年{int(day[5:7])}月",
                    f"{int(day[:4])}年",
                    f"{int(day[5:7])}月",
                }
            )
    for source in sources:
        start, end = source["requested_start"], source["requested_end"]
        if start and end:
            first_month = int(start[:4]) * 12 + int(start[5:7]) - 1
            last_month = int(end[:4]) * 12 + int(end[5:7]) - 1
            for month in range(first_month, min(last_month + 1, first_month + 36)):
                year, zero_month = divmod(month, 12)
                known_dates.update({f"{year}年{zero_month + 1}月", f"{zero_month + 1}月"})

    def prose_refs(text):
        return [ref.removesuffix("|cite") for ref in re.findall(r"\{\{([^{}]+)\}\}", text)]

    def render(text, references=None, location="主要判断"):
        actual_dates = {day for source in sources for day in source["actual_dates"]}
        for match in re.finditer(r"(?:(\d{4})年)?(\d{1,2})月(?:末|底)", text):
            year = int(match[1]) if match[1] else None
            month = int(match[2])
            if not 1 <= month <= 12 or year is not None and not 1 <= year <= 9999:
                continue  # 下方数值校验仍会拒绝非法日期。
            # 省略年份的“8月底”同样属于月末断言，不能绕过实际观测日校验。
            month_end_observed = any(
                int(day[5:7]) == month
                and (year is None or int(day[:4]) == year)
                and int(day[8:10]) == calendar.monthrange(int(day[:4]), month)[1]
                for day in actual_dates
            )
            clause = (
                re.split(r"[。；;\n]", text[: match.start()])[-1]
                + text[match.start() : match.end() + 20]
            )
            if not month_end_observed and not re.search(
                r"无数据|暂无|缺少|未取得|没有|未提供", clause
            ):
                raise ApplicationError(
                    "ANALYSIS_REPORT_NUMBER",
                    f"{location}把月中记录称为月末：{match[0]}。实际观测日期为{'、'.join(sorted(actual_dates))}，请原样披露实际截至日。",
                    status_code=422,
                )
        refs = prose_refs(text)
        if set(refs) - atoms.keys() or references is not None and set(references) - atoms.keys():
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE",
                "报告包含不存在的事实引用，请使用回执中的原子ref。",
                status_code=422,
            )
        remaining = re.sub(r"\{\{[^{}]+\}\}", "", text)
        # 模型可引用原子，也可原样引用已显示值；数值必须逐字匹配本段证据。
        # 不接受仅因数字相同就通过的裸数字，也不让本段借用未引用的其他段落数值。
        selected_atoms = [atoms[ref] for ref in references] if references else list(atoms.values())

        # 仅核验明确比较量的数学正负，不据此推导业务好坏或未知指标公式。
        def check_direction(prefix, atom):
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
            if not (
                atom.get("value") is not None
                and (
                    atom["type"] == "calculation"
                    and atom.get("name") in {"difference", "change_rate"}
                    or atom["type"] == "fact"
                    and re.search(r"较(?:上月|同期|年初)(?:增幅)?$", atom.get("metric_name", ""))
                )
            ):
                return
            if re.search(r"不能|无法|未能|是否|尚未", clause):
                return
            direction = re.search(
                r"(增加|增长|上升|上行|减少|下降|降低|回落|下行|降|减)\s*(?:了|约|为)?\s*$", clause
            )
            if not direction:
                return
            value = Decimal(atom["value"])
            upward = direction[1] in {"增加", "增长", "上升", "上行"}
            if value == 0 or upward != (value > 0):
                raise ApplicationError(
                    "ANALYSIS_REPORT_DIRECTION",
                    f"{location}的增减方向与所引比较量不一致："
                    f"{atom.get('metric_name', '')}为{atom['display']}。"
                    "请修正方向，或直接按正式指标名称描述其观测值。",
                    status_code=422,
                )

        for match in re.finditer(r"\{\{([^{}]+?)(\|cite)?\}\}", text):
            if not match[2]:
                check_direction(text[: match.start()], atoms[match[1]])
        exact_values = {
            value
            for atom in selected_atoms
            for value in re.findall(
                r"[+-]?\d+(?:\.\d+)?(?:亿元|万元|元|个百分点|%|名|户|笔|倍)",
                atom["display"],
            )
        }
        checked = remaining
        if any("数值编码未审核" in item for source in sources for item in source["limitations"]):
            # 这是禁止换算的口径说明，100不是模型编造的业务数值。
            checked = re.sub(
                r"(?:不(?:自动)?|未(?:做)?|不能)\s*(?:做)?\s*乘(?:以)?\s*100", "", checked
            )
        for value in sorted(known_dates, key=len, reverse=True):
            checked = checked.replace(value, "")
        for metric in (metric for source in sources for metric in source["metric_descriptors"]):
            checked = checked.replace(metric["name"], "")

        def literal_value(match):
            value = match[0]
            matches = [
                atom
                for atom in selected_atoms
                if atom["type"] in {"fact", "calculation"} and value in atom["display"]
            ]
            if value in exact_values:
                if len(matches) == 1:
                    check_direction(checked[: match.start()], matches[0])
                return ""
            # “减少0.20亿元”可表达已核验的-0.20亿元，不能无方向地丢弃负号。
            if not value.startswith(("-", "+")) and "-" + value in exact_values:
                prefix = re.split(r"[，。；;!?\n]", checked[: match.start()])[-1][-20:]
                if re.search(r"(?:减少|下降|降低|回落|降|减)\s*(?:了|约|为)?\s*$", prefix):
                    return ""
            return value

        checked = re.sub(
            r"[+-]?\d+(?:\.\d+)?(?:亿元|万元|元|个百分点|%|名|户|笔|倍)", literal_value, checked
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
        checked = re.sub(
            r"原始值\s*(?:为|是)?\s*([+-]?\d+(?:\.\d+)?)",
            lambda match: "" if Decimal(match[1]) in raw_values else match[0],
            checked,
        )
        # 段首、冒号或分号后的建议序号属于排版；后续业务数值仍须逐项匹配证据。
        # 不删除单位前的数字，避免把“1）亿元”一类异常数值当作序号放行。
        checked = re.sub(
            r"(^|[\n：:；;])\s*(?:[（(](?:[1-9]|1[0-2])[）)]|"
            r"(?:[1-9]|1[0-2])[）)])\s*(?!(?:亿元|万元|元|个百分点|%))"
            r"(?=[\u4e00-\u9fffA-Za-z])",
            r"\1",
            checked,
        )
        numeric_error = None
        if re.search(r"\d", checked):
            unmatched = re.search(r".{0,12}\d[^，。；\n]{0,35}", checked)
            numeric_error = ApplicationError(
                "ANALYSIS_REPORT_NUMBER",
                f"{location}存在未获本段证据支持的数值：{unmatched[0] if unmatched else ''}。"
                "使用{{原子ref}}，或逐字引用证据显示值；"
                "同时修改summary和各段落，不保留错误数字。",
                status_code=422,
            )
        claims = re.finditer(
            r"导致|主要原因是|原因在于|因为.+所以|由于.+导致|客户(?:已|都)?流失|"
            r"可能(?:存在|与|因|源于|来自)|(?:贡献|变化)[^。；\n]{0,10}(?:来自|来源于)|"
            r"增长主要集中|(?:增长|增量).{0,12}主要(?:来自|来源于|由)|"
            r"(?:增长|总量)的主要支撑|主要由[^。；\n]{0,50}(?:拉动|带动)|"
            r"(?:结构|构成)(?:较为|相对)?稳定|(?:同期|历史|去年).{0,6}高位|"
            r"(?:月度动能|增长动能|扩张动能|增长势头)[^。！？；]{0,8}(?:趋缓|放缓|增强|减弱|加速|强于|弱于|更强|更弱|停滞|乏力)|"
            r"监管(?:达标|不达标)(?!阈值|标准)|(?:高于|低于)监管|符合监管要求|满足监管要求|"
            r"预测.*(?:将|会)|资金(?:已|都)?流向|整体平稳|经营.{0,8}稳定|风险可控|盈利良好|较好的盈利|"
            r"(?:资产|贷款)质量[^。；\n]{0,12}(?:良好|可控|稳健|平稳|较低水平)|"
            r"(?:投放|获客|吸储|回收|清收|还款)(?:速度|节奏|力度|能力).{0,12}(?:平稳|稳定|稳健|放缓|趋缓|加快|增强)|"
            r"(?:负债|客户|存款|贷款)(?:端)?稳定性.{0,6}(?:较好|良好|较强)|"
            r"(?:费用|成本)(?:控制|效率|管理)[^。；\n]{0,24}(?:改善|恶化|良好|优化|有效)|"
            r"(?:客户|存款|贷款|盈利|经营)(?:基础|增势|态势|状况|能力|表现).{0,8}(?:平稳|稳健|良好|扎实)|"
            r"(?:不良(?:贷款)?(?:比)?率|风险水平|客户集中度|存贷比)[^。；\n]{0,20}(?:较高|较低|偏高|偏低|低位|高位)|"
            r"(?:说明|表明|反映)[^。；\n]{0,35}(?:投放|获客|揽储|清收|还款)|"
            r"(?:说明|表明|反映)[^。；\n]{0,45}(?:运用|能力|动能)[^。；\n]{0,15}(?:偏弱|偏强|更强|更弱|较强|较弱)|"
            r"(?:说明|表明|反映)[^。；\n]{0,60}(?:抵消|驱动|支撑|拉动|传导|源于|来自|带动)",
            remaining,
        )
        unsupported = None
        for claim in claims:
            # 明确否定与待核实说明不构成因果/达标断言；遇到转折重新判断。
            prefix = re.split(r"[，。；;!?\n]|但是|然而|但", remaining[: claim.start()])[-1][-40:]
            sentence_prefix = re.split(r"[。；;!?\n]", remaining[: claim.start()])[-1][-120:]
            verification = re.search(
                r"(?:需(?:要)?|建议|待|应|进一步)[^。；\n]{0,20}(?:核查|核实|验证|确认)[^。；\n]{0,40}$|"
                r"需(?:要)?补充[^。；\n]{0,70}判断[^。；\n]{0,30}$",
                sentence_prefix,
            )
            # “尚未回到同期高位”仍把同期认定为高位，前置的尚未并没有否定该基准。
            if re.search(r"(?:同期|历史|去年).{0,6}高位", claim[0]):
                if not re.search(
                    r"不能称|不能认定|不能判断|不应称|不代表|无法判断|未证实|是否", prefix
                ):
                    unsupported = claim[0]
                    break
                continue
            if not re.search(
                r"不能|无法|不足以|未能|尚未|不宜|不应|不等于|不代表|缺乏|缺少|未提供|没有|是否|能否|待验证|待核实",
                prefix,
            ) and not verification:
                unsupported = claim[0]
                break
        if not any(
            step["method"] == "trend"
            for source in sources for step in source["plan"]["steps"]
        ):
            for claim in re.finditer(
                r"(?:改善|增长|下降|回升|回落|变化)[^。；\n]{0,8}集中在(?:近期|本月|最近|上半年|下半年|年初)[^。；\n]{0,20}|"
                r"连续(?:收缩|扩张|增长|下降|回落|上升)|"
                r"(?:改善|回升|下降)[^。；\n]{0,12}更多(?:是|在)[^。；\n]{0,6}近期|"
                r"(?:扭转|延续)[^。；\n]{0,8}(?:上升|下降|增长)趋势|"
                r"(?:中长期|长期)[^。；\n]{0,8}(?:承压|恶化|向好|改善)", remaining
            ):
                prefix = re.split(
                    r"[，。；;!?\n]|但是|然而|但", remaining[: claim.start()]
                )[-1][-40:]
                if not re.search(r"不能|无法|不足以|不代表|是否|尚未|未确认", prefix):
                    unsupported = claim[0]
        cited_dates = {atoms[ref].get("date") for ref in refs if atoms[ref].get("date")}
        cited_atoms = [atoms[ref] for ref in set(refs + (references or []))]
        has_growth_rates = any(
            atom.get("name") == "change_rate" or "增幅" in atom.get("metric_name", "")
            for atom in cited_atoms
        )
        if not has_growth_rates:
            for claim in re.finditer(r"增长(?:明显|显著|相对)?(?:快于|慢于)|增长速度[^。；\n]{0,8}(?:更快|更慢|快于|慢于)", remaining):
                prefix = re.split(r"[，。；;!?\n]|但是|然而|但", remaining[:claim.start()])[-1][-40:]
                if not re.search(r"不能|无法|不足以|不代表|是否|尚未|未确认", prefix):
                    unsupported = claim[0]
        if not all(
            int(day[8:10]) == calendar.monthrange(int(day[:4]), int(day[5:7]))[1]
            for day in cited_dates or actual_dates
        ):
            # 月中余额与正式“较上月”能作时点比较，不能扩大成整月发生或强弱判断。
            for claim in re.finditer(r"月度(?:增长|增量|增速|回落)|单月(?:增长|增量|增速|看)|(?:增长|增势)[^。；\n]{0,8}(?:停滞|乏力)", remaining):
                prefix = re.split(r"[，。；;!?\n]|但是|然而|但", remaining[:claim.start()])[-1][-40:]
                if not re.search(r"不能|无法|不足以|不代表|是否|尚未|未确认", prefix):
                    unsupported = claim[0]
        if not any(
            metric.get("quantity_kind") == "cumulative_flow"
            for source in sources
            for metric in source["metric_descriptors"]
        ):
            for claim in re.finditer(r"累计口径|累计发生额|年内累计|累计差额|累计(?:同比|环比|利润|收入)", remaining):
                prefix = re.split(r"[，。；;!?\n]|但是|然而|但", remaining[: claim.start()])[-1][
                    -30:
                ]
                if not re.search(r"不能|无法|不代表|未确认|未知|未审核|是否|缺少", prefix):
                    unsupported = claim[0]
        if unsupported:
            raise ApplicationError(
                "ANALYSIS_REPORT_CAUSE",
                f"{location}包含未经证实的业务评价、因果、监管、预测或累计口径判断：{unsupported}。"
                "请删除对应断言，改为已证事实和待核查方向；不要把‘可能’等措辞当作已有归因依据。"
                + (f"另外，{numeric_error.message}" if numeric_error else ""),
                status_code=422,
            )
        if numeric_error:
            raise numeric_error
        # 不同比较基期不能被一句“均低于/高于某基期”合并，避免数值正确但解释错位。
        if re.search(
            r"(?:同比[、与和及]较年初|较年初[、与和及]同比)[^。；\n]{0,12}"
            r"(?:高于|低于|超过|不及)[^。；\n]{0,8}(?:去年同期|上年同期|年初)",
            remaining,
        ):
            raise ApplicationError(
                "ANALYSIS_REPORT_DIRECTION",
                f"{location}混用了比较基期。同比对应上年同期，较年初对应年初，"
                "请分别描述各自的比较结果，不能合并为同一基期。",
                status_code=422,
            )
        if references is not None and not refs and not references:
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE", "分析段落必须关联真实证据。", status_code=422
            )
        # 结构化观察已由计算器确定方向；不允许纯文字将全体下降改写成全体增长。
        relevant = [
            atoms[ref]
            for ref in set(refs + (references or []))
            if atoms[ref]["type"] == "observation"
        ]
        if (
            relevant
            and all("观测值减少" in item["display"] for item in relevant)
            and re.search(r"全部增长|均增长|全面上升", remaining)
        ):
            raise ApplicationError(
                "ANALYSIS_REPORT_DIRECTION", "文字方向与所引比较证据不一致。", status_code=422
            )
        rendered = re.sub(r"\{\{([^{}]+?)(\|cite)?\}\}",
                          lambda match: "" if match[2] else atoms[match[1]]["display"], text)
        # 显示值自带单位；处理模型在引用后再次添加单位的排版重复。
        rendered = re.sub(r"(亿元|万元|元|个百分点|%|名|户|笔|倍)(?:\1)+", r"\1", rendered)
        # 原样数值紧邻同值引用时仅清除括号内的重复展示，不改写业务文字或事实。
        rendered = re.sub(r"(?P<value>[+-]?\d+(?:\.\d+)?(?:亿元|万元|元|个百分点|%|名|户|笔|倍))[（(]\s*(?P=value)\s*[）)]", r"\g<value>", rendered)
        return re.sub(
            r"(减少|下降|降低|回落|降|减)(\s*(?:\*\*|__)?\s*)-(\d+(?:\.\d+)?(?:亿元|万元|元|个百分点|%))",
            r"\1\2\3",
            rendered,
        )

    observations = list({item["text"]: item for item in [
        *({"ref": atom["ref"], "text": atom["display"]}
          for atom in atoms.values() if atom.get("judgment_kind")),
        *(item for source in sources for item in source["observations"]),
    ]}.values())
    summary_refs = set()
    body_evidence = []
    if request.fallback:
        summary = (
            "部分文字分析未通过校验，以下保留已核验分析、基础事实与缺口。"
            if request.summary.strip() or request.sections
            else "以下展示已核验的基础事实与缺口，完整文字分析尚未完成。"
        )
        retained = []
        for paragraph in re.split(r"\n\s*\n", request.summary):
            if not paragraph.strip():
                continue
            try:
                retained.append(render(paragraph))
                refs = sorted(expanded_refs(prose_refs(paragraph)))
                summary_refs.update(refs)
                body_evidence.append({"paragraph": len(retained), "evidence_refs": refs})
            except ApplicationError:
                continue  # 只保留整段通过原校验的正文，不删词改写原意。
        if retained:
            summary = "\n\n".join(retained)
        sections = []
        for section in request.sections:
            try:
                sections.append({
                    "title": render(section.title, location="章节标题"),
                    "text": render(section.text, section.evidence_refs, location=section.title),
                    "evidence_refs": section.evidence_refs,
                })
            except ApplicationError:
                continue  # 逐段复核，不能因为一句无依据判断而丢失其他已经通过的分析。
        sections = sections or ([] if retained else [
            {
                "title": "已核验事实",
                "text": "\n".join(item["text"] for item in observations[:36]),
                "evidence_refs": [item["ref"] for item in observations[:36]],
            }
        ])
    else:
        if not request.summary:
            raise ApplicationError(
                "ANALYSIS_REPORT_SUMMARY", "请根据目标与事实提交核心判断。", status_code=422
            )
        failures = []

        def validate_render(text, references=None, location="主要判断"):
            try:
                return render(text, references, location)
            except ApplicationError as error:
                failures.append(error)
                return ""

        summary = "\n\n".join(validate_render(paragraph, location=f"正文第{index + 1}段")
                                 for index, paragraph in enumerate(re.split(r"\n\s*\n", request.summary)) if paragraph.strip())
        summary_refs.update(expanded_refs(prose_refs(request.summary)))
        body_evidence = [{"paragraph": index + 1, "evidence_refs": sorted(expanded_refs(prose_refs(paragraph)))}
                         for index, paragraph in enumerate(re.split(r"\n\s*\n", request.summary)) if paragraph.strip()]
        sections = [
            {
                "title": validate_render(section.title, location="章节标题"),
                "text": validate_render(
                    section.text, section.evidence_refs, location=section.title
                ),
                "evidence_refs": section.evidence_refs,
            }
            for section in request.sections
        ]
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
        refs = {
            ref
            for step in first["plan"]["steps"]
            if requirement["id"] in step["answers"]
            for ref in step["metric_refs"]
        }
        codes = {
            metric["code"]
            for metric in first["metric_descriptors"]
            if metric["binding_ref"] in refs
        }
        related_atoms = {ref for ref, atom in atoms.items() if atom.get("metric_code") in codes}
        for source in sources:
            for observation in source["observations"]:
                steps = [
                    step
                    for step in source["plan"]["steps"]
                    if step["id"] == observation.get("step_id")
                ]
                observed = {ref for step in steps for ref in step["metric_refs"]}
                if any(
                    metric["code"] in codes and metric["binding_ref"] in observed
                    for metric in source["metric_descriptors"]
                ):
                    related_atoms.add(observation["ref"])
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
                "ANALYSIS_REPORT_COVERAGE",
                f"报告遗漏原始子问题：{requirement['question']}。请在正文开篇或展开段落中回应，并引用实际证据；不要求每个子问题单独成章。",
                status_code=422,
            )
        requirement_coverage.append(
            {
                "id": requirement["id"],
                "question": requirement["question"],
                "status": "covered" if titles else "gap" if not related_atoms else "facts_only",
                "sections": titles,
            }
        )
    rows = list(
        {
            (row["metric_name"], row["org_name"], row["stat_date"], row["value_role"]): row
            for source in sources
            for row in source["rows"]
        }.values()
    )
    metric_names = {code: item.name for code, item in semantics.items.items()}
    gaps = list(
        dict.fromkeys(
            cleaned
            for item in [
                *(item for source in sources for item in source["gaps"]),
                *request.planning_gaps,
            ]
            if (cleaned := public_analysis_gap(item, metric_names))
        )
    )
    if request.fallback:
        gaps.append(
            "部分分析文字未通过证据校验，已省略；基础数据与通过校验的分析仍可查看。"
            if request.summary.strip() or request.sections
            else "完整文字分析尚未完成；当前仅交付已核验的基础事实与缺口。"
        )
    limitations = list(dict.fromkeys(item for source in sources for item in source["limitations"]))
    defaults = list(
        dict.fromkeys(item for source in sources for item in source["defaults_applied"])
    )
    dates = sorted({day for source in sources for day in source["actual_dates"]})
    scope = f"分析机构：{'、'.join(first['org_names'])}。"
    if first["requested_start"]:
        scope += f"请求期间：{first['requested_start']}至{first['requested_end']}。"
    scope += (
        f"实际观测日期：{'、'.join(dates) if dates else '未取得可用记录'}；"
        f"覆盖检查日期：{first['checked_on']}。"
    )
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
    answer = "\n\n".join(
        [
            scope,
            *defaults,
            first["source_notice"],
            # 模型的scope_notice保留在计划中，不作为默认机构、日期等已核验事实展示。
            summary,
            *[f"**{item['title']}**\n\n{item['text']}" for item in sections],
            *([f"**{presentation['labels']['gaps']}**\n\n" + "；".join(gaps)] if gaps else []),
            *([f"**{presentation['labels']['sources']}**\n\n" + "；".join(limitations)] if limitations else []),
        ]
    )
    return {
        "kind": "business_report",
        "status": "succeeded",
        "delivery": "business_evidence_v1",
        "answer_policy": "verified_report_v1",
        "analysis_protocol": "general-analysis-v1",
        "public_answer": answer,
        "partial_analysis": bool(request.planning_gaps)
        or request.fallback
        or any(not source["complete"] for source in sources),
        "run_refs": request.run_refs,
        "org_codes": first["org_codes"],
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
