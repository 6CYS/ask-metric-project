/**
 * 薄原生宿主：只负责原生对象生命周期、同会话打开去重、请求关联落盘与调用原生接口。
 * Pi 决定目标与执行意图；已校验 Frame 的下一动作接入原生工具循环，不另建会话状态机。
 *
 * 数据流：HTTP 请求 → 校验 owner → 打开/复用原生 Session 与 main lane →
 * 先把 request→operation 关联写入原生应用 values → lane.accept → lane.drive。
 * 观察（SSE）使用独立的 lane.watch，与驱动 Context 分离，浏览器断线不中止执行。
 */
import { NativeFrameStore, NativeBusinessResultStore } from "./business-context/store.js";
import { frameClarificationOptions, modelCapabilitySchemas, modelFrame, modelHistoryIndex } from "./business-context/modelView.js";
import { renderClarificationOptions } from "./business-context/clarificationOptions.js";
import { metricMentions } from "./business-context/metricMentions.js";
import { pendingBusinessAction, deterministicBusinessAction } from "./business-context/continuation.js";
import {businessKey} from "./business-context/service.js";
import {ACTION_REQUIRED, CONVERSATION_REPLY, MAX_ACTION_REPAIRS, currentTurnMessages, hasTurnAction, conversationAnswer} from "./tools/turnContract.js";
import { createHash } from "node:crypto";
import { legacyToolsFor } from "./tools/index.js";
import { auditToolCall, withToolExecutionAudit } from "./toolAudit.js";
import { modelUsage } from "./modelUsage.js";
import { projectHistoricalResults } from "./modelContext.js";
import {
  AgentHarness,
  type Skill,
  BACKGROUND_CONTEXT,
  LaneBusy,
  value,
  type AgentHarnessTool,
  type AgentHarnessToolInvocation,
  type AgentLane,
  type Context,
  type DriveOutcome,
  type Entry,
  type JsonlSessionMetadata,
  type LaneSnapshot,
  type OpenOperation,
  type OperationResultRecord,
  type Session,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import type { AgentServiceConfig } from "./config.js";
import type { ModelBundle } from "./models.js";
import type { ImageContent, JsonValue, RetryPolicy, TextContent } from "@earendil-works/pi-ai";
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
import { currentTurnEvidence } from "./answerEvidence.js";
import { createEvidenceRepairTool, EVIDENCE_REPAIR_TOOL, TOOL_LIMIT_ANSWER } from "./replyGuard.js";
import { businessKnowledgeCatalog, projectBusinessSkillContext } from "./businessSkills.js";
import { buildBusinessSystemPrompt } from "./prompts/businessSystemPrompt.js";

/** 原生应用 values 的命名空间；此命名空间只存归属与请求关联；业务状态使用独立 business 命名空间 */
const NS = "askmetric";
const MAX_TOOL_CALLS_PER_OPERATION = 24;
/**
 * 常驻内存治理：会话数量不设上限（历史只是磁盘文件），只回收内存中的 harness 与文件句柄。
 * 空闲超时或超过常驻上限时，从最久未用的空闲会话开始关闭；运行中、接纳中的会话不回收。
 */
const DEFAULT_RESIDENCY = {idleMs: 30 * 60_000, maxResident: 200, sweepIntervalMs: 60_000};
const TITLE_CACHE_LIMIT = 5_000;
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
  readOnlyReason?: "LEGACY_QUERY_REQUIRES_NEW_TURN";
}

/** 浏览器一次确认发送的完整输入（协议 V3）；标识与授权由宿主绑定，模型不可见 */
export interface PromptInput {
  protocol_version: 3;
  request_id: string;
  message: string;
  clarification_target?: { task_id: string; version: number; clarification_id: string };
  selected_answers?: Record<string, unknown>;
  /** 点选待确认清单的选项；系统按选项标识应用，模型不可见 */
  clarification_selection?: { frame_id: string; option_ids: string[] };
}

export type AdmitOutcome =
  | { ok: true; operationId: string; context: Context; request: AskMetricRequestContext;
      /** 同一 request_id 的操作已结束：重试只回放原终态，不再接纳或驱动 */
      completed?: OperationResultRecord }
  | { ok: false; code: "SESSION_BUSY" | "INVALID_MESSAGE" | "REQUEST_CONFLICT" | "SESSION_CLOSED" | "LEGACY_QUERY_REQUIRES_NEW_TURN"; message: string };

export type DriveOutcomeResult =
  | { ok: true; operationId: string; outcome: DriveOutcome }
  | { ok: false; code: "SESSION_BUSY" | "INVALID_MESSAGE" | "REQUEST_CONFLICT" | "SESSION_CLOSED" | "LEGACY_QUERY_REQUIRES_NEW_TURN"; message: string };

