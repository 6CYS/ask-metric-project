/**
 * 结构化查询适配器：仅由已校验 Business Frame 调用。
 * Resolver 完成实体和日期解析后，以正式字段调用后端 basic-queries（不调用后端语义模型）。
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
  verify_question_coverage: Type.Optional(Type.Boolean()),
  source_question: Type.Optional(Type.String({minLength: 1,
    description: "覆盖率复核的归一化原句，仅由业务 Frame 适配器按已确认口径注入；缺省使用本轮用户原文"})),
  metric_codes: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 100,
    description: "正式指标编码数组，必须来自 catalog 的指标检索结果或会话中已确认的编码，不得编造",
  }),
  org_codes: Type.Optional(Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 1000,
    description: "实际查询目标的正式机构编码，不表示父机构；集合范围用 organization_scope"})),
  organization_scope: Type.Optional(Type.Union([
    Type.Object({kind: Type.Literal("authorized_cohort"), cohort: Type.Literal("rural_commercial_banks")}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("children_of"), parent_code: Type.String({minLength: 1})}, {additionalProperties: false}),
  ])),
  scope_fingerprint: Type.Optional(Type.String({pattern: "^[a-f0-9]{64}$"})),
  start: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "起始日期 YYYY-MM-DD（含）；多个离散日期时为最早日期" }),
  end: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "结束日期 YYYY-MM-DD（含）；多个离散日期时为最晚日期" }),
  dates: Type.Optional(Type.Array(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), {
    minItems: 2, maxItems: 31,
    description: "多个离散日期点（如各月末），各点独立取值；start/end 须等于最早/最晚。与排名、完整时间序列互斥。",
  })),
  selection: StringEnum(["exact", "latest_in_range", "all_in_range"], {
    description: "日期取值方式：exact=指定同一天；latest_in_range=范围内最新有值日期；all_in_range=全部已有数据点。排名单独由 operation 表达，不扩展日期。",
  }),
  operation: Type.Optional(Type.Union([
    Type.Object({kind: Type.Literal("value")}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("ranking"), order: StringEnum(["asc", "desc"]), top_n: Type.Integer({minimum: 1, maximum: 100})}, {additionalProperties: false}),
  ])),
}, {additionalProperties: false});

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
      const hasDates = Array.isArray(params.dates) && params.dates.length > 0;
      if (hasDates) {
        const dates = params.dates!;
        const sortedUnique = [...new Set(dates)].sort();
        if (dates.length < 2 || !dates.every(isCalendarDate) || sortedUnique.length !== dates.length
          || dates.some((date, index) => index > 0 && date <= dates[index - 1]!)
          || dates[0] !== params.start || dates[dates.length - 1] !== params.end) {
          return {
            content: [{ type: "text", text: JSON.stringify({ status: "error", message: "离散日期须为升序去重的日历日期，且 start/end 等于最早/最晚" }) }],
            details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
          };
        }
      }
      if (!hasDates && params.selection === "exact" && params.start !== params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "selection=exact 时 start 与 end 必须是同一天" }) }],
          details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
        };
      }
      const scopeValid = params.organization_scope
        ? !!params.scope_fingerprint && /^[a-f0-9]{64}$/.test(params.scope_fingerprint) && params.org_codes === undefined
        : !params.scope_fingerprint && !!params.org_codes?.length;
      if (!scopeValid || !["exact", "latest_in_range", "all_in_range"].includes(params.selection)
        || "order" in params || "top_n" in params || (params.operation?.kind === "ranking" && params.selection === "all_in_range")
        || (hasDates && (params.operation?.kind === "ranking" || params.selection === "all_in_range"))) {
        return {
          content: [{type: "text", text: JSON.stringify({status: "error", error_code: "QUERY_CONTRACT_INVALID", message: "机构必须为实际编码或带指纹的集合；尚不支持逐日排名"})}],
          details: {kind: "metric_query_structured" as const, status: "error", retryable: false, error_code: "QUERY_CONTRACT_INVALID", public_answer: "查询条件组合未通过校验。"},
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
          ...(params.verify_question_coverage ? {source_question: params.source_question ?? request.originalMessage} : {}),
          metric_codes: [...new Set(params.metric_codes)],
          schema_version: 2,
          ...(params.organization_scope ? {organization_scope: params.organization_scope, scope_fingerprint: params.scope_fingerprint!}
            : {org_codes: [...new Set(params.org_codes!)]}),
          time: { start: params.start, end: params.end, ...(hasDates ? { dates: params.dates } : {}) },
          selection: params.selection as BasicQuerySpec["selection"],
          operation: (params.operation ?? {kind: "value"}) as NonNullable<BasicQuerySpec["operation"]>,
        };
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
            ...(result.error_code ? {error_code: result.error_code} : {}),
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        if (request.businessExecutionFrame && (!(error instanceof BackendApiError) || error.status >= 500)) throw error;
        if (error instanceof BackendApiError && error.code === "SCOPE_CHANGED") return {
          content: [{type: "text", text: JSON.stringify({status: "error", error_code: error.code,
            message: "机构范围已变化，使用原Frame条件重新解析以校验当前权限和范围，不沿用过期指纹。"})}],
          details: {kind: "metric_query_structured", status: "error", error_code: error.code, retryable: true,
            public_answer: "机构范围发生变化，本次查询未执行成功，需要重新校验原查询条件。"},
        };
        const handled = backendErrorResult(error, {kind: "metric_query_structured" as const, status: "error",
          ...(error instanceof BackendApiError && error.code ? {error_code: error.code} : {})});
        if (handled) return handled;
        throw error;
      }
    },
  };
}
