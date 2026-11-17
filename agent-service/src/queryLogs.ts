/** 会话日志是原生账本的只读投影；一条用户消息为一轮，工具任务与模型重试均归属该轮。 */
import {
  BACKGROUND_CONTEXT,
  operationMeta,
  operationResult,
  value,
  type Entry,
  type OperationMeta,
  type OperationResultRecord,
  type StoredValue,
} from "@earendil-works/pi-agent-core";
import { Hono } from "hono";
import type { BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import type { EvaluationService } from "./evaluation/service.js";
import type { HarnessHost, RequestAssociation } from "./harnessHost.js";
import { getLegacySession, listLegacySessions, projectLegacyMessages } from "./legacySessions.js";
import type { NativeSessionStore } from "./nativeSessions.js";
import { NativeSemanticTaskStore } from "./semantic-task/store.js";
import { projectEntries, type ProjectedMessage } from "./sessionProjection.js";
import {
  MODEL_DEADLINE_EXCEEDED,
  MODEL_FIRST_RESPONSE_TIMEOUT,
  MODEL_STREAM_IDLE_EXCEEDED,
} from "./models.js";

export type LogStatus = "success" | "failed" | "cancelled" | "waiting_user" | "running" | "unknown";
export interface LogStep {
  id: string;
  name: string;
  status: LogStatus;
  duration_ms: number | null;
  note: string;
}
export interface LogRound {
  id: string;
  number: number;
  question: string;
  answers: string[];
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: LogStatus;
  retry_count: number;
  operation_id: string | null;
  request_id: string | null;
  model: string | null;
  error_code: string | null;
  task_ids: string[];
  steps: LogStep[];
  query_started: boolean;
  access_restricted: boolean;
  context: { organizations: string[]; dates: string[]; metrics: string[] };
}
export interface LogSession {
  session_id: string;
  title: string;
  created_at: number;
  last_active_at: number;
  rounds: LogRound[];
  legacy: boolean;
}
type Variables = { user: BackendUser; token: string };
type Redact = (
  messages: ProjectedMessage[],
  token: string,
  reader?: NativeSemanticTaskStore,
) => Promise<ProjectedMessage[]>;
const object = (input: unknown): Record<string, unknown> | undefined =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
const text = (input: unknown): string | null =>
  typeof input === "string" && input.trim() ? input : null;
const duration = (input: unknown): number | null =>
  typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
const toolNames: Record<string, string> = {
  metric_search: "指标检索",
  organization_search: "机构检索",
  organization_resolve: "机构匹配",
  metric_query: "指标查询",
  topic_query: "主题指标查询",
  metric_availability: "查询数据覆盖范围",
  analysis_read: "读取分析结果",
  analysis_chart: "生成图表",
  analysis_answer: "整理系统回答",
  conversation_reply: "交付系统回答",
  business_knowledge_search: "检索业务知识",
  session_history_read: "读取会话历史",
  metric_ask: "指标查询",
  metric_read: "读取查询结果",
  analysis_execute: "执行分析查询",
  analysis_query: "执行分析查询",
  analysis_calculate: "结果计算",
  analysis_report: "整理分析结果",
  business_skill_read: "读取业务知识",
  inquiry_context: "确认查询条件",
  inquiry_query: "执行指标查询",
};

/** 仅提取已授权回执中的明确字段；不解析模型正文推断机构、指标或日期。 */
function receiptContext(messages: ProjectedMessage[]): {
  task_ids: string[];
  context: LogRound["context"];
  waiting: boolean;
  failed: boolean;
  restricted: boolean;
} {
  const tasks = new Set<string>(),
    organizations = new Set<string>(),
    dates = new Set<string>(),
    metrics = new Set<string>();
  let waiting = false,
    restricted = false;
  const collect = (input: unknown): void => {
    if (Array.isArray(input)) {
      input.forEach(collect);
      return;
    }
    const node = object(input);
    if (!node) return;
    if (node.history_redacted === true) {
      restricted = true;
      return;
    }
    if (text(node.task_id)) tasks.add(String(node.task_id));
    const status = text(node.status)?.toLowerCase();
    if (status === "waiting_user" || status === "needs_clarification") waiting = true;
    if (Array.isArray(node.pending_questions) && node.pending_questions.length) waiting = true;
    for (const [key, val] of Object.entries(node)) {
      const target = ["org_name", "organization_name", "matched_org_name"].includes(key)
        ? organizations
        : ["date", "stat_date", "query_date", "start_date", "end_date"].includes(key)
          ? dates
          : ["metric_name", "metric_code"].includes(key)
            ? metrics
            : undefined;
      if (target && text(val)) target.add(String(val));
      if (val && typeof val === "object") collect(val);
    }
  };
  messages
    .filter((message) => message.role === "tool")
    .forEach((message) => collect(message.details));
  const last = messages.filter((message) => message.role === "tool").at(-1);
  const finalReceipt = last?.role === "tool" ? object(last.details) : undefined;
  // 中间澄清或错误不覆盖随后已交付的正式结果；工具返回失败与原生 operation 终态分别判断。
  if (
    finalReceipt &&
    ["business_report", "runtime_delivery", "conversation_reply"].includes(
      text(finalReceipt.kind) ?? "",
    ) &&
    ["succeeded", "delivered", "answered"].includes(text(finalReceipt.status) ?? "")
  )
    waiting = false;
  const failed =
    last?.role === "tool" && !restricted
      ? last.is_error ||
        ["failed", "error", "argument_error", "denied"].includes(
          text(finalReceipt?.status)?.toLowerCase() ?? "",
        ) ||
        finalReceipt?.outcome === "incomplete"
      : false;
  return {
    task_ids: [...tasks],
    context: { organizations: [...organizations], dates: [...dates], metrics: [...metrics] },
    waiting,
    failed,
    restricted,
  };
}

function operationFor(
  entries: Entry[],
  metas: OperationMeta[],
  results: OperationResultRecord[],
): string | undefined {
  const first = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
  if (!first) return undefined;
  const meta = metas.find(
    (meta) => meta.intent.kind === "run" && meta.intent.promptEntryIds.includes(first.id),
  );
  if (meta) return meta.operationId;
  const ids = new Set(entries.map((entry) => entry.id));
  return results.find((result) => result.kind === "run" && result.tipId && ids.has(result.tipId))
    ?.operationId;
}

/** 请求和 operation 按稳定 ID 关联；失败后的下一条提问仍是一轮独立对话。 */
export function projectLogRounds(
  entries: Entry[],
  messages: ProjectedMessage[],
  metas: OperationMeta[] = [],
  results: OperationResultRecord[] = [],
  requests: StoredValue<RequestAssociation>[] = [],
): LogRound[] {
  const rawTurns: Entry[][] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") rawTurns.push([]);
    rawTurns.at(-1)?.push(entry);
  }
  const visibleTurns: ProjectedMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") visibleTurns.push([]);
    visibleTurns.at(-1)?.push(message);
  }
  return visibleTurns.map((visible, index) => {
    const user = visible.find((message) => message.role === "user");
    const raw = rawTurns.find((turn) => turn.some((entry) => entry.id === user?.entry_id)) ?? [];
    const operationId = operationFor(raw, metas, results);
    const result = results.find((result) => result.operationId === operationId);
    const request = requests.find((request) => request.value.operationId === operationId);
    const receipt = receiptContext(visible);
    const answers = visible.flatMap((message) =>
      message.role === "assistant" && message.text.trim() ? [message.text] : [],
    );
    const assistants = raw.filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const lastAssistant = assistants.at(-1);
    const finalError =
      lastAssistant?.type === "message" &&
      lastAssistant.message.role === "assistant" &&
      ["error", "length"].includes(lastAssistant.message.stopReason);
    const publicError = visible.some((message) => message.role === "assistant" && message.error);
    const aborted =
      result?.status === "aborted" ||
      (lastAssistant?.type === "message" &&
        lastAssistant.message.role === "assistant" &&
        lastAssistant.message.stopReason === "aborted");
    const status: LogStatus = aborted
      ? "cancelled"
      : result?.status === "failed" ||
          result?.status === "declined" ||
          finalError ||
          publicError ||
          receipt.failed
        ? "failed"
        : receipt.waiting
          ? "waiting_user"
          : result?.status === "completed"
            ? "success"
            : operationId
              ? "running"
              : "unknown";
    let retryCount = 0,
      modelIndex = 0,
      toolIndex = 0;
    const steps: LogStep[] = [];
    const timings = request?.value.timings_ms;
    const modelDurations = timings?.model.length === assistants.length ? timings.model : [];
    const toolEntries = raw.filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    const serialTools = assistants.every(
      (entry) =>
        entry.type !== "message" ||
        entry.message.role !== "assistant" ||
        entry.message.content.filter((block) => block.type === "toolCall").length <= 1,
    );
    const toolDurations =
      serialTools && timings?.tools.length === toolEntries.length ? timings.tools : [];
    for (const [rawIndex, entry] of raw.entries()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        const previous = raw[rawIndex - 1];
        const retry =
          previous?.type === "message" &&
          previous.message.role === "assistant" &&
          previous.message.stopReason === "error" &&
          entry.parentId === previous.id;
        if (retry) {
          retryCount += 1;
          // 重试等待只使用两次持久化时间戳的差值，不拿总耗时均摊。
          const wait = duration(message.timestamp - previous.timestamp);
          steps.push({
            id: `${entry.id}:retry`,
            name: "等待重试",
            status: "success",
            duration_ms: wait,
            note: `第 ${retryCount} 次自动重试`,
          });
        }
        steps.push({
          id: entry.id,
          name: retry ? "模型调用（重试）" : "模型调用",
          status:
            message.stopReason === "error" || message.stopReason === "length"
              ? "failed"
              : message.stopReason === "aborted"
                ? "cancelled"
                : "success",
          duration_ms: duration(modelDurations[modelIndex]),
          note:
            message.stopReason === "error"
              ? "模型调用失败"
              : message.stopReason === "length"
                ? "模型输出达到长度限制"
                : message.content.some((block) => block.type === "toolCall")
                  ? "生成工具调用"
                  : "生成系统回答",
        });
        modelIndex += 1;
      } else if (message.role === "toolResult" && !receipt.restricted) {
        steps.push({
          id: entry.id,
          name: toolNames[message.toolName] ?? message.toolName,
          status:
            message.isError ||
            receiptContext(visible.filter((item) => item.entry_id === entry.id)).failed
              ? "failed"
              : "success",
          duration_ms:
            duration(timings?.tool_calls?.[message.toolCallId]) ??
            duration(toolDurations[toolIndex]),
          note:
            message.isError ||
            receiptContext(visible.filter((item) => item.entry_id === entry.id)).failed
              ? "工具返回失败，请查看本轮回答与查询详情"
              : "工具已返回",
        });
        toolIndex += 1;
      }
    }
    const startedAt = result?.startedAt ?? request?.value.createdAt ?? user?.timestamp ?? null;
    const endedAt = result?.endedAt ?? null;
    const elapsed =
      duration(timings?.drive_total) ??
      (startedAt !== null && endedAt !== null ? duration(endedAt - startedAt) : null);
    // 没有生成终态的轮次不推断为成功；老记录缺测量值保持为空。
    if (!steps.length || status === "running")
      steps.push({
        id: `${user?.entry_id}:terminal`,
        name: status === "running" ? "等待执行完成" : "执行记录",
        status,
        duration_ms: null,
        note:
          status === "running" ? "该轮尚无完成记录，刷新可查看最新状态" : "历史记录未保存分步耗时",
      });
    const model = assistants.find(
      (entry) =>
        entry.type === "message" && entry.message.role === "assistant" && entry.message.model,
    );
    const modelError =
      lastAssistant?.type === "message" && lastAssistant.message.role === "assistant"
        ? lastAssistant.message.errorMessage
        : undefined;
    const timeout = [
      MODEL_FIRST_RESPONSE_TIMEOUT,
      MODEL_DEADLINE_EXCEEDED,
      MODEL_STREAM_IDLE_EXCEEDED,
    ].find((code) => modelError?.startsWith(code));
    const error = timeout ?? result?.error?.code ?? (publicError ? "MODEL_RESPONSE_FAILED" : null);
    return {
      id: user?.entry_id ?? `legacy-${index}`,
      number: index + 1,
      question: user?.role === "user" ? user.text : "",
      answers,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: elapsed,
      status,
      retry_count: retryCount,
      operation_id: operationId ?? null,
      request_id: request?.address.key.replace(/^request\//u, "") ?? null,
      model:
        model?.type === "message" && model.message.role === "assistant"
          ? model.message.model
          : null,
      error_code: error ?? (status === "failed" ? "EXECUTION_FAILED" : null),
      task_ids: receipt.restricted ? [] : receipt.task_ids,
      context: receipt.restricted ? { organizations: [], dates: [], metrics: [] } : receipt.context,
      steps,
      query_started: receipt.task_ids.length > 0,
      access_restricted: receipt.restricted,
    };
  });
}

