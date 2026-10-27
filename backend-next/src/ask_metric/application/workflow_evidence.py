"""排名结果绑定及供模型整理的精简证据包；不让文字规划决定补查机构。"""

from datetime import date
from decimal import Decimal

from ask_metric.core.errors import ApplicationError


def bind_ranked_scope(context, source_id):
    source = context["state"]["completed_steps"].get(source_id, {})
    ranked = [o for o in source.get("observations", []) if o.get("type") == "ranking"]
    facts = {f["fact_id"]: f for f in source.get("facts", [])}
    if not ranked:
        return None, "排名范围未取得可比有效值，不能确定原因补查机构；缺失不等于零。"
    # 每个选择都必须由该排名节点的事实支持，且仍属于最初的授权范围。
    allowed = set(context["org_codes"])
    for item in ranked:
        if item.get("org_code") not in allowed or not any(
            facts.get(ref, {}).get("org_code") == item["org_code"]
            and facts[ref]["date"] == item["date"] for ref in item.get("fact_refs", [])
        ):
            raise ApplicationError(
                "ANALYSIS_RESULT_SCOPE_INVALID", "排名来源与补查机构不一致。", status_code=422
            )
    dates = sorted({item["date"] for item in ranked})
    if len(dates) != 1:
        return None, ("本次包含多个排名日期，已保留逐期排名；"
                      "本试点暂不将不同日期的入选机构混合归因。")
    codes = list(dict.fromkeys(item["org_code"] for item in ranked))
    day = date.fromisoformat(dates[0])
    payload = context["payload"].model_copy(update={
        "date_selection": "exact", "start": day, "end": day, "dates": None,
        "anchor_date": None,
    })
    return {"org_codes": codes, "org_names": {c: context["org_names"][c] for c in codes},
            "payload": payload}, None


def attach_workflow_brief(evidence):
    ranked = [o for o in evidence["observations"] if o["type"] == "ranking"]
    selected = {o["org_code"] for o in ranked}
    atoms = evidence["evidence_items"]
    rank_refs = [o["ref"] for o in ranked]
    selected_atoms = [a for a in atoms if a.get("org_code") in selected
                      and a.get("step_id") != "rank" and a.get("type") != "gap"]
    focus = list(dict.fromkeys([*rank_refs, *[a["ref"] for a in selected_atoms]]))
    focus.extend(a["ref"] for a in atoms if a.get("type") == "gap")
    # 比较观察已由计算服务生成；非入选机构的整表仍留在服务端供明细与校验。
    selected_observations = [o for o in evidence["observations"]
                             if o.get("type") == "comparison" and any(
                                 ref in {a.get("fact_id") for a in selected_atoms}
                                 for ref in o.get("fact_refs", []))]
    gaps = list(dict.fromkeys(evidence["gaps"]))
    has_data = bool(ranked)
    rank_failed = any(s["id"] == "rank" and s["status"] in {"failed", "blocked"}
                      for s in evidence["step_dispositions"])
    evidence["workflow_brief"] = {
        "workflow_id": evidence["plan"]["workflow_id"],
        "outcome": "answered" if has_data else "unavailable" if rank_failed else "no_data",
        "selected_org_codes": sorted(selected), "focus_refs": focus,
        "ranking": ranked, "comparisons": selected_observations,
        "coverage": {"requested_org_count": len(evidence["org_codes"]),
                     "valid_org_count": len(set(ranked[0]["comparison_fact_refs"]))
                     if ranked else 0},
        "unresolved": gaps,
        "interpretation": [
            "先说明净利润金额排名结果，再解释入选机构的已证实变化。金额排名不等于盈利效率或综合经营好坏。",
            "历史观测值差额不自动代表单月利润；正式比较与历史值比较应分别标注。",
            "收入、成本或利润单项观测只能说明现象；没有可验证分解和业务材料时，不宣称已证明因果。",
        ] if has_data else [
            "本次排名取数服务暂时不可用，不能把服务异常说成数据库没有数据。"
        ] if rank_failed else [
            "请求日期或范围没有取得可比有效记录，本次不能确定盈利排名；这是数据覆盖结果，不是模型或查询错误。",
            "保留用户明确日期，不擅自换日、不补零、不声称该机构没有盈利；近期则说明已按实际覆盖检查。",
        ],
    }


