import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createStructuredQueryTool } from "../tools/structuredQuery.js";
import { createDataAvailabilityTool } from "../tools/dataAvailability.js";
import { createMetricCalculateTool } from "../tools/metricCalculate.js";
import type { BusinessFrame, MentionResolution, ResolvedOrganizations } from "./types.js";

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
 * 覆盖率复核的归一化原句：按 mention 的 start/end span（Unicode 码点）把已 resolved/已确认片段
 * 替换为最终名称，被 remove 放弃的片段整段删除；后端据此重跑匹配，静默丢项会以 409 拦下。
 */
export function coverageQuestion(questionText: string, mentions: MentionResolution[], removed: MentionResolution[]): string {
  const chars = Array.from(questionText);
  const removedKeys = new Set(removed.map(mention => `${mention.start}:${mention.end}`));
  let result = "";
  let cursor = 0;
  // 保留项与已删除项一起按 span 排序参与改写，删除片段才不会留在原句里。
  for (const mention of [...mentions, ...removed].sort((a, b) => a.start - b.start)) {
    if (mention.start < cursor || mention.end > chars.length) continue;
    result += chars.slice(cursor, mention.start).join("");
    if (!removedKeys.has(`${mention.start}:${mention.end}`)) {
      const finalName = mention.status === "resolved" ? mention.value?.names?.[0] : undefined;
      result += finalName ?? chars.slice(mention.start, mention.end).join("");
    }
    cursor = mention.end;
  }
  return result + chars.slice(cursor).join("");
}
/** 有逐条 mention 快照的 Frame 才能构造归一化原句；旧 Frame 维持首轮原句行为。 */
function coverageSourceQuestion(frame: BusinessFrame): string | undefined {
  const metadata = frame.fields.metrics?.metadata;
  const mentions = metadata?.mentionResolutions;
  if (!Array.isArray(mentions) || !mentions.length || typeof metadata?.questionText !== "string") return undefined;
  const removed = Array.isArray(metadata.removedMentions) ? metadata.removedMentions as MentionResolution[] : [];
  return coverageQuestion(metadata.questionText as string, mentions as MentionResolution[], removed);
}
export function createBusinessTools(): BusinessToolRegistry {
  const registry = new BusinessToolRegistry();
  registry.register("metric_query_structured", async (frame, [id, , update, request, invocation, context]) => {
    const time = value(frame, "time") as {start: string; end: string; dates?: string[]};
    const tool = createStructuredQueryTool();
    const organizations = value(frame, "organizations") as ResolvedOrganizations;
    if (organizations.scope && !organizations.scope_fingerprint) throw new Error("SCOPE_FINGERPRINT_MISSING");
    const selection = value(frame, "selection");
    // 单日范围内取最新与精确日语义等价，在执行边界统一请求，保留 Frame 原始意图。
    const normalizedSelection = selection === "latest_in_range" && time.start === time.end ? "exact" : selection;
    // 有 mention 快照的 Frame（含续查确认/放弃）也做覆盖率复核；首轮原句即原句，行为不变。
    const sourceQuestion = coverageSourceQuestion(frame);
    const params = {metric_codes: codes(frame, "metrics"), ...time,
      ...(frame.delta.baseReference === null || sourceQuestion ? {verify_question_coverage: true} : {}),
      ...(sourceQuestion ? {source_question: sourceQuestion} : {}),
      ...(organizations.scope ? {organization_scope: organizations.scope, scope_fingerprint: organizations.scope_fingerprint}
        : {org_codes: organizations.codes}),
      selection: normalizedSelection, operation: value(frame, "operation") ?? {kind: "value"}};
    return tool.execute(id, params as Parameters<typeof tool.execute>[1], update, request, invocation, context);
  });
  registry.register("data_availability", async (frame, [id, , update, request, invocation, context]) => {
    if ((value(frame, "organizations") as ResolvedOrganizations | undefined)?.scope) throw new Error("UNSUPPORTED_ORGANIZATION_SCOPE");
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
