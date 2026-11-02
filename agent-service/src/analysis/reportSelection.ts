import type {AskMetricRequestContext} from "../requestContext.js";

// 仅保存本轮已经绑定真实证据的交付选择；不写回历史计划，也不跨轮缓存授权。
const selections = new WeakMap<AskMetricRequestContext, {runRefs: string[]; payload: Record<string, unknown>}>();
export function rememberReportSelection(request: AskMetricRequestContext, runRefs: string[], payload: Record<string, unknown>) {
  selections.set(request, {runRefs: [...runRefs], payload: structuredClone(payload)});
}
export function reportSelection(request: AskMetricRequestContext, runRefs: string[]) {
  const selected = selections.get(request);
  if (!selected || selected.runRefs.length !== runRefs.length || selected.runRefs.some(ref => !runRefs.includes(ref))) return undefined;
  return structuredClone(selected.payload);
}
