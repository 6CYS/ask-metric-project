/**
 * metric_query_structured 工具：结构化基础查询快速通道（pi 已确认正式实体与查询范围）。
 * agent 自行完成实体锁定与日期换算后，以正式编码和明确日期调用后端 basic-queries（不调用后端语义模型）。
 * 编码不是授权凭据，后端仍按当前用户权限与启用目录校验；幂等键由参数指纹派生，不用随机键。
 */
import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { commandKey } from "../harnessHost.js";
import { BackendApiError, type BasicQuerySpec } from "../backendClient.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import { resultAnswer } from "../answerEvidence.js";
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
      "exact：起止必须同日的指定日原值，明确月末使用该月最后一天；latest_in_range：用户指定范围内最后一个可用日期的原值，不得为月末自行扩展或倒退日期范围；all_in_range：范围内全部已有数据点；" +
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
    description: "用途：正式编码、日期和取值口径已确认时直接取数，包括覆盖后取值、组合计算的基础取数、批量查询或排名。不适用：条件未明的自然语言提槽、历史结果重显或业务归因。前提：正式机构/指标编码有目录或成功回执依据，完整绝对日期已确认；无需预先查覆盖，沿用覆盖范围时不能用样例日期替代。返回：执行条件、任务/结果引用、样例行、截断标记和可计算事实。",
    parameters: structuredQueryParameters,
    execute: async (_toolCallId, params: Static<typeof structuredQueryParameters>, _onUpdate, request, _invocation, context) => {
      if (!isCalendarDate(params.start) || !isCalendarDate(params.end) || params.start > params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "日期必须是 YYYY-MM-DD 且 start 不晚于 end" }) }],
          details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
        };
      }
      if (params.selection === "exact" && params.start !== params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "selection=exact 时 start 与 end 必须是同一天" }) }],
          details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
        };
      }
      const isRanking = params.selection === "ranking";
      // 排名只在一个范围机构内分解下级：空数组=全省汇总直接下级，多于一个范围机构无法定义名次口径
      if (isRanking && params.org_codes.length > 1) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "selection=ranking 时 org_codes 至多一个范围机构，空数组表示全省汇总的直接下级" }) }],
          details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
        };
      }
      if (!isRanking && params.org_codes.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "org_codes 不能为空；仅 selection=ranking 允许空数组（缺省为全省汇总直接下级）" }) }],
          details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
        };
      }
      try {
        let conversationId = await request.commands.getConversationId();
        if (!conversationId) {
          const created = await request.backend.createAgentQueryContext(request.sessionId, {signal: context.abortSignal});
          conversationId = created.conversation_id;
          await request.commands.setConversationId(conversationId);
        }
        const spec: BasicQuerySpec = {
          conversation_id: conversationId,
          calculation_context: {scope_id: request.operationId, user_question: request.originalMessage},
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
        // 正式任务回执提供结果引用和版本，供后续回读/追问；不能从编码拼造任务 ID。
        const task = result.status === "succeeded"
          ? await request.backend.getTask(result.task_id, {signal: context.abortSignal}) : undefined;
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
                task_id: result.task_id,
                version: task?.version,
                result_id: task?.result?.result_id,
                query_evidence: result.evidence,
                columns: result.columns,
                // 仅样例行供模型核对口径；明细数值的完整展示由用户界面的结果表承担
                sample_rows: sampleRows,
                facts: (result.facts ?? []).slice(0, 100),
                fact_count: result.facts?.length ?? 0,
                facts_truncated: (result.facts?.length ?? 0) > 100,
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
            version: task?.version,
            result_id: task?.result?.result_id,
            public_answer: result.status === "succeeded" ? resultAnswer(result) : readableMessage ?? "查询未成功。",
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