def attach_workflow_execution(evidence, context):
    """持久化实际节点摘要；不从最终正文反推执行状态，也不复制业务事实整表。"""
    state = context["state"]
    no_data = evidence["workflow_brief"]["outcome"] == "no_data"
    steps = []
    for step in context["payload"].plan.steps:
        result = (state["completed_steps"].get(step.id)
                  or state.get("failed_steps", {}).get(step.id) or {})
        facts, tasks = result.get("facts", []), result.get("tasks", [])
        error = result.get("execution_error")
        blocked = error == "ANALYSIS_DEPENDENCY_UNAVAILABLE"
        status = (
            "skipped_no_data" if blocked and no_data else "blocked" if blocked
            else "failed" if error or any(t["status"] != "succeeded" for t in tasks)
            else "no_data" if not facts else "partial" if result.get("gaps")
            else "completed"
        )
        steps.append({
            "id": step.id, "status": status,
            "fact_count": len(facts), "task_count": len(tasks),
            "org_count": len({f["org_code"] for f in facts}),
            "actual_dates": sorted({f["date"] for f in facts}),
            "gaps": list(dict.fromkeys(result.get("gaps", []))),
            **({"error_code": error} if error and status != "skipped_no_data" else {}),
        })
    evidence["workflow_execution"] = {"steps": steps}


def workflow_fact_answer(evidence):
    """从不可变证据编译注册路线正文，不依赖模型重写排名及原因边界。"""
    brief = evidence.get("workflow_brief")
    if not brief:
        return None
    atoms = evidence["evidence_items"]
    facts = {a.get("fact_id"): a for a in atoms if a.get("type") == "fact"}
    refs, paragraphs = set(), []
    for atom in atoms:
        if atom.get("type") == "scope":
            paragraphs.append(atom["display"])
            refs.add(atom["ref"])
    if brief["ranking"]:
        coverage = brief["coverage"]
        order = next(s["position"] for s in evidence["plan"]["steps"] if s["id"] == "rank")
        dates = sorted({item["date"] for item in brief["ranking"]})
        paragraphs.append((
            "本次仅确认一家机构，无法据此比较机构之间的净利润高低；"
            "以下保留该机构已查询到的盈利信息。"
        ) if coverage["requested_org_count"] < 2 else (
            f"按{'、'.join(dates)}净利润金额{'从高到低' if order == 'top' else '从低到高'}比较，"
            f"本次目标范围{coverage['requested_org_count']}家机构，"
            f"其中{coverage['valid_org_count']}家取得同日有效记录；其余机构未纳入本次排序。"
        ) if len(dates) == 1 else (
            f"目标范围{coverage['requested_org_count']}家机构，以下分别按各观测日的有效净利润金额"
            f"{'从高到低' if order == 'top' else '从低到高'}排序，不合并跨日期结果。"
        ))
        positions = {}
        for observation in brief["ranking"]:
            atom = next((facts[r] for r in observation["fact_refs"] if r in facts), None)
            if atom:
                day = observation["date"]
                positions[day] = positions.get(day, 0) + 1
                refs.update([atom["ref"], observation["ref"]])
                prefix = (f"{day}（参与{len(set(observation['comparison_fact_refs']))}家）"
                          if len(dates) > 1 else "")
                text = (f"{positions[day]}. {prefix}**{atom['org_name']}**："
                        f"净利润{atom['display']}。")
                supplement = list({a["fact_id"]: a for a in facts.values()
                                   if a.get("org_code") == atom["org_code"]
                                   and a.get("date") == atom["date"]
                                   and a.get("metric_code") != atom["metric_code"]}.values())
                details = []
                for item in supplement:
                    label, display = item["metric_name"], item["display"]
                    if label.startswith("净利润") and label.endswith(("较上月", "较同期")):
                        value = Decimal(item["value"])
                        direction = "增加" if value > 0 else "减少" if value < 0 else "持平"
                        details.append(
                            label[-3:] + direction + (display.lstrip("-") if value else "")
                        )
                    else:
                        details.append(f"{label}{display}")
                    refs.add(item["ref"])
                paragraphs.append(text + (" " + "；".join(details) + "。" if details else ""))
        comparisons = brief["comparisons"][:6]
        for item in comparisons:
            paragraphs.append(item["text"])
            refs.add(item["ref"])
        if len(evidence["plan"]["requirements"]) > 1:
            paragraphs.append(
                "以上能够确认利润水平及已取得的比较信息。现有收入、成本等指标"
                "尚不足以证明具体业务原因，也不能仅凭利润金额排名判断盈利效率或整体经营好坏。"
            )
    elif brief["outcome"] == "no_data":
        start, end = evidence.get("requested_start"), evidence.get("requested_end")
        window = (start if start == end else f"{start}至{end}") if start else "已检查的近期覆盖范围"
        paragraphs.append(
            f"本次在{window}未取得可供机构间比较的有效净利润记录，暂不能确定排名。"
            "缺失不等于零，不能据此判断哪家机构盈利较差。"
        )
        paragraphs.append("已保留请求的机构和时间条件；可以改查其他统计期，当前未擅自替换日期。")
    else:
        paragraphs.append("本次排名查询服务暂时不可用，尚不能给出可靠排序；这不代表数据库没有数据。")
    refs.update(a["ref"] for a in atoms if a.get("type") == "gap")
    return "\n\n".join(paragraphs), sorted(refs)
