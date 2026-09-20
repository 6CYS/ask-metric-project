/**
 * 薄原生宿主：只负责原生对象生命周期、同会话打开去重、请求关联落盘与调用原生接口。
 * 不决定工具顺序、不维护聊天历史、不自建摘要或 Agent 状态机——这些全部归 pi 原生。
 *
 * 数据流：HTTP 请求 → 校验 owner → 打开/复用原生 Session 与 main lane →
 * 先把 request→operation 关联写入原生应用 values → lane.accept → lane.drive。
 * 观察（SSE）使用独立的 lane.watch，与驱动 Context 分离，浏览器断线不中止执行。
 */
import { createHash } from "node:crypto";
import { activeClarificationTarget, coverageContext, historicalReadConflict, latestFollowupReference, queryCandidateBeforeTurn, queryReferenceContext } from "./queryContext.js";
import { modelUsage } from "./modelUsage.js";
import { projectHistoricalResults } from "./modelContext.js";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  LaneBusy,
  value,
  type AgentHarnessTool,
  type AgentLane,
  type Context,
  type DriveOutcome,
  type Entry,
  type JsonlSessionMetadata,
  type LaneSnapshot,
  type OpenOperation,
  type Session,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import type { AgentServiceConfig } from "./config.js";
import type { ModelBundle } from "./models.js";
import type { RetryPolicy } from "@earendil-works/pi-ai";
import type { BackendClient, BackendUser } from "./backendClient.js";
import { NativeSessionStore } from "./nativeSessions.js";
import {
  withRequestContext,
  requireRequestContext,
  type AskMetricRequestContext,
  type CommandBridge,
  type HistoryBridge,
  type HistoryEntrySummary,
  type WriteCommandRecord,
} from "./requestContext.js";
import { businessEvidence, evidenceAnswer } from "./answerEvidence.js";
import { buildBusinessSystemPrompt } from "./prompts/businessSystemPrompt.js";

/** 原生应用 values 的命名空间；只存归属与请求关联，不存 Agent 状态/槽位/业务结果 */
const NS = "askmetric";
const ownerValue = value<string>(NS, "owner");
const conversationValue = value<string>(NS, "conversationId");

/** 一次浏览器请求的持久关联：先落盘再接纳，重试凭同一 requestId 找回 */
export interface RequestAssociation {
  fingerprint: string;
  originalMessage: string;
  operationId: string;
  lane: string;
  createdAt: number;
  /** 本请求已接纳的独立业务写意图（同一 operation 最多一个） */
  write?: WriteCommandRecord;
  input?: PromptInput;
  timings_ms?: { model: number[]; tools: number[]; drive_total: number };
}

const requestValue = (requestId: string) => value<RequestAssociation>(NS, `request/${requestId}`);
/** operation → request 反查：重启恢复时凭 operationId 找回已接纳输入 */
const operationRequestValue = (operationId: string) => value<string>(NS, `operation/${operationId}`);

/** 完整 PromptInput 的确定性指纹：键排序序列化后取 SHA-256 */
export function promptFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** 业务命令键：同一请求内相同写意图去重；clarify 的受控版本刷新不改变该键 */
export function commandKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

/** 阶段键：同一命令的各业务阶段（submit/analyze/execute/clarify/cancel）独立幂等 */
export function phaseKey(key: string, phase: string): string {
  return createHash("sha256").update(canonicalJson({ command_key: key, phase })).digest("hex");
}

function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(input) ?? "null";
}

export interface HostedSession {
  sessionId: string;
  ownerUserId: string;
  session: Session<JsonlSessionMetadata>;
  harness: AgentHarness<AskMetricRequestContext>;
  lane: AgentLane;
  /** 重开时原生报告的未完成操作；恢复时重新授权后再处理 */
  open: OpenOperation[];
  createdAt: number;
}

