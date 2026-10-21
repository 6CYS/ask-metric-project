"""将不可变事实和计算回执压缩为模型可引用的证据与展示单元。"""

import hashlib
from decimal import ROUND_HALF_UP, Decimal, localcontext


def display_value(
    item: dict,
    *,
    percentage_points: bool = False,
    encoding: str | None = None,
    money_unit: str | None = None,
) -> str:
    value = item.get("reply_value", item.get("display_value", item.get("value")))
    unit = item.get("reply_unit", item.get("unit", ""))
    with localcontext() as context:
        context.prec = 60
        raw = Decimal(item["value"])
        if money_unit == "亿元" and item.get("unit") in {"元", "万元", "亿元"}:
            divisors = {"元": Decimal("100000000"), "万元": Decimal("10000"), "亿元": Decimal(1)}
            value = format(
                (raw / divisors[item["unit"]]).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
                "f",
            )
            unit = "亿元"
        elif encoding in {"ratio", "calculated_ratio_difference"}:
            multiplier = (
                Decimal(10000) if encoding == "calculated_ratio_difference" else Decimal(100)
            )
            value = format(
                (raw * multiplier).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), "f"
            )
            unit = "%"
    if percentage_points:
        unit = "个百分点"
    return f"{value}{unit}"


def overview_evidence(result: dict, topic: dict) -> dict:
    evidence, rows = [], []
    day = result["analysis_date"]
    labels = {item["id"]: item["label"] for item in topic["metrics"]}
    encodings = {item["id"]: item.get("value_encoding") for item in topic["metrics"]}
    money_unit = topic.get("display_money_unit")
    comparisons = {"mom": "较上月", "yoy": "较同期", "ytd": "较年初", "share": "占比"}

    def add(ref, label, item, *, points=False, encoding=None):
        evidence.append(
            {
                "ref": ref,
                "label": label,
                "display": display_value(
                    item, percentage_points=points, encoding=encoding, money_unit=money_unit
                ),
                "value": item["value"],
                "unit": item.get("unit", ""),
                "fact_id": item.get("fact_id"),
                "date": item.get("date", day),
                "value_encoding": encoding,
            }
        )

    for metric, facts in result["facts"].items():
        current = facts.get(day)
        if not current:
            continue
        label = labels[metric]
        add(f"{metric}.current", label, current, encoding=encodings[metric])
        row = {
            "metric_id": metric,
            "指标": label,
            "当前值": display_value(current, encoding=encodings[metric], money_unit=money_unit),
        }
        for comparison, title in comparisons.items():
            calculation = next(
                (
                    item
                    for item in result["calculations"]
                    if item["metric"] == metric and item["comparison"] == comparison
                ),
                None,
            )
            official = next(
                (
                    item
                    for item in result.get("reported_comparisons", [])
                    if item["metric"] == metric and item["comparison"] == comparison
                ),
                None,
            )
            if calculation:
                cells = []
                for output in calculation["results"]:
                    points = current["unit"] == "%" and output["name"] == "difference"
                    encoding = (
                        "calculated_ratio_difference"
                        if points and encodings[metric] == "ratio"
                        else "ratio" if output["name"] in {"rate", "share"} else None
                    )
                    add(
                        f"{metric}.{comparison}.{output['name']}",
                        f"{label}{title}{output['label']}",
                        output,
                        points=points,
                        encoding=encoding,
                    )
                    cells.append(
                        display_value(
                            output,
                            percentage_points=points,
                            encoding=encoding,
                            money_unit=money_unit,
                        )
                    )
                row[title] = "；".join(cells)
            elif official:
                cells = []
                for measure, fact in official["facts"].items():
                    points = current["unit"] == "%" and measure == "difference"
                    encoding = (
                        "ratio" if measure == "rate" or encodings[metric] == "ratio" else None
                    )
                    add(
                        f"{metric}.{comparison}.{measure}",
                        f"{label}{title}（正式复合指标）",
                        fact,
                        points=points,
                        encoding=encoding,
                    )
                    cells.append(
                        display_value(
                            fact, percentage_points=points, encoding=encoding, money_unit=money_unit
                        )
                    )
                row[title] = "；".join(cells) + "（正式指标）"
            else:
                row[title] = "—"
        rows.append(row)
    if result.get("data_freshness"):
        evidence.append(
            {
                "ref": "scope.freshness",
                "label": "数据截至日与新鲜度",
                "display": result["data_freshness"]["notice"],
                "type": "observation",
            }
        )
    # 分项比较的顺序来自同周期正式增量；不用余额大小替代增长来源。
    values = {item["ref"]: item for item in evidence}
    for relationship in topic["relationships"]:
        if relationship["type"] != "reconciliation":
            continue
        for comparison in result["plan"]["comparisons"]:
            changes = [
                values.get(f"{child}.{comparison}.difference") for child in relationship["children"]
            ]
            if any(item is None for item in changes):
                continue
            if len({item["unit"] for item in changes}) != 1:
                continue
            increases = sorted(
                (item for item in changes if Decimal(item["value"]) > 0),
                key=lambda item: Decimal(item["value"]),
                reverse=True,
            )
            decreases = sorted(
                (item for item in changes if Decimal(item["value"]) < 0),
                key=lambda item: Decimal(item["value"]),
            )

            def name(item):
                return labels[item["ref"].split(".")[0]]

            evidence.append(
                {
                    "ref": f"growth_sources.{comparison}",
                    "label": f"{comparisons[comparison]}分项增量排序",
                    "display": (
                        f"{comparisons[comparison]}增加分项从大到小："
                        f"{'、'.join(map(name, increases)) or '无'}；"
                        f"下降分项按减少金额从大到小：{'、'.join(map(name, decreases)) or '无'}。"
                        "此为同周期正式增量排序，不代表已经核实完整贡献比例。"
                    ),
                    "type": "observation",
                    "ranked_increases": [item["ref"].split(".")[0] for item in increases],
                }
            )
    for gap in result["gaps"]:
        gap_id = hashlib.sha256((gap.get("label", "") + gap["reason"]).encode()).hexdigest()[:12]
        evidence.append(
            {
                "ref": f"gap.{gap_id}",
                "label": gap.get("label", "数据缺口"),
                "display": gap["reason"],
                "type": "gap",
            }
        )
    # 残差核对也是证据，模型不能只凭分项相近就宣称完整组成。
    for index, reconciliation in enumerate(result["reconciliations"]):
        item = reconciliation["results"][0]
        evidence.append(
            {
                "ref": f"reconciliation.{index}.value",
                "label": "组成残差",
                "display": display_value(item, money_unit=money_unit),
                "value": item["value"],
                "unit": item["unit"],
            }
        )
        evidence.append(
            {
                "ref": f"reconciliation.{index}",
                "label": "组成核对",
                "display": (
                    f"{reconciliation['date']}组成核对"
                    f"{'通过' if reconciliation['passed'] else '未通过'}；残差{display_value(item)}"
                ),
                "passed": reconciliation["passed"],
                "value": str(Decimal(item["value"])),
            }
        )
    from ask_metric.application.verified_findings import attach_overview_findings

    compiled = attach_overview_findings({**result, "evidence_items": evidence}, topic)
    return {
        "evidence_items": evidence,
        "verified_findings": compiled.get("verified_findings"),
        "table_rows": rows,
        "table_columns": ["指标", "当前值", "较上月", "较同期", "较年初", "占比"],
        "followup_candidates": followup_candidates(result, topic, evidence),
    }


