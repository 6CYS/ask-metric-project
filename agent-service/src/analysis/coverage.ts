import type {AskMetricRequestContext} from "../requestContext.js";
import {analysisCandidates} from "./bindings.js";
import type {AnalysisEvidence} from "./tools.js";

/** 目录方向与正式比较入口仅供选择，不构成必查清单，也不推断指标关系。 */
export function analysisPlanningReview(request: AskMetricRequestContext) {
  const candidates = analysisCandidates(request);
  return analysisCoverageReview(request, []).map(item => ({...item,
    comparisons: item.candidates.flatMap(base => {
      const hint = candidates.find(candidate => candidate.binding_ref === base.binding_ref)?.analysis_hint;
      if (!hint || hint.comparison) return [];
      return candidates.filter(candidate => candidate.analysis_hint?.topic === hint.topic
        && candidate.analysis_hint.metric_id === hint.metric_id
        && ["mom", "yoy"].includes(candidate.analysis_hint.comparison ?? "")
        && candidate.analysis_hint.comparison_role === "difference")
        .map(candidate => ({binding_ref: candidate.binding_ref, name: candidate.name}));
    }),
  }));
}

/** 检查已经发现的正式分析方向是否被尝试；不把指标分组当作分解或因果关系。 */
export function analysisCoverageReview(request: AskMetricRequestContext, sources: AnalysisEvidence[]) {
  if (!/情况|概况|概览|表现|怎么样|经营分析/u.test(request.originalMessage)) return [];
  const candidates = analysisCandidates(request);
  const attempted = new Set(sources.flatMap(source => source.metric_descriptors.map(item => item.code)));
  const queried = candidates.filter(item => attempted.has(item.code));
  const topics = new Map(candidates.flatMap(item => item.analysis_hint ? [[item.analysis_hint.topic, item.analysis_hint] as const] : []));
  const labels: Record<string, string> = {scale: "规模水平", growth: "可比变化", structure: "业务构成", quality: "质量"};
  const focus = !/整体|总体|经营|存贷款|存贷|以及|和|及/u.test(request.originalMessage)
    ? /质量|不良/u.test(request.originalMessage) ? "quality" : /结构|构成|占比/u.test(request.originalMessage) ? "structure"
      : /增长|增速|变化/u.test(request.originalMessage) ? "growth" : undefined : undefined;
  const review = [...topics.values()].flatMap(topic => (focus ? [focus] : topic.default_sections).flatMap(section => {
    const root = candidates.find(item => item.analysis_hint?.topic === topic.topic && item.analysis_hint.section === "scale");
    const belongs = (item: typeof candidates[number]) => item.analysis_hint?.topic === topic.topic && item.analysis_hint.section === section
      && (section !== "growth" || !root || item.analysis_hint.metric_id === root.analysis_hint?.metric_id);
    const available = candidates.filter(belongs);
    const covered = queried.filter(belongs);
    const compared = section === "growth" && sources.some(source => source.plan.steps.some(step => step.method === "compare"
      && step.metric_refs.some(ref => source.metric_descriptors.some(metric => metric.binding_ref === ref
        && candidates.some(item => item.code === metric.code && item.analysis_hint?.topic === topic.topic
          && (!root || item.code === root.code))))));
    const required = section === "structure" || section === "quality" ? Math.min(2, Math.max(1, available.length)) : 1;
    if (compared || covered.length >= required) return [];
    const remaining = available.filter(item => !attempted.has(item.code)).slice(0, section === "structure" || section === "quality" ? 2 : 1);
    return [{topic: topic.topic, aspect: labels[section] ?? section,
      message: `${topic.topic_name}尚未检查${labels[section] ?? section}。`,
      candidates: remaining.map(item => ({binding_ref: item.binding_ref, name: item.name}))}];
  }));
  // 当前水平不代表变化已被分析。比较入口来自正式映射，已尝试但缺数也不反复查询。
  for (const topic of topics.values()) {
    for (const section of ["structure", "quality"]) {
      if (focus && focus !== section || !focus && !topic.default_sections.includes(section)) continue;
      const bases = queried.filter(item => item.analysis_hint?.topic === topic.topic && item.analysis_hint.section === section
        && !item.analysis_hint.comparison && sources.some(source => source.evidence_items?.some(atom =>
          atom.type === "fact" && atom.metric_code === item.code))).slice(0, 2);
      for (const base of bases) {
        const remaining = candidates.filter(item => item.analysis_hint?.topic === topic.topic
          && item.analysis_hint.metric_id === base.analysis_hint!.metric_id
          && ["mom", "yoy"].includes(item.analysis_hint.comparison ?? "")
          && item.analysis_hint.comparison_role === "difference" && !attempted.has(item.code)
          && !sources.some(source => source.plan.steps.some(step => step.method === "compare"
            && step.comparisons?.includes(item.analysis_hint!.comparison as "mom" | "yoy")
            && step.metric_refs.some(ref => source.metric_descriptors.some(metric => metric.binding_ref === ref && metric.code === base.code)))));
        if (remaining.length) review.push({topic: topic.topic, aspect: `${labels[section]}变化`,
          message: `已取得${base.name}现状，尚未检查已发现的较上月/较同期比较；不能将未查询写成无数据。`,
          candidates: remaining.map(item => ({binding_ref: item.binding_ref, name: item.name}))});
      }
    }
  }
  return review;
}
