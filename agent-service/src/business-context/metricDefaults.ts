import type {FieldResolution} from "./types.js";

type MetricValue = {codes: string[]; names: string[]};
type DefaultBinding = {value?: MetricValue; context_codes?: string[]};

/** 只以服务端给出的同概念候选继承已确认口径；完整名称、显式口径没有默认标记，不能被覆盖。 */
export function applyMetricDefaultContext(resolution: FieldResolution, known?: MetricValue): FieldResolution {
  if (resolution.status !== "resolved" || !known?.codes.length || resolution.metadata?.default_context_applied) return resolution;
  const defaults = (resolution.metadata?.metric_defaults ?? (resolution.metadata?.default_value_basis
    ? [{...resolution.metadata, value: resolution.value}] : [])) as DefaultBinding[];
  if (!Array.isArray(defaults) || !defaults.length) return resolution;
  const value = resolution.value as MetricValue;
  const members = new Map(value.codes.map((code, index) => [code, value.names[index]!]));
  let changed = false;
  for (const binding of defaults) {
    const allowed = new Set(binding.context_codes ?? []);
    const selected = known.codes.filter(code => allowed.has(code));
    if (selected.length > 1) return {status: "needs_confirmation", candidates: selected.map(code =>
      ({code, value: known.names[known.codes.indexOf(code)]!})), metadata: {issue: "multiple_confirmed_metric_bases"}};
    if (selected.length !== 1 || !binding.value?.codes.length) continue;
    for (const code of binding.value.codes) members.delete(code);
    members.set(selected[0]!, known.names[known.codes.indexOf(selected[0]!)]!);
    changed = true;
  }
  if (!changed) return resolution;
  return {...resolution, value: {codes: [...members.keys()], names: [...members.values()]},
    metadata: {...resolution.metadata, default_context_applied: true,
      metrics: [...members].map(([code, name]) => ({code, name}))}};
}
