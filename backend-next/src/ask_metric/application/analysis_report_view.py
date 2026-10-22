"""从已授权分析证据生成追问视图和紧凑事实摘要，不修改原运行记录。"""

import re
from copy import deepcopy

from ask_metric.core.errors import ApplicationError


def focused_sources(sources: list[dict], references: list[str]) -> list[dict]:
    atoms = {atom["ref"]: atom for source in sources for atom in source["evidence_items"]}
    selected, visiting = set(), set()

    def visit(ref):
        if ref not in atoms or ref in visiting:
            raise ApplicationError(
                "ANALYSIS_REPORT_REFERENCE",
                "追问引用不属于所选证据或依据链不完整。",
                status_code=422,
            )
        if ref in selected:
            return
        visiting.add(ref)
        for parent in atoms[ref].get("input_refs", []):
            visit(parent)
        visiting.remove(ref)
        selected.add(ref)

    for ref in references:
        visit(ref)
    codes = {atoms[ref]["metric_code"] for ref in selected if atoms[ref].get("metric_code")}
    if not codes:
        raise ApplicationError(
            "ANALYSIS_REPORT_REFERENCE",
            "追问需引用具体指标事实或具有完整依据的判断。",
            status_code=422,
        )
    views = []
    for original in sources:
        source = deepcopy(original)
        metrics = [metric for metric in source["metric_descriptors"] if metric["code"] in codes]
        if not metrics:
            continue
        bindings = {metric["binding_ref"] for metric in metrics}
        steps = [
            step for step in source["plan"]["steps"] if bindings.intersection(step["metric_refs"])
        ]
        full_steps = {step["id"] for step in steps if set(step["metric_refs"]) <= bindings}
        observations = [
            item for item in source["observations"] if item.get("step_id") in full_steps
        ]
        allowed = {
            atom["ref"] for atom in source["evidence_items"] if atom.get("metric_code") in codes
        }
        allowed.update(item["ref"] for item in observations)
        allowed.update(ref for ref in selected if atoms[ref].get("type") == "gap")
        # 跨指标判断只有全部输入均在视图中才保留，不能将半条证据链当成完整结论。
        changed = True
        while changed:
            added = {
                atom["ref"]
                for atom in source["evidence_items"]
                if atom.get("input_refs") and set(atom["input_refs"]) <= allowed
            }
            changed = not added <= allowed
            allowed.update(added)
        projected_atoms = [
            atom
            for atom in source["evidence_items"]
            if atom["ref"] in allowed and set(atom.get("input_refs", [])) <= allowed
        ]
        fact_keys = {
            (atom.get("metric_name"), atom.get("org_name"), atom.get("date"))
            for atom in projected_atoms
            if atom["type"] == "fact"
        }
        source["rows"] = [
            row
            for row in source["rows"]
            if (row["metric_name"], row["org_name"], row["stat_date"]) in fact_keys
        ]
        source["row_count"] = len(source["rows"])
        source["actual_dates"] = sorted(
            {row["stat_date"] for row in source["rows"] if row["value_role"] == "分析时点"}
        )
        source["analysis_date"] = max(source["actual_dates"], default=None)
        source["metric_descriptors"], source["evidence_items"], source["observations"] = (
            metrics,
            projected_atoms,
            observations,
        )
        answers = {answer for step in steps for answer in step["answers"]}
        # 原计划完整保留作审计依据，投影视图不是一份可再次执行的缩减计划。
        source["requirement_dispositions"] = [
            item for item in source["requirement_dispositions"] if item["id"] in answers
        ]
        if len(steps) != len(original["plan"]["steps"]) or len(metrics) != len(
            original["metric_descriptors"]
        ):
            source["gaps"] = list(
                dict.fromkeys(
                    [atom["display"] for atom in projected_atoms if atom["type"] == "gap"]
                    + [
                        item["reason"]
                        for item in source["requirement_dispositions"]
                        if item.get("reason")
                    ]
                    + (
                        ["所选指标存在未取得的观测或比较证据，不能将未覆盖部分视为已完成。"]
                        if any(
                            item["status"] != "completed"
                            for item in source["requirement_dispositions"]
                        )
                        else []
                    )
                )
            )
        source["limitations"] = list(
            dict.fromkeys(note for metric in metrics for note in metric.get("limitations", []))
        )
        source["complete"] = all(
            item["status"] == "completed" for item in source["requirement_dispositions"]
        )
        views.append(source)
    if not views or not selected <= {
        atom["ref"] for source in views for atom in source["evidence_items"]
    }:
        raise ApplicationError(
            "ANALYSIS_REPORT_REFERENCE",
            "追问所选依据不完整，不能缩小后丢弃被引用的事实。",
            status_code=422,
        )
    return views


