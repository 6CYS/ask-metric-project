import type {AskMetricRequestContext} from "../requestContext.js";
import {BusinessInputError} from "../business-context/inputError.js";
import {hasInputEvidence} from "../business-context/inputEvidence.js";
import {metricMentions} from "../business-context/metricMentions.js";
import {analysisCandidates, catalogBindingState, resolveCatalogBindings} from "./bindings.js";
import type {AnalysisPlan, AnalysisPlanDiagnostic} from "./contracts.js";

export class AnalysisMetricCoverageError extends BusinessInputError {
  constructor(diagnostics: AnalysisPlanDiagnostic[]) {
    super("ANALYSIS_EXPLICIT_METRIC_MISSING", "plan", "计划尚未覆盖原文明确指标；按诊断检索缺失指标并修复对应步骤，机构和日期保持。",
      undefined, undefined, undefined, diagnostics);
  }
}

export function missingMetricDiagnostics(plan: AnalysisPlan, metrics: Array<{code: string; name: string; text?: string}>): AnalysisPlanDiagnostic[] {
  return metrics.map(metric => {
    const related = plan.requirements.filter(item => hasInputEvidence(item.question, metric.text ?? metric.name)
      || hasInputEvidence(item.question, metric.name));
    const ids = (related.length ? related : plan.requirements).map(item => item.id);
    return {code: "EXPLICIT_METRIC_MISSING", requirement_ids: ids,
      step_ids: plan.steps.filter(step => step.answers.some(id => ids.includes(id))).map(step => step.id),
      missing_metrics: [{code: metric.code, name: metric.name}], next_action: "discover_metrics"};
  });
}

/** 只补原文已唯一绑定、且本轮目录已签发的指标；未知指标进入定向恢复，不猜编码或公式。 */
export async function completeExplicitMetricCoverage(request: AskMetricRequestContext, plan: AnalysisPlan): Promise<AnalysisPlan> {
  const mentions = await metricMentions(request);
  if (mentions.status === "temporary_error") return plan; // 后端完整原文校验仍是最终边界。
  const registry = catalogBindingState(request), selected = new Set(resolveCatalogBindings(request, plan).steps.flatMap(step => step.metric_refs));
  const explicit = [...new Map(mentions.mentions.flatMap(mention => {
    const value = mention.resolution.value as {codes?: string[]; names?: string[]} | undefined;
    const contextCodes = mention.resolution.metadata?.context_codes;
    // 默认仍是一项回答义务；已选同概念口径时不再强行补回普通当日数。
    if (mention.resolution.metadata?.resolution_source === "business_default"
      && Array.isArray(contextCodes) && contextCodes.some(code => typeof code === "string"
        && selected.has(registry[`code:${code}`] ?? ""))) return [];
    return mention.resolution.status === "resolved" && value?.codes?.length === 1 && value.names?.length === 1
      && mention.resolution.metadata?.match !== "homophone"
      ? [[value.codes[0]!, {code: value.codes[0]!, name: value.names[0]!, text: mention.text}] as const] : [];
  })).values()];
  if (!explicit.length) return plan;
  const known = new Set(Object.values(registry));
  if ([...selected].some(ref => !known.has(ref))) return plan;
  const answered = new Set(plan.steps.flatMap(step => step.answers));
  const deferred = plan.requirements.filter(item => item.gap_reason?.trim() && !answered.has(item.id));
  const missing = explicit.filter(item => !selected.has(registry[`code:${item.code}`] ?? "")
    && !deferred.some(requirement => hasInputEvidence(requirement.question, item.text) || hasInputEvidence(requirement.question, item.name)));
  if (!missing.length) return plan;
  const candidates = analysisCandidates(request);
  const diagnostics = missingMetricDiagnostics(plan, missing);
  const additions: AnalysisPlan["steps"] = [];
  for (const [index, metric] of missing.entries()) {
    const candidate = candidates.find(item => item.code === metric.code);
    const answers = plan.requirements.filter(item => hasInputEvidence(item.question, metric.text)
      || hasInputEvidence(item.question, metric.name)).map(item => item.id);
    // 只补普通取值，不把补一个数值当成已完成排名、比较或归因；这类计划交由局部修复保留方法。
    const relatedSteps = plan.steps.filter(step => step.answers.some(id => answers.includes(id)));
    if (!candidate || !answers.length || !relatedSteps.length || relatedSteps.some(step => step.method !== "observe"))
      throw new AnalysisMetricCoverageError(diagnostics);
    let id = `explicit_metric_${index + 1}`;
    while (plan.steps.some(step => step.id === id) || additions.some(step => step.id === id)) id += "_";
    additions.push({id, method: "observe", metric_refs: [candidate.binding_ref], answers,
      rationale: "补齐用户原文明示且正式目录已确认的指标，保留其他已验证步骤。"});
  }
  if (plan.steps.length + additions.length > 12) throw new AnalysisMetricCoverageError(diagnostics);
  return {...plan, steps: [...plan.steps, ...additions]};
}
