/**
 * read 统一读取入口：复用任务/结果分页与原生历史回读实现，旧工具保留用于操作恢复。
 * 两者不触发 SQL 或重算，不建立第二份记忆；权限与归属由后端/宿主边界校验。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resultAnswer, resultAnswerBlocks } from "../answerEvidence.js";
import { BackendApiError, type AnswerBlock } from "../backendClient.js";
import type { AskMetricRequestContext } from "../requestContext.js";

/* ------------------------------- metric_read ------------------------------ */

const metricReadParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("task"),
    task_id: Type.String({ minLength: 1, maxLength: 128 }),
  }, { description: "读取任务当前状态、版本、已确认条件、待补项与结果引用" }),
  Type.Object({
    kind: Type.Literal("result"),
    task_id: Type.String({ minLength: 1, maxLength: 128 }),
    result_id: Type.String({ minLength: 1, maxLength: 128 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }, { description: "分页读取不可变查询结果；默认 20 行、最多 100 行" }),
]);

export interface MetricReadDetails {
  kind: "metric_read";
  task_id?: string;
  result_id?: string;
  status: string;
  row_count?: number;
  columns?: string[];
  public_answer?: string;
  public_answer_blocks?: AnswerBlock[];
  error_code?: string;
}

export function createMetricReadTool(): AgentHarnessTool<AskMetricRequestContext, typeof metricReadParameters, MetricReadDetails> {
  return {
    name: "metric_read",
    label: "任务与结果读取",
    description: "用途：只读任务状态或重显/分页读取不可变结果，不重新查数。前提：task_id/result_id 来自正式回执，按机构、日期、指标选择；来源不明先回读历史。返回：任务版本、待补项或带执行条件的结果页。零行成功也可读取；改条件取数用 resolve_business_turn。",
    parameters: metricReadParameters,
    execute: async (_toolCallId, params, _onUpdate, request, _invocation, context) => {
      try {
        if (params.kind === "task") {
          const task = await request.backend.getTask(params.task_id, { signal: context.abortSignal });
          return json<MetricReadDetails>(
            {
              status: task.status,
              task_id: task.task_id,
              version: task.version,
              query_description: task.resolved_question ?? null,
              missing: task.missing ?? [],
              clarification: task.clarification ?? null,
              result_id: task.result?.result_id ?? null,
              error_code: task.error_code ?? null,
              error_message: task.error_message ?? null,
            },
            { kind: "metric_read", task_id: task.task_id, status: task.status,
              ...(task.status === "FAILED" ? {
                public_answer: task.error_message ?? "本次查询未成功，请稍后回查原任务。",
                ...(task.error_code ? { error_code: task.error_code } : {}),
              } : {}),
            },
          );
        }
        const page = await request.backend.getTaskResult(
          params.task_id,
          params.offset ?? 0,
          params.limit ?? 20,
          { signal: context.abortSignal },
          request.originalMessage || undefined,
        );
        if (page.result_id !== params.result_id) {
          return json<MetricReadDetails>(
            {
              status: "error",
              error: { code: "RESULT_MISMATCH", message: "result_id 与任务结果不一致，请用 read(kind=task) 重新确认。" },
            },
            { kind: "metric_read", task_id: params.task_id, status: "error" },
          );
        }
        const blocks = resultAnswerBlocks(page);
        return json<MetricReadDetails>(
          {
            status: page.status,
            task_id: page.task_id,
            result_id: page.result_id,
            columns: page.columns,
            rows: page.rows,
            query_evidence: page.evidence,
            facts: (page.facts ?? []).slice(0, 100),
            fact_count: page.facts?.length ?? 0,
            facts_truncated: page.has_more || (page.facts?.length ?? 0) > 100,
            comparisons: page.comparisons,
            row_count: page.row_count,
            result_truncated: page.truncated,
            offset: page.offset,
            next_offset: page.next_offset,
            has_more: page.has_more,
            message: page.message ?? null,
          },
          {
            kind: "metric_read",
            task_id: page.task_id,
            result_id: page.result_id,
            status: page.status,
            row_count: page.row_count,
            columns: page.columns,
            public_answer: resultAnswer(page),
            ...(blocks ? { public_answer_blocks: blocks } : {}),
          },
        );
      } catch (error) {
        if (error instanceof BackendApiError) {
          const code = error.code ?? "BACKEND_ERROR";
          if (code === "RESULT_REFERENCE_CONFLICT") {
            // 未取得可交付事实，继续原生循环纠正引用；不得把它当作查询成功或重建业务任务。
            return json<MetricReadDetails>({
              status: "reference_mismatch", code, conflicts: error.details,
              message: "该引用与用户原文明示条件冲突，不能交付。请从历史索引选择同时匹配机构、日期和指标的另一个已有结果；不要创建新任务。",
            }, {kind: "metric_read", status: "reference_mismatch", task_id: params.task_id});
          }
          const message =
            error.status === 404
              ? "任务不存在或无权访问。"
              : code === "RESULT_NOT_READY"
                ? "结果尚未就绪，任务还未成功完成。"
                : code === "RESULT_SNAPSHOT_MISSING"
                  ? "结果快照缺失，无法回放；请重新查询。"
                  : "结果读取暂时失败，请稍后重试。";
          return json<MetricReadDetails>(
            { status: "error", error: { code, message } },
            { kind: "metric_read", task_id: params.task_id, status: "error" },
          );
        }
        throw error;
      }
    },
  };
}

