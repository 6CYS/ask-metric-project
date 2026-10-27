"""从已授权分析证据生成追问视图和紧凑事实摘要，不修改原运行记录。"""

import re
from copy import deepcopy
from datetime import date
from decimal import Decimal, InvalidOperation

from ask_metric.application.verified_findings import PERIODS, analysis_comparison
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
        # selected 已在全部授权来源中展开完整依据链；跨运行计算的父事实可位于另一份视图。
        # 每份视图仍只投影自己的原子，末尾统一检查所有所选依据确实保留。
        allowed.update(selected)
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


def validated_report_atoms(sources: list[dict]) -> dict[str, dict]:
    """先核对整份来源的事实身份，不能靠裁剪错误段落掩盖冲突或越界证据。"""
    atoms, identities, catalog = {}, {}, {}

    def reject():
        raise ApplicationError(
            "ANALYSIS_REPORT_REFERENCE", "报告事实身份、数值或依据链不一致，请重新取数。",
            status_code=422,
        )

    for source in sources:
        metrics = {item["code"]: item for item in source["metric_descriptors"]}
        bindings = {item["binding_ref"] for item in source["metric_descriptors"]}
        if len(metrics) != len(source["metric_descriptors"]) or len(bindings) != len(metrics):
            reject()
        for metric in metrics.values():
            ref = metric["binding_ref"]
            identity = tuple(metric.get(key) for key in (
                "code", "name", "unit", "value_basis", "quantity_kind", "metadata_version",
                "analysis_hint",
            ))
            if ref in catalog and catalog[ref] != identity:
                reject()
            catalog[ref] = identity
        steps = source["plan"]["steps"]
        if (not bindings <= {ref for step in steps for ref in step["metric_refs"]}
                or any(step["method"] not in {"observe", "compare", "trend", "ranking", "structure"}
                       for step in steps)):
            reject()
        codes, names = source["org_codes"], source["org_names"]
        if len(codes) != len(set(codes)) or len(codes) != len(names):
            reject()
        organizations = dict(zip(codes, names, strict=True))
        days = set(source["actual_dates"]) | {row["stat_date"] for row in source["rows"]}
        for atom in source["evidence_items"]:
            ref = atom["ref"]
            if ref in atoms and atoms[ref] != atom:
                reject()
            atoms[ref] = atom
            if atom.get("type") not in {"fact", "calculation"}:
                continue
            value = atom.get("value")
            try:
                if value is not None and not Decimal(value).is_finite():
                    reject()
            except (InvalidOperation, TypeError, ValueError):
                reject()
            if atom["type"] != "fact":
                continue
            metric = metrics.get(atom.get("metric_code"))
            if (not metric or atom.get("metric_name") != metric["name"]
                    or atom.get("org_code") not in organizations
                    or atom.get("org_name") != organizations[atom["org_code"]]
                    or not isinstance(atom.get("display"), str)):
                reject()
            try:
                date.fromisoformat(atom["date"])
            except (KeyError, TypeError, ValueError):
                reject()
            if atom["date"] not in days:
                reject()
            identity = (atom["metric_code"], atom["org_code"], atom["date"])
            content = (Decimal(value) if value is not None else None,
                       atom["display"], atom.get("unit"), atom.get("metadata_version"))
            if identity in identities and identities[identity] != content:
                reject()
            identities[identity] = content
    return atoms


def unconfirmed_ratio(metric: dict) -> bool:
    return metric.get("unit") == "%" and metric.get("value_encoding") not in {"ratio", "percent"}


