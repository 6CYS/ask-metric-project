import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import type { SourceMetricBinding, SourceMetricExclusion } from "../backendClient.js";
import { createStructuredQueryTool } from "../tools/structuredQuery.js";
import { createDataAvailabilityTool } from "../tools/dataAvailability.js";
import { createMetricCalculateTool } from "../tools/metricCalculate.js";
import type { BusinessFrame, MentionResolution, QueryOperation, ResolvedOrganizations } from "./types.js";
import { withOrgResolutionNotices } from "./resolutionNotice.js";

type Tool = AgentHarnessTool<AskMetricRequestContext>;
type Call = Parameters<Tool["execute"]>;
export type Adapter = (frame: BusinessFrame, call: Call) => Promise<AgentToolResult<unknown>>;
/** 能力适配器拥有业务参数知识；新增能力注册适配器，无需改 Frame 主流程。 */
export class BusinessToolRegistry {
  private readonly adapters = new Map<string, Adapter>();
  register(name: string, adapter: Adapter): void {
    if (this.adapters.has(name)) throw new Error("BUSINESS_TOOL_ALREADY_REGISTERED");
    this.adapters.set(name, adapter);
  }
  async execute(name: string, frame: BusinessFrame, call: Call) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error("BUSINESS_TOOL_NOT_REGISTERED");
    return adapter(frame, call);
  }
}
const value = (frame: BusinessFrame, name: string) => frame.fields[name]?.resolvedValue;
const codes = (frame: BusinessFrame, name: string) => (value(frame, name) as {codes?: string[]} | undefined)?.codes ?? [];
/**
 * 覆盖率复核保留完整用户原句，已确认身份按编码传递，明确放弃项单独标记原始区间。
 * 不能删除基础名称，否则后续省略名称的口径无法解析；未绑定目标仍交后端检查漏项。
 */
