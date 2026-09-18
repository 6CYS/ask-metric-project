import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BackendApiError, type BackendClient } from "./backendClient.js";

const parameters = Type.Object({
  dimension: Type.Optional(StringEnum(["dates", "metrics"], { description: "问哪些日期有数据用dates（默认）；问某机构某日哪些指标有记录用metrics，返回指标总数和名称。" })),
  metric_codes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100, description: "目录确认的指标编码；省略表示不限制指标" })),
  org_codes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100, description: "目录确认的机构编码；省略表示账号授权范围" })),
  match: Type.Optional(StringEnum(["any", "all"], { description: "默认any：有记录的日期；仅用户明确问所选机构指标都有数据时用all，且需同时指定机构和指标。" })),
  start: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  end: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
});

export function createDataAvailabilityTool(client: BackendClient, finish?: () => void): AgentTool<typeof parameters> {
  let resultPromise: ReturnType<AgentTool<typeof parameters>["execute"]> | undefined;
  const tool: AgentTool<typeof parameters> = {
    name: "data_availability", label: "查看数据可用范围",
    description: "查询有记录的日期或正式指标。用户问哪些指标有数据必须用dimension=metrics，按指定机构和业务日期筛选并列指标，不使用日期模式回答。metrics仅支持match=any。用户指定单日时start=end该日。查看数据湖业务日期：未给机构或指标时仅按授权范围查日期，不限制指标；具体机构指标先检索编码。默认any为至少一项有记录；明确问都有数据时用all。用户未指定时间时必须省略start/end，不得猜年份。无记录是最终结果，不扩年、拆指标或反复尝试。日期按总数和有限列表展示，不保证连续或有效指标值。",
    parameters,
    execute: async (_id, params) => {
      try {
        const result = await client.dataAvailability(params);
        return { content: [{ type: "text", text: JSON.stringify(result) }],
          details: { kind: "data_availability", ...result } };
      } catch (error) {
        const message = error instanceof BackendApiError && error.status === 403
          ? "当前账号无权查看所选机构的数据覆盖情况。"
          : "数据覆盖查询未完成，请确认登录和查询条件，或缩小范围后重试；这不代表没有数据。";
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
          details: { kind: "data_availability", status: "error", message } };
      } finally {
        finish?.();
      }
    },
  };
  // 每轮仅一次可用范围查询（含并发）；重建工具后下一轮可接受新的用户条件。
  return { ...tool, execute: (...args) => resultPromise ??= tool.execute(...args) };
}