def fact_narrative(sources: list[dict]) -> dict:
    """按正式指标、日期和机构范围重建事实，不从失败草稿中挑选文字。"""
    displayed_refs = set()
    atoms = {atom["ref"]: atom for source in sources for atom in source["evidence_items"]}
    unknown_codes = {metric["code"] for source in sources
                     for metric in source["metric_descriptors"] if unconfirmed_ratio(metric)}
    excluded_refs = {ref for ref, atom in atoms.items() if atom.get("metric_code") in unknown_codes}
    while True:
        dependents = {ref for ref, atom in atoms.items()
                      if set(atom.get("input_refs", [])) & excluded_refs}
        if dependents <= excluded_refs:
            break
        excluded_refs.update(dependents)
    groups = {}
    for source in sources:
        organizations = dict(zip(source["org_codes"], source["org_names"], strict=True))
        for metric in source["metric_descriptors"]:
            atoms = [atom for atom in source["evidence_items"]
                     if atom["type"] == "fact" and atom.get("metric_code") == metric["code"]]
            days = sorted({atom["date"] for atom in atoms} or set(source["actual_dates"]))
            ranking_options = {
                (step["position"], step["top_n"])
                for step in source["plan"]["steps"]
                if step["method"] == "ranking" and metric["binding_ref"] in step["metric_refs"]
                and step.get("position") in {"top", "bottom"}
                and isinstance(step.get("top_n"), int) and 1 <= step["top_n"] <= 100
            }
            for day in days or [None]:
                # 同一正式绑定、时点和范围才可合并补查；冲突已在来源校验中拒绝。
                key = (metric["binding_ref"], day, tuple(sorted(organizations)))
                group = groups.setdefault(key, {"metric": metric, "day": day,
                    "organizations": organizations, "atoms": {}, "rankings": set()})
                group["atoms"].update({atom["ref"]: atom for atom in atoms if atom["date"] == day})
                group["rankings"].update(ranking_options)
    paragraphs, references, missing = [], [], set()
    coverage_groups, replaced_gaps = {}, []
    compared_refs, ranked_refs = set(), set()
    for key, group in groups.items():
        metric, day, organizations = group["metric"], group["day"], group["organizations"]
        if unconfirmed_ratio(metric):
            continue
        facts = {}
        for atom in group["atoms"].values():
            if atom.get("value") is not None:
                facts.setdefault(atom["org_code"], (Decimal(atom["value"]), atom))
        ordered = sorted(facts.values(), key=lambda item: (item[0], item[1]["org_code"]))
        comparison = bool(ordered) and all(
            analysis_comparison(atom, metric) is not None for _, atom in ordered
        )
        selected_groups = []
        if group["rankings"]:
            for position, top_n in sorted(group["rankings"]):
                selected = sorted(ordered, key=lambda item: (
                    item[0].copy_negate() if position == "top" else item[0], item[1]["org_code"],
                ))[:top_n]
                label = "按已确认排序列示（从高到低）" if position == "top" \
                    else "按已确认排序列示（从低到高）"
                selected_groups.append((label, selected))
        elif comparison:
            negative = [item for item in ordered if item[0] < 0][:10]
            positive = sorted((item for item in ordered if item[0] > 0),
                              key=lambda item: (item[0].copy_negate(), item[1]["org_code"]))[:4]
            selected_groups = [("负向变动（按比较值从低到高，列示部分机构）", negative),
                               ("正向变动（按比较值从高到低，列示部分机构）", positive),
                               ("零变动（列示部分机构）", ordered[:4]
                                if not negative and not positive else [])]
        elif ordered:
            selected_groups = [("已取得的观测值（列示部分机构）",
                                sorted(ordered, key=lambda item: item[1]["org_code"])[:4])]
        selected_groups = [
            (label, [item for item in selected if item[1]["ref"] not in displayed_refs])
            for label, selected in selected_groups
        ]
        single_institution = len(organizations) == 1 and not group["rankings"]
        if any(selected for _, selected in selected_groups):
            # 部分列示仍代表这个指标、日期和机构范围；不再逐家补同类方向或排名。
            group_refs = {atom["ref"] for _, atom in ordered}
            if comparison:
                compared_refs.update(group_refs)
            if group["rankings"]:
                ranked_refs.update(group_refs)
        if not single_institution and any(selected for _, selected in selected_groups):
            title = f"**{metric['name']}**" + (f"（{day}）" if day else "")
            if comparison:
                title += "\n以下仅比较已取得有效值的机构，不能据此确认整体变化或完整贡献。"
            paragraphs.append({"text": title, "evidence_refs": []})
        for label, selected in selected_groups:
            if selected:
                if single_institution:
                    value, atom = selected[0]
                    comparison_basis = analysis_comparison(atom, metric)
                    name, expression = metric["name"], "为"
                    if comparison_basis:
                        period, role = comparison_basis
                        name = re.sub(r"(?:较上月|较同期|较年初)(?:增幅)?$", "", name)
                        expression = PERIODS[period] + (
                            "增幅为" if role == "rate" else
                            "增加" if value > 0 else "减少" if value < 0 else "变化为"
                        )
                    paragraphs.append({
                        "text": f"截至{day}，{atom['org_name']}{name}{expression}"
                                + "{{" + atom["ref"] + "}}。",
                        "evidence_refs": [atom["ref"]],
                    })
                    displayed_refs.add(atom["ref"])
                    continue
                if group["rankings"]:
                    text = f"**{label}**\n\n| 机构 | 指标值 |\n|---|---|\n" + "\n".join(
                        f"| {atom['org_name']} | " + "{{" + atom["ref"] + "}} |"
                        for _, atom in selected
                    )
                else:
                    text = f"**{label}**\n" + "\n".join(
                        f"{index}. {atom['org_name']}：" + "{{" + atom["ref"] + "}}。"
                        for index, (_, atom) in enumerate(selected, 1)
                    )
                paragraphs.append({
                    "text": text,
                    "evidence_refs": [atom["ref"] for _, atom in selected],
                })
                displayed_refs.update(atom["ref"] for _, atom in selected)
        missing_organizations = set(organizations) - facts.keys()
        if missing_organizations:
            identity = (day, tuple(sorted(missing_organizations)), bool(facts))
            coverage_groups.setdefault(identity, []).append(metric["name"])
            # 兼容执行器已保存的缺数说明；可见摘要使用同一缺失集合的合并说明。
            replaced_gaps.append(
                f"{metric['name']}在{day}有{len(missing_organizations)}家机构未取得有效值；"
                "排名仅覆盖实际有数据的机构。"
            )
        references.extend(atom["ref"] for atom in group["atoms"].values())
        missing.update((key, org) for org in missing_organizations)
    seen_findings = set()
    for source in sources:
        organizations = dict(zip(source["org_codes"], source["org_names"], strict=True))
        metrics = {metric["code"]: metric for metric in source["metric_descriptors"]}
        # 已核验计算和判断保留原引用，不在报告层重新推导或扩大其含义。
        for atom in source["evidence_items"]:
            if not (atom.get("judgment_kind") or atom["type"] == "calculation") \
                    or atom["ref"] in seen_findings:
                continue
            seen_findings.add(atom["ref"])
            if atom["ref"] in excluded_refs:
                continue
            covered = ranked_refs if atom.get("judgment_kind") == "ranking" else (
                compared_refs if atom.get("judgment_kind") in {
                    "comparison_direction", "baseline_divergence",
                } else set()
            )
            if atom["ref"] in displayed_refs or (
                atom.get("judgment_kind") and atom.get("input_refs")
                and set(atom["input_refs"]) <= displayed_refs | covered
            ):
                continue
            org = organizations.get(atom.get("org_code"), "")
            reference = "{{" + atom["ref"] + "}}"
            if atom.get("judgment_kind"):
                text = (f"{org}：" if org else "") + reference
            else:
                label = atom.get("metric_name") or atom.get("label") or "已核验计算"
                day = atom.get("date")
                scope = f"{day}，" if day and day not in atom["display"] else ""
                comparison = analysis_comparison(atom, metrics.get(atom.get("metric_code"), {}))
                if comparison:
                    period, role = comparison
                    label += " " + PERIODS[period] + ("差额" if role == "difference" else "增幅")
                text = f"{scope}{org} {label}：{reference}。"
            paragraphs.append({"text": text, "evidence_refs": [atom["ref"]]})
            references.append(atom["ref"])
    coverage = []
    multiple_dates = len({group["day"] for group in groups.values()}) > 1
    for (day, absent, has_facts), names in coverage_groups.items():
        label = "、".join(dict.fromkeys(names)) + (f"（{day}）" if day and multiple_dates else "")
        coverage.append(label + (f"：还有{len(absent)}家机构暂无数据，未纳入本次分析。"
                                 if has_facts else "：当前机构范围暂无数据，暂无法分析。"))
    if not paragraphs and not coverage and not displayed_refs \
            and not any(source["gaps"] for source in sources) \
            and not any(unconfirmed_ratio(item["metric"]) for item in groups.values()):
        raise ApplicationError("ANALYSIS_REPORT_SUMMARY", "没有可交付的已核验事实或缺口。",
                               status_code=422)
    return {"paragraphs": paragraphs, "coverage": coverage, "replaced_gaps": replaced_gaps,
            "evidence_refs": list(dict.fromkeys(references)), "missing_count": len(missing)}


