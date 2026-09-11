"""Four-dimensional narrative, assembled exclusively from computed evidence."""

from decimal import Decimal

from ask_metric.domain.analysis_calculation import amount, formatted


def render_multidimensional(target, evidence, reason):
    lines, rows, gaps = [], [], []
    root = target or {}
    facts = [e.get("total", e) for e in evidence]
    total = next(
        (
            f
            for f in facts
            if f.get("status") == "OK"
            and "difference" in f
            and f.get("metric_code") == root.get("metric_code")
            and f.get("org_code") == root.get("org_code")
        ),
        None,
    )
    lines.append("一、规模维度")
    if total:
        lines.append(
            f"{root.get('org_name', root.get('org_code'))}，{total['metric_name']}："
            f"{total['report_date']}余额"
            f"{amount(total['current_value'], total['unit'], compact=True)}，"
            f"基期{total['base_date']}余额"
            f"{amount(total['base_value'], total['unit'], compact=True)}；"
            f"变化{amount(total['difference'], total['unit'])}，"
            + (
                f"变化率{formatted(total['change_rate'])}%。"
                if total["change_rate"] is not None
                else "基期为零，变化率未定义。"
            )
        )
        rows.append(
            {
                k: total[k]
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
        rows[0]["change_rate"] = (
            formatted(total["change_rate"]) + "%" if total["change_rate"] is not None else None
        )
        for k in ("base_value", "current_value", "difference"):
            rows[0][k] = format(Decimal(total[k]).normalize(), "f")
    else:
        gaps.append("尚无完整的总量两期比较证据")

    decompositions = [e for e in evidence if e.get("tool") in {"decompose", "decompose_org"}]
    groups = [
        (
            "二、结构维度",
            [
                e
                for e in decompositions
                if e.get("dimension") == "metric"
                and e.get("metric_code") == root.get("metric_code")
                and e.get("org_code") == root.get("org_code")
            ],
        ),
        (
            "三、明细维度",
            [
                e
                for e in decompositions
                if e.get("dimension") == "metric"
                and (e.get("metric_code"), e.get("org_code"))
                != (root.get("metric_code"), root.get("org_code"))
            ],
        ),
        ("四、机构维度", [e for e in decompositions if e.get("dimension") == "organization"]),
    ]
    for title, items in groups:
        lines.append(title)
        if not items:
            gap = title[2:] + "尚无已完成的分解证据"
            lines.append(gap + "。")
            gaps.append(gap)
        for item in items:
            parent = item.get("total") or {}
            unit = parent.get("unit", "")
            heading = parent.get("metric_name", item.get("metric_code", "目标"))
            if item.get("dimension") == "organization":
                heading += " / " + item.get("org_name", item.get("org_code", ""))
            lines.append(f"以{heading}为直接父项：")
            for row in item.get("rows", []):
                label = (
                    row.get("org_name")
                    if item.get("dimension") == "organization"
                    else row.get("metric_name")
                ) or row.get("metric_code")
                net, direction = (
                    row.get("contribution_pct"),
                    row.get("directional_contribution_pct"),
                )
                lines.append(
                    f"• {label}：变化{amount(row['difference'], unit)}，变化率"
                    + (
                        formatted(row.get("change_rate")) + "%"
                        if row.get("change_rate") is not None
                        else "未定义（基期为零）"
                    )
                    + (
                        f"；对父项净变化的贡献占比{formatted(net)}%，"
                        f"带涨跌方向的贡献度{formatted(direction)}%。"
                        if net is not None
                        else "；贡献率未定义（父项净变化为零）。"
                    )
                )
            if "unexplained_change" in item:
                lines.append(
                    f"总分核对：基期差额{amount(item['base_residual'], unit)}，"
                    f"报告期差额{amount(item['current_residual'], unit)}，"
                    f"未解释变化{amount(item['unexplained_change'], unit)}。"
                )
            if not item.get("reconciled"):
                gaps.append(heading + "：分项覆盖或总分核对未完整通过，保留差额")
            for relation in item.get("available_child_relations", []):
                completed = any(
                    e.get("tool") == item.get("tool")
                    and e.get("metric_code")
                    == (
                        relation["parent"]
                        if item.get("dimension") == "metric"
                        else item.get("metric_code")
                    )
                    and e.get("org_code")
                    == (
                        relation["parent"]
                        if item.get("dimension") == "organization"
                        else item.get("org_code")
                    )
                    and "unexplained_change" in e
                    for e in decompositions
                )
                if not completed:
                    gaps.append(f"{relation['parent']}已配置下级关系，但本次尚未完成该层取证")

    # Conversion results are facts too; never suppress an explicitly requested conversion.
    for item in evidence:
        if item.get("tool") == "calculate" and item.get("status") == "OK":
            lines.append(
                f"单位换算：{item['metric_name']}基期"
                f"{amount(item['base_value'], item['unit'])}，报告期"
                f"{amount(item['current_value'], item['unit'])}，变化"
                f"{amount(item['difference'], item['unit'])}。"
            )
        if item.get("gap"):
            gaps.append(item["gap"])

    # Only root-level metric structure can support this summary; dimensions never add together.
    structure = groups[0][1]
    if total and structure:
        parts = structure[0].get("rows", [])
        delta = Decimal(total["difference"])
        aligned = [r for r in parts if Decimal(r["difference"]) * delta > 0]
        if aligned:
            leading = max(aligned, key=lambda r: abs(Decimal(r["difference"])))
            qualifier = "已取得的结构分项中" if not structure[0].get("reconciled") else "结构维度中"
            lines.append(
                f"综合来看，{qualifier}{leading['metric_name']}对本次"
                f"{'增长' if delta > 0 else '下降'}的同向变化贡献最大，"
                f"净变化贡献占比为{formatted(leading['contribution_pct'])}%。"
            )
    lines.append(
        "各维度分别解释同一总量变化，贡献度不能跨维度相加；"
        "明细贡献相对于其直接父项。分项贡献说明数据变化来源，不能证明具体业务动因。"
    )
    labels = {
        "CANCELLED": "分析已取消",
        "MODEL_INVALID": "模型动作不符合契约",
        "MODEL_UNAVAILABLE": "分析模型暂不可用",
        "PERMISSION_DENIED": "权限校验未通过",
        "NO_PROGRESS": "重复动作没有新证据",
        "LEASE_LOST": "执行租约失效",
    }
    if reason not in {"EVIDENCE_COMPLETE", "CLARIFICATION"}:
        lines.append(labels.get(reason, "分析已达到运行限制") + "，已停止后续取证。")
    lines.extend("证据缺口：" + gap + "。" for gap in dict.fromkeys(gaps))
    return "\n\n".join(lines), rows, list(dict.fromkeys(gaps))