export class HarnessHost {
  /** 同会话打开 Promise 去重：并发请求共享同一次打开，不重复打开同一 Session */
  private readonly live = new Map<string, Promise<HostedSession>>();
  /** 会话级授权状态：撤权后该会话的后续模型请求（含压缩）在 provider 边界被拒 */
  private readonly authorization = new Map<string, { authorized: boolean }>();
  /** 同会话接纳串行化：请求关联的“读→写→accept”跨多个 await，并发时会互相覆盖 */
  private readonly admissions = new Map<string, Promise<void>>();
  /** 已打开会话的最近使用时间；回收只看这里，列表读取不延长常驻 */
  private readonly lastUsed = new Map<string, number>();
  /** 列表读取标题时的临时打开；正式打开须等其释放，避免复用即将被关闭的 Session */
  private readonly peeks = new Map<string, Promise<unknown>>();
  private readonly titles = new Map<string, string | undefined>();
  private readonly residency: typeof DEFAULT_RESIDENCY;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AgentServiceConfig,
    private readonly createModels: (authorize: () => boolean) => ModelBundle,
    private readonly store: NativeSessionStore,
    private readonly tools: AgentHarnessTool<AskMetricRequestContext>[],
    private readonly options: { retry?: RetryPolicy; skills?: Skill[];
      residency?: Partial<typeof DEFAULT_RESIDENCY> } = {},
  ) {
    this.residency = {...DEFAULT_RESIDENCY, ...options.residency};
    this.sweeper = setInterval(() => {
      void this.evictIdle().catch((error: unknown) => console.error(JSON.stringify({event: "session_eviction_failed",
        reason: error instanceof Error ? error.message : String(error)})));
    }, this.residency.sweepIntervalMs);
    this.sweeper.unref();
  }

  async createSession(actor: BackendUser): Promise<HostedSession> {
    const session = await this.store.create(actor.id);
    const hosted = await this.attach(actor, session);
    this.touch(hosted.sessionId);
    // 归属在创建时落定；缺 owner 的半创建会话不可见、不可运行
    await session.setValue(ownerValue, actor.id, BACKGROUND_CONTEXT);
    return hosted;
  }

  /** 打开当前身份名下的会话；不存在或不属于该用户都表现为不存在 */
  async openSession(actor: BackendUser, sessionId: string): Promise<HostedSession | undefined> {
    const known = await this.liveFor(actor, sessionId);
    if (known !== null) return known;
    const metadata = await this.store.findMetadata(actor.id, sessionId);
    if (!metadata) return undefined;
    await this.peeks.get(sessionId)?.catch(() => undefined);
    // 上面的等待期间可能已有并发请求开始打开；复查后同步登记，同一 Session 只挂一个 harness。
    const raced = await this.liveFor(actor, sessionId);
    if (raced !== null) return raced;
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
      const hosted = await opening;
      this.touch(sessionId);
      return hosted;
    } catch (error) {
      this.live.delete(sessionId);
      if (error instanceof Error && error.message === "SESSION_OWNER_MISMATCH") return undefined;
      throw error;
    }
  }

  /** 已在打开或已打开：返回归属校验后的结果；null 表示尚未打开 */
  private async liveFor(actor: BackendUser, sessionId: string): Promise<HostedSession | undefined | null> {
    const pending = this.live.get(sessionId);
    if (!pending) return null;
    const hosted = await pending;
    if (hosted.ownerUserId !== actor.id) return undefined;
    this.touch(sessionId);
    return hosted;
  }

  private touch(sessionId: string): void {
    if (this.live.has(sessionId)) this.lastUsed.set(sessionId, Date.now());
  }

  /**
   * 回收空闲会话的内存句柄（不删除历史）。按最久未用排序：超时的一律回收，
   * 未超时的仅在超过常驻上限时回收；运行中、接纳中或检查期间被再次使用的跳过。
   */
  async evictIdle(now = Date.now()): Promise<string[]> {
    const byAge = [...this.lastUsed.entries()].sort((a, b) => a[1] - b[1]);
    let resident = byAge.length;
    const evicted: string[] = [];
    for (const [sessionId, usedAt] of byAge) {
      if (now - usedAt <= this.residency.idleMs && resident <= this.residency.maxResident) break;
      if (this.admissions.has(sessionId)) continue;
      const hosted = await this.live.get(sessionId)?.catch(() => undefined);
      if (!hosted) { this.lastUsed.delete(sessionId); continue; }
      const execution = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
      if (execution.current || this.admissions.has(sessionId) || this.lastUsed.get(sessionId) !== usedAt) continue;
      await this.closeSession(sessionId);
      resident -= 1;
      evicted.push(sessionId);
    }
    return evicted;
  }

  /**
   * 列表标题：已打开的会话直接读取；未打开的临时打开、读完即释放，不因浏览列表常驻内存。
   * 名称写入会更新文件修改时间，缓存按 id+修改时间失效。
   */
  async sessionTitle(ownerUserId: string, metadata: JsonlSessionMetadata): Promise<string | undefined> {
    const cacheKey = `${metadata.id}:${metadata.modifiedAt}`;
    if (this.titles.has(cacheKey)) return this.titles.get(cacheKey);
    const pending = this.live.get(metadata.id);
    let title: string | undefined;
    if (pending) {
      title = await (await pending.catch(() => undefined))?.session.getName(BACKGROUND_CONTEXT);
    } else {
      await this.peeks.get(metadata.id)?.catch(() => undefined);
      const peek = (async () => {
        const session = await this.store.open(ownerUserId, metadata);
        try {
          return await session.getName(BACKGROUND_CONTEXT);
        } finally {
          if (!this.live.has(metadata.id)) await this.store.release(ownerUserId, metadata.id);
        }
      })();
      this.peeks.set(metadata.id, peek);
      try { title = await peek; } finally { if (this.peeks.get(metadata.id) === peek) this.peeks.delete(metadata.id); }
    }
    if (this.titles.size >= TITLE_CACHE_LIMIT) this.titles.clear();
    this.titles.set(cacheKey, title);
    return title;
  }

  /** 已创建会话的打开结果登记；调用方负责 this.live 去重，这里不再查表（避免自引用死锁） */
  private async attach(actor: BackendUser, session: Session<JsonlSessionMetadata>): Promise<HostedSession> {
    const sessionId = session.metadata.id;
    const opening = (async (): Promise<HostedSession> => {
      // 授权状态对象按会话共享引用，撤权即刻对该会话全部后续模型请求生效
      const authorization = { authorized: true };
      this.authorization.set(sessionId, authorization);
      const bundle = this.createModels(() => authorization.authorized);
      const runtimeTools = [...this.tools, ...legacyToolsFor(this.tools), createEvidenceRepairTool()].map(withToolExecutionAudit);
      const { harness, open } = await AgentHarness.create(
        {
          session,
          models: bundle.models,
          model: bundle.model,
          tools: runtimeTools,
          toolExecution: "sequential",
          // 工具上下文即当次请求绑定；缺请求上下文说明链路被绕过，直接失败
          toolContext: (context) => requireRequestContext(context),
          resources: { skills: this.options.skills ?? [] },
          systemPrompt: () => buildBusinessSystemPrompt(new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date())) + businessKnowledgeCatalog(this.options.skills ?? []),
          compaction: {
            enabled: this.config.compaction.enabled,
            reserveTokens: this.config.compaction.reserveTokens,
            keepRecentTokens: this.config.compaction.keepRecentTokens,
          },
          // 显式收紧重试：不传则回落到 SDK 默认（3 次重试 + 指数退避），失败要拖满两分钟才暴露。
          retry: this.options.retry ?? this.config.modelRetry,
        },
        BACKGROUND_CONTEXT,
      );
      const lane = await harness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
      // 原生会话持久化工具白名单；升级后同步注册集，旧会话也能选择新增覆盖工具。
      // 仅在空闲时更新，不改变正在恢复的操作的工具配置。
      const execution = await lane.inspectExecution(BACKGROUND_CONTEXT);
      const activeTools = await lane.getActiveTools(BACKGROUND_CONTEXT);
      const retired = this.tools.some(tool => tool.name === "resolve_business_turn")
        && activeTools.some(name => ["metric_ask", "metric_query_structured", "data_availability", "metric_calculate", "answer_present"].includes(name));
      if (!execution.current && !retired) await lane.setActiveTools(this.tools.map(tool => tool.name), BACKGROUND_CONTEXT);
      this.registerHooks(harness, lane);
      return {
        sessionId,
        ownerUserId: actor.id,
        session,
        harness,
        lane,
        open,
        createdAt: session.metadata.createdAt,
        ...(retired ? {readOnlyReason: "LEGACY_QUERY_REQUIRES_NEW_TURN" as const} : {}),
      };
    })();
    this.live.set(sessionId, opening);
    opening.catch(() => this.live.delete(sessionId));
    return opening;
  }

  /**
   * 把已校验的执行意图接在解析回执上落地：工具与参数都由 Frame 决定，模型和网关都不能改写。
   * 返回的 patch 由原生 finalizeToolCall 写成持久化回执，因此证据、投影与审计看到的仍是业务回执原文。
   * 任何意外都向上抛给调用方降级：保留原 READY 回执，按原协议由下一次模型响应接续执行。
   */
  private async landValidatedAction(
    event: {toolName: string; toolCallId: string; details?: unknown; isError: boolean},
    request: AskMetricRequestContext,
    context: Context,
  ): Promise<{content: Array<TextContent | ImageContent>; details: JsonValue} | undefined> {
    if (event.toolName !== "resolve_business_turn" || event.isError) return;
    const details = event.details as {kind?: string; status?: string; frame_id?: string} | undefined;
    if (details?.kind !== "business_context" || !details.frame_id || !request.frames) return;
    const state = await request.frames.state();
    if (state.focusFrameId !== details.frame_id) return;
    const frame = await request.frames.get(details.frame_id);
    const action = deterministicBusinessAction(frame, details.status, request);
    if (!action) return;
    const tool = this.tools.find(item => item.name === action.name);
    if (!tool) return;
    auditToolCall(request, event.toolCallId, action.name, "admitted", action.arguments);
    const result = await tool.execute(event.toolCallId, action.arguments as never, () => {}, request, invocationOf(event.toolCallId, request), context);
    auditToolCall(request, event.toolCallId, action.name, "executed", action.arguments);
    return {content: landedReceipt(result.content, action.name, details.frame_id, result.details),
      details: result.details as JsonValue};
  }

  /** /no_think 等提供方兼容只作用于发送副本，不改用户原文与原生历史 */
  private registerHooks(harness: AgentHarness<AskMetricRequestContext>, lane: AgentLane): void {
    const registeredNames = new Set([...this.tools, ...legacyToolsFor(this.tools)].map(tool => tool.name));
    const turnContract = registeredNames.has(CONVERSATION_REPLY) && registeredNames.has(ACTION_REQUIRED);
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
    harness.hooks.on("before_payload", async (event, context) => {
      const request = requireRequestContext(context);
      let payload = event.payload as Record<string, unknown>;
      if (request.modelCall) request.modelCall.payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary") return undefined;
      // 业务工具由 Pi 自主选择；旧交付工具仅为读取旧操作注册，不再对模型暴露。
      if (Array.isArray(payload.tools)) {
        const activeNames = payload.tools.map(raw => {
          const definition = raw as {name?: string; function?: {name?: string}};
          return definition.function?.name ?? definition.name;
        });
        payload = {...payload, tools: payload.tools.filter(raw => {
          const definition = raw as {name?: string; function?: {name?: string}};
          const name = definition.function?.name ?? definition.name;
          if (name === ACTION_REQUIRED || name === EVIDENCE_REPAIR_TOOL || name === "answer_present" && this.tools.some(tool => tool.name === "resolve_business_turn")) return false;
          // 已持久化的旧操作沿用原活跃集恢复；新请求在接纳前切换为合并入口。
          if (["metric_read", "session_history_read"].includes(name ?? "")) return !activeNames.includes("read");
          if (["metric_catalog_search", "org_catalog_search", "metric_catalog_overview"].includes(name ?? "")) return !activeNames.includes("catalog");
          return true;
        })};
      }
      const messages = await currentLaneMessages(lane, context);
      const current = currentTurnMessages(messages);
      const contractActive = turnContract && (await lane.getActiveTools(context)).includes(CONVERSATION_REPLY);
      if (contractActive && conversationAnswer(current) !== undefined) {
        const {tools: _tools, ...answerPayload} = payload;
        return {payload: {...answerPayload, tool_choice: "none"}};
      }
      if (contractActive && hasTurnAction(current) && Array.isArray(payload.tools)) {
        // 已进入业务处理后继续用真实回执回答，不允许再改报“本轮无需动作”。
        payload = {...payload, tools: payload.tools.filter(raw =>
          (raw as {function?: {name?: string}}).function?.name !== CONVERSATION_REPLY)};
      }
      const lastResolution = [...messages].reverse().find(message => message.role === "toolResult" && message.toolName === "resolve_business_turn");
      if (lastResolution?.role === "toolResult"
        && (lastResolution.details as {status?: string} | undefined)?.status === "NEEDS_CLARIFICATION") {
        // 待用户补充时只生成澄清问题；重复检索不能代替用户确认。
        // 已等待用户时不再发送可调用定义，避免兼容网关仍生成工具协议文本。
        const {tools: _tools, ...clarificationPayload} = payload;
        return {payload: {...clarificationPayload, tool_choice: "none"}};
      }
      const action = await pendingBusinessAction(messages, request);
      if (action && Array.isArray(payload.tools)
        && payload.tools.some(raw => (raw as {function?: {name?: string}}).function?.name === action.name)) {
        return {payload: {...payload, tool_choice: {type: "function", function: {name: action.name}}}};
      }
      if (contractActive && !hasTurnAction(current) && Array.isArray(payload.tools) && payload.tools.length) {
        // 与是否重复提及指标无关：Pi 选择实际业务动作或显式普通回答，纯文字不能冒充动作。
        return {payload: {...payload, tool_choice: "required"}};
      }
      // 已命中正式指标的本轮先取得业务工具回执，避免模型只输出长篇计划直至请求超时。
      // 不指定具体能力：查询、目录解释和历史指代仍由 Pi 在可用工具中选择。
      let turnStart = messages.length - 1;
      while (turnStart >= 0 && messages[turnStart]?.role !== "user") turnStart -= 1;
      const turn = messages.slice(turnStart + 1);
      const hasBusinessReceipt = turn.some(message => message.role === "toolResult"
        && message.toolName !== "business_skill_read");
      if (!hasBusinessReceipt && Array.isArray(payload.tools) && payload.tools.length
        && typeof request.backend.matchMetricQuestion === "function") {
        const matched = await metricMentions(request);
        if (!matched.status && matched.mentions.length) return {payload: {...payload, tool_choice: "required"}};
      }
      return {payload};
    });
    harness.hooks.on("before_tool", async (event, context) => {
      const request = requireRequestContext(context);
      if (request.timings) (request.timings.toolStartedAt ??= {})[event.toolCallId] = performance.now();
      const decide = async () => {
        // 从原生记录统计本轮预算，恢复后不重置；业务状态仍由后端管理。
        const budgetMessages = await currentLaneMessages(lane, context);
        if (turnContract && conversationAnswer(currentTurnMessages(budgetMessages)) !== undefined) {
          return {block: {reason: "本轮已选择无需业务操作的普通回答，不能追加业务动作。", terminate: true}};
        }
        if (turnContract && event.toolName === CONVERSATION_REPLY && hasTurnAction(currentTurnMessages(budgetMessages))) {
          return {block: {reason: "本轮已有业务动作，请依据实际回执回答，不能改报无需业务操作。", terminate: false}};
        }
        let turnStart = budgetMessages.length - 1;
        while (turnStart >= 0 && budgetMessages[turnStart]?.role !== "user") turnStart -= 1;
        const toolCount = budgetMessages.slice(turnStart + 1).filter(message => message.role === "toolResult").length;
        if (toolCount >= MAX_TOOL_CALLS_PER_OPERATION) return {block: {reason: TOOL_LIMIT_ANSWER, terminate: true}};
        const lastResolution = [...budgetMessages].reverse().find(message => message.role === "toolResult" && message.toolName === "resolve_business_turn");
        if (lastResolution?.role === "toolResult" && (lastResolution.details as {status?: string})?.status === "NEEDS_CLARIFICATION") {
          return {block: {reason: "当前业务状态等待用户补充。请依据已有 issues 和 candidates 生成澄清问题并结束本轮，不能继续调用工具代替用户确认。", terminate: false}};
        }
        if (this.tools.some(tool => tool.name === "resolve_business_turn")
          && ["metric_ask", "metric_query_structured", "data_availability", "metric_calculate", "answer_present", EVIDENCE_REPAIR_TOOL].includes(event.toolName)) {
          return {block: {reason: "查询入口已升级：请使用 resolve_business_turn 解析并校验字段，再执行 READY Frame。", terminate: false}};
        }
        return undefined;
      };
      const decision = await decide();
      auditToolCall(request, event.toolCallId, event.toolName, decision?.block ? "blocked" : "admitted", event.args);
      return decision;
    });
    harness.hooks.on("after_tool", async (event, context) => {
      const request = requireRequestContext(context);
      const timings = request.timings;
      const started = timings?.toolStartedAt?.[event.toolCallId];
      if (timings && started !== undefined) {
        timings.tool_ms.push(Math.round(performance.now() - started));
        delete timings.toolStartedAt?.[event.toolCallId];
      }
      // 解析回执为 READY/REUSE_RESULT 时，下一步调用与参数都已由 Frame 确定，
      // 直接在原生回执上落地，不再为一次必然被宿主改写掉的模型往返付出整份 prompt 的耗时。
      const landingStarted = performance.now();
      const landed = await this.landValidatedAction(event, request, context).catch(error => {
        // 落地失败不影响本轮：回执保持 READY，before_payload/after_response 的原协议仍会接续执行。
        console.error(JSON.stringify({event: "business_action_landing_failed", request_id: request.requestId,
          operation_id: request.operationId, reason: error instanceof Error ? error.message : String(error)}));
        return undefined;
      });
      // 就地执行的耗时单独记一笔，诊断里仍能看到这次后端查询的真实成本。
      if (landed && timings) timings.tool_ms.push(Math.round(performance.now() - landingStarted));
      return landed;
    });
    harness.hooks.on("after_response", async (event, context) => {
      const request = requireRequestContext(context);
      // 原生压缩与分支摘要不是业务回答，不能被数字过滤、工具强制或回执替换改写。
      if (request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary") return undefined;
      for (const block of event.message.content) {
        if (block.type === "toolCall") auditToolCall(request, block.id,
          registeredNames.has(block.name) ? block.name : "unknown", "proposed", block.arguments);
      }
      const timings = request.timings;
      if (timings?.modelStartedAt !== undefined) timings.model_ms.push(Math.round(performance.now() - timings.modelStartedAt));
      // 传输失败交回 pi 原生重试/失败处理，不能伪造成工具调用或正常结束。
      if (["error", "aborted"].includes(event.message.stopReason)) return undefined;
      // 只读取原生当前分支，不维护第二份会话记忆；重启后仍遵守相同交付规则。
      const messages = await currentLaneMessages(lane, context);
      let start = messages.length - 1;
      while (start >= 0 && messages[start]?.role !== "user") start -= 1;
      const current = messages.slice(start + 1);
      const receipts = current.filter(message => message.role === "toolResult");
      const plainAnswer = turnContract ? conversationAnswer(current) : undefined;
      if (plainAnswer !== undefined) {
        // 普通回答选择没有业务副作用；网关忽略 none 也不能在其后插入取数或改焦点。
        return {message: {...event.message, content: [{type: "text" as const, text: plainAnswer}], stopReason: "stop" as const}};
      }
      let inputFailures = 0;
      for (const receipt of [...receipts].reverse()) {
        const status = (receipt.details as {status?: string} | undefined)?.status;
        // resolve 就地执行后，业务终态（succeeded/failed）与 READY 一样是本轮解析的终点，
        // 不能继续往前扫到更早的 ARGUMENT_ERROR 误判为连续失败。
        if (receipt.toolName === "resolve_business_turn"
          && ["READY", "REUSE_RESULT", "NEEDS_CLARIFICATION", "succeeded", "failed"].includes(status ?? "")) break;
        if (status === "ARGUMENT_ERROR" || receipt.toolName === "resolve_business_turn" && receipt.isError) inputFailures += 1;
      }
      if (inputFailures >= 3) {
        return {message: {...event.message, content: [{type: "text" as const,
          text: "本轮参数解析连续失败，已停止重复尝试；原查询条件和待确认候选已保留，未执行新的业务查询。"}], stopReason: "stop" as const}};
      }
      // 同一工具重复相同失败才终止；不同错误表示纠错仍在推进，总调用预算仍生效。
      const failedArguments = (receipt: (typeof receipts)[number]) => {
        for (const message of current.slice(0, current.indexOf(receipt)).reverse()) {
          if (message.role !== "assistant") continue;
          const call = message.content.find(block => block.type === "toolCall"
            && block.id === receipt.toolCallId && block.name === receipt.toolName);
          if (call?.type === "toolCall") return businessKey(call.arguments);
        }
        return undefined;
      };
      if (receipts.length >= 2 && receipts.at(-1)?.toolName === receipts.at(-2)?.toolName
        && failedArguments(receipts.at(-1)!) !== undefined
        && failedArguments(receipts.at(-1)!) === failedArguments(receipts.at(-2)!)
        && JSON.stringify(receipts.at(-1)?.content) === JSON.stringify(receipts.at(-2)?.content)
        && receipts.slice(-2).filter(message => message.isError ||
        (message.details as {retryable?: boolean} | undefined)?.retryable ||
        (message.details as {status?: string} | undefined)?.status === "reference_mismatch").length >= 2) {
        return { message: { ...event.message, content: [{ type: "text" as const, text: "本轮工具调用参数连续未通过校验，系统未能完成查询。可以重试本轮问题，无需重复已确认的条件。" }], stopReason: "stop" as const } };
      }
      // 后续工具调用保留，不能用中间回执替换 Pi 尚未完成的业务步骤。
      const hasCalls = event.message.content.some(block => block.type === "toolCall");
      const calls = event.message.content.filter(block => block.type === "toolCall");
      const conflictingAnswer = calls.length > 1 && calls.some(call => call.name === CONVERSATION_REPLY);
      if (turnContract && (!hasCalls || conflictingAnswer) && !hasTurnAction(current)
        && (await lane.getActiveTools(context)).includes(CONVERSATION_REPLY)) {
        const attempts = receipts.filter(receipt => receipt.toolName === ACTION_REQUIRED).length;
        if (attempts >= MAX_ACTION_REPAIRS) {
          return {message: {...event.message, content: [{type: "text" as const,
            text: "本轮未能发起所需操作，原业务条件保持不变，未执行新的查询。请重试本轮请求。"}],
            stopReason: "error" as const, errorMessage: "BUSINESS_ACTION_NOT_STARTED"}};
        }
        // 网关忽略 required 时仅补协议纠错，不从文字猜工具参数；次数来自原生记录，恢复不归零。
        const call = {type: "toolCall" as const, id: `action-required-${attempts + 1}`, name: ACTION_REQUIRED, arguments: {}};
        auditToolCall(request, call.id, call.name, "proposed", call.arguments);
        return {message: {...event.message, content: [call], stopReason: "toolUse" as const}};
      }
      // 正常回合在预算边界交付未完成正文；before_tool 同时兜住同一批并行调用。
      if (hasCalls && receipts.length >= MAX_TOOL_CALLS_PER_OPERATION) {
        return {message: {...event.message, content: [{type: "text" as const, text: TOOL_LIMIT_ANSWER}], stopReason: "stop" as const}};
      }
      const action = receipts.length < MAX_TOOL_CALLS_PER_OPERATION
        ? await pendingBusinessAction(messages, request) : undefined;
      if (action && registeredNames.has(action.name)) {
        // 网关即使忽略 tool_choice、模型提前确认或传错引用，也落实已校验的同一执行意图。
        // 调用仍经过 Pi 原生 before_tool、权限、幂等和回执落盘；不直接调用后端。
        const call = {type: "toolCall" as const,
          id: `frame-${createHash("sha256").update(`${action.name}:${action.arguments.frameId}`).digest("hex").slice(0, 24)}`,
          ...action};
        auditToolCall(request, call.id, call.name, "proposed", call.arguments);
        return {message: {...event.message, content: [call], stopReason: "toolUse" as const}};
      }
      if (hasCalls) return { message: { ...event.message, content: event.message.content.filter(block => block.type !== "text") } };
      // 待确认时由系统追加规范编号清单：用户看到的与系统保存的是同一份，回复据此对应，模型不罗列候选。
      const clarification = [...receipts].reverse().find(message => message.toolName === "resolve_business_turn");
      const clarifyingFrameId = (clarification?.details as {status?: string; frame_id?: string} | undefined)?.status === "NEEDS_CLARIFICATION"
        ? (clarification!.details as {frame_id?: string}).frame_id : undefined;
      const frame = clarifyingFrameId ? await request.frames?.get(clarifyingFrameId) : undefined;
      const listing = frame ? renderClarificationOptions(frameClarificationOptions(frame),
        Object.values(frame.fields).some(field => field.metadata?.confirmationUnclear === true)) : "";
      if (listing) {
        const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
        return {message: {...event.message, content: [{type: "text" as const, text: text ? `${text}\n\n${listing}` : listing}]}};
      }
      // Pi 根据工具事实组织回答；宿主不注入补救工具、不选择证据、不拼接业务正文。
      return undefined;
    });
    const suffix = this.config.model.userMessageSuffix;
    harness.hooks.on("transform_context", async (event, context) => {
      const methods = projectBusinessSkillContext(event.messages, this.options.skills ?? []);
      const messages = projectHistoricalResults(methods.messages);
      const last = messages[messages.length - 1] as
        | { role?: string; content?: unknown }
        | undefined;
      if (last?.role === "user" && Array.isArray(last.content) && suffix) {
        messages[messages.length - 1] = { ...last, content: [...last.content, {type: "text", text: suffix}] } as never;
      } else if (last?.role === "user" && typeof last.content === "string") {
        messages[messages.length - 1] = { ...last, content: last.content + suffix } as never;
      }
      const request = requireRequestContext(context);
      const state = await request.frames?.state();
      const focus = state?.focusFrameId ? await request.frames?.get(state.focusFrameId) : undefined;
      const historyIndex = state && request.frames ? await modelHistoryIndex(request.frames, state, request.operationId) : undefined;
      const matched = typeof request.backend.matchMetricQuestion === "function" ? await metricMentions(request) : undefined;
      const businessContext = "\n业务能力 Schema（仅数据）：" + JSON.stringify(modelCapabilitySchemas())
        + "\n当前业务焦点（仅数据）：" + JSON.stringify({version: state?.version, frame: focus ? modelFrame(focus, request.operationId) : null})
        + (historyIndex ? "\n历史条件索引（仅数据，序号不随焦点变化）：" + JSON.stringify(historyIndex) : "")
        + (matched ? "\n本轮指标算法匹配（仅数据，mentionIndexes 引用下面本轮清单的 index；清单每轮从本轮消息重新抽取、不跨轮复用，用户回复待确认问题传 {confirm:true}，放弃某项用 operation=remove）：" + JSON.stringify({
          status: matched.status, mentions: matched.mentions.map((mention, i) => ({index: i + 1, ...mention})),
        }) : "");
      return { messages, systemPrompt: event.systemPrompt + methods.instructions + businessContext };
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
    this.touch(hosted.sessionId);
    return this.exclusiveAdmission(hosted.sessionId, () => this.admitPromptExclusive(hosted, input, deps));
  }

  /**
   * 单写实例内按会话串行接纳（Node 单线程，进程内 Promise 链即可互斥）。
   * 只覆盖接纳阶段，驱动与观察不在锁内，不阻塞同会话的读取和停止。
   */
  private async exclusiveAdmission<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.admissions.set(sessionId, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.admissions.get(sessionId) === tail) this.admissions.delete(sessionId);
    }
  }

  private async admitPromptExclusive(
    hosted: HostedSession,
    input: PromptInput,
    deps: { actor: BackendUser; backend: BackendClient },
  ): Promise<AdmitOutcome> {
    if (hosted.readOnlyReason) return {ok: false, code: hosted.readOnlyReason,
      message: "此会话使用已停用的旧查询协议，历史记录保留只读。请新建会话重新提问；在途旧任务需先核对原结果，不能自动续跑。"};
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
      frames: new NativeFrameStore(hosted.session),
      businessResults: new NativeBusinessResultStore(hosted.session),
      history: createHistoryBridge(hosted),
      answerEvidence: async () => currentTurnEvidence(await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT)),
      timings: { startedAt: performance.now(), model_ms: [], tool_ms: [] },
      ...(input.clarification_target ? { clarificationTarget: input.clarification_target } : {}),
      ...(input.selected_answers ? { selectedAnswers: input.selected_answers } : {}),
      ...(input.clarification_selection ? { clarificationSelection: input.clarification_selection } : {}),
    };
    const context = withRequestContext(requestContext, BACKGROUND_CONTEXT);
    if (existing) {
      // 原生接纳只拒绝“当前有活动操作”，不识别已结束的同一 operation；
      // 结束后再重试若继续 accept，会追加第二条相同的用户消息并重跑模型与取数。
      const completed = await hosted.lane.getResult(operationId, context);
      if (completed) return { ok: true, operationId, context, request: requestContext, completed };
    }
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

    const desiredTools = this.tools.map(tool => tool.name);
    const activeTools = await hosted.lane.getActiveTools(context);
    // 仅旧操作恢复后需要同步，普通请求不重复写原生配置。
    if (activeTools.length !== desiredTools.length || activeTools.some((name, index) => name !== desiredTools[index])) {
      const execution = await hosted.lane.inspectExecution(context);
      if (!execution.current) await hosted.lane.setActiveTools(desiredTools, context);
    }
    // 协议标记随原生用户消息持久化，回放与纯目录回合也保留 Pi 正文。
    const prompt = {role: "user" as const, content: input.message, timestamp: Date.now(),
      businessProtocol: "frame_v1"};
    const admitted = await hosted.lane.accept(
      { kind: "prompt", operationId, prompt },
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
    if (admitted.completed) {
      return { ok: true, operationId: admitted.operationId, outcome: { kind: "settled", outcome: admitted.completed } };
    }
    const driven = await hosted.lane.drive(
      { operationId: admitted.operationId, waitForRetry: true, pollDeferred: false },
      admitted.context,
    ).finally(() => this.touch(hosted.sessionId));
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
  async readOnlyReason(sessionId: string): Promise<HostedSession["readOnlyReason"]> {
    const pending = this.live.get(sessionId);
    return pending ? (await pending.catch(() => undefined))?.readOnlyReason : undefined;
  }

  async isRunning(sessionId: string): Promise<boolean> {
    const pending = this.live.get(sessionId);
    if (!pending) return false;
    const hosted = await pending.catch(() => undefined);
    if (!hosted || hosted.readOnlyReason) return false;
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
    if (hosted.readOnlyReason) {
      hosted.open.splice(0); // 只清内存恢复队列，不改写持久化审计与在途记录。
      throw new Error(hosted.readOnlyReason);
    }
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
        ...(association.value.input?.clarification_selection ? { clarificationSelection: association.value.input.clarification_selection } : {}),
        promptFingerprint: association.value.fingerprint,
        sessionId: hosted.sessionId,
        requestId: requestRef.value,
        operationId: operation.operationId,
        commands: this.createCommandBridge(hosted, requestRef.value),
        frames: new NativeFrameStore(hosted.session),
        businessResults: new NativeBusinessResultStore(hosted.session),
        history: createHistoryBridge(hosted),
        answerEvidence: async () => currentTurnEvidence(await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT)),
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
    this.lastUsed.delete(sessionId);
    this.authorization.delete(sessionId);
    if (!pending) return;
    const hosted = await pending.catch(() => undefined);
    // harness.close 会连带关闭原生 Session；仓库层缓存同步释放
    await hosted?.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    if (hosted) await this.store.release(hosted.ownerUserId, sessionId);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    const ids = [...this.live.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }
}