export function metricCoverageSource(questionText: string, mentions: MentionResolution[], removed: MentionResolution[]): {
  source_question: string; source_metric_bindings: SourceMetricBinding[]; source_metric_exclusions?: SourceMetricExclusion[];
} {
  const chars = Array.from(questionText);
  if (!mentions.length || ![...mentions, ...removed].every(mention => mention !== null && typeof mention === "object")) {
    throw new Error("INVALID_METRIC_COVERAGE_SNAPSHOT");
  }
  const entries = [...mentions.map(mention => ({mention, removed: false})), ...removed.map(mention => ({mention, removed: true}))]
    .sort((a, b) => a.mention.start - b.mention.start);
  let cursor = 0;
  const bindings: SourceMetricBinding[] = [];
  const exclusions: SourceMetricExclusion[] = [];
  for (const entry of entries) {
    const {mention} = entry;
    if (!Number.isInteger(mention.start) || !Number.isInteger(mention.end) || mention.start < cursor
      || mention.start < 0 || mention.end <= mention.start || mention.end > chars.length
      || chars.slice(mention.start, mention.end).join("") !== mention.text
      || (entry.removed ? mention.status !== "removed" : mention.status !== "resolved" || !Array.isArray(mention.value?.codes) || !mention.value.codes.length
        || !mention.value.codes.every(code => typeof code === "string" && code.trim().length > 0)
        || new Set(mention.value.codes).size !== mention.value.codes.length)) {
      throw new Error("INVALID_METRIC_COVERAGE_SNAPSHOT");
    }
    if (entry.removed) exclusions.push({start: mention.start, end: mention.end, text: mention.text});
    else {
      bindings.push({start: mention.start, end: mention.end,
        text: mention.text, codes: [...mention.value!.codes]});
    }
    cursor = mention.end;
  }
  return {source_question: questionText, source_metric_bindings: bindings,
    ...(exclusions.length ? {source_metric_exclusions: exclusions} : {})};
}
/** 旧 Frame 没有逐条快照时沿用原文严格复核；快照存在但损坏时拒绝生成伪绑定。 */
function coverageSource(frame: BusinessFrame): ReturnType<typeof metricCoverageSource> | undefined {
  const metadata = frame.fields.metrics?.metadata;
  const mentions = metadata?.mentionResolutions;
  if (mentions === undefined) return undefined;
  if (!Array.isArray(mentions) || typeof metadata?.questionText !== "string"
    || (metadata.removedMentions !== undefined && !Array.isArray(metadata.removedMentions))) {
    throw new Error("INVALID_METRIC_COVERAGE_SNAPSHOT");
  }
  return metricCoverageSource(metadata.questionText, mentions as MentionResolution[],
    (metadata.removedMentions ?? []) as MentionResolution[]);
}
export function createBusinessTools(): BusinessToolRegistry {
  const registry = new BusinessToolRegistry();
  registry.register("metric_query_structured", async (frame, [id, , update, request, invocation, context]) => {
    const time = value(frame, "time") as {start: string; end: string; dates?: string[]};
    const tool = createStructuredQueryTool();
    // “近N年”默认解析的完整年度备选口径：随查询提交并透传回执，供前端“切换口径”重查。
    const rawAlternative = frame.fields.time?.metadata?.timeAlternative as {label?: unknown; start?: unknown; end?: unknown} | undefined;
    const timeAlternative = rawAlternative && typeof rawAlternative.label === "string"
      && typeof rawAlternative.start === "string" && typeof rawAlternative.end === "string"
      ? {label: rawAlternative.label, start: rawAlternative.start, end: rawAlternative.end} : undefined;
    const organizations = value(frame, "organizations") as ResolvedOrganizations;
    if (organizations.scope && !organizations.scope_fingerprint) throw new Error("SCOPE_FINGERPRINT_MISSING");
    const selection = value(frame, "selection");
    // 单日范围内取最新与精确日语义等价，在执行边界统一请求，保留 Frame 原始意图。
    const normalizedSelection = selection === "latest_in_range" && time.start === time.end ? "exact" : selection;
    // 绑定仅由宿主读取 Frame 快照生成；模型不能自行提交编码与原句之间的关系。
    const analysisReceipt = frame.fields.metrics?.metadata?.semanticSelectionReceipt;
    const source = typeof analysisReceipt === "string" ? undefined : coverageSource(frame);
    const comparison = value(frame, "comparison_organizations") as ResolvedOrganizations | undefined;
    if (comparison?.scope && !comparison.scope_fingerprint) throw new Error("SCOPE_FINGERPRINT_MISSING");
    const params = {metric_codes: codes(frame, "metrics"), ...time,
      ...(timeAlternative ? {time_alternative: timeAlternative} : {}),
      ...(typeof analysisReceipt === "string" ? {source_semantic_receipt: analysisReceipt}
        : frame.delta.baseReference === null || source ? {verify_question_coverage: true} : {}),
      ...source,
      ...(organizations.scope ? {organization_scope: organizations.scope, scope_fingerprint: organizations.scope_fingerprint}
        : {org_codes: organizations.codes}),
      ...(comparison ? {comparison_scope: comparison.scope
        ? {organization_scope: comparison.scope, scope_fingerprint: comparison.scope_fingerprint}
        : {org_codes: comparison.codes}} : {}),
      selection: normalizedSelection, operation: (value(frame, "operation") ?? {kind: "value"}) as QueryOperation};
    // 机构条件若是错字纠正或模型推断命中，回执与兜底答案必须固定明示，不靠模型自觉。
    return withOrgResolutionNotices(frame, await tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context));
  });
  registry.register("data_availability", async (frame, [id, , update, request, invocation, context]) => {
    if ((value(frame, "organizations") as ResolvedOrganizations | undefined)?.scope) throw new Error("UNSUPPORTED_ORGANIZATION_SCOPE");
    const tool = createDataAvailabilityTool();
    const params = {dimension: value(frame, "dimension"), org_codes: codes(frame, "organizations"),
      ...(value(frame, "metrics") ? {metric_codes: codes(frame, "metrics")} : {}),
      ...(value(frame, "time") as object | undefined),
      ...Object.fromEntries(["match", "page", "page_size"].filter(name => value(frame, name) !== undefined).map(name => [name, value(frame, name)]))};
    return withOrgResolutionNotices(frame, await tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context));
  });
  registry.register("metric_calculate", async (frame, [id, , update, request, invocation, context]) => {
    const tool = createMetricCalculateTool();
    const params = Object.fromEntries(Object.entries(frame.fields).filter(([, field]) => field.resolutionStatus === "resolved")
      .map(([name, field]) => [name, field.resolvedValue]));
    return tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context);
  });
  return registry;
}