/** 浏览器一次确认发送的完整输入（协议 V3）；标识与授权由宿主绑定，模型不可见 */
export interface PromptInput {
  protocol_version: 3;
  request_id: string;
  message: string;
  clarification_target?: { task_id: string; version: number; clarification_id: string };
  selected_answers?: Record<string, unknown>;
}

export type AdmitOutcome =
  | { ok: true; operationId: string; context: Context; request: AskMetricRequestContext }
  | { ok: false; code: "SESSION_BUSY" | "INVALID_MESSAGE" | "REQUEST_CONFLICT" | "SESSION_CLOSED"; message: string };

export type DriveOutcomeResult =
  | { ok: true; operationId: string; outcome: DriveOutcome }
  | { ok: false; code: "SESSION_BUSY" | "INVALID_MESSAGE" | "REQUEST_CONFLICT" | "SESSION_CLOSED"; message: string };

export class HarnessHost {
  /** 同会话打开 Promise 去重：并发请求共享同一次打开，不重复打开同一 Session */
  private readonly live = new Map<string, Promise<HostedSession>>();
  /** 会话级授权状态：撤权后该会话的后续模型请求（含压缩）在 provider 边界被拒 */
  private readonly authorization = new Map<string, { authorized: boolean }>();

  constructor(
    private readonly config: AgentServiceConfig,
    private readonly createModels: (authorize: () => boolean) => ModelBundle,
    private readonly store: NativeSessionStore,
    private readonly tools: AgentHarnessTool<AskMetricRequestContext>[],
    private readonly options: { retry?: RetryPolicy } = {},
  ) {}

  async createSession(actor: BackendUser): Promise<HostedSession> {
    const session = await this.store.create(actor.id);
    const hosted = await this.attach(actor, session);
    // 归属在创建时落定；缺 owner 的半创建会话不可见、不可运行
    await session.setValue(ownerValue, actor.id, BACKGROUND_CONTEXT);
    return hosted;
  }

  /** 打开当前身份名下的会话；不存在或不属于该用户都表现为不存在 */
  async openSession(actor: BackendUser, sessionId: string): Promise<HostedSession | undefined> {
    const pending = this.live.get(sessionId);
    if (pending) {
      const hosted = await pending;
      return hosted.ownerUserId === actor.id ? hosted : undefined;
    }
    const metadata = await this.store.findMetadata(actor.id, sessionId);
    if (!metadata) return undefined;
    const opening = this.store
      .open(actor.id, metadata)
      .then((session) => this.attach(actor, session))
      .then(async (hosted) => {
        const owner = await hosted.session.getValue(ownerValue, BACKGROUND_CONTEXT);
        if (owner?.value !== actor.id) throw new Error("SESSION_OWNER_MISMATCH");
        return hosted;
      });
    this.live.set(sessionId, opening);
    try {
      return await opening;
    } catch (error) {
      this.live.delete(sessionId);
      if (error instanceof Error && error.message === "SESSION_OWNER_MISMATCH") return undefined;
      throw error;
    }
  }