/**
 * 就地落地后的回执：业务回执保持单个 JSON 块（历史投影、证据和续跑都按 content[0] 解析），
 * 下一步说明与原 READY frameId 写入同一 JSON，不再追加第二个文本块。
 * 说明随执行结果变化：失败时不能告诉模型“查询已执行、不要重复取数”。
 */
export function landedReceipt(content: Array<TextContent | ImageContent>, actionName: string, readyFrameId: string,
  rawDetails: unknown): Array<TextContent | ImageContent> {
  const details = (rawDetails ?? {}) as {status?: unknown; error_code?: unknown; retryable?: unknown};
  const executed = actionName === "execute_business_frame";
  const succeeded = String(details.status ?? "").toLowerCase() === "succeeded";
  const errorCode = typeof details.error_code === "string" ? details.error_code : undefined;
  const nextStep = succeeded
    ? `${executed ? "条件已全部确定，查询已执行" : "历史结果已回读"}。请直接依据本回执组织回答，不要再向用户确认，也不要重复取数。`
    : details.retryable === true
      ? `${executed ? "查询" : "历史结果回读"}未完成${errorCode ? `（${errorCode}）` : ""}。可再次调用 ${actionName}（frameId: ${readyFrameId}）重试，同一条件不会重复取数；不要改用其他工具绕过。`
      : `${executed ? "查询" : "历史结果回读"}未成功${errorCode ? `（${errorCode}）` : ""}。请依据回执如实告知用户，不要声称已取得数据；如需重试，应重新解析条件后发起新查询。`;
  const [first, ...rest] = content;
  let receipt: Record<string, unknown>;
  try {
    const parsed: unknown = first?.type === "text" ? JSON.parse(first.text) : undefined;
    receipt = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown>
      : {message: first?.type === "text" ? first.text : undefined};
  } catch {
    receipt = {message: first?.type === "text" ? first.text : undefined};
  }
  return [{type: "text", text: JSON.stringify({...receipt, ready_frame_id: readyFrameId, next_step: nextStep})},
    ...rest.filter(block => block.type !== "text")];
}

/** 同一逻辑工具调用的稳定身份：就地落地复用外层 toolCallId，不产生第二次调用记录 */
function invocationOf(toolCallId: string, request: AskMetricRequestContext): AgentHarnessToolInvocation {
  return {invocationId: toolCallId, operationId: request.operationId, turnId: request.operationId,
    getMemo: async () => undefined, setMemo: async () => {}};
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

/** 从原生 lane 反向扫描到本轮用户消息即停；不为每次工具/模型往返加载全部历史。 */
async function currentLaneMessages(lane: AgentLane, context: Context) {
  const messages: import("@earendil-works/pi-agent-core").AgentMessage[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = await lane.findEntries({type: "message", order: "newestFirst", limit: 32,
      ...(cursor !== undefined ? {cursor: {seq: cursor}} : {})}, context);
    for (const entry of page) {
      if (entry.type !== "message") continue;
      messages.push(entry.message);
      if (entry.message.role === "user") return messages.reverse();
    }
    if (page.length < 32) return messages.reverse();
    cursor = page.at(-1)!.seq;
  }
}
