"""先从受治理回执形成可复核判断，再交给模型组织正文；不接收模型提供的数值或公式。"""

import hashlib
import re
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, localcontext
from itertools import combinations

VERSION = "verified-findings-v1"
PERIODS = {"mom": "较上月", "yoy": "较同期", "ytd": "较年初"}
BOUNDARY = "判断仅覆盖所引机构、观测日与比较基期；不证明连续趋势、业务因果、监管达标或经营好坏。"


def _sign(value):
    return "增加" if value > 0 else "减少" if value < 0 else "持平"


def _compile(evidence, measures, peer_groups=()):
    """只编译已登记原子；固定减法采用原始 Decimal，不从舍入后的展示文字反算。"""
    atoms = {item["ref"]: item for item in evidence["evidence_items"]}
    findings, derived = [], []

    def add(kind, text, inputs, *, calculation=None):
        refs = list(dict.fromkeys(item["ref"] for item in inputs))
        if any(ref not in atoms for ref in refs):
            raise ValueError("判断引用必须来自当前回执")
        identity = hashlib.sha256(
            (VERSION + kind + inputs[0]["org_code"] + inputs[0]["date"] + "|".join(refs)).encode()
        ).hexdigest()[:16]
        finding = {
            "ref": f"finding.{identity}",
            "kind": kind,
            "text": f"截至{inputs[0]['date']}，{text}",
            "evidence_refs": refs,
            "date": inputs[0]["date"],
            "org_code": inputs[0]["org_code"],
        }
        if calculation:
            finding["calculation"] = calculation
        findings.append(finding)

    # 每个正式差额优先于相应增幅，避免一项事实重复生成两份方向判断。
    groups = defaultdict(dict)
    for item in measures:
        value = Decimal(item["value"])
        if not value.is_finite() or item["ref"] not in atoms:
            continue
        key = (item["org_code"], item["date"], item["metric_id"])
        old = groups[key].get(item["period"])
        if old is None or old["role"] == "rate" and item["role"] == "difference":
            groups[key][item["period"]] = item

    # 不同比较基期出现反向，是判断需要限定的证据，不能描述为时间上的转折或加速。
    for periods in groups.values():
        ordered = [periods[p] for p in PERIODS if p in periods]
        if len({_sign(Decimal(item["value"])) for item in ordered}) > 1:
            text = "、".join(
                f"{PERIODS[item['period']]}{_sign(Decimal(item['value']))}" for item in ordered
            )
            add(
                "baseline_divergence",
                f"{ordered[0]['label']}在不同基期下方向有别：{text}。"
                "这些是不同基期的比较，不能据此认定增长加速、放缓或连续趋势。",
                ordered,
            )

    # 只比较配置已明确列为同组分项的正式增幅；不以余额、差额大小冒充增速或贡献。
    rates = defaultdict(dict)
    for item in measures:
        if item["role"] == "rate" and item.get("percent_scale") is not None:
            rates[(item["org_code"], item["date"], item["period"])][item["metric_id"]] = item
    for members in peer_groups:
        for (_, _, period), values in rates.items():
            for left_id, right_id in combinations(dict.fromkeys(members), 2):
                if left_id not in values or right_id not in values:
                    continue
                left, right = values[left_id], values[right_id]
                with localcontext() as context:
                    context.prec = 60
                    a = Decimal(left["value"]) * Decimal(left["percent_scale"])
                    b = Decimal(right["value"]) * Decimal(right["percent_scale"])
                    if not a.is_finite() or not b.is_finite() or a == b:
                        continue
                    high, low = (left, right) if a > b else (right, left)
                    gap = abs(a - b)
                    display = f"{gap.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP):.2f}个百分点"
                formula = {
                    "operation": "rate_gap",
                    "inputs": [high["ref"], low["ref"]],
                    "percent_scales": [high["percent_scale"], low["percent_scale"]],
                    "value": str(gap),
                    "display": display,
                    "unit": "个百分点",
                    "version": VERSION,
                }
                text = (
                    f"{PERIODS[period]}增幅中，{high['label']}高于{low['label']}，相差{display}。"
                    "这只是同基期增幅比较，不代表增量贡献或业务能力高低。"
                    if Decimal(display.removesuffix("个百分点"))
                    else f"{high['label']}与{low['label']}的{PERIODS[period]}增幅"
                    "在当前展示精度下接近，"
                    "不能据此认定明显差异。"
                )
                add("peer_rate_gap", text, [high, low], calculation=formula)

    for periods in groups.values():
        items = [periods[p] for p in PERIODS if p in periods]
        text = "；".join(
            f"{PERIODS[item['period']]}{_sign(Decimal(item['value']))}" for item in items
        )
        add("comparison_direction", f"{items[0]['label']}的正式比较结果：{text}。", items)

    # 有界摘要降低上下文成本；未入选的原始事实仍可引用，不代表没有其他发现。
    selected = list({item["ref"]: item for item in findings}.values())[:8]
    for item in selected:
        calculation = item.get("calculation")
        if calculation:
            ref = item["ref"] + ".gap"
            derived.append(
                {
                    "ref": ref,
                    "type": "calculation",
                    "name": "rate_gap",
                    "label": "同基期正式增幅差",
                    "display": calculation["display"],
                    "value": calculation["value"],
                    "unit": calculation["unit"],
                    "date": item["date"],
                    "org_code": item["org_code"],
                    "input_refs": list(item["evidence_refs"]),
                    "calculation": calculation,
                }
            )
            item["evidence_refs"] = [*item["evidence_refs"], ref]
        derived.append(
            {
                "ref": item["ref"],
                "type": "observation",
                "display": item["text"],
                "label": "已核验比较判断",
                "date": item["date"],
                "org_code": item["org_code"],
                "judgment_kind": item["kind"],
                "input_refs": item["evidence_refs"],
                "compiler_version": VERSION,
            }
        )
    evidence["evidence_items"].extend(derived)
    evidence["verified_findings"] = {"version": VERSION, "items": selected, "boundary": BOUNDARY}
    return evidence