  /** 已创建会话的打开结果登记；调用方负责 this.live 去重，这里不再查表（避免自引用死锁） */
  private async attach(actor: BackendUser, session: Session<JsonlSessionMetadata>): Promise<HostedSession> {
    const sessionId = session.metadata.id;
    const opening = (async (): Promise<HostedSession> => {
      // 授权状态对象按会话共享引用，撤权即刻对该会话全部后续模型请求生效
      const authorization = { authorized: true };
      this.authorization.set(sessionId, authorization);
      const bundle = this.createModels(() => authorization.authorized);
      const { harness, open } = await AgentHarness.create(
        {
          session,
          models: bundle.models,
          model: bundle.model,
          tools: this.tools,
          toolExecution: "sequential",
          // 工具上下文即当次请求绑定；缺请求上下文说明链路被绕过，直接失败
          toolContext: (context) => requireRequestContext(context),
          systemPrompt: () => buildBusinessSystemPrompt(new Date().toISOString().slice(0, 10)),
          compaction: {
            enabled: this.config.compaction.enabled,
            reserveTokens: this.config.compaction.reserveTokens,
            keepRecentTokens: this.config.compaction.keepRecentTokens,
          },
          ...(this.options.retry ? { retry: this.options.retry } : {}),
        },
        BACKGROUND_CONTEXT,
      );
      const lane = await harness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
      // 原生会话持久化工具白名单；升级后同步注册集，旧会话也能选择新增覆盖工具。
      // 仅在空闲时更新，不改变正在恢复的操作的工具配置。
      const execution = await lane.inspectExecution(BACKGROUND_CONTEXT);
      if (!execution.current) await lane.setActiveTools(this.tools.map(tool => tool.name), BACKGROUND_CONTEXT);
      this.registerHooks(harness, lane);
      return {
        sessionId,
        ownerUserId: actor.id,
        session,
        harness,
        lane,
        open,
        createdAt: session.metadata.createdAt,
      };
    })();
    this.live.set(sessionId, opening);
    opening.catch(() => this.live.delete(sessionId));
    return opening;
  }