def compact_fact_section(sources: list[dict], atoms: dict[str, dict]) -> dict:
    """同一日期只标注一次；按指标合并机构，比较基期及其余数据留在明细中。"""
    rows = list(
        {
            (row["metric_name"], row["org_name"], row["stat_date"]): row
            for source in sources
            for row in source["rows"]
            if row["value_role"] == "分析时点"
        }.values()
    )
    groups = {}
    for row in rows:
        groups.setdefault((row["stat_date"], row["metric_name"]), []).append(row)
    fact_refs = {
        (atom.get("metric_name"), atom.get("org_name"), atom.get("date")): atom["ref"]
        for atom in atoms.values()
        if atom["type"] == "fact"
    }
    dates = sorted({day for day, _ in groups})
    organizations = {
        code: name
        for source in sources
        for code, name in zip(source["org_codes"], source["org_names"], strict=True)
    }
    lines, references = [], []
    shown = 0
    for day in dates:
        if shown >= 6:
            break
        if len(dates) > 1:
            lines.append(f"**{day}**")
        judgments = [
            atom for atom in atoms.values() if atom.get("judgment_kind") and atom.get("date") == day
        ][:2]
        for atom in judgments:
            text = re.sub(
                r"^(?:截至|截止)" + re.escape(day) + r"日?\s*[，,：:]\s*", "", atom["display"]
            )
            if len(organizations) > 1 and atom.get("org_code") in organizations:
                text = f"{organizations[atom['org_code']]}：{text}"
            lines.append(text)
            references.append(atom["ref"])
        for (date, name), items in groups.items():
            if date != day or shown >= 6:
                continue
            if any(atom.get("judgment_kind") == "ranking" for atom in judgments):
                # 排名结论已经基于完整集合计算，正文无需再抄前四个机构的原值。
                shown += 1
                continue
            visible = items[:4]
            lines.append(
                f"- **{name}**："
                + "；".join(f"{row['org_name']} {row['metric_value']}" for row in visible)
                + "。"
            )
            references.extend(fact_refs[(name, row["org_name"], day)] for row in visible)
            shown += 1
    if not lines:
        items = [atom for atom in atoms.values() if atom["type"] in {"gap", "observation"}][:3]
        lines = [atom["display"] for atom in items]
        references = [atom["ref"] for atom in items]
    if shown < len(groups) or any(len(items) > 4 for items in groups.values()):
        lines.append("其余数据见数据明细。")
    return {
        "title": "已核验事实",
        "text": "\n\n".join(lines),
        "evidence_refs": list(dict.fromkeys(references)),
    }


def shared_date_text(text: str, dates: list[str]) -> str:
    """全部观测同日时，顶部已展示日期；仅去除普通段首相同日期，不改写正文内或代码内日期。"""
    if len(dates) != 1:
        return text
    day = dates[0]
    variants = [re.escape(day), f"{int(day[:4])}年0?{int(day[5:7])}月0?{int(day[8:10])}日"]
    pattern = re.compile(
        r"(^|\n\s*\n)([ \t]*)(?:截至|截止)\s*(?:" + "|".join(variants) + r")日?\s*[，,：:]\s*"
    )
    parts = re.split(r"(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)", text)
    return "".join(
        part if index % 2 else pattern.sub(r"\1\2", part) for index, part in enumerate(parts)
    )
