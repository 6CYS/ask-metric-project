import type {BasicQuerySpec} from "../backendClient.js";
import type {SemanticTarget} from "./store.js";

/** 工作状态字段到规范化查询条件的投影：只取真实规范身份，不把模型业务文本或提案状态当作条件。 */
type QueryField = "metrics" | "organizations" | "comparison_organizations" | "time" | "selection" | "operation";
function queryValue(target: SemanticTarget, field: QueryField): unknown {
  const value = target.fields[field]?.resolvedValue;
  return ["metrics", "organizations", "comparison_organizations"].includes(field)
    ? structuredClone((value as {codes?: string[]} | undefined)?.codes ?? []) : structuredClone(value ?? null);
}
/** 全部必需字段已绑定且无待决项时生成完整规范化 spec；否则返回 undefined，不能投影半份条件。 */
export function completeQuery(target: SemanticTarget): BasicQuerySpec | undefined {
  if (["metrics", "organizations", "time", "selection", "operation"].some(name => target.fields[name]?.resolutionStatus !== "resolved" || target.pending[name])) return;
  if ((target.fields.operation?.resolvedValue as {kind?: string})?.kind === "rank_position"
    && (target.fields.comparison_organizations?.resolutionStatus !== "resolved" || target.pending.comparison_organizations)) return;
  const comparison = queryValue(target, "comparison_organizations") as string[];
  const alternative = target.fields.time?.metadata?.timeAlternative as BasicQuerySpec["time_alternative"];
  return {metric_codes: queryValue(target, "metrics") as string[], org_codes: queryValue(target, "organizations") as string[],
    time: queryValue(target, "time") as BasicQuerySpec["time"], selection: queryValue(target, "selection") as BasicQuerySpec["selection"],
    operation: queryValue(target, "operation") as NonNullable<BasicQuerySpec["operation"]>, ...(comparison.length ? {comparison_scope: {org_codes: comparison}} : {}),
    ...(alternative ? {time_alternative: structuredClone(alternative)} : {})};
}