def attach_overview_findings(evidence, topic):
    measures = []
    labels = {item["id"]: item["label"] for item in topic["metrics"]}
    orgs = evidence.get("org_codes", [])
    if len(orgs) != 1:
        return evidence
    for atom in evidence["evidence_items"]:
        match = re.fullmatch(r"([^.]+)\.(mom|yoy|ytd)\.(difference|rate)", atom["ref"])
        if not match or match[1] not in labels or atom.get("value") is None:
            continue
        measures.append(
            {
                **atom,
                "metric_id": match[1],
                "label": labels[match[1]],
                "period": match[2],
                "role": match[3],
                "org_code": orgs[0],
                "date": atom.get("date") or evidence["analysis_date"],
                # overview 的正式增幅绑定与计算回执均为 ratio；展示适配器明确标记。
                "percent_scale": "100"
                if atom.get("value_encoding") == "ratio" and atom.get("unit") == "%"
                else None,
            }
        )
    sources = {item["id"]: item.get("source") for item in topic["metrics"]}
    peers = [
        item["children"]
        for item in topic["relationships"]
        if item["type"] in {"classification", "reconciliation"}
        and len({sources.get(child) for child in item["children"]}) == 1
    ]
    return _compile(evidence, measures, peers)


def attach_analysis_findings(evidence):
    descriptors = {item["code"]: item for item in evidence["metric_descriptors"]}
    measures = []
    for atom in evidence["evidence_items"]:
        if atom.get("value") is None or not atom.get("date") or not atom.get("org_code"):
            continue
        metric = descriptors.get(atom.get("metric_code"), {})
        hint = metric.get("analysis_hint") or {}
        period = atom.get("comparison") or hint.get("comparison")
        role = atom.get("comparison_role") or hint.get("comparison_role")
        label = metric.get("name", "")
        # 无专项 Skill 时也接受目录明确发布的比较口径，不猜测任意名称的含义。
        if not period and metric.get("value_basis") in PERIODS.values():
            period = next(key for key, value in PERIODS.items() if value == metric["value_basis"])
            role = "rate" if label.endswith("增幅") else "difference"
        if period not in PERIODS or role not in {"difference", "rate"}:
            continue
        label = re.sub(r"(?:较上月|较同期|较年初)(?:增幅)?$", "", label)
        measures.append(
            {
                **atom,
                "label": label,
                # 跨主题计划中存款、贷款都可能使用 total/personal，不能混成同一指标。
                "metric_id": f"{hint.get('topic')}:{hint['metric_id']}"
                if hint.get("topic") and hint.get("metric_id")
                else label,
                "period": period,
                "role": role,
            }
        )
    return _compile(evidence, measures)
