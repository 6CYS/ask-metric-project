import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createStructuredQueryTool } from "../tools/structuredQuery.js";
import { createDataAvailabilityTool } from "../tools/dataAvailability.js";
import { createMetricCalculateTool } from "../tools/metricCalculate.js";
import type { BusinessFrame } from "./types.js";

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
  registry.register("metric_query_structured", async (frame, [id, , update, request, invocation, context]) => {
    const time = value(frame, "time") as {start: string; end: string};
    const tool = createStructuredQueryTool();
    const params = {metric_codes: codes(frame, "metrics"), org_codes: codes(frame, "organizations"), ...time,
      selection: value(frame, "selection"), ...(value(frame, "order") ? {order: value(frame, "order")} : {}),
      ...(value(frame, "top_n") ? {top_n: value(frame, "top_n")} : {})};
    return tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context);
  });
  registry.register("data_availability", async (frame, [id, , update, request, invocation, context]) => {
    const tool = createDataAvailabilityTool();
    const params = {dimension: value(frame, "dimension"), org_codes: codes(frame, "organizations"),
      ...(value(frame, "metrics") ? {metric_codes: codes(frame, "metrics")} : {}),
      ...(value(frame, "time") as object | undefined),
      ...Object.fromEntries(["match", "page", "page_size"].filter(name => value(frame, name) !== undefined).map(name => [name, value(frame, name)]))};
    return tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context);
  });
  registry.register("metric_calculate", async (frame, [id, , update, request, invocation, context]) => {
    const tool = createMetricCalculateTool();
    const params = Object.fromEntries(Object.entries(frame.fields).filter(([, field]) => field.resolutionStatus === "resolved")
      .map(([name, field]) => [name, field.resolvedValue]));
    return tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context);
  });
  return registry;
}