export function filterLogSessions(
  sessions: LogSession[],
  options: { search: string; range: string; errors: boolean; page: number; pageSize: number },
  now = Date.now(),
) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const today = Date.parse(`${day}T00:00:00+08:00`);
  const since =
    options.range === "today" ? today : options.range === "7d" ? today - 6 * 86400_000 : 0;
  const query = options.search.trim().toLocaleLowerCase();
  const filtered = sessions
    .filter((session) => session.rounds.length && session.last_active_at >= since)
    .filter(
      (session) => !options.errors || session.rounds.some((round) => round.status === "failed"),
    )
    .filter(
      (session) =>
        !query ||
        [
          session.title,
          ...session.rounds.flatMap((round) => [round.question, ...round.answers]),
        ].some((text) => text.toLocaleLowerCase().includes(query)),
    )
    .sort(
      (left, right) =>
        right.last_active_at - left.last_active_at ||
        left.session_id.localeCompare(right.session_id),
    );
  const rounds = filtered.flatMap((session) => session.rounds),
    measured = rounds.filter((round) => round.duration_ms !== null);
  const page = Math.min(options.page, Math.max(1, Math.ceil(filtered.length / options.pageSize)));
  return {
    items: filtered.slice((page - 1) * options.pageSize, page * options.pageSize).map((session) => {
      const { rounds, ...metadata } = session;
      return {
        ...metadata,
        round_count: rounds.length,
        failed_count: rounds.filter((round) => round.status === "failed").length,
        status: rounds.at(-1)?.status ?? "unknown",
        last_question: rounds.at(-1)?.question ?? "",
        matched_text: query
          ? (rounds
              .flatMap((round) => [round.question, ...round.answers])
              .find((text) => text.toLocaleLowerCase().includes(query)) ?? null)
          : null,
      };
    }),
    total: filtered.length,
    page,
    page_size: options.pageSize,
    stats: {
      sessions: filtered.length,
      rounds: rounds.length,
      failed_rounds: rounds.filter((round) => round.status === "failed").length,
      average_duration_ms: measured.length
        ? measured.reduce((sum, round) => sum + (round.duration_ms ?? 0), 0) / measured.length
        : null,
    },
  };
}

