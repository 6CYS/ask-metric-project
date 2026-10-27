import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createStructuredQueryTool } from "../tools/structuredQuery.js";
import { createDataAvailabilityTool } from "../tools/dataAvailability.js";
import { createMetricCalculateTool } from "../tools/metricCalculate.js";
import type { BusinessFrame, QueryOperation, ResolvedOrganizations } from "./types.js";
import { withOrgResolutionNotices } from "./resolutionNotice.js";
import { createBusinessOverviewTool } from "../tools/businessOverview.js";
import {createGeneralAnalysisTool} from "../analysis/tools.js";

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
export function createBusinessTools(): BusinessToolRegistry {
  const registry = new BusinessToolRegistry();
  registry.register("general_analysis", async (frame, call) => {
    const tool = createGeneralAnalysisTool(frame);
    return tool.execute(call[0], {}, call[2], call[3], call[4], call[5]);
  });
  registry.register("business_overview", async (frame, call) => {
    const tool = createBusinessOverviewTool(frame);
    return tool.execute(call[0], {}, call[2], call[3], call[4], call[5]);
  });
  registry.register("metric_query_structured", async (frame, [id, , update, request, invocation, context]) => {
    const time = value(frame, "time") as import("../backendClient.js").BasicQueryTime;
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
    const normalizedSelection = selection === "latest_in_range" && time.start && time.start === time.end ? "exact" : selection;
    const comparison = value(frame, "comparison_organizations") as ResolvedOrganizations | undefined;
    if (comparison?.scope && !comparison.scope_fingerprint) throw new Error("SCOPE_FINGERPRINT_MISSING");
    // 只组装规范化查询参数；指标/机构/日期身份已由宿主绑定层核验，不再附原句证明。
    const params = {metric_codes: codes(frame, "metrics"), ...time,
      ...(timeAlternative ? {time_alternative: timeAlternative} : {}),
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
