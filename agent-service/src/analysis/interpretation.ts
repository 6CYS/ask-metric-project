import type {EvidenceReference} from "../answerEvidence.js";
import {analysisCandidates, type AnalysisCandidate} from "./bindings.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {AnalysisEvidence} from "./tools.js";

/** 依据实际回执提示分析线索；不生成业务归因、不计算未经审核的占比和贡献。 */
export function analysisInterpretationBrief(request: AskMetricRequestContext, evidence: EvidenceReference[]) {
  const candidates = new Map(analysisCandidates(request).map(item => [item.code, item]));
  const comparisonHint = (candidate: AnalysisCandidate | undefined) => {
    if (candidate?.analysis_hint) return candidate.analysis_hint;
    // 只识别正式目录明确的比较标签，缺字段时接受完整名称的精确末尾；不解析编码、增幅或排名，
    // 不由名称推导公式、会计口径、可加总关系或好坏，只提示已取比较量的正负分化。
    const label = candidate?.name.match(/^(.+)(较上月|较同期|较年初)$/u);
    const period = ({较上月: "mom", 较同期: "yoy", 较年初: "ytd"} as Record<string, string>)[candidate?.value_basis ?? label?.[2] ?? ""];
    const base = candidate?.base_name ?? label?.[1];
    return base && period ? {topic: `catalog:${base}:${candidate?.unit ?? ""}`,
      topic_name: base, metric_id: base, section: "growth", comparison: period,
      comparison_role: "difference", default_sections: []} : undefined;
  };
  const facts = evidence.flatMap(source => (source.evidence as AnalysisEvidence).evidence_items
    ?.filter(atom => atom.type !== "observation").flatMap((atom, index) => {
      const hint = atom.metric_code ? comparisonHint(candidates.get(atom.metric_code)) : undefined;
      if (atom.type !== "fact" || !hint?.comparison || hint.comparison_role !== "difference"
        || !atom.date || !atom.org_code
        || atom.value == null || !/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(String(atom.value))) return [];
      // 这里只判正负，不转成浮点数计算，原始精度与显示仍由后端负责。
      const nonzero = /[1-9]/u.test(String(atom.value).split(/[eE]/u)[0]!);
      const direction = nonzero ? String(atom.value).startsWith("-") ? "减少" : "增加" : "持平";
      return [{ref: `${source.ref}.v${index + 1}`, name: atom.metric_name ?? candidates.get(atom.metric_code!)!.name,
        date: atom.date, org: atom.org_code, hint, direction}];
    }) ?? []);
  const signals: Array<{kind: string; question: string; evidence_refs: string[]; boundary: string;
    check_metrics?: Array<{binding_ref: string; name: string}>}> = [];
  const groups = new Map<string, typeof facts>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.org, fact.date, fact.hint.topic, fact.hint.comparison]);
    groups.set(key, [...groups.get(key) ?? [], fact]);
  }
  for (const group of groups.values()) {
    if (!group.some(item => item.direction === "增加") || !group.some(item => item.direction === "减少")) continue;
    signals.push({kind: "same_period_divergence",
      question: `${group[0]!.hint.topic_name}在同一比较期间出现增减分化：${group.map(item => `${item.name}${item.direction}`).join("；")}。哪些业务类别的变化方向不同，整体增加是否与部分指标减少并存？`,
      evidence_refs: [...new Set(group.map(item => item.ref))],
      boundary: "只能描述实际指标的分化，指标分组不证明可加总组成或贡献；不从余额推断投放、还款或客户行为。"});
  }
  const families = new Map<string, typeof facts>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.org, fact.date, fact.hint.topic, fact.hint.metric_id]);
    families.set(key, [...families.get(key) ?? [], fact]);
  }
  for (const group of families.values()) {
    if (new Set(group.map(item => item.hint.comparison)).size < 2
      || !group.some(item => item.direction === "增加") || !group.some(item => item.direction === "减少")) continue;
    signals.push({kind: "baseline_divergence",
      question: `${group.map(item => `${item.name}${item.direction}`).join("；")}。同一指标在不同基期下为何呈现不同方向，分别能说明什么？`,
      evidence_refs: [...new Set(group.map(item => item.ref))],
      boundary: "先解释比较基期不同，不把不同跨度的增量大小解释为加速、放缓或连续趋势；未取得业务动因时不回答实际原因。"});
  }
  // 有总量比较但只有分类现值时，现值不能解释分类变化；给出由事实触发的疑问而非补齐清单。
  const levels = evidence.flatMap(source => (source.evidence as AnalysisEvidence).evidence_items
    ?.filter(atom => atom.type !== "observation").flatMap((atom, index) => {
      const hint = atom.metric_code ? candidates.get(atom.metric_code)?.analysis_hint : undefined;
      return atom.type === "fact" && atom.date && atom.org_code && hint?.section === "structure" && !hint.comparison
        ? [{ref: `${source.ref}.v${index + 1}`, name: atom.metric_name ?? candidates.get(atom.metric_code!)!.name, date: atom.date, org: atom.org_code, hint}] : [];
    }) ?? []);
  for (const group of groups.values()) {
    const unresolved = levels.filter(level => level.org === group[0]!.org && level.date === group[0]!.date
      && level.hint.topic === group[0]!.hint.topic && !group.some(fact => fact.hint.metric_id === level.hint.metric_id));
    if (!unresolved.length) continue;
    signals.push({kind: "unverified_category_change",
      question: `已观察到${group.map(item => `${item.name}${item.direction}`).join("；")}，但${unresolved.map(item => item.name).join("、")}目前只有水平值。相关类别在同一比较期间是否同向变化，还是存在分化？`,
      evidence_refs: [...new Set([...group.map(item => item.ref), ...unresolved.map(item => item.ref)])],
      check_metrics: [...candidates.values()].filter(candidate => unresolved.some(level =>
        candidate.analysis_hint?.topic === level.hint.topic && candidate.analysis_hint.metric_id === level.hint.metric_id)
        && candidate.analysis_hint?.comparison === group[0]!.hint.comparison
        && candidate.analysis_hint?.comparison_role === "difference")
        .slice(0, 4).map(candidate => ({binding_ref: candidate.binding_ref, name: candidate.name})),
      boundary: "这只是尚未验证的分类变化问题；按需要读取相应同期间正式比较。当前余额大小不能证明变化方向、增长贡献或原因。"});
  }
  if (/怎么样|如何|表现|经营|变化|增长|趋势|情况/u.test(request.originalMessage)) {
    const attempted = new Set(evidence.flatMap(source => (source.evidence as AnalysisEvidence).metric_descriptors?.map(item => item.code) ?? []));
    for (const source of evidence) {
      const items = (source.evidence as AnalysisEvidence).evidence_items?.filter(atom => atom.type !== "observation") ?? [];
      items.forEach((atom, index) => {
        const candidate = atom.metric_code ? candidates.get(atom.metric_code) : undefined;
        if (atom.type !== "fact" || !atom.date || !atom.org_code || !candidate || atom.value == null
          || !/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(String(atom.value))
          || comparisonHint(candidate)?.comparison || candidate.analysis_hint?.section === "structure") return;
        if (evidence.some(prior => {
          const checked = prior.evidence as AnalysisEvidence;
          return checked.plan.steps.some(step => step.method === "compare" && step.comparisons?.some(period => ["mom", "yoy"].includes(period))
            && step.metric_refs.some(ref => ref === candidate.binding_ref || checked.metric_descriptors.some(metric =>
              metric.binding_ref === ref && metric.code === candidate.code)));
        })) return;
        const base = candidate.base_name ?? candidate.name.match(/^(.+)当日数$/u)?.[1];
        const comparisons = [...candidates.values()].filter(item => {
          const hint = comparisonHint(item);
          const sameFamily = candidate.analysis_hint
            ? hint?.topic === candidate.analysis_hint.topic && hint.metric_id === candidate.analysis_hint.metric_id
            : base && hint?.metric_id === base && item.unit === candidate.unit;
          return sameFamily && ["mom", "yoy"].includes(hint?.comparison ?? "")
            && hint?.comparison_role === "difference";
        });
        if (!comparisons.length || comparisons.some(item => attempted.has(item.code))) return;
        signals.push({kind: "snapshot_without_comparison",
          question: `已取得${candidate.name}的时点值，但它是否与比较基期同向变化尚未核对。较上月与较同期的方向是否一致，当前水平判断是否需要限定？`,
          evidence_refs: [`${source.ref}.v${index + 1}`],
          check_metrics: comparisons.slice(0, 2).map(item => ({binding_ref: item.binding_ref, name: item.name})),
          boundary: "当前值不能证明变化方向；这是由已取事实触发的待核验问题，非必查栏目。只使用正式比较，不能推断会计口径、增速或业务原因。"});
      });
    }
  }
  const plans = evidence.filter(source => source.evidence.kind === "analysis_evidence")
    .map(source => (source.evidence as AnalysisEvidence).plan).filter(Boolean);
  const questions = (plans[0]?.requirements ?? []).map(question => {
    const related = plans.flatMap(plan => plan.requirements.filter(item => item.question === question.question));
    const hasSteps = plans.some(plan => plan.requirements.some(item => item.question === question.question
      && plan.steps.some(step => step.answers.includes(item.id))));
    return {id: question.id, question: question.question,
      status: hasSteps ? "evidence_collected" : related.some(item => item.gap_reason) ? "gap" : "pending",
      reason: hasSteps ? undefined : related.find(item => item.gap_reason)?.gap_reason ?? question.deferred_reason};
  });
  return {original_question: request.originalMessage, questions, signals: signals.slice(0, 10),
    completion_boundary: "evidence_collected只表示已经取证，不表示原业务问题已经回答。对照原问决定下一步；待查问题应继续取证或明确尚未完成，不能改写为数据不存在。先定位对象再解释原因时，下一批只调查真实结果选中的对象。",
    report_guidance: "围绕最有价值的发现自由成文：可以直接回答、按发现列要点或深入一个具体疑问，不按主题机械分章。先回答用户所问；补查必须由已有事实触发，说明要检验什么以及什么证据会改变判断。取得新证据后吸收、修正或限定原判断。正文只引用关键数字，完整数据留表格；开篇与展开各有信息，不重复抄表。没有审核关系不计算贡献或因果；推测写成具体待核验问题，证据不足时明确尚不能解释。",
    scope_boundary: "信号仅根据同机构、同观测日、同一正式比较期间产生；没有信号不等于没有分析价值。不同主题截至日可能不同，跨主题关联需要先核对日期与统计口径。"};
}