  /** /no_think 等提供方兼容只作用于发送副本，不改用户原文与原生历史 */
  private registerHooks(harness: AgentHarness<AskMetricRequestContext>, lane: AgentLane): void {
    // 原生 usage 事件同时覆盖业务调用、自动压缩和分支摘要；after_response 不覆盖原生摘要。
    harness.events.on("usage", (event, context) => {
      if (event.row.adjustment) return;
      const request = requireRequestContext(context);
      console.info(JSON.stringify({
        event: "model_usage", layer: "agent", usage_id: event.row.id,
        request_id: request.requestId, session_id: request.sessionId, operation_id: request.operationId,
        step: request.modelCall?.step ?? "unknown", attempt: request.modelCall?.attempt ?? null,
        model: request.modelCall?.model ?? null,
        payload_bytes: request.modelCall?.payloadBytes ?? null,
        duration_ms: request.modelCall ? Math.round(performance.now() - request.modelCall.startedAt) : null,
        ...modelUsage(event.row.usage),
      }));
    });
    harness.hooks.on("before_request", (event, context) => {
      const request = requireRequestContext(context);
      request.modelCall = { step: event.step, model: event.model.id, attempt: event.attempt, startedAt: performance.now() };
      const timings = request.timings;
      if (timings) timings.modelStartedAt = performance.now();
      return undefined;
    });
    harness.hooks.on("before_payload", (event, context) => {
      const request = requireRequestContext(context);
      const payload = event.payload as Record<string, unknown>;
      if (request.modelCall) request.modelCall.payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary") return undefined;
      // 仅显式提交澄清选择时固定工具。其他目标由 pi 判断是否需要工具，
      // 不支持的分析可直接说明限制，不能强迫它编造一个基础问数调用。
      if (request.clarificationTarget && this.tools.some(tool => tool.name === "metric_ask")
        && request.timings?.model_ms.length === 0
        && Array.isArray(payload.tools) && payload.tools.length) {
        return { payload: { ...payload, tool_choice: { type: "function", function: { name: "metric_ask" } } } };
      }
      return undefined;
    });
    harness.hooks.on("before_tool", async (event, context) => {
      const request = requireRequestContext(context);
      if (request.timings) (request.timings.toolStartedAt ??= {})[event.toolCallId] = performance.now();
      if (event.toolName === "metric_read" && event.args.kind === "result") {
        const entries = await lane.findEntries({order: "oldestFirst"}, context);
        if (historicalReadConflict(entries.filter(entry => entry.type === "message").map(entry => entry.message), event.args.task_id, request.originalMessage)) {
          return {block: {reason: "该结果日期比当前连续追问基准更早，但用户没有要求历史日期。纯换机构应使用 metric_ask followup，继承最新成功任务的日期；不能读该机构旧日期。", terminate: false}};
        }
      }
      if (event.toolName !== "metric_ask") return undefined;
      // 结构化澄清选择是用户确认的事实；普通文本由语义链判断对话关系。
      if (request.clarificationTarget) return { args: { action: "clarify", target: request.clarificationTarget } };
      if (event.args.action === "clarify") {
        const entries = await lane.findEntries({ order: "oldestFirst" }, context);
        const active = activeClarificationTarget(entries.filter(entry => entry.type === "message").map(entry => entry.message));
        const target = event.args.target;
        // 自然语言澄清只能引用正式待补充回执，禁止向失败任务提交模型编造的目标。
        if (!active || !target || typeof target !== "object" || Array.isArray(target)
          || target.task_id !== active.task_id || target.clarification_id !== active.clarification_id) {
          return { block: { reason: "没有与该目标匹配的有效待补充回执，不能执行clarify或编造clarification_id。用户修改条件重新提问请使用metric_ask action=new；条件有缺项也应由新任务分析并返回澄清。", terminate: false } };
        }
      }
      if (event.args.action === "new") {
        const entries = await lane.findEntries({ order: "oldestFirst" }, context);
        request.queryCandidate = queryCandidateBeforeTurn(entries.filter(entry => entry.type === "message").map(entry => entry.message));
      }
      if (event.args.action === "followup") {
        const entries = await lane.findEntries({ order: "oldestFirst" }, context);
        const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
        let latestUser = messages.length - 1;
        while (latestUser >= 0 && messages[latestUser]?.role !== "user") latestUser -= 1;
        const previous = messages.slice(0, latestUser).reverse().find(message => message.role === "toolResult" && businessEvidence(message.details));
        const previousEvidence = previous?.role === "toolResult" ? businessEvidence(previous.details) : undefined;
        if (previousEvidence && previousEvidence.status.toLowerCase() !== "succeeded") {
          return { block: { reason: previousEvidence.status.toLowerCase() === "clarification_required"
            ? "该来源仍待澄清，不能 followup。本轮已完整给出指标、机构、日期或另查独立问题时请用 metric_ask new；仅补充缺项时用 clarify。不要因旧任务待补充而要求用户重说已明确的条件。"
            : "上一轮修改未成功，请先确认本轮要沿用的机构和日期，不能自动退回更早成功查询。", terminate: false } };
        }
        const source = event.args.source;
        const latest = latestFollowupReference(messages, request.originalMessage);
        if (latest && source && typeof source === "object" && !Array.isArray(source) && source.task_id !== latest.task_id) {
          // 来源由本分支最新成功回执决定；回读后继续追问也必须继承刚展示的条件。
          if (typeof latest?.task_id === "string" && Number.isInteger(latest.version)) {
            return { args: { ...event.args, source: { task_id: latest.task_id, version: latest.version as number } } };
          }
          return { block: { reason: "省略追问必须沿用最近成功回执的机构和日期；请先读取该任务版本后再 followup。", terminate: false } };
        }
      }
      return undefined;
    });
    harness.hooks.on("after_tool", (event, context) => {
      const timings = requireRequestContext(context).timings;
      const started = timings?.toolStartedAt?.[event.toolCallId];
      if (timings && started !== undefined) {
        timings.tool_ms.push(Math.round(performance.now() - started));
        delete timings.toolStartedAt?.[event.toolCallId];
      }
      // 基础问数/澄清的完整回执已由后端确认，使用 pi 原生终止能力直接交付，
      // 不再串行调用一个模型复述确定性事实。目录与 task 状态读取仍继续原生循环。
      const evidence = businessEvidence(event.details);
      if (evidence) return { terminate: true };
      return undefined;
    });
    harness.hooks.on("after_response", async (event, context) => {
      const request = requireRequestContext(context);
      // 原生压缩与分支摘要不是业务回答，不能被数字过滤、工具强制或回执替换改写。
      if (request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary") return undefined;
      const timings = request.timings;
      if (timings?.modelStartedAt !== undefined) timings.model_ms.push(Math.round(performance.now() - timings.modelStartedAt));
      // 只读取原生当前分支，不维护第二份会话记忆；重启后仍遵守相同交付规则。
      const entries = await lane.findEntries({ order: "oldestFirst" }, context);
      const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
      let start = messages.length - 1;
      while (start >= 0 && messages[start]?.role !== "user") start -= 1;
      const current = messages.slice(start + 1);
      const receipts = current.filter(message => message.role === "toolResult");
      const confirmationNeeded = receipts.some(message => message.content.some(block => block.type === "text" && block.text.includes("上一轮修改未成功")));
      if (confirmationNeeded) return { message: { ...event.message, content: [{ type: "text" as const, text: "上一轮修改没有成功。本次要查询哪个机构、哪个日期？请明确这两个条件后继续。" }], stopReason: "stop" as const } };
      const write = await requireRequestContext(context).commands.getWriteCommand();
      const evidence = receipts.map(message => businessEvidence(message.details)).filter(item => item &&
        (!write?.taskId || item.task_id === write.taskId)).at(-1);
      if (evidence) {
        return { message: { ...event.message, content: [{ type: "text" as const, text: evidenceAnswer(evidence) }], stopReason: "stop" as const } };
      }
      // 确定性参数错误最多允许一次纠正；不让相同错误消耗无限模型调用。
      if (receipts.filter(message => message.isError ||
        (message.details as {status?: string} | undefined)?.status === "reference_mismatch").length >= 2) {
        return { message: { ...event.message, content: [{ type: "text" as const, text: "本次工具参数未能通过校验，请完整描述查询条件后重试。" }], stopReason: "stop" as const } };
      }
      // 没有工具证据的纯文本不得交付金额；工具调用前正文同样不能抢先泄露事实。
      const hasCalls = event.message.content.some(block => block.type === "toolCall");
      if (hasCalls) return { message: { ...event.message, content: event.message.content.filter(block => block.type !== "text") } };
      const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
      if (/\d/.test(text) && this.tools.some(tool => tool.name === "metric_ask")) {
        return { message: { ...event.message, content: [{ type: "text" as const, text: "本轮尚未取得查询结果，请确认要查询的指标、机构和日期。" }] } };
      }
      return undefined;
    });
    const suffix = this.config.model.userMessageSuffix;
    harness.hooks.on("transform_context", (event) => {
      const messages = projectHistoricalResults(event.messages);
      const last = messages[messages.length - 1] as
        | { role?: string; content?: unknown }
        | undefined;
      if (last?.role === "user" && Array.isArray(last.content) && suffix) {
        messages[messages.length - 1] = { ...last, content: [...last.content, {type: "text", text: suffix}] } as never;
      } else if (last?.role === "user" && typeof last.content === "string") {
        messages[messages.length - 1] = { ...last, content: last.content + suffix } as never;
      }
      return { messages, systemPrompt: event.systemPrompt + queryReferenceContext(event.messages) + coverageContext(event.messages) };
    });
  }

  /**
   * 接纳一次用户输入：先把 request→operation 关联写入原生应用 values，再 accept。
   * 同一 requestId 重试复用原 operationId，不产生第二条用户消息。
   * 返回的 context/request 供 drivePrompt 复用（同一次绑定，不重建）。
   */
  async admitPrompt(
    hosted: HostedSession,
    input: PromptInput,
    deps: { actor: BackendUser; backend: BackendClient },
  ): Promise<AdmitOutcome> {
    const fingerprint = promptFingerprint({ ...input });
    const existing = await hosted.session.getValue(requestValue(input.request_id), BACKGROUND_CONTEXT);
    if (existing && existing.value.fingerprint !== fingerprint) {
      return { ok: false, code: "REQUEST_CONFLICT", message: "同一 request_id 提交了不同输入" };
    }
    const operationId = existing?.value.operationId ?? hosted.session.idGenerator.next();
    const bridge = this.createCommandBridge(hosted, input.request_id);
    const requestContext: AskMetricRequestContext = {
      actor: deps.actor,
      backend: deps.backend.withTraceId?.(input.request_id) ?? deps.backend,
      originalMessage: input.message,
      promptFingerprint: fingerprint,
      sessionId: hosted.sessionId,
      requestId: input.request_id,
      operationId,
      commands: bridge,
      history: createHistoryBridge(hosted),
      timings: { startedAt: performance.now(), model_ms: [], tool_ms: [] },
      ...(input.clarification_target ? { clarificationTarget: input.clarification_target } : {}),
      ...(input.selected_answers ? { selectedAnswers: input.selected_answers } : {}),
    };
    const context = withRequestContext(requestContext, BACKGROUND_CONTEXT);
    if (!existing) {
      await hosted.session.setValue(
        requestValue(input.request_id),
        {
          fingerprint,
          input,
          originalMessage: input.message,
          operationId,
          lane: "main",
          createdAt: Date.now(),
        },
        context,
      );
      await hosted.session.setValue(operationRequestValue(operationId), input.request_id, context);
    }

    const admitted = await hosted.lane.accept(
      { kind: "prompt", operationId, prompt: input.message },
      context,
    );
    if (!admitted.ok) {
      if (LaneBusy.is(admitted.error)) {
        // 关联已存在时可能是同 operation 的重试：核对当前操作身份再决定
        const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
        if (existing && info.current?.id === operationId) {
          return { ok: true, operationId, context, request: requestContext };
        }
        return { ok: false, code: "SESSION_BUSY", message: "该会话正在处理上一个提问，请等待完成" };
      }
      return { ok: false, code: "INVALID_MESSAGE", message: admitted.error.message };
    }
    return { ok: true, operationId, context, request: requestContext };
  }

  /** 驱动已接纳的 operation；原生结果提交后调用方才允许发送终态 */
  async drivePrompt(hosted: HostedSession, admitted: Extract<AdmitOutcome, { ok: true }>): Promise<DriveOutcomeResult> {
    const driven = await hosted.lane.drive(
      { operationId: admitted.operationId, waitForRetry: true, pollDeferred: false },
      admitted.context,
    );
    const timings = admitted.request.timings;
    if (timings) {
      const stored = await hosted.session.getValue(requestValue(admitted.request.requestId), BACKGROUND_CONTEXT);
      const summary = { model: timings.model_ms, tools: timings.tool_ms, drive_total: Math.round(performance.now() - timings.startedAt) };
      if (stored) await hosted.session.setValue(requestValue(admitted.request.requestId), { ...stored.value, timings_ms: summary }, BACKGROUND_CONTEXT);
      console.info(JSON.stringify({ event: "agent_request_timing", session_id: hosted.sessionId, operation_id: admitted.operationId, request_id: admitted.request.requestId, timings_ms: summary }));
    }
    if (!driven.ok) {
      return { ok: false, code: "SESSION_CLOSED", message: driven.error.message };
    }
    return { ok: true, operationId: admitted.operationId, outcome: driven.value };
  }

  /** 一步到位：先接纳后驱动（测试与非流式调用用） */
  async runPrompt(
    hosted: HostedSession,
    input: PromptInput,
    deps: { actor: BackendUser; backend: BackendClient },
  ): Promise<DriveOutcomeResult> {
    const admitted = await this.admitPrompt(hosted, input, deps);
    if (!admitted.ok) return admitted;
    return this.drivePrompt(hosted, admitted);
  }

  /** 命令桥接：写命令登记与业务 conversation 映射落在原生应用 values，随会话持久 */
  private createCommandBridge(hosted: HostedSession, requestId: string): CommandBridge {
    const { session } = hosted;
    return {
      getWriteCommand: async () => {
        const stored = await session.getValue(requestValue(requestId), BACKGROUND_CONTEXT);
        return stored?.value.write;
      },
      setWriteCommand: async (record) => {
        const stored = await session.getValue(requestValue(requestId), BACKGROUND_CONTEXT);
        if (!stored) throw new Error("请求关联尚未建立，不能登记业务命令");
        await session.setValue(
          requestValue(requestId),
          { ...stored.value, write: record },
          BACKGROUND_CONTEXT,
        );
      },
      getConversationId: async () => {
        const stored = await session.getValue(conversationValue, BACKGROUND_CONTEXT);
        return stored?.value ?? null;
      },
      setConversationId: async (conversationId) => {
        await session.setValue(conversationValue, conversationId, BACKGROUND_CONTEXT);
      },
    };
  }

  /**
   * 会话是否有活动 operation：只有经本宿主打开过的会话才可能有活动执行，
   * 未打开的会话一定空闲（不为此挂载 harness）。
   */
  async isRunning(sessionId: string): Promise<boolean> {
    const pending = this.live.get(sessionId);
    if (!pending) return false;
    const hosted = await pending.catch(() => undefined);
    if (!hosted) return false;
    const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
    return Boolean(info.current);
  }

  /**
   * 重启恢复：重新授权后驱动重开时原生报告的未完成 operation。
   * 原文与标识从已接纳的请求关联读取，不使用落盘令牌；
   * 业务副作用由稳定命令键幂等保护，恢复不会重复提交。
   */
  async resumeOpenOperations(
    hosted: HostedSession,
    deps: { actor: BackendUser; backend: BackendClient },
  ): Promise<number> {
    let resumed = 0;
    // 同步取走本次待恢复列表，多个 GET 不会重复推进；失败项保留供下次认证重试。
    const pending = hosted.open.splice(0);
    for (const operation of pending) {
      if (operation.lane !== "main" || operation.kind !== "run") continue;
      const requestRef = await hosted.session.getValue(
        operationRequestValue(operation.operationId),
        BACKGROUND_CONTEXT,
      );
      if (!requestRef) continue;
      const association = await hosted.session.getValue(
        requestValue(requestRef.value),
        BACKGROUND_CONTEXT,
      );
      if (!association) continue;
      const requestContext: AskMetricRequestContext = {
        actor: deps.actor,
        backend: deps.backend.withTraceId?.(requestRef.value) ?? deps.backend,
        originalMessage: association.value.originalMessage,
        ...(association.value.input?.clarification_target ? { clarificationTarget: association.value.input.clarification_target } : {}),
        ...(association.value.input?.selected_answers ? { selectedAnswers: association.value.input.selected_answers } : {}),
        promptFingerprint: association.value.fingerprint,
        sessionId: hosted.sessionId,
        requestId: requestRef.value,
        operationId: operation.operationId,
        commands: this.createCommandBridge(hosted, requestRef.value),
        history: createHistoryBridge(hosted),
        timings: { startedAt: performance.now(), model_ms: [], tool_ms: [] },
      };
      try {
        const result = await hosted.lane.resume(withRequestContext(requestContext, BACKGROUND_CONTEXT));
        if (!result.ok) throw new Error("原生操作恢复暂时失败");
        resumed += 1;
      } catch (error) {
        hosted.open.push(operation);
        throw error;
      }
    }
    return resumed;
  }

  /** 观察会话：原生原子快照 + 订阅；调用方负责 unsubscribe，断线只停止观察 */
  async watch(
    hosted: HostedSession,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<WatchHandle<LaneSnapshot>> {
    return hosted.lane.watch(context);
  }

  /** 显式停止：原生取消指定 operation；不删除任何历史 */
  async abort(hosted: HostedSession, operationId: string): Promise<void> {
    await hosted.lane.requestAbort(operationId, BACKGROUND_CONTEXT);
  }

  /**
   * 标记会话授权失效（如历史引用被撤权）：之后的模型请求在 provider 边界被拒，
   * 页面应提示用户开启干净的新会话；原生记录保留，不做摘要清洗。
   */
  markContextAccessChanged(sessionId: string): void {
    const state = this.authorization.get(sessionId);
    if (state) state.authorized = false;
  }

  isAuthorized(sessionId: string): boolean {
    return this.authorization.get(sessionId)?.authorized ?? false;
  }

  /** 缓存淘汰或会话关闭：只关闭句柄，不删除历史数据 */
  async closeSession(sessionId: string): Promise<void> {
    const pending = this.live.get(sessionId);
    this.live.delete(sessionId);
    this.authorization.delete(sessionId);
    if (!pending) return;
    const hosted = await pending.catch(() => undefined);
    // harness.close 会连带关闭原生 Session；仓库层缓存同步释放
    await hosted?.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    if (hosted) await this.store.release(hosted.ownerUserId, sessionId);
  }

  async close(): Promise<void> {
    const ids = [...this.live.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }
}

/** 历史条目的可见文本：只含用户/助手正文与工具公开回执，过滤隐藏思考与自定义条目 */
function entryVisibleText(entry: Entry): string {
  if (entry.type === "message") {
    const message = entry.message as { role?: string; content?: unknown };
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = (message.content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
    }
    return `[${message.role ?? "message"}] ${text}`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return `[${entry.type}] ${entry.summary}`;
  }
  return "";
}

/** 按 Unicode code point 切片，避免与 Python/浏览器的字符计数口径混用 */
function sliceByCodePoints(text: string, offset: number, length: number): { text: string; next: number | null } {
  const chars = [...text];
  const slice = chars.slice(offset, offset + length).join("");
  const consumed = offset + [...slice].length;
  return { text: slice, next: consumed < chars.length ? consumed : null };
}

/** 原生历史受控回读：只读当前 lane 分支祖先；read 通过分页扫描命中，伪造/跨分支 ID 返回 null */
function createHistoryBridge(hosted: HostedSession): HistoryBridge {
  const { lane } = hosted;
  return {
    async list(beforeSeq, limit = 10) {
      const capped = Math.min(Math.max(limit ?? 10, 1), 20);
      const found = await lane.findEntries(
        {
          order: "newestFirst",
          limit: capped + 1,
          ...(beforeSeq !== undefined ? { cursor: { seq: beforeSeq } } : {}),
        },
        BACKGROUND_CONTEXT,
      );
      const page = found.slice(0, capped);
      const entries: HistoryEntrySummary[] = page.map((entry) => ({
        entry_id: entry.id,
        seq: entry.seq,
        type: entry.type,
        preview: sliceByCodePoints(entryVisibleText(entry), 0, 80).text,
      }));
      return {
        entries,
        next_before_seq: page.length ? page[page.length - 1]!.seq : null,
        has_more: found.length > capped,
      };
    },
    async read(entryId, offset = 0, length = 4000) {
      const cappedLength = Math.min(Math.max(length, 1), 8000);
      let cursor: number | undefined;
      for (;;) {
        const batch = await lane.findEntries(
          {
            order: "newestFirst",
            limit: 200,
            ...(cursor !== undefined ? { cursor: { seq: cursor } } : {}),
          },
          BACKGROUND_CONTEXT,
        );
        const hit = batch.find((entry) => entry.id === entryId);
        if (hit) {
          const sliced = sliceByCodePoints(entryVisibleText(hit), offset, cappedLength);
          return { entry_id: hit.id, seq: hit.seq, type: hit.type, text: sliced.text, next_offset: sliced.next };
        }
        if (batch.length < 200) return null;
        cursor = batch[batch.length - 1]!.seq;
      }
    },
  };
}