/* --------------------------- session_history_read -------------------------- */

const historyReadParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("list"),
    before_seq: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }, { description: "按时间倒序列出本会话历史条目（含压缩之前的旧记录），默认 10 条" }),
  Type.Object({
    kind: Type.Literal("entry"),
    entry_id: Type.String({ minLength: 1, maxLength: 128 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    length: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
  }, { description: "按 entry_id 精确回读某条历史的可见正文（分段，默认 4000 字符）" }),
]);

export interface HistoryReadDetails {
  kind: "session_history_read";
  status: string;
}

export function createSessionHistoryReadTool(): AgentHarnessTool<AskMetricRequestContext, typeof historyReadParameters, HistoryReadDetails> {
  return {
    name: "session_history_read",
    label: "会话历史回读",
    description:
      "用途：找回本会话历史引用和覆盖回执，不触发取数。前提：先 list 获取正式 entry_id，再用 entry 回读，不能编造。返回：历史条目预览、完整工具正文分段及下一段位置。" +
      "可跨压缩读取旧记录；正文截断时继续读取 next_offset，未读完整不能当作完整条件。",
    parameters: historyReadParameters,
    execute: async (_toolCallId, params, _onUpdate, request) => {
      if (params.kind === "list") {
        const page = await request.history.list(params.before_seq, params.limit ?? 10);
        return json<HistoryReadDetails>(
          {
            status: "ok",
            entries: page.entries,
            next_before_seq: page.next_before_seq,
            has_more: page.has_more,
          },
          { kind: "session_history_read", status: "ok" },
        );
      }
      const entry = await request.history.read(params.entry_id, params.offset ?? 0, params.length ?? 4000);
      if (!entry) {
        return json<HistoryReadDetails>(
          {
            status: "error",
            error: { code: "ENTRY_NOT_FOUND", message: "该条目不在本会话可访问范围内。" },
          },
          { kind: "session_history_read", status: "error" },
        );
      }
      return json<HistoryReadDetails>(
        {
          status: "ok",
          entry_id: entry.entry_id,
          seq: entry.seq,
          type: entry.type,
          text: entry.text,
          next_offset: entry.next_offset,
        },
        { kind: "session_history_read", status: "ok" },
      );
    },
  };
}

function json<TDetails>(payload: Record<string, unknown>, details: TDetails): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details };
}

// 合并既有分支并收紧额外字段；显式保留原联合类型，避免数组映射丢失静态推导。
const readParameters = Type.Unsafe<Static<typeof metricReadParameters> | Static<typeof historyReadParameters>>({anyOf: [
  ...metricReadParameters.anyOf,
  ...historyReadParameters.anyOf,
].map(branch => ({...branch, additionalProperties: false}))});

/** 统一读取入口，保留回执 kind 区分正式结果与原生历史，历史正文不能充当事实证据。 */
export function createReadTool(): AgentHarnessTool<AskMetricRequestContext, typeof readParameters, MetricReadDetails | HistoryReadDetails> {
  const metric = createMetricReadTool();
  const history = createSessionHistoryReadTool();
  return {
    name: "read", label: "读取任务、结果与历史", parameters: readParameters,
    description: "只读已有记录，不重新取数。kind=task 读取正式任务状态/版本/待补项；result 按 task_id/result_id 分页读取经鉴权的结果；list 列出本会话历史；entry 按 list 返回的 entry_id 分段回读。引用必须来自正式回执，截断继续翻页。历史正文只用于找回引用和条件，数值须经 result 回读。改条件取数用 resolve_business_turn。",
    execute: (id, params, update, request, invocation, context) => {
      if (params.kind === "task" || params.kind === "result") {
        return metric.execute(id, params, update, request, invocation, context);
      }
      return history.execute(id, params, update, request, invocation, context);
    },
  };
}
