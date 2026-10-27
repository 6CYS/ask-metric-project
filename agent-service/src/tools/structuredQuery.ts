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
  comparison_scope: Type.Optional(Type.Object({
    org_codes: Type.Optional(Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 1000})),
    organization_scope: Type.Optional(Type.Union([
      Type.Object({kind: Type.Literal("authorized_cohort"), cohort: Type.Literal("rural_commercial_banks")}, {additionalProperties: false}),
      Type.Object({kind: Type.Literal("children_of"), parent_code: Type.String({minLength: 1})}, {additionalProperties: false}),
    ])),
    scope_fingerprint: Type.Optional(Type.String({pattern: "^[a-f0-9]{64}$"})),
  }, {additionalProperties: false})),
  start: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "起始日期 YYYY-MM-DD（含）；多个离散日期时为最早日期" })),
  end: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "结束日期 YYYY-MM-DD（含）；多个离散日期时为最晚日期" })),
  preset: Type.Optional(Type.Literal("latest")),
  time_alternative: Type.Optional(Type.Object({
    label: Type.String({minLength: 1, maxLength: 200}),
    start: Type.String({pattern: "^\\d{4}-\\d{2}-\\d{2}$"}),
    end: Type.String({pattern: "^\\d{4}-\\d{2}-\\d{2}$"}),
  }, {additionalProperties: false,
    description: "仅由业务 Frame 适配器注入的“近N年”备选口径（最近 N 个完整年度），随回执透传供前端切换口径；模型不填写"})),
  dates: Type.Optional(Type.Array(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), {
    minItems: 2, maxItems: 31,
    description: "多个离散日期点（如各月末），各点独立取值；start/end 须等于最早/最晚。与排名、完整时间序列互斥。",
  })),
  selection: StringEnum(["exact", "latest", "latest_in_range", "all_in_range"], {
    description: "日期取值方式：latest=普通取值按最新有效数据日；exact=指定同一天；latest_in_range=范围内最新有值日期；all_in_range=全部已有数据点。排名单独由 operation 表达，不扩展日期。",
  }),
  operation: Type.Optional(Type.Union([
    Type.Object({kind: Type.Literal("value")}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("ranking"), position: StringEnum(["top", "bottom"]), top_n: Type.Integer({minimum: 1, maximum: 100})}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("rank_position")}, {additionalProperties: false}),
  ])),
}, {additionalProperties: false});

export function createStructuredQueryTool(): AgentHarnessTool<AskMetricRequestContext, typeof structuredQueryParameters, StructuredQueryDetails> {
  return {
    name: "metric_query_structured",
    label: "指标结构化查询",
    description: "用途：正式编码、日期和取值口径已确认时直接取数，包括覆盖后取值、组合计算的基础取数、批量查询或排名。不适用：条件未明的自然语言提槽、历史结果重显或业务归因。前提：正式机构/指标编码有目录或成功回执依据，完整绝对日期或latest策略已由宿主确认；无需预先查覆盖，沿用覆盖范围时不能用样例日期替代。返回：执行条件、任务/结果引用、样例行、截断标记和可计算事实。",
    parameters: structuredQueryParameters,
    execute: async (_toolCallId, params: Static<typeof structuredQueryParameters>, _onUpdate, request, _invocation, context) => {
      const latest = params.preset === "latest";
      if (latest ? params.start !== undefined || params.end !== undefined || params.dates !== undefined
        || params.time_alternative !== undefined || params.selection !== "latest" || params.operation?.kind && params.operation.kind !== "value"
        : !params.start || !params.end || !isCalendarDate(params.start) || !isCalendarDate(params.end) || params.start > params.end || params.selection === "latest") {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "日期必须是 YYYY-MM-DD 且 start 不晚于 end" }) }],
          details: { kind: "metric_query_structured" as const, status: "error", retryable: true, public_answer: "查询参数未通过校验，请核对日期与机构范围。" },
        };
      }
      const hasDates = Array.isArray(params.dates) && params.dates.length > 0;
      // 备选口径仅随有效查询透传；畸形值不影响主查询，按未注入处理。
      const timeAlternative = params.time_alternative && isCalendarDate(params.time_alternative.start)
        && isCalendarDate(params.time_alternative.end) && params.time_alternative.start <= params.time_alternative.end
        ? params.time_alternative : undefined;
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
      const comparison = params.comparison_scope;
      const comparisonValid = comparison?.organization_scope
        ? !!comparison.scope_fingerprint && /^[a-f0-9]{64}$/.test(comparison.scope_fingerprint) && comparison.org_codes === undefined
        : !!comparison?.org_codes?.length && !comparison.scope_fingerprint;
      const isRank = params.operation?.kind === "ranking" || params.operation?.kind === "rank_position";
      if (!scopeValid || (params.operation?.kind === "rank_position" ? !comparisonValid : comparison !== undefined)
        || !["exact", "latest", "latest_in_range", "all_in_range"].includes(params.selection)
        || "order" in params || "top_n" in params || (isRank && params.selection === "all_in_range")
        || (hasDates && (isRank || params.selection === "all_in_range"))) {
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
          metric_codes: [...new Set(params.metric_codes)],
          schema_version: 2,
          ...(params.organization_scope ? {organization_scope: params.organization_scope, scope_fingerprint: params.scope_fingerprint!}
            : {org_codes: [...new Set(params.org_codes!)]}),
          ...(comparison ? {comparison_scope: comparison} : {}),
          time: latest ? {preset: "latest"} : {start: params.start!, end: params.end!, ...(hasDates ? {dates: params.dates} : {})},
          ...(timeAlternative ? {time_alternative: timeAlternative} : {}),
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
        if (request.businessExecutionFrame) {
          // 发送前登记幂等键：响应丢失后下一轮凭它只读回查，不靠重发请求确认结果。
          await request.businessResults?.linkExecution(request.businessExecutionFrame,
            {tool: "metric_query_structured", idempotencyKey: key, conversationId});
        }
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
            ...(result.answer_blocks ? {public_answer_blocks: result.answer_blocks} : {}),
            ...(result.evidence?.query_dates ? {query_dates: result.evidence.query_dates} : {}),
            status: result.status,
            // “近N年”备选口径透传到工具明细（SSE tool_end 与会话快照同源），前端据此提供“切换口径”。
            ...(timeAlternative ? {time_variants: [timeAlternative]} : {}),
            ...(result.error_code ? {error_code: result.error_code} : {}),
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        // 结果未知时交给执行 Frame 保持 executing，下一轮按幂等键回查收敛，不能记成业务失败：
        // 网络/5xx、仍在执行，以及查询成功后读取任务时令牌过期（401/403）都属于此类。
        if (request.businessExecutionFrame && (!(error instanceof BackendApiError) || error.status >= 500
          || error.status === 401 || error.status === 403 || error.code === "QUERY_ALREADY_RUNNING")) throw error;
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
