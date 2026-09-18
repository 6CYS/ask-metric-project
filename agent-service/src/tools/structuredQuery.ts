/**
 * metric_query_structured 工具：结构化基础查询快速通道（保留兼容，普通自然语言会话默认不启用）。
 * agent 自行完成实体锁定与日期换算后，以正式编码和明确日期调用后端 basic-queries（不调用后端语义模型）。
 * 编码不是授权凭据，后端仍按当前用户权限与启用目录校验；幂等键由参数指纹派生，不用随机键。
 */
import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { commandKey } from "../harnessHost.js";
import { BackendApiError, type BasicQuerySpec } from "../backendClient.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import {
  MAX_ROWS_FOR_MODEL,
  backendErrorResult,
  failureReason,
  isCalendarDate,
  type StructuredQueryDetails,
} from "./shared.js";

const structuredQueryParameters = Type.Object({
  metric_codes: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 100,
    description: "正式指标编码数组，必须来自 metric_catalog_search 或会话中已确认的编码，不得编造",
  }),
  org_codes: Type.Array(Type.String({ minLength: 1 }), {
    maxItems: 1000,
    description:
      "正式机构编码数组，必须来自 org_catalog_search、会话中已确认的编码或已展开的全目录集合，不得编造；" +
      "selection=ranking 时至多一个范围机构，空数组表示全省汇总的直接下级",
  }),
  start: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "起始日期 YYYY-MM-DD（含）" }),
  end: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "结束日期 YYYY-MM-DD（含）" }),
  selection: StringEnum(["exact", "latest_in_range", "all_in_range", "ranking"], {
    description:
      "exact：起止必须同日的指定日原值；latest_in_range：范围内最后一个可用日期的原值（月末时点查询用此值）；all_in_range：范围内全部已有数据点；" +
      "ranking：排名榜单与名次反查，按范围机构（缺省全省汇总直接下级）的下级排序取前 top_n 名，结果行自带机构、数值和名次",
  }),
  order: Type.Optional(
    StringEnum(["asc", "desc"], {
      description: "仅 selection=ranking：排名方向，desc=数值高在前（缺省），asc=数值低在前（问排名最后时用）",
    }),
  ),
  top_n: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "仅 selection=ranking：返回名次条数，缺省 5；问第1名用 top_n=1" }),
  ),
});

export function createStructuredQueryTool(): AgentHarnessTool<AskMetricRequestContext, typeof structuredQueryParameters, StructuredQueryDetails> {
  return {
    name: "metric_query_structured",
    label: "指标结构化查询",
    description:
      "以正式指标编码、机构编码和明确日期直接取数（不经过语义解析）。仅当指标、机构、日期都能确定为正式编码和绝对日期时使用；" +
      "条件不明确、叫法拿不准或需要澄清的问题改用 metric_ask。日期规则：明确的某月末/某日用 start=end 并 selection=exact；" +
      "某月末时点取值用该月1日至月末日、selection=latest_in_range；整月或区间取值用对应区间、selection=latest_in_range；逐月趋势用 all_in_range。" +
      "排名榜单与名次反查（“第1名/前N名是哪家机构”“排名第几的是谁”）用 selection=ranking：值指标编码须先确认，org_codes 至多一个范围机构、" +
      "空数组表示全省汇总直接下级，问第1名用 top_n=1，问排名最后用 order=asc；单位为“名”的排名指标不能用 ranking 反查机构。",
    parameters: structuredQueryParameters,
    execute: async (_toolCallId, params: Static<typeof structuredQueryParameters>, _onUpdate, request, _invocation, context) => {
      if (!isCalendarDate(params.start) || !isCalendarDate(params.end) || params.start > params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "日期必须是 YYYY-MM-DD 且 start 不晚于 end" }) }],
          details: { kind: "metric_query_structured" as const, status: "error" },
        };
      }
      if (params.selection === "exact" && params.start !== params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "selection=exact 时 start 与 end 必须是同一天" }) }],
          details: { kind: "metric_query_structured" as const, status: "error" },
        };
      }
      const isRanking = params.selection === "ranking";
      // 排名只在一个范围机构内分解下级：空数组=全省汇总直接下级，多于一个范围机构无法定义名次口径
      if (isRanking && params.org_codes.length > 1) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "selection=ranking 时 org_codes 至多一个范围机构，空数组表示全省汇总的直接下级" }) }],
          details: { kind: "metric_query_structured" as const, status: "error" },
        };
      }
      if (!isRanking && params.org_codes.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "org_codes 不能为空；仅 selection=ranking 允许空数组（缺省为全省汇总直接下级）" }) }],
          details: { kind: "metric_query_structured" as const, status: "error" },
        };
      }
      try {
        const spec: BasicQuerySpec = {
          metric_codes: [...new Set(params.metric_codes)],
          org_codes: [...new Set(params.org_codes)],
          time: { start: params.start, end: params.end },
          selection: params.selection as BasicQuerySpec["selection"],
        };
        if (isRanking) {
          spec.order = (params.order ?? "desc") as "asc" | "desc";
          spec.top_n = params.top_n ?? 5;
        }
        // 稳定幂等键：同一请求内相同参数重试复用同一后端任务，不产生重复查询
        const key = commandKey({
          owner: request.actor.id,
          session_id: request.sessionId,
          request_id: request.requestId,
          action: "structured",
          spec,
        });
        const { result } = await request.backend.basicQueries(spec, key, { signal: context.abortSignal });
        const sampleRows = result.rows.slice(0, MAX_ROWS_FOR_MODEL);
        // 非成功状态必须给模型可读原因（含 error_code），模型拿到原因后才能去 search 或如实转述
        const readableMessage =
          result.status === "succeeded"
            ? result.message ?? null
            : failureReason(result.error_code, result.error_message);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: result.status,
                columns: result.columns,
                // 仅样例行供模型核对口径；明细数值的完整展示由用户界面的结果表承担
                sample_rows: sampleRows,
                row_count: result.row_count,
                truncated: Boolean(result.truncated),
                error_code: result.error_code ?? null,
                message: readableMessage,
                display_hint:
                  "明细数据已在用户界面以结果表展示，回答正文不要逐条罗列数值，简洁概括即可。",
              }),
            },
          ],
          details: {
            kind: "metric_query_structured",
            task_id: result.task_id,
            status: result.status,
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        const handled = backendErrorResult(error, { kind: "metric_query_structured" as const, status: "error" });
        if (handled) return handled;
        throw error;
      }
    },
  };
}