def followup_candidates(result: dict, topic: dict, evidence: list[dict]) -> list[dict]:
    """以已校验变化和主题关系提出补查要求；不替模型写分析计划或业务原因。"""
    policy = topic.get("followup_policy", {})
    if result.get("goal") not in policy.get("goals", []) or not result.get("analysis_date"):
        return []
    items = {item["ref"]: item for item in evidence if "value" in item}
    selected = set(result["plan"]["metric_ids"])
    available = set(result.get("available_metric_ids", []))
    definitions = {item["id"]: item for item in topic["metrics"]}
    day = result["analysis_date"]
    candidates = []
    for relationship in topic["relationships"]:
        if relationship["type"] != "classification":
            continue
        parent = relationship["parent"]
        children = [
            child
            for child in relationship["children"]
            if child in available - selected
            and (
                definitions[child].get("frequency") != "quarterly"
                or day[5:] in {"03-31", "06-30", "09-30", "12-31"}
            )
        ]
        if not children:
            continue
        comparisons = []
        for comparison in result["plan"]["comparisons"]:
            root_ref = f"{policy.get('root_metric', 'total')}.{comparison}.difference"
            parent_ref = f"{parent}.{comparison}.difference"
            if root_ref in items and parent_ref in items:
                if Decimal(items[root_ref]["value"]) > 0 > Decimal(items[parent_ref]["value"]):
                    comparisons.append(comparison)
        if comparisons:
            candidates.append(
                {
                    "parent": parent,
                    "metric_ids": children,
                    "comparisons": comparisons,
                    "reason": (
                        f"{definitions[parent]['label']}在总量增长的比较期间下降，"
                        "应补查已绑定分类明细；分类可能交叉，不据此宣称完整归因。"
                    ),
                }
            )
    return candidates