export function createQueryLogRoutes(
  config: AgentServiceConfig,
  host: HarnessHost,
  store: NativeSessionStore,
  redact: Redact,
  legacySafe: (messages: ProjectedMessage[]) => ProjectedMessage[],
  evaluations?: EvaluationService,
) {
  const app = new Hono<{ Variables: Variables }>();
  const read = async (
    actor: BackendUser,
    id: string,
    token: string,
  ): Promise<LogSession | undefined> => {
    const native = await host.readSession(actor, id, async (session) => {
      const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
      const results = (await session.scanValues(operationResult(""), BACKGROUND_CONTEXT)).map(
        (record) => record.value,
      );
      const metas = (await session.scanValues(operationMeta(""), BACKGROUND_CONTEXT)).map(
        (record) => record.value,
      );
      const requests = await session.scanValues(
        value<RequestAssociation>("askmetric", "request/"),
        BACKGROUND_CONTEXT,
      );
      const messages = await redact(
        projectEntries(entries, results),
        token,
        new NativeSemanticTaskStore(session),
      );
      const rounds = projectLogRounds(entries, messages, metas, results, requests);
      return {
        session_id: id,
        title: (await session.getName(BACKGROUND_CONTEXT)) ?? "问数会话",
        created_at: session.metadata.createdAt,
        last_active_at: Math.max(
          session.metadata.createdAt,
          ...rounds.flatMap((round) => [
            round.started_at ?? 0,
            round.ended_at ?? round.started_at ?? 0,
          ]),
        ),
        rounds,
        legacy: false,
      };
    });
    if (native || store.cluster) return native;
    const legacy = getLegacySession(config.dataDir, actor.id, id);
    if (!legacy) return undefined;
    const messages = await redact(legacySafe(projectLegacyMessages(legacy)), token);
    return {
      session_id: id,
      title: legacy.title,
      created_at: legacy.createdAt,
      last_active_at: legacy.lastActiveAt,
      rounds: projectLogRounds([], messages),
      legacy: true,
    };
  };
  app.get("/", async (c) => {
    const page = Number(c.req.query("page") ?? 1),
      size = Number(c.req.query("page_size") ?? 10);
    const range = c.req.query("range") ?? "7d",
      search = c.req.query("search") ?? "";
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 100 ||
      !["today", "7d", "all"].includes(range) ||
      search.length > 4000
    )
      return c.json({ detail: "日志筛选参数无效" }, 400);
    const actor = c.get("user"),
      token = c.get("token");
    const excluded = new Set((await evaluations?.listSessionIds(actor.id)) ?? []);
    const ids = (await store.list(actor.id)).map((metadata) => metadata.id);
    if (!store.cluster)
      ids.push(...listLegacySessions(config.dataDir, actor.id).map((session) => session.id));
    const sessions: LogSession[] = [];
    // 限制并发打开文件/授权请求；统计先覆盖筛选全集，再做分页。
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = await Promise.all(
        ids
          .slice(offset, offset + 4)
          .filter((id) => !excluded.has(id))
          .map((id) => read(actor, id, token)),
      );
      for (const session of batch) if (session) sessions.push(session);
    }
    return c.json(
      filterLogSessions(sessions, {
        search,
        range,
        errors: c.req.query("errors_only") === "true",
        page,
        pageSize: size,
      }),
    );
  });
  app.get("/:id", async (c) => {
    const actor = c.get("user"),
      id = c.req.param("id");
    if ((await evaluations?.listSessionIds(actor.id))?.includes(id))
      return c.json({ detail: "会话日志不存在" }, 404);
    const session = await read(actor, id, c.get("token"));
    return session ? c.json(session) : c.json({ detail: "会话日志不存在" }, 404);
  });
  return app;
}
