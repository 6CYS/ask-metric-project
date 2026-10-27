"""标准任务召回与服务端计划注册表，未适用的任务继续交给通用智能体。"""

import json
import math
import re
from pathlib import Path

from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.domain.analysis_methods import AnalysisPlan
from ask_metric.domain.organization_scope import cohort_source_expressions

WORKFLOW_ID = "profitability_ranking_v1"


def load_workflows(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def route_focus(question: str) -> str:
    """仅压缩召回文本；完整原句始终用于后续机构、日期和排除条件校验。"""
    clauses = re.split(r"[。；;\n]", question)
    focused = [c.strip() for c in clauses if re.search(r"收益|盈利|利润|赚钱", c)]
    text = "；".join(focused or clauses)[-2400:]
    # 路线按任务类型召回，具体日期和名次数量仍从完整原句解析，不能支配相似度。
    text = re.sub(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", "", text)
    text = re.sub(r"(?:\d{4}年)?[一二三四五六七八九十\d]{1,3}月"
                  r"(?:[一二三四五六七八九十\d]{1,3}[日号]|末|底)?", "", text)
    return re.sub(r"(前|后|倒数)\s*[零一二三四五六七八九十百两\d]+\s*(家|名|个)",
                  r"\1N\2", text)


def _rank_count(token):
    if token.isdigit():
        return int(token)
    digits = dict(zip("一二三四五六七八九", range(1, 10), strict=True))
    if token in digits or token == "两":
        return digits.get(token, 2)
    if token in {"一百", "百"}:
        return 100
    tens = re.fullmatch(r"([二三四五六七八九]?)十([一二三四五六七八九]?)", token)
    return (digits.get(tens[1], 1) * 10 + digits.get(tens[2], 0)) if tens else 0


def pilot_parameters(question: str):
    # 适用性门禁与向量相似度分开：相关不等于能够执行，复合任务不能被试点吞掉。
    if not re.search(r"收益|盈利|利润|赚钱", question):
        return None
    if re.search(
        r"预测|预计|明年|未来|收益率|利润率|净息差|成本收入比|降幅|跌幅|下降最多|"
        r"同比最|环比最|营业收入排名|收入最高|收入最低|利润总额|营业利润|盈利质量|"
        r"不要.{0,8}(?:利润|收益|盈利)|不查.{0,8}(?:利润|收益)|"
        r"存款|贷款|不良|资本|全部记录|每天|逐日|每个月|逐月|"
        r"排除|剔除|去掉|不要|不查|只(?:看|查)|仅|下辖|下属", question,
    ):
        return None
    if not re.search(r"哪|谁|排名|排行|最低|最高|最差|最好|最少|最多|前|后|倒数", question):
        return None
    high = bool(re.search(
        r"最高|最好|最多|最强|前\s*[一二三四五六七八九十百两\d]+|赚.*最多", question
    ))
    low = bool(re.search(r"最低|最差|最少|不好|较弱|最弱|后\s*[一二三四五六七八九十\d]+", question))
    if high and low:
        return None
    number = re.search(
        r"(?:前|后|倒数)\s*([零一二三四五六七八九十百两\d]+)\s*(?:名|家|个)?", question
    )
    count = _rank_count(number[1]) if number else 1
    if not 1 <= count <= 100:
        return None
    return {"position": "top" if high else "bottom", "top_n": count,
            "explain": bool(re.search(r"为什么|原因|分析|解释|不好|最差|较弱", question))}


def workflow_admission(question):
    expressions = cohort_source_expressions(question)
    numbered = None
    if not expressions:
        numbered = re.search(r"(?<![\d前后数])([1-9]\d{0,2})\s*家(?:机构|农商行|银行)", question)
        if not numbered:
            return {}
        expressions = [(numbered[0], numbered.start())]
    if len(expressions) != 1:
        return None
    text, index = expressions[0]
    prefix = re.split(r"[，,。；;\n]", question[:index])[-1]
    prefix = route_focus(prefix)
    prefix = re.sub(
        r"请|帮我|帮忙|我想|想要|查询|查一下|查|分析|比较|近期|最近|在|的|一下|看看|看",
        "", prefix,
    )
    # 地域、子集及未知限定交给通用流程，不能只截取“各家”便扩大到整个授权集合。
    if prefix.strip():
        return None
    return {"organization_expression": text,
            **({"expected_org_count": int(numbered[1])} if numbered else {})}


def validate_workflow_admission(admission, *, actor, organizations, permissions, hierarchy):
    """数量须对应完整正式集合；任意 N 家或未明确的子集不能被扩大为全集。"""
    if "expected_org_count" not in admission:
        return admission
    resolved = resolve_query_scope(
        scope={"kind": "authorized_cohort", "cohort": "rural_commercial_banks"},
        actor=actor, organizations=organizations, permissions=permissions, hierarchy=hierarchy,
    )
    codes = set(resolved["codes"])
    snapshot = hierarchy.strict_snapshot()
    root = snapshot.validated_root()
    counts = {len(codes)}
    # 有些用户按目录总数包含省级汇总；只有全目录恰为完整法人行集合加根节点才接受。
    if {item.code for item in organizations} == codes | {root}:
        counts.add(len(organizations))
    if admission["expected_org_count"] not in counts:
        return None
    return {**admission, "numbered_cohort": True}


def retrieve_workflow(question, *, index, model, catalog, min_score=0.5, margin=0.04):
    parameters = pilot_parameters(question)
    if not parameters:
        return {"status": "fallback", "reason": "outside_pilot"}
    admission = workflow_admission(question)
    if admission is None:
        return {"status": "fallback", "reason": "unsupported_scope"}
    focus = route_focus(question)
    candidates = index.search(model=model, documents=catalog["documents"],
                              version=catalog["version"], query=focus)
    if not candidates:
        return {"status": "fallback", "reason": "no_candidate"}
    scores = model.rerank(query=focus, documents=[d["text"] for d in candidates],
                          top_n=len(candidates))
    ranked, seen = [], set()
    for item in scores:
        i, score = item.get("index"), item.get("relevance_score")
        if (type(i) is not int or not 0 <= i < len(candidates) or i in seen
                or isinstance(score, bool) or not isinstance(score, (int, float))
                or not math.isfinite(score)):
            return {"status": "fallback", "reason": "invalid_rerank"}
        seen.add(i)
        ranked.append((score, candidates[i]))
    if len(seen) != len(candidates):
        return {"status": "fallback", "reason": "incomplete_rerank"}
    ranked.sort(key=lambda entry: entry[0], reverse=True)
    score, best = ranked[0]
    other = max((s for s, d in ranked if d["workflow_id"] != best["workflow_id"]), default=0)
    if best["workflow_id"] != WORKFLOW_ID or score < min_score or score - other < margin:
        return {"status": "fallback", "reason": "low_confidence"}
    return {"status": "matched", "workflow_id": WORKFLOW_ID,
            "version": catalog["version"], "name": catalog[WORKFLOW_ID]["name"],
            "parameters": parameters, "admission": admission,
            "retrieval": {
                "strategy": "embedding_milvus_rerank",
                "matched_document": {"id": best["id"], "text": best["text"]},
                "rerank_score": score, "other_class_score": other,
                "min_score": min_score, "min_margin": margin,
            },
            "basis": "按净利润金额比较高低，不等同于综合经营好坏"}


def profitability_plan(question, *, semantics, catalog, parameters):
    """目录按正式名称唯一绑定，不把近似召回直接当作正式指标身份。"""
    metrics = {}
    for role, names in catalog[WORKFLOW_ID]["metrics"].items():
        for name in names:
            matches = [item for item in semantics.items.values() if item.name == name
                       and item.unit in {"元", "万元", "亿元"}]
            if len(matches) == 1:
                descriptor = semantics.descriptor(matches[0].code)
                metrics[role] = {**descriptor,
                                 "binding_ref": semantics.binding(descriptor, name)}
                break
            if len(matches) > 1:
                break
    if "net_profit" not in metrics:
        return None
    main = metrics["net_profit"]
    requirements = [{"id": "rank", "question": "所选机构中净利润金额的排序及实际覆盖"}]
    steps = [{"id": "rank", "method": "ranking", "metric_refs": [main["binding_ref"]],
              "answers": ["rank"], "rationale": "共同观测日期内按实际有效值排序，不补零",
              "position": parameters["position"], "top_n": parameters["top_n"]}]
    if parameters["explain"]:
        requirements.append({"id": "explain", "question": "入选机构盈利变化及原因证据的边界"})
        # 首批排名结果直接绑定补查范围，模型不再抄写机构名称，也不能切换分析对象。
        peers = [metrics[k]["binding_ref"] for k in
                 ["profit_mom", "profit_yoy", "revenue", "operating_profit", "total_profit", "cost"]
                 if k in metrics]
        historical = [basis for basis, role in [("mom", "profit_mom"), ("yoy", "profit_yoy")]
                      if role not in metrics]
        if historical:
            steps.append({"id": "selected_history", "method": "compare",
                          "metric_refs": [main["binding_ref"]], "answers": ["explain"],
                          "comparisons": historical, "depends_on": ["rank"],
                          "organization_from_step": "rank",
                          "rationale": "目录无正式比较时核对入选机构历史取值，不推定为单月利润"})
        if peers:
            steps.append({"id": "selected_drivers", "method": "observe", "metric_refs": peers,
                          "answers": ["explain"], "depends_on": ["rank"],
                          "organization_from_step": "rank",
                          "rationale": "定向核对利润正式比较及收入成本信息，仅披露有证据的关联"})
    plan = AnalysisPlan.model_validate({
        "workflow_id": WORKFLOW_ID, "objective": question[:500],
        "scope_notice": ("按净利润金额排名；补查仅涉及排名入选机构，"
                         "原因需收入成本证据，不作综合经营优劣评价。"),
        "requirements": requirements, "steps": steps,
    })
    return {"plan": plan.model_dump(mode="json", exclude_none=True),
            "metrics": list(metrics.values())}
