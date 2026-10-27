import type {AskMetricRequestContext} from "../requestContext.js";
import type {AnalysisPlan} from "./contracts.js";
import {BusinessInputError} from "../business-context/inputError.js";
import type {AgentMessage} from "@earendil-works/pi-agent-core";

/** 主题是本轮正式目录推荐的辅助方法，不从历史主题或用户关键词推定。 */
export function analysisTopicHints(messages: readonly AgentMessage[]): Array<"loan" | "deposit"> {
  const topics = new Set<"loan" | "deposit">();
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  for (const message of messages.slice(start + 1)) {
    if (message.role !== "toolResult" || message.isError || message.toolName !== "analysis_catalog") continue;
    const receipt = message.details as {kind?: string; status?: string; topic_hints?: unknown} | undefined;
    if (receipt?.kind !== "analysis_catalog" || receipt.status !== "succeeded" || !Array.isArray(receipt.topic_hints)) continue;
    for (const hint of receipt.topic_hints) {
      const topic = hint && typeof hint === "object" ? (hint as {topic?: unknown}).topic : undefined;
      if (topic === "loan" || topic === "deposit") topics.add(topic);
    }
  }
  return [...topics];
}

// 短引用限定当前用户回合；恢复时只从原生工具回执还原，后端仍复核签名与版本。
const registries = new WeakMap<AskMetricRequestContext, Map<string, string>>();
export const analysisDiscoveryStarted = (request: AskMetricRequestContext) => registries.has(request);
const rounds = new WeakMap<AskMetricRequestContext, number>();
export interface QueryRecoveryCatalogSource {
  operation_id: string; plan_ref: string; step_id: string; target_ref: string; original_message: string; metric_expression: string;
}
export interface AnalysisCandidate {code: string; name: string; binding_ref: string; match_type?: string; base_name?: string; value_basis?: string; unit?: string;
  query_recovery?: QueryRecoveryCatalogSource; analysis_hint?: {
  topic: string; topic_name: string; section: string; metric_id: string; comparison?: string; comparison_role?: string; default_sections: string[];
}}
const candidates = new WeakMap<AskMetricRequestContext, Map<string, AnalysisCandidate>>();
const plans = new WeakMap<AskMetricRequestContext, AnalysisPlan[]>();
/** 执行适配器克隆请求以绑定 Frame 时，仍共享同一回合的目录与短引用状态。 */
export function inheritAnalysisState(source: AskMetricRequestContext, target: AskMetricRequestContext) {
  const bindings = registries.get(source), discovered = candidates.get(source), selected = plans.get(source);
  if (bindings) registries.set(target, bindings);
  if (discovered) candidates.set(target, discovered);
  if (selected) plans.set(target, selected);
  rounds.set(target, analysisDiscoveryRounds(source));
}
export const analysisCandidates = (request: AskMetricRequestContext) => [...(candidates.get(request)?.values() ?? [])];
export function registerAnalysisPlan(request: AskMetricRequestContext, plan: AnalysisPlan) {
  const previous = plans.get(request) ?? [];
  if (!previous.some(item => JSON.stringify(item) === JSON.stringify(plan))) plans.set(request, [...previous, plan]);
}
export function analysisBudget(request: AskMetricRequestContext) {
  const topics = new Set(analysisCandidates(request).flatMap(item => item.analysis_hint ? [item.analysis_hint.topic] : []));
  const questions = new Set((plans.get(request) ?? []).flatMap(plan => plan.requirements.map(item => item.question)));
  const breadth = Math.max(topics.size, Math.ceil(questions.size / 2), 1);
  return {discovery: Math.min(10, 4 + (breadth - 1) * 2), executions: Math.min(6, 3 + breadth - 1),
    tools: Math.min(36, 24 + (breadth - 1) * 4)};
}
export const analysisDiscoveryRounds = (request: AskMetricRequestContext) => rounds.get(request) ?? 0;
export const registerAnalysisDiscovery = (request: AskMetricRequestContext) => {
  const count = analysisDiscoveryRounds(request) + 1;
  rounds.set(request, count);
  return count;
};
export const catalogBindingState = (request: AskMetricRequestContext) => Object.fromEntries(registries.get(request) ?? []);
export function restoreAnalysisDiscovery(request: AskMetricRequestContext, receipts: unknown[]) {
  for (const raw of receipts) {
    const receipt = raw as {kind?: string; status?: string; plan?: AnalysisPlan; candidate_map?: AnalysisCandidate[]};
    if (receipt?.status !== "succeeded" && !(receipt?.kind === "business_topic_read" && receipt?.status === "ok")) continue;
    if (receipt.kind === "analysis_evidence" && receipt.plan) registerAnalysisPlan(request, receipt.plan);
    if (["analysis_catalog", "analysis_evidence", "business_topic_read"].includes(receipt.kind ?? "") && receipt.candidate_map) {
      const registry = candidates.get(request) ?? new Map<string, AnalysisCandidate>();
      for (const item of receipt.candidate_map) if (item.match_type !== "semantic" && item.binding_ref?.trim()) registry.set(item.code, item);
      candidates.set(request, registry);
    }
  }
  const bindingReceipts = receipts.filter((item): item is {kind: string; status: string; binding_map?: Record<string, string>; candidate_map?: AnalysisCandidate[]} =>
    !!item && typeof item === "object" && (["analysis_catalog", "analysis_evidence"].includes((item as {kind: string}).kind)
    && (item as {status?: string}).status === "succeeded"
    || (item as {kind: string}).kind === "business_topic_read" && (item as {status?: string}).status === "ok"));
  if (!bindingReceipts.length) return;
  const registry = registries.get(request) ?? new Map<string, string>();
  for (const catalog of bindingReceipts) {
    const suggestions = new Set((catalog.candidate_map ?? []).filter(item => item.match_type === "semantic")
      .flatMap(item => [`code:${item.code}`, item.binding_ref]));
    for (const [alias, signed] of Object.entries(catalog.binding_map ?? {})) {
      if (!suggestions.has(alias) && /^(?:k\d+|code:.+)$/.test(alias) && typeof signed === "string" && signed.trim()) registry.set(alias, signed);
    }
  }
  registries.set(request, registry);
  rounds.set(request, Math.max(analysisDiscoveryRounds(request), bindingReceipts.filter(item => item.kind === "analysis_catalog").length));
}
export function catalogBindingView(request: AskMetricRequestContext, value: unknown, recovery?: QueryRecoveryCatalogSource): unknown {
  let registry = registries.get(request);
  if (!registry) {registry = new Map(); registries.set(request, registry);}
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    const suggestion = "match_type" in item && item.match_type === "semantic";
    const descriptor = !suggestion && "binding_ref" in item && typeof item.binding_ref === "string" && !!item.binding_ref.trim();
    if (descriptor && "code" in item && typeof item.code === "string" && typeof item.binding_ref === "string")
      registry!.set(`code:${item.code}`, item.binding_ref);
    const modelKeys = new Set(["binding_ref", "code", "name", "unit", "aliases", "description", "explanation", "value_encoding", "frequency", "quantity_kind", "business_direction", "methods", "match_type", "semantic_source", "semantic_status", "limitations", "analysis_hint", "value_basis", "base_name"]);
    const output = Object.fromEntries(Object.entries(item).filter(([key, field]) =>
      (key !== "binding_ref" || descriptor) && (!descriptor || modelKeys.has(key) && field != null)).map(([key, field]) => {
      if (key !== "binding_ref" || typeof field !== "string") return [key, visit(field)];
      let alias = [...registry!.entries()].find(([key, signed]) => /^k\d+$/.test(key) && signed === field)?.[0];
      if (!alias) {alias = `k${[...registry!.keys()].filter(key => /^k\d+$/.test(key)).length + 1}`; registry!.set(alias, field);}
      return [key, alias];
    }));
    if (descriptor && typeof output.code === "string" && typeof output.name === "string") {
      const registry = candidates.get(request) ?? new Map<string, AnalysisCandidate>();
      registry.set(output.code, {...output, ...(recovery ? {query_recovery: recovery} : {})} as unknown as AnalysisCandidate);
      candidates.set(request, registry);
    }
    return output;
  };
  return visit(value);
}

export function resolveCatalogBindings(request: AskMetricRequestContext, plan: AnalysisPlan): AnalysisPlan {
  return {...plan, steps: plan.steps.map(step => ({...step, metric_refs: step.metric_refs.map(ref => {
    // 已在本轮正式发现的完整编码可无歧义还原；不是重新猜测指标，也不放行任意编码。
    const discovered = registries.get(request)?.get(`code:${ref}`);
    if (discovered) return discovered;
    if (!/^k\d+$/.test(ref)) {
      if (/^ORG_/.test(ref)) throw new BusinessInputError("ANALYSIS_BINDING_INVALID", "plan",
        `metric_refs中的${ref}是指标编码，不是绑定引用。仅使用本轮analysis_catalog返回的k引用；尚未发现的指标先检索，预算不足时保留为明确缺口，不能反复提交编码。`);
      return ref; // 持久 Frame 中的正式签名保持兼容。
    }
    const signed = registries.get(request)?.get(ref);
    if (!signed) throw new BusinessInputError("ANALYSIS_BINDING_INVALID", "plan", "指标短引用不属于本轮目录结果，请重新analysis_catalog检索并使用其binding_ref，不能自行编造引用。");
    return signed;
  })}))};
}