def report_rows(sources: list[dict]) -> list[dict]:
    """表格保留原展示文本，图表另取同一事实的原始值和单位，不解析带单位文案。"""
    values: dict[tuple, set[tuple[str, str]]] = {}
    for source in sources:
        for atom in source["evidence_items"]:
            # 百分比原值还依赖 ratio/percent 编码；缺少编码时不向图表猜测换算。
            if atom.get("type") != "fact" or atom.get("unit") not in {
                "元", "万元", "亿元", "户", "个", "家", "笔",
            }:
                continue
            value = str(atom.get("value", ""))
            try:
                if not Decimal(value).is_finite():
                    continue
            except InvalidOperation:
                continue
            key = (atom.get("metric_name"), atom.get("org_name"),
                   atom.get("date"), atom.get("display"))
            values.setdefault(key, set()).add((value, atom["unit"]))
    rows = {}
    for source in sources:
        for row in source["rows"]:
            key = (row["metric_name"], row["org_name"], row["stat_date"])
            result = {
                name: value for name, value in row.items() if name not in {"raw_value", "unit"}
            }
            candidates = values.get((*key, row["metric_value"]), set())
            if len(candidates) == 1:
                result["raw_value"], result["unit"] = next(iter(candidates))
            rows[(*key, row["value_role"])] = result
    return list(rows.values())


def shared_date_text(text: str, dates: list[str]) -> str:
    """全部观测同日时精简段首和标题的重复日期，正文比较日期与代码原样保留。"""
    if len(dates) != 1:
        return text
    day = dates[0]
    variants = [re.escape(day), f"{int(day[:4])}年0?{int(day[5:7])}月0?{int(day[8:10])}日"]
    pattern = re.compile(
        r"(^|\n\s*\n)([ \t]*)(?:截至|截止)\s*(?:" + "|".join(variants) + r")日?\s*[，,：:]\s*"
    )
    parts = re.split(r"(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)", text)
    heading_date = re.compile(
        r"[（(](?:截至|截止)\s*(?:" + "|".join(variants) + r")日?\s*[）)]"
    )
    # 只精简独立 Markdown 标题，正文中的比较日期和代码仍原样保留。
    def clean(part: str) -> str:
        return "\n".join(
            heading_date.sub("", line)
            if re.fullmatch(r"\s*(?:#{1,6}\s+.+|\*\*[^*]+\*\*)\s*", line)
            else line for line in pattern.sub(r"\1\2", part).split("\n")
        )
    return "".join(part if index % 2 else clean(part) for index, part in enumerate(parts))
