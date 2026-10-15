import type {BasicQuerySpec} from "../backendClient.js";
import {metricCoverageSource} from "../business-context/adapters.js";
import type {SemanticOperation} from "./protocol.js";
import type {SemanticTarget} from "./store.js";

export type TransitionField = "metrics" | "organizations" | "comparison_organizations" | "time" | "selection" | "operation";
export interface SemanticChange {field: TransitionField; action: Exclude<SemanticOperation["action"], "copy" | "select" | "rank_all">; before: unknown; after: unknown}
export interface SemanticTransition {
  before: BasicQuerySpec; changes: SemanticChange[];
  source_semantic_receipt?: string; source_question?: string; bindings?: unknown[]; exclusions?: unknown[];
  field_sources?: Array<{field: TransitionField; before: BasicQuerySpec; source_semantic_receipt?: string; source_question?: string; bindings?: unknown[]; exclusions?: unknown[]}>;
}
const fields: TransitionField[] = ["metrics", "organizations", "comparison_organizations", "time", "selection", "operation"];
export const isTransitionField = (field: string): field is TransitionField => fields.includes(field as TransitionField);
/** 只投影真实规范身份，不把模型业务文本或提案状态当作before/after。 */
export function transitionValue(target: SemanticTarget, field: TransitionField): unknown {
  const value = target.fields[field]?.resolvedValue;
  return ["metrics", "organizations", "comparison_organizations"].includes(field)
    ? structuredClone((value as {codes?: string[]} | undefined)?.codes ?? []) : structuredClone(value ?? null);
}
export function completeQuery(target: SemanticTarget): BasicQuerySpec | undefined {
  if (["metrics", "organizations", "time", "selection", "operation"].some(name => target.fields[name]?.resolutionStatus !== "resolved" || target.pending[name])) return;
  if ((target.fields.operation?.resolvedValue as {kind?: string})?.kind === "rank_position"
    && (target.fields.comparison_organizations?.resolutionStatus !== "resolved" || target.pending.comparison_organizations)) return;
  const comparison = transitionValue(target, "comparison_organizations") as string[];
  const alternative = target.fields.time?.metadata?.timeAlternative as BasicQuerySpec["time_alternative"];
  return {metric_codes: transitionValue(target, "metrics") as string[], org_codes: transitionValue(target, "organizations") as string[],
    time: transitionValue(target, "time") as BasicQuerySpec["time"], selection: transitionValue(target, "selection") as BasicQuerySpec["selection"],
    operation: transitionValue(target, "operation") as NonNullable<BasicQuerySpec["operation"]>, ...(comparison.length ? {comparison_scope: {org_codes: comparison}} : {}),
    ...(alternative ? {time_alternative: structuredClone(alternative)} : {})};
}

/** 完整来源才进入跨轮状态对账；未完成目标仍保留原始义务及逐字段解析。 */
export function transitionBasis(target: SemanticTarget): SemanticTransition | undefined {
  const before = completeQuery(target);
  if (!before) return;
  const receipt = target.fields.metrics?.metadata?.semanticSelectionReceipt;
  const source = target.coverage ? metricCoverageSource(target.coverage.question, target.coverage.mentions, target.coverage.removed) : undefined;
  if (typeof receipt !== "string" && !source) return;
  if (typeof receipt !== "string") {
    const covered = target.coverage?.mentions.flatMap(mention => mention.value?.codes ?? []) ?? [];
    if (before.metric_codes.some(code => !covered.includes(code)) || covered.some(code => !before.metric_codes.includes(code))) return;
  }
  return {before, changes: [], ...(typeof receipt === "string" ? {source_semantic_receipt: receipt} : {}),
    ...(source ? {source_question: source.source_question, bindings: source.source_metric_bindings, exclusions: source.source_metric_exclusions} : {})};
}
