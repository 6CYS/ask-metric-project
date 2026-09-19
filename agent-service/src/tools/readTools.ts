/**
 * 只读工具：metric_read（任务状态/结果分页）与 session_history_read（原生历史回读）。
 * 两者不触发 SQL 或重算，不建立第二份记忆；权限与归属由后端/宿主边界校验。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resultAnswer } from "../answerEvidence.js";
import { BackendApiError } from "../backendClient.js";
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
  error_code?: string;
}

export function createMetricReadTool(): AgentHarnessTool<AskMetricRequestContext, typeof metricReadParameters, MetricReadDetails> {
  return {
    name: "metric_read",
    label: "任务与结果读取",
    description:
      "只读：kind=task 查看任务当前状态/版本/澄清目标；kind=result 按 offset 分页读取已确认结果（默认 20 行，最多 100 行）。" +
      "用户要求重看、再次显示、找回先前数据时必须使用 kind=result，按历史回执的机构、日期、指标选择对应结果，即使它不是最新一笔。" +
      "成功的零行结果（暂无数据）也有 result_id，可以回读；根据正式查询条件匹配，不得因 rows 为空而重新创建任务或澄清指标。" +
      "仅说“再看某机构”而未要求历史结果时，应使用 metric_ask(followup) 沿用最新日期，不能读该机构旧日期。不会重新查询。",
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
          request.originalMessage,
        );
        if (page.result_id !== params.result_id) {
          return json<MetricReadDetails>(
            {
              status: "error",
              error: { code: "RESULT_MISMATCH", message: "result_id 与任务结果不一致，请用 metric_read task 模式重新确认。" },
            },
            { kind: "metric_read", task_id: params.task_id, status: "error" },
          );
        }
        return json<MetricReadDetails>(
          {
            status: page.status,
            task_id: page.task_id,
            result_id: page.result_id,
            columns: page.columns,
            rows: page.rows,
            query_evidence: page.evidence,
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
      "只读本会话历史：摘要记不清时先 list 找到条目，再用 entry 精确回读原文。" +
      "可以跨过压缩条目读取更早内容；读不到就说明找不到，不得臆造内容。",
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
