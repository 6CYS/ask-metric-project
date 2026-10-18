import {inspectTurn} from "./semantic-task/actionBinding.js";
/**
 * 薄原生宿主：只负责原生对象生命周期、同会话打开去重、请求关联落盘与调用原生接口。
 * Pi 决定目标与执行意图；已校验 Frame 的下一动作接入原生工具循环，不另建会话状态机。
 *
 * 数据流：HTTP 请求 → 校验 owner → 打开/复用原生 Session 与 main lane →
 * 先把 request→operation 关联写入原生应用 values → lane.accept → lane.drive。
 * 观察（SSE）使用独立的 lane.watch，与驱动 Context 分离，浏览器断线不中止执行。
 */
import { NativeFrameStore, NativeBusinessResultStore } from "./business-context/store.js";
import { metricMentions } from "./business-context/metricMentions.js";
import { orgCatalogTurnState } from "./business-context/orgCatalog.js";
import { repeatedToolFailure, repeatedContextRead } from "./toolRecovery.js";
import { ACTION_REQUIRED, CONVERSATION_REPLY, MAX_ACTION_REPAIRS, currentTurnMessages, hasTurnAction, conversationAnswer } from "./tools/turnContract.js";
import { createHash } from "node:crypto";
import { auditToolCall, withToolExecutionAudit } from "./toolAudit.js";
import { modelUsage } from "./modelUsage.js";
import { projectHistoricalResults } from "./modelContext.js";
import { getResolutionFailureDisposition, isTerminalResolutionFailure } from "./business-context/resolutionFailure.js";
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
import { validateToolArguments, type JsonValue, type RetryPolicy } from "@earendil-works/pi-ai";
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
import {NativeSemanticTaskStore, type SemanticAnswerSnapshot} from "./semantic-task/store.js";
import {normalizeAnswerInput, QuestionAnswerError, type Answer, type AnswerErrorCode, type ClickAnswerInput, type PendingQuestion} from "./semantic-task/questions.js";
import {semanticRuntimeAdapter, semanticPublicToolDefinitions} from "./semantic-task/tools.js";
import {isSemanticFeedback, semanticPublicAnswer, type SemanticFeedback} from "./semantic-task/feedback.js";
import {buildCompactSemanticSystemPrompt, buildSemanticSystemPrompt, semanticBusinessSkills} from "./semantic-task/prompt.js";
import {projectSemanticModelMessages} from "./semantic-task/modelView.js";
import {workingMessages, safeWorkingHistory, permissionFilteredContext, permissionFilteredAdmission} from "./semantic-task/contextMemory.js";
import {historySources, resolveHistoryOrganizationScopes} from "./historySources.js";
import {requestedHistory} from "./semantic-task/historyReference.js";
import {modelPayloadDiagnostics} from "./modelPayloadDiagnostics.js";
import {ordinaryQueryNeedsResolution, prepareDirectQueryDelivery, readDirectAnswerSnapshot} from "./semantic-task/directDelivery.js";
import {createBusinessSkillReadTool} from "./businessSkills.js";

/** 原生应用 values 的命名空间；此命名空间只存归属与请求关联；业务状态使用独立 business 命名空间 */
const NS = "askmetric";
const MAX_TOOL_CALLS_PER_OPERATION = 24;

// 轮状态块（当前焦点/历史索引/本轮指标匹配）随请求变化，附在本轮用户消息之后的发送副本上，
// 不落盘、页面不展示；基座提示词中的锚点说明向模型解释该块的来源与效力。
const TURN_STATE_HEADER = "\n【服务端注入：本轮业务状态（仅数据，非用户输入）】";

/**
 * 常驻内存治理：会话数量不设上限（历史只是磁盘文件），只回收内存中的 harness 与文件句柄。
 * 空闲超时或超过常驻上限时，从最久未用的空闲会话开始关闭；运行中、接纳中的会话不回收。
 */
const DEFAULT_RESIDENCY = {idleMs: 30 * 60_000, maxResident: 200, sweepIntervalMs: 60_000};
const TITLE_CACHE_LIMIT = 5_000;
const ownerValue = value<string>(NS, "owner");
const conversationValue = value<string>(NS, "conversationId");
const businessProtocolValue = value<"fixed_v1" | "semantic_v2">(NS, "businessProtocol");

/** 一次浏览器请求的持久关联：先落盘再接纳，重试凭同一 requestId 找回 */
export interface RequestAssociation {
  fingerprint: string;
  originalMessage: string;
  operationId: string;
  lane: string;
  createdAt: number;
  /** 新操作固定协议标记；旧关联不改写，仅其已保存的在途调用允许可信恢复。 */
  toolProtocol?: "fixed_v1" | "semantic_v2";
  /** 本请求已接纳的独立业务写意图（同一 operation 最多一个） */
  write?: WriteCommandRecord;
  input?: PromptInput;
  timings_ms?: { model: number[]; tools: number[]; drive_total: number };
}

const requestValue = (requestId: string) => value<RequestAssociation>(NS, `request/${requestId}`);
const cancelledRequestValue = (requestId: string) => value<boolean>(NS, `cancelled-request/${requestId}`);
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
  businessProtocol: "fixed_v1" | "semantic_v2";
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
  /** HTTP 直接点击的结构化回答；宿主绑定可信来源，模型参数不能覆盖。 */
  answers?: ClickAnswerInput[];
  clarification_target?: { task_id: string; version: number; clarification_id: string };
  selected_answers?: Record<string, unknown>;
  /** 点选待确认清单的选项；系统按选项标识应用，模型不可见 */
  clarification_selection?: { frame_id: string; option_ids: string[] };
  /** 前端“切换口径”按钮的显式时间重查；宿主校验后直接落实为 time 字段，不经过模型换算 */
  time_override?: { start: string; end: string };
}

type PromptFailureCode = "SESSION_BUSY" | "INVALID_MESSAGE" | "REQUEST_CONFLICT" | "REQUEST_CANCELLED"
  | "SESSION_CLOSED" | "LEGACY_QUERY_REQUIRES_NEW_TURN" | AnswerErrorCode;

export type AdmitOutcome =
  | { ok: true; operationId: string; context: Context; request: AskMetricRequestContext;
      /** 同一 request_id 的操作已结束：重试只回放原终态，不再接纳或驱动 */
      completed?: OperationResultRecord }
  | { ok: false; code: PromptFailureCode; message: string };

export type DriveOutcomeResult =
  | { ok: true; operationId: string; outcome: DriveOutcome }
  | { ok: false; code: PromptFailureCode; message: string };

/** 指纹前只规范形状与顺序；问题是否存在、是否仍可答由核心在幂等查询后判断。 */
async function normalizePromptAnswers(input: PromptInput, store: NativeSemanticTaskStore): Promise<PromptInput> {
  const {answers: rawAnswers, ...rest} = input;
  if (rawAnswers === undefined) return rest;
  if (!Array.isArray(rawAnswers) || rawAnswers.length > 20) {
    throw new QuestionAnswerError("ANSWER_INPUT_SHAPE_INVALID", "一轮最多提交 20 条回答。");
  }
  const answers = rawAnswers.map(raw => {
    const answer = normalizeAnswerInput(raw, {channel: "click", operation_id: "http"});
    return {question_id: answer.question_id, version: answer.version, choice: answer.choice} as ClickAnswerInput;
  });
  const questions = new Map<string, PendingQuestion | undefined>();
  for (const answer of answers) {
    if (answer.choice.type !== "select") continue;
    const key = `${answer.question_id}/${answer.version}`;
    if (!questions.has(key)) questions.set(key, (await store.question(answer.question_id, answer.version))?.question);
    const question = questions.get(key);
    if (!question) continue;
    const order = new Map(question.options.map((option, index) => [option.option_id, index]));
    answer.choice = {type: "select", option_ids: [...answer.choice.option_ids].sort((left, right) =>
      (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      || (left < right ? -1 : left > right ? 1 : 0)) as [string, ...string[]]};
  }
  answers.sort((left, right) => (left.question_id < right.question_id ? -1 : left.question_id > right.question_id ? 1 : 0)
    || left.version - right.version || (canonicalJson(left.choice) < canonicalJson(right.choice) ? -1 : canonicalJson(left.choice) > canonicalJson(right.choice) ? 1 : 0));
  return {...rest, ...(answers.length ? {answers} : {})};
}

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
    await session.setValue(businessProtocolValue, "semantic_v2", BACKGROUND_CONTEXT);
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
      // 协议只读判定：无标记或 fixed_v1 的历史会话一律只读，不再按其协议恢复执行。
      const businessProtocol = (await session.getValue(businessProtocolValue, BACKGROUND_CONTEXT))?.value ?? "fixed_v1";
      if (!["fixed_v1", "semantic_v2"].includes(businessProtocol)) throw new Error("SESSION_PROTOCOL_UNSUPPORTED");
      const skills = semanticBusinessSkills(this.options.skills ?? []);
      const sessionTools = this.tools.map(tool =>
        tool.name === "business_skill_read" ? createBusinessSkillReadTool(skills) : tool);
      const semanticPrompt = this.config.semanticPromptVariant === "compact_v1" ? buildCompactSemanticSystemPrompt : buildSemanticSystemPrompt;
      const runtimeTools = [...sessionTools, createEvidenceRepairTool()]
        .map(tool => semanticRuntimeAdapter(tool)).map(withToolExecutionAudit);
      const { harness, open } = await AgentHarness.create(
        {
          session,
          models: bundle.models,
          model: bundle.model,
          tools: runtimeTools,
          toolExecution: "sequential",
          // 工具上下文即当次请求绑定；缺请求上下文说明链路被绕过，直接失败
          toolContext: (context) => requireRequestContext(context),
          resources: { skills },
          systemPrompt: () => semanticPrompt(new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date())) + businessKnowledgeCatalog(skills),
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
      const retired = businessProtocol !== "semantic_v2"
        || activeTools.some(name => ["metric_ask", "metric_query_structured", "data_availability", "metric_calculate", "answer_present"].includes(name));
      if (!execution.current && !retired) await lane.setActiveTools(sessionTools.map(tool => tool.name), BACKGROUND_CONTEXT);
      this.registerHooks(harness, lane, runtimeTools, sessionTools, skills);
      return {
        businessProtocol,
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

  /** /no_think 等提供方兼容只作用于发送副本，不改用户原文与原生历史 */
  private registerHooks(harness: AgentHarness<AskMetricRequestContext>, lane: AgentLane,
    runtimeTools: AgentHarnessTool<AskMetricRequestContext>[],
    sessionTools: AgentHarnessTool<AskMetricRequestContext>[], skills: Skill[]): void {
    const registeredNames = new Set(sessionTools.map(tool => tool.name));
    const turnContract = registeredNames.has(CONVERSATION_REPLY) && registeredNames.has(ACTION_REQUIRED);
    // 语义上下文只帮助选择业务动作，不完成本轮动作义务；普通回答仍须显式交付。
    const turnHasAction = (messages: import("@earendil-works/pi-agent-core").AgentMessage[]) => hasTurnAction(
      messages.filter(message => message.role !== "toolResult" || message.toolName !== "business_context_read"));
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
        final_payload_bytes: request.modelCall?.finalPayloadBytes ?? null,
        duration_ms: request.modelCall ? Math.round(performance.now() - request.modelCall.startedAt) : null,
        ...modelUsage(event.row.usage),
      }));
    });
    harness.hooks.on("before_request", (event, context) => {
      const request = requireRequestContext(context);
      if (event.attempt > 1 && request.answerStream) request.reportAnswerRetry?.(request.answerStream.callSeq);
      request.modelCall = { step: event.step, model: event.model.id, attempt: event.attempt, startedAt: performance.now() };
      const timings = request.timings;
      if (timings) {
        timings.modelStartedAt = performance.now();
        timings.modelFirstTokenRecorded = false;
      }
      return undefined;
    });
    harness.events.on("message_update", (_event, context) => {
      const timings = requireRequestContext(context).timings;
      if (timings?.modelStartedAt !== undefined && !timings.modelFirstTokenRecorded) {
        timings.modelFirstTokenMs.push(Math.round(performance.now() - timings.modelStartedAt));
        timings.modelFirstTokenRecorded = true;
      }
    });
    harness.hooks.on("before_payload", async (event, context) => {
      const request = requireRequestContext(context);
      const decision = await (async () => {
        const callSeq = (request.modelCall?.attempt ?? 1) > 1 && request.answerStream
          ? request.answerStream.callSeq : (request.answerStream?.callSeq ?? 0) + 1;
        request.answerStream = {callSeq, mode: "none"};
        let payload = semanticPublicToolDefinitions(event.payload as Record<string, unknown>);
        if (request.modelCall) request.modelCall.payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        if (request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary") return {payload};
        // 业务工具由 Pi 自主选择；旧交付工具仅为读取旧操作注册，不再对模型暴露。
        if (Array.isArray(payload.tools)) {
          const activeNames = payload.tools.map(raw => {
            const definition = raw as {name?: string; function?: {name?: string}};
            return definition.function?.name ?? definition.name;
          });
          payload = {...payload, tools: payload.tools.filter(raw => {
            const definition = raw as {name?: string; function?: {name?: string}};
            const name = definition.function?.name ?? definition.name;
            if (name === ACTION_REQUIRED || name === EVIDENCE_REPAIR_TOOL || name === "answer_present") return false;
            if (name === CONVERSATION_REPLY && request.trustedAnswers?.length) return false;
            // 已持久化的旧操作沿用原活跃集恢复；新请求在接纳前切换为合并入口。
            if (["metric_read", "session_history_read"].includes(name ?? "")) return !activeNames.includes("read");
            if (["metric_catalog_search", "org_catalog_search", "metric_catalog_overview"].includes(name ?? "")) return !activeNames.includes("catalog");
            return true;
          })};
        }
        const messages = await currentLaneMessages(lane, context);
        const current = currentTurnMessages(messages);
        const frameTurn = ([...messages].reverse().find(message => message.role === "user") as {businessProtocol?: string} | undefined)?.businessProtocol === "frame_v1";
        const setStreamMode = (mode: "none" | "text" | "reply") => {
          request.answerStream = {callSeq, mode: frameTurn ? mode : "none"};
        };
        const contractActive = turnContract && (await lane.getActiveTools(context)).includes(CONVERSATION_REPLY);
        const semanticAnswer = terminalSemanticAnswer(current);
        if (semanticAnswer !== undefined) {
          // 已保存的待用户/失败回执决定本轮终态；恢复或同批旁支不能重新打开工具循环。
          const {tools: _tools, ...answerPayload} = payload;
          setStreamMode("none");
          return {payload: {...answerPayload, tool_choice: "none"}};
        }
        const terminalFailure = terminalResolutionFailure(current);
        if (terminalFailure) {
          // 确定的能力/权限范围限制只能交付说明，不能通过换条件或换能力重试同一目标。
          const {tools: _tools, ...answerPayload} = payload;
          setStreamMode("text");
          return {payload: {...answerPayload, tool_choice: "none"}};
        }
        // 普通回答回执带 terminate 时本轮不再请求模型；可信点击必须先进入语义受理，不能被聊天回执截断。
        if (contractActive && !request.trustedAnswers?.length && conversationAnswer(current) !== undefined) {
          const {tools: _tools, ...answerPayload} = payload;
          return {payload: {...answerPayload, tool_choice: "none"}};
        }
        if (contractActive && turnHasAction(current) && Array.isArray(payload.tools)) {
          // 已进入业务处理后继续用真实回执回答，不允许再改报“本轮无需动作”。
          payload = {...payload, tools: payload.tools.filter(raw =>
            (raw as {function?: {name?: string}}).function?.name !== CONVERSATION_REPLY)};
        }
        const lastResolution = [...current].reverse().find(message => message.role === "toolResult" && message.toolName === "resolve_business_turn");
        if (!lastResolution && request.trustedAnswers?.length && Array.isArray(payload.tools)
          && payload.tools.some(raw => {const definition = raw as {name?: string; function?: {name?: string}}; return (definition.function?.name ?? definition.name) === "resolve_business_turn";})) {
          setStreamMode("none");
          return {payload: {...payload, tool_choice: {type: "function", function: {name: "resolve_business_turn"}}}};
        }
        if (!lastResolution && request.originalMessage && Array.isArray(payload.tools)
          && current.filter(message => message.role === "toolResult").every(message => ["business_context_read", "business_skill_read", ACTION_REQUIRED].includes(message.toolName))) {
          const facts = await inspectTurn(request, request.originalMessage, (await request.semanticTasks!.turn(request.operationId))!.businessDate, undefined, context.abortSignal);
          const complete = facts.fragments.length > 0 && facts.fragments.every(fragment => fragment.organizations.length > 0
            && fragment.mentions.length > 0 && fragment.mentions.every(mention => mention.resolution.status === "resolved")
            && fragment.calendar.ranges.length > 0 && !fragment.calendar.unresolved.length);
          if (complete && await ordinaryQueryNeedsResolution(request, facts, context.abortSignal)) {
            // 原问已经独立给齐普通取值条件，不需探索旧历史；参数仍由Pi按唯一Schema理解生成。
            return {payload: {...payload, tool_choice: {type: "function", function: {name: "resolve_business_turn"}}}};
          }
        }
        if (!lastResolution && current.some(message => message.role === "toolResult"
          && message.toolName === ACTION_REQUIRED && message.toolCallId.startsWith("semantic-action-required-")) && Array.isArray(payload.tools)
          && payload.tools.some(raw => {const definition = raw as {name?: string; function?: {name?: string}}; return (definition.function?.name ?? definition.name) === "resolve_business_turn";})) {
          // 普通取值义务已经由宿主正向确认；继续同一Pi选择提案参数，不能用目录旁支当作完成。
          setStreamMode("none");
          return {payload: {...payload, tool_choice: {type: "function", function: {name: "resolve_business_turn"}}}};
        }
        if (lastResolution?.role === "toolResult" && isSemanticFeedback(lastResolution.details)
          && ["needs_interpretation", "invalid_input", "conflict"].includes(lastResolution.details.status)
          && lastResolution.details.continuation.actor === "pi" && Array.isArray(payload.tools) && payload.tools.length) {
          // 内部提案修复仍在同一Pi循环内，不能以计划文字或重复询问用户结束。
          setStreamMode("none");
          if (requiresSemanticProposal(lastResolution.details)) {
            // revise_proposal 的进展是重提语义，成功读历史不算修复；参数仍完全由 Pi 理解。
            return {payload:{...payload,tool_choice:{type:"function",function:{name:"resolve_business_turn"}}}};
          }
          // 真正缺目录证据或历史引用时保留探索自由，不用 required 强迫反复成功读取。
          return {payload};
        }
        if (contractActive && !turnHasAction(current) && Array.isArray(payload.tools) && payload.tools.length) {
          // 与是否重复提及指标无关：Pi 选择实际业务动作或显式普通回答，纯文字不能冒充动作。
          setStreamMode("reply");
          return {payload: {...payload, tool_choice: "required"}};
        }
        // 已命中正式指标的本轮先取得业务工具回执，避免模型只输出长篇计划直至请求超时。
        // 不指定具体能力：查询、目录解释和历史指代仍由 Pi 在可用工具中选择。
        let turnStart = messages.length - 1;
        while (turnStart >= 0 && messages[turnStart]?.role !== "user") turnStart -= 1;
        const turn = messages.slice(turnStart + 1);
        const hasBusinessReceipt = turn.some(message => message.role === "toolResult"
          && message.toolName !== "business_skill_read");
        if (!hasBusinessReceipt && request.originalMessage && Array.isArray(payload.tools) && payload.tools.length
          && typeof request.backend.matchMetricQuestion === "function") {
          const matched = await metricMentions(request);
          if (!matched.status && matched.mentions.length) return {payload: {...payload, tool_choice: "required"}};
        }
        setStreamMode("text");
        return {payload};
      })();
      // 必须在所有工具裁剪和tool_choice分支后计量，旧payload_bytes仅保留兼容。
      const diagnostics = modelPayloadDiagnostics(decision.payload);
      if (request.modelCall) request.modelCall.finalPayloadBytes = diagnostics.final_payload_bytes;
      console.info(JSON.stringify({event: "model_request_payload", request_id: request.requestId,
        session_id: request.sessionId, operation_id: request.operationId, call_seq: request.answerStream?.callSeq ?? null,
        step: request.modelCall?.step, attempt: request.modelCall?.attempt,
        prompt_variant: this.config.semanticPromptVariant ?? "full", context_view: this.config.modelContextView ?? "raw", ...diagnostics}));
      return decision;
    });
    harness.hooks.on("before_tool", async (event, context) => {
      const request = requireRequestContext(context);
      if (request.timings) (request.timings.toolStartedAt ??= {})[event.toolCallId] = performance.now();
      const decide = async () => {
        // 从原生记录统计本轮预算，恢复后不重置；业务状态仍由后端管理。
        const budgetMessages = await currentLaneMessages(lane, context);
        const semanticAnswer = terminalSemanticAnswer(currentTurnMessages(budgetMessages));
        if (semanticAnswer !== undefined) return {block: {reason: "当前业务状态已结束本轮处理，不能继续调用工具代替用户补充或改写已保存的交付。", terminate: true}};
        const terminalFailure = terminalResolutionFailure(currentTurnMessages(budgetMessages));
        // 同批尚未执行的调用也须拦住；保留一次正文交付，不以隐藏的工具错误结束页面回答。
        if (terminalFailure) return {block: {reason: terminalFailure.message}};
        if (turnContract && event.toolName === CONVERSATION_REPLY && request.trustedAnswers?.length) {
          return {block: {reason: "本轮包含可信结构化回答，必须先通过 resolve_business_turn 受理，不能用普通聊天结束。", terminate: false}};
        }
        if (turnContract && !request.trustedAnswers?.length && conversationAnswer(currentTurnMessages(budgetMessages)) !== undefined) {
          return {block: {reason: "本轮已选择无需业务操作的普通回答，不能追加业务动作。", terminate: true}};
        }
        if (turnContract && event.toolName === CONVERSATION_REPLY && turnHasAction(currentTurnMessages(budgetMessages))) {
          return {block: {reason: "本轮已有业务动作，请依据实际回执回答，不能改报无需业务操作。", terminate: false}};
        }
        let turnStart = budgetMessages.length - 1;
        while (turnStart >= 0 && budgetMessages[turnStart]?.role !== "user") turnStart -= 1;
        const toolCount = budgetMessages.slice(turnStart + 1).filter(message => message.role === "toolResult").length;
        if (event.toolName === "business_context_read") {
          const reads = repeatedContextRead(budgetMessages.slice(turnStart + 1), event.args);
          if (reads >= 2) return {block: {reason: "同一参数的历史读取已经返回，未新增来源。请使用已签发引用继续提案，或改变query_number/task_ref/topic_ref/cursor读取真正缺少的来源；不要再次读取相同页。", terminate: reads >= 3}};
        }
        if (toolCount >= MAX_TOOL_CALLS_PER_OPERATION) return {block: {reason: TOOL_LIMIT_ANSWER, terminate: true}};
        if (["metric_ask", "metric_query_structured", "data_availability", "metric_calculate", "answer_present", EVIDENCE_REPAIR_TOOL].includes(event.toolName)) {
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
      if (isSemanticFeedback(event.details)) {
        let feedback: SemanticFeedback = event.details;
        let content = event.content;
        if (event.toolName === "resolve_business_turn" && ["ready", "reused"].includes(feedback.status)) {
          const taskRef = feedback.state.task_ref;
          const tool = sessionTools.find(item => item.name === (feedback.status === "ready" ? "execute_business_frame" : "read_business_result"));
          if (tool && taskRef) {
            const results: Record<string, unknown>[] = [], blocks: typeof content = [];
            const targets = [...feedback.state.targets].sort((a,b) => Number(a.kind === "calculation") - Number(b.kind === "calculation"));
            for (const target of targets) {
              if (!["ready", "waiting_dependency", "succeeded"].includes(target.status)) continue;
              const result = await tool.execute(event.toolCallId, {task_ref: taskRef, target_ref: target.target_ref}, () => {}, request, invocationOf(event.toolCallId, request), context);
              if (isSemanticFeedback(result.details)) {
                feedback = result.details; blocks.push(...result.content);
                if (feedback.state.evidence) results.push(feedback.state.evidence);
                if (["unknown", "failed", "conflict", "denied", "needs_user", "needs_interpretation"].includes(feedback.status)) break;
              }
            }
            content = blocks.length ? blocks : content;
            if (results.length === 1) feedback.state.evidence = results[0]!;
            if (results.length > 1) feedback.state.evidence = {kind: "semantic_results", delivery: "business_evidence_v1",
              status: feedback.status === "succeeded" ? "succeeded" : "partial", results,
              public_answer: results.map(item => item.public_answer).filter(item => typeof item === "string").join("\n\n")};
          }
        }
        content = [{type: "text", text: JSON.stringify(feedback)}];
        const messages = currentTurnMessages(await currentLaneMessages(lane, context));
        const withCurrent = [...messages, {role: "toolResult" as const, toolName: event.toolName, toolCallId: event.toolCallId,
          content, details: feedback, isError: event.isError, timestamp: Date.now()}];
        if (repeatedToolFailure(withCurrent)) feedback = {...feedback, status: "failed",
          issues: [...feedback.issues.map(issue => ({...issue, remediation: "stop" as const})),
            {code: "SEMANTIC_NO_PROGRESS", category: "semantic", message: "相同提案未取得进展，已停止重复尝试；以上为实际拒绝原因，原始要求及待修修改均保留。", remediation: "stop"}],
          continuation: {actor: "none", action: "stop"}};
        const deliveryMode = (await request.semanticTasks?.turn(request.operationId))?.directQueryDelivery ?? "off";
        if (!event.isError && deliveryMode !== "off") {
          const decision = await prepareDirectQueryDelivery(request, feedback, {toolName: event.toolName, toolCallId: event.toolCallId,
            messages, signal: context.abortSignal}).catch(() => ({eligible: false, reason: "delivery_validation_unavailable"}));
          console.info(JSON.stringify({event: "direct_query_delivery", request_id: request.requestId, operation_id: request.operationId,
            mode: deliveryMode, eligible: decision.eligible, reason: decision.reason,
            delivery_path: deliveryMode === "on" && decision.eligible ? "direct_query" : "pi_answer"}));
          if ("terminalFeedback" in decision && decision.terminalFeedback) feedback = decision.terminalFeedback;
          else if (deliveryMode === "on" && "snapshot" in decision && decision.snapshot) {
            // patch 随同真实 toolResult 由 SDK finalizeToolCall 一次落盘，恢复不依赖伪造 assistant。
            feedback = {...feedback, continuation: {actor: "none", action: "deliver_saved_answer"}, direct_answer: decision.snapshot};
          }
        }
        content = [{type: "text", text: JSON.stringify(feedback)}];
        const snapshot = readDirectAnswerSnapshot(feedback);
        const answer = snapshot?.public_answer ?? semanticPublicAnswer(feedback);
        return {details: feedback as unknown as JsonValue, content: snapshot ? content : answer ? [{type: "text" as const, text: answer}] : content,
          ...(answer ? {terminate: true} : {})};
      }
      if (!event.isError && event.toolName !== "resolve_business_turn") {
        const messages = await currentLaneMessages(lane, context);
        const batch = [...messages].reverse().find(message => message.role === "assistant");
        if (batch?.role === "assistant" && batch.content.some(block => block.type === "toolCall" && block.name === "resolve_business_turn")) {
          // Pi 仅在整批回执都 terminate 时结束。先行读取不决定结束；READY/参数错误仍以非终止解析回执继续循环。
          return {terminate: true};
        }
      }
      return undefined;
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
      const semanticAnswer = terminalSemanticAnswer(current);
      if (semanticAnswer !== undefined) {
        // 网关忽略 none 或旧批次尚有非终止回执时，也只交付原正式回执的正文。
        return {message: {...event.message, content: [{type: "text" as const, text: semanticAnswer}], stopReason: "stop" as const}};
      }
      const pendingSemantic = [...receipts].reverse().find(message => message.toolName === "resolve_business_turn");
      const proposalRequired = pendingSemantic && isSemanticFeedback(pendingSemantic.details)
        && requiresSemanticProposal(pendingSemantic.details);
      if (!event.message.content.some(block => block.type === "toolCall")
        || proposalRequired && !event.message.content.some(block => block.type === "toolCall" && block.name === "resolve_business_turn")) {
        const taskIndex = await request.semanticTasks?.planIndex();
        const task = taskIndex?.focus ? await request.semanticTasks?.plan(taskIndex.focus) : undefined;
        const contextOnly = receipts.length > 0 && receipts.every(message => ["business_context_read", "business_skill_read", ACTION_REQUIRED].includes(message.toolName));
        const supportingOnly = receipts.length > 0 && receipts.every(message => ["business_context_read", "business_skill_read", "catalog",
          "metric_catalog_search", "org_catalog_search", "metric_catalog_overview", ACTION_REQUIRED].includes(message.toolName));
        if (supportingOnly && request.originalMessage && task?.operationId !== request.operationId) {
          const facts = await inspectTurn(request, request.originalMessage, (await request.semanticTasks!.turn(request.operationId))!.businessDate, undefined, context.abortSignal);
          // 机构和日期缺失正是正式任务应澄清的情况，不能以缺项为由允许只读计划完成。
          const needsAction = contextOnly ? facts.requires_calculation || facts.fragments.some(fragment => fragment.mentions.length)
            : await ordinaryQueryNeedsResolution(request, facts, context.abortSignal).catch(() => false);
          if (needsAction) {
            const attempts = receipts.filter(message => message.toolName === ACTION_REQUIRED).length;
            if (attempts < MAX_ACTION_REPAIRS) return {message: {...event.message, content: [{type: "toolCall" as const,
              id: `semantic-action-required-${attempts + 1}`, name: ACTION_REQUIRED, arguments: {}}], stopReason: "toolUse" as const}};
            return {message: {...event.message, content: [{type: "text" as const, text: "本轮仅完成辅助读取，业务目标尚未保存为正式任务，未执行新的查询。请重试本轮请求。"}], stopReason: "stop" as const}};
          }
        }
        if (task?.operationId === request.operationId && task.issues.some(issue => issue.code === "ANALYSIS_EVIDENCE_PENDING")) {
          const attempts = current.filter(message => message.role === "toolResult" && message.toolCallId.startsWith("semantic-analysis-pending-")).length;
          if (attempts < MAX_ACTION_REPAIRS && receipts.length < MAX_TOOL_CALLS_PER_OPERATION) {
            return {message: {...event.message, content: [{type: "toolCall" as const, id: `semantic-analysis-pending-${attempts + 1}`,
              name: "business_context_read", arguments: {limit: 20}}], stopReason: "toolUse" as const}};
          }
          return {message: {...event.message, content: [{type: "text" as const, text: "已取得部分分析结果，用户明确要求的依据尚未全部取证，本次分析尚未完成。已有结果仍可查看。"}], stopReason: "stop" as const}};
        }
      }
      const plainAnswer = turnContract ? conversationAnswer(current) : undefined;
      if (!request.trustedAnswers?.length && plainAnswer !== undefined) {
        // 普通回答选择没有业务副作用；网关忽略 none 也不能在其后插入取数或改焦点。
        // 新操作在普通回答回执处即结束（terminate），此处兜底升级前已在途操作的续跑。
        return {message: {...event.message, content: [{type: "text" as const, text: plainAnswer}], stopReason: "stop" as const}};
      }
      const terminalFailure = terminalResolutionFailure(current);
      if (terminalFailure) {
        // 网关忽略 tool_choice=none 时兜住额外动作；正文只采用已确认错误的公开说明。
        if (event.message.content.some(block => block.type === "toolCall")) {
          return {message: {...event.message, content: [{type: "text" as const, text: terminalFailure.message}], stopReason: "stop" as const}};
        }
        // 同批被拦截的调用不是新的参数失败，不能让预算提示覆盖真实的业务限制说明。
        return undefined;
      }
      if (repeatedToolFailure(current)) {
        return {message: {...event.message, content: [{type: "text" as const,
          text: "本轮工具调用未通过校验或执行；相同参数重复提交后仍得到相同失败，已停止重复尝试。原查询条件仍保留，未完成的查询或计算不作为成功结果。"}], stopReason: "stop" as const}};
      }
      // 后续工具调用保留，不能用中间回执替换 Pi 尚未完成的业务步骤。
      const hasCalls = event.message.content.some(block => block.type === "toolCall");
      const calls = event.message.content.filter(block => block.type === "toolCall");
      if (calls.filter(call => call.name === "resolve_business_turn").length > 1) {
        return {message: {...event.message, content: [{type: "text" as const, text: "本轮提案需要统一提交完整目标，未执行新的查询，原始目标已保留。"}],
          stopReason: "error" as const, errorMessage: "BUSINESS_BATCH_ARGUMENTS_INVALID"}};
      }
      const activeTools = new Set(await lane.getActiveTools(context));
      const preparedCalls = calls.map(call => {
        const tool = runtimeTools.find(candidate => candidate.name === call.name && activeTools.has(candidate.name));
        if (!tool) return {call, valid: false};
        try {
          // 与 Pi 使用同一确定性准备和 Schema 校验，只检测可执行性；原调用和业务参数保持原样。
          const raw = structuredClone(call.arguments);
          const args = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
          validateToolArguments(tool, {...call, arguments: args as typeof call.arguments});
          return {call, valid: true};
        } catch { return {call, valid: false}; }
      });
      const resolutions = preparedCalls.filter(item => item.call.name === "resolve_business_turn");
      if (resolutions.length > 1 && resolutions.some(item => !item.valid)) {
        // 非法提案可能包含另一目标，不能丢掉它后执行同批合法的半份业务变更。
        for (const call of calls) auditToolCall(request, call.id,
          registeredNames.has(call.name) ? call.name : "unknown", "blocked", call.arguments);
        return {message: {...event.message, content: [{type: "text" as const,
          text: "本轮业务参数批次未通过校验，原条件已保留，未执行新的查询。请重试本轮请求。"}],
          stopReason: "error" as const, errorMessage: "BUSINESS_BATCH_ARGUMENTS_INVALID"}};
      }
      const invalidSiblings = resolutions.some(item => item.valid)
        ? new Set(preparedCalls.filter(item => !item.valid).map(item => item.call.id)) : new Set<string>();
      for (const item of preparedCalls.filter(item => invalidSiblings.has(item.call.id))) {
        // Pi 的 prepare 错误跳过工具 Hook 且不终止；裁去不可执行的旁支，避免已保存澄清被迫再请求模型。
        auditToolCall(request, item.call.id, registeredNames.has(item.call.name) ? item.call.name : "unknown", "blocked", item.call.arguments);
      }
      const executableCalls = calls.filter(call => !invalidSiblings.has(call.id));
      const conflictingAnswer = executableCalls.length > 1 && executableCalls.some(call => call.name === CONVERSATION_REPLY);
      if (turnContract && (!hasCalls || conflictingAnswer) && !turnHasAction(current)
        && activeTools.has(CONVERSATION_REPLY)) {
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
      if (hasCalls) return { message: { ...event.message, content: event.message.content.filter(block => block.type !== "text"
        && (block.type !== "toolCall" || !invalidSiblings.has(block.id))) } };
      // Pi 根据工具事实组织回答；宿主不注入补救工具、不选择证据、不拼接业务正文。
      return undefined;
    });
    const suffix = this.config.model.userMessageSuffix;
    harness.hooks.on("transform_context", async (event, context) => {
      const methods = projectBusinessSkillContext(event.messages, skills);
      const request = requireRequestContext(context);
      const selected = workingMessages(methods.messages);
      const history = projectHistoricalResults(await safeWorkingHistory(request, selected));
      const replySources = historySources(history.flatMap(message => message.role === "toolResult" ? [message.details] : []),
        () => {throw new Error("HISTORY_SCOPE_UNAVAILABLE");});
      request.replyHistorySources = {tasks: [...replySources.tasks].map(([task_id, result_id]) => ({task_id, ...(result_id ? {result_id} : {})})),
        organizationScopes: await resolveHistoryOrganizationScopes(replySources, request.semanticTasks, () => {throw new Error("HISTORY_SCOPE_UNAVAILABLE");})};
      const messages = this.config.modelContextView === "compact_v1" ? projectSemanticModelMessages(history) : history;
      const runtime = await permissionFilteredContext(request, await request.semanticTasks!.runtimeContext());
      const referenced = await requestedHistory(request);
      const taskContext = {...runtime,
        requested_history: referenced.slice(0, 12), requested_history_has_more: referenced.length > 12,
        admitted_context: await permissionFilteredAdmission(request)};
      // 机构清单随轮状态注入本轮用户消息副本，系统提示词保持逐字稳定。
      // 轮状态块只改发送副本，不写入原生历史，页面展示与会话存档不变。
      const orgCatalogBlock = await orgCatalogTurnState(request);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== "user") continue;
        const injected = TURN_STATE_HEADER + JSON.stringify(taskContext ?? {}) + orgCatalogBlock + suffix;
        messages[i] = {...message, content: typeof message.content === "string" ? message.content + injected
          : [...message.content, {type: "text", text: injected}]};
        break;
      }
      return {messages, systemPrompt: event.systemPrompt + methods.instructions};
    });
    harness.hooks.on("before_compaction", async (event) => {
      // 业务记忆保存在 Session 领域账本；压缩只收束消息，不用模型自由摘要重写确认及来源。
      return {compaction: {summary: "较早对话已归档。精确条件、目标绑定、待明确项及结果来源保存在本会话业务账本。沿用历史须依据当前状态或business_context_read定向读取并复核权限；本段说明不提供事实、确认或执行许可。",
        tokensBefore: event.preparation.tokensBefore, retainedTail: event.preparation.retainedTail,
        details: {version: 1, memory: "semantic_session_ledger", generated_by: "host"}}};
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
    if ((await hosted.session.getValue(cancelledRequestValue(input.request_id), BACKGROUND_CONTEXT))?.value) {
      return {ok: false, code: "REQUEST_CANCELLED", message: "此次提问已停止，未接纳新的执行。"};
    }
    if (hosted.readOnlyReason) return {ok: false, code: hosted.readOnlyReason,
      message: "此会话使用已停用的旧查询协议，历史记录保留只读。请新建会话重新提问；在途旧任务需先核对原结果，不能自动续跑。"};
    const semanticTasks = new NativeSemanticTaskStore(hosted.session);
    try {
      input = await normalizePromptAnswers(input, semanticTasks);
    } catch (error) {
      if (error instanceof QuestionAnswerError) return {ok: false, code: error.code, message: error.message};
      throw error;
    }
    if (!input.message && !input.answers?.length) {
      return {ok: false, code: "INVALID_MESSAGE", message: "空文本必须伴随结构化回答。"};
    }
    const fingerprint = promptFingerprint({ ...input });
    const existing = await hosted.session.getValue(requestValue(input.request_id), BACKGROUND_CONTEXT);
    if (existing && existing.value.fingerprint !== fingerprint) {
      return { ok: false, code: "REQUEST_CONFLICT", message: "同一 request_id 提交了不同输入" };
    }
    if (existing && (existing.value.toolProtocol ?? "fixed_v1") !== hosted.businessProtocol) {
      return {ok: false, code: "REQUEST_CONFLICT", message: "原操作绑定的业务协议与当前会话不一致，已停止自动执行。"};
    }
    const operationId = existing?.value.operationId ?? hosted.session.idGenerator.next();
    const bridge = this.createCommandBridge(hosted, input.request_id);
    const trustedAnswers = input.answers ?? [];
    const answers: Answer[] = trustedAnswers.map(answer => ({...structuredClone(answer), source: {channel: "click", operation_id: operationId}}));
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
      semanticTasks,
      businessResults: new NativeBusinessResultStore(hosted.session),
      history: createHistoryBridge(hosted, () => requestContext),
      answerEvidence: async () => currentTurnEvidence(await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT)),
      questionPublicationProof: createQuestionPublicationProof(hosted, operationId),
      timings: { startedAt: performance.now(), modelFirstTokenMs: [], model_ms: [], tool_ms: [] },
      ...(trustedAnswers.length ? {trustedAnswers: structuredClone(trustedAnswers)} : {}),
      ...(input.clarification_target ? { clarificationTarget: input.clarification_target } : {}),
      ...(input.selected_answers ? { selectedAnswers: input.selected_answers } : {}),
      ...(input.clarification_selection ? { clarificationSelection: input.clarification_selection } : {}),
      ...(input.time_override ? { timeOverride: input.time_override } : {}),
    };
    let admittedTurn: Awaited<ReturnType<NativeSemanticTaskStore["admit"]>>;
    try {
      admittedTurn = await semanticTasks.admit(operationId, input.message, undefined, this.config.directQueryDelivery ?? "off",
        {actorId: deps.actor.id, answers, publicationProof: createQuestionPublicationProof(hosted, operationId)});
    } catch (error) {
      if (error instanceof QuestionAnswerError) return {ok: false, code: error.code, message: error.message};
      throw error;
    }
    const displayText = input.message ? "" : clickAnswerDisplayText(admittedTurn.answerSnapshots ?? []);
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
          toolProtocol: hosted.businessProtocol,
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
    // 原文、可信点击与页面展示分别持久化；纯点击不向模型或后端伪造用户原文。
    const prompt = {role: "user" as const, content: input.message, timestamp: Date.now(),
      businessProtocol: "semantic_v2",
      ...(trustedAnswers.length ? {clickAnswers: structuredClone(trustedAnswers)} : {}),
      ...(!input.message && displayText ? {displayText} : {})};
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
    if (!admitted.request.timings?.reportAtSnapshot) await this.recordRequestTiming(hosted, admitted.request);
    if (!driven.ok) {
      return { ok: false, code: "SESSION_CLOSED", message: driven.error.message };
    }
    return { ok: true, operationId: admitted.operationId, outcome: driven.value };
  }

  /** 提问路由在正式快照发送后记录，关闭流式时也能取得首字耗时。 */
  async recordRequestTiming(hosted: HostedSession, request: AskMetricRequestContext): Promise<void> {
    const timings = request.timings;
    if (!timings) return;
    const stored = await hosted.session.getValue(requestValue(request.requestId), BACKGROUND_CONTEXT);
    const summary = {model: timings.model_ms, tools: timings.tool_ms,
      drive_total: Math.round(performance.now() - timings.startedAt),
      first_visible_ms: timings.firstVisibleAt === undefined ? null
        : Math.round(timings.firstVisibleAt - (timings.receivedAt ?? timings.startedAt)),
      model_first_token_ms: timings.modelFirstTokenMs};
    if (stored) await hosted.session.setValue(requestValue(request.requestId), {...stored.value, timings_ms: summary}, BACKGROUND_CONTEXT);
    console.info(JSON.stringify({event: "agent_request_timing", session_id: hosted.sessionId,
      operation_id: request.operationId, request_id: request.requestId, timings_ms: summary}));
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
      if ((association.value.toolProtocol ?? "fixed_v1") !== hosted.businessProtocol) {
        hosted.open.push(operation);
        throw new Error("OPERATION_PROTOCOL_CONFLICT");
      }
      const requestContext: AskMetricRequestContext = {
        actor: deps.actor,
        backend: deps.backend.withTraceId?.(requestRef.value) ?? deps.backend,
        originalMessage: association.value.originalMessage,
        questionPublicationProof: createQuestionPublicationProof(hosted, operation.operationId),
        ...(association.value.input?.answers?.length ? {trustedAnswers: structuredClone(association.value.input.answers)} : {}),
        ...(association.value.input?.clarification_target ? { clarificationTarget: association.value.input.clarification_target } : {}),
        ...(association.value.input?.selected_answers ? { selectedAnswers: association.value.input.selected_answers } : {}),
        ...(association.value.input?.clarification_selection ? { clarificationSelection: association.value.input.clarification_selection } : {}),
        ...(association.value.input?.time_override ? { timeOverride: association.value.input.time_override } : {}),
        promptFingerprint: association.value.fingerprint,
        sessionId: hosted.sessionId,
        requestId: requestRef.value,
        operationId: operation.operationId,
        commands: this.createCommandBridge(hosted, requestRef.value),
        frames: new NativeFrameStore(hosted.session),
        semanticTasks: new NativeSemanticTaskStore(hosted.session),
        businessResults: new NativeBusinessResultStore(hosted.session),
        history: createHistoryBridge(hosted, () => requestContext),
        answerEvidence: async () => currentTurnEvidence(await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT)),
        timings: { startedAt: performance.now(), modelFirstTokenMs: [], model_ms: [], tool_ms: [] },
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

  /** 停止与接纳共用会话锁；accepted尚未到达浏览器时也只取消指定request，不误停其它操作。 */
  async cancelRequest(hosted: HostedSession, requestId: string): Promise<void> {
    await this.exclusiveAdmission(hosted.sessionId, async () => {
      await hosted.session.setValue(cancelledRequestValue(requestId), true, BACKGROUND_CONTEXT);
      const request = await hosted.session.getValue(requestValue(requestId), BACKGROUND_CONTEXT);
      if (request) await this.abort(hosted, request.value.operationId);
    });
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

function clickAnswerDisplayText(snapshots: readonly SemanticAnswerSnapshot[]): string {
  const rows = snapshots.filter(snapshot => snapshot.answer.source.channel === "click").map(snapshot => {
    const {question, answer} = snapshot;
    if (answer.choice.type === "none_of_these") return "以上选项都不符合";
    const ids = answer.choice.type === "select" ? answer.choice.option_ids
      : question.kind === "confirm" ? [question.confirmation_option_id] : [];
    const selected = question.options.filter(option => ids.includes(option.option_id))
      .map(option => `第 ${option.no} 项「${option.label}」`).join("、") || "所选选项";
    return answer.choice.type === "select" ? `选择${selected}` : answer.choice.type === "accept" ? `确认${selected}` : `拒绝${selected}`;
  });
  return rows.join("\n") || "提交结构化回答";
}

/** 只接受当前分支、本轮之前、签发 operation 内的最终 resolve 回执。 */
function createQuestionPublicationProof(hosted: HostedSession, operationId: string) {
  return async (question: PendingQuestion): Promise<boolean> => {
    if (!question.issued_operation_id || question.issued_operation_id === operationId) return false;
    const result = await hosted.lane.getResult(question.issued_operation_id, BACKGROUND_CONTEXT);
    if (!result || result.kind !== "run" || !result.tipId) return false;
    const currentBranch = await hosted.lane.findEntries({order: "oldestFirst", stopAtId: result.tipId}, BACKGROUND_CONTEXT);
    if (currentBranch.at(-1)?.id !== result.tipId) return false;
    const from = result.fromTipId ? await hosted.session.getEntry(result.fromTipId, BACKGROUND_CONTEXT) : undefined;
    if (result.fromTipId && !from) return false;
    // findEntries 沿父链从 start 向旧回溯；oldestFirst 会把 stopAtId 之前的整段历史也扫进来，
    // 叠加 seq 下界过滤后恒为空——跨轮签发（fromTipId 非空）的回执因此全部漏检。
    // 正确区间是签发 operation 实际写入的条目：从完成点向旧扫到起始点，再用 seq 排除起始点本身。
    const entries = await hosted.lane.findEntries({start: result.tipId, order: "newestFirst", type: "message",
      ...(result.fromTipId ? {stopAtId: result.fromTipId} : {})}, BACKGROUND_CONTEXT);
    return entries.some(entry => {
      if (entry.type !== "message" || from && entry.seq <= from.seq) return false;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== "resolve_business_turn" || message.isError
        || !isSemanticFeedback(message.details)) return false;
      return (message.details.pending_questions ?? []).some(candidate =>
        candidate.question_id === question.question_id && candidate.version === question.version);
    });
  };
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
export function createHistoryBridge(hosted: HostedSession, request: () => AskMetricRequestContext): HistoryBridge {
  const { lane } = hosted;
  type Sources = import("./requestContext.js").HistoryReadSources;
  let original: Promise<{entries: Entry[]; turns: Map<string, Entry[]>}> | undefined;
  const checked = new Map<Entry[], Promise<{entries: Entry[]; sources: Sources}>>();
  const view = () => original ??= (async () => {
    const entries = await lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const turns = new Map<string, Entry[]>(); let turn: Entry[] = [];
    for (const entry of entries) if (entry.type === "message") {
      if (entry.message.role === "user") turn = [];
      turn.push(entry); turns.set(entry.id, turn);
    }
    return {entries, turns};
  })();
  const check = (turn: Entry[]) => {
    if (!checked.has(turn)) checked.set(turn, (async () => {
      const messages = turn.filter(entry => entry.type === "message");
      const sentinel = {role: "user" as const, content: "", timestamp: 0};
      const safe = (await safeWorkingHistory(request(), [sentinel, ...messages.map(entry => entry.message), sentinel])).slice(1, -1);
      const refs = historySources(safe.flatMap(message => message.role === "toolResult" ? [message.details] : []),
        () => {throw new Error("HISTORY_SCOPE_UNAVAILABLE");});
      const sources: Sources = {tasks: [...refs.tasks].map(([task_id, result_id]) => ({task_id, ...(result_id ? {result_id} : {})})),
        organizationScopes: await resolveHistoryOrganizationScopes(refs, request().semanticTasks, () => {throw new Error("HISTORY_SCOPE_UNAVAILABLE");})};
      return {entries: messages.map((entry, index) => ({...entry, message: safe[index]}) as Entry), sources};
    })());
    return checked.get(turn)!;
  };
  // 先本地定位涉及的完整回合，再查权限；百轮会话读取一条旧记录只复核其来源。
  const authorized = async (entries: Entry[], turns: Map<string, Entry[]>) => {
    const groups = [...new Set(entries.flatMap(entry => turns.get(entry.id) ? [turns.get(entry.id)!] : []))];
    const decisions = await Promise.all(groups.map(check));
    const safe = new Map<string, Entry>(), sources = new Map<string, Sources>();
    for (const decision of decisions) for (const entry of decision.entries) {safe.set(entry.id, entry); sources.set(entry.id, decision.sources);}
    return {entries: entries.map(entry => safe.get(entry.id) ?? entry), sources};
  };
  const joined = (ids: string[], sources: Map<string, Sources>): Sources => {
    const tasks = new Map<string, {task_id: string; result_id?: string}>(), scopes = new Map<string, string[]>();
    for (const id of ids) {
      for (const ref of sources.get(id)?.tasks ?? []) tasks.set(ref.task_id, ref);
      for (const scope of sources.get(id)?.organizationScopes ?? []) scopes.set(JSON.stringify([...scope].sort()), scope);
    }
    return {tasks: [...tasks.values()], organizationScopes: [...scopes.values()]};
  };
  return {
    async list(beforeSeq, limit = 10) {
      const capped = Math.min(Math.max(limit ?? 10, 1), 20);
      const snapshot = await view();
      const found = [...snapshot.entries].reverse().filter(entry => beforeSeq === undefined || entry.seq < beforeSeq);
      const permitted = await authorized(found.slice(0, capped), snapshot.turns);
      const page = permitted.entries;
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
        sources: joined(page.map(entry => entry.id), permitted.sources),
      };
    },
    async read(entryId, offset = 0, length = 4000) {
      const cappedLength = Math.min(Math.max(length, 1), 8000);
      const snapshot = await view();
      const originalHit = snapshot.entries.find(entry => entry.id === entryId);
      if (originalHit?.type === "message") {
          const permitted = await authorized([originalHit], snapshot.turns);
          const hit = permitted.entries[0]!;
          const sliced = sliceByCodePoints(entryVisibleText(hit), offset, cappedLength);
          return { entry_id: hit.id, seq: hit.seq, type: hit.type, text: sliced.text, next_offset: sliced.next,
            sources: joined([hit.id], permitted.sources)};
      }
      return null;
    },
  };
}

/** 本轮的确定失败不能被随后被拦截的工具调用覆盖；新用户回合由调用方划定边界。 */
function terminalResolutionFailure(messages: import("@earendil-works/pi-agent-core").AgentMessage[]) {
  const receipt = [...messages].reverse().find(message => message.role === "toolResult"
    && message.toolName === "resolve_business_turn" && isTerminalResolutionFailure(message.details));
  if (receipt?.role !== "toolResult") return undefined;
  return getResolutionFailureDisposition((receipt.details as {error_code: string}).error_code);
}

/** 业务回执先于旁支工具决定终态；只在本轮记录内恢复，不另存会话状态。 */
function terminalSemanticAnswer(messages: import("@earendil-works/pi-agent-core").AgentMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "toolResult" || !isSemanticFeedback(message.details)) continue;
    const answer = readDirectAnswerSnapshot(message.details)?.public_answer ?? semanticPublicAnswer(message.details);
    if (answer !== undefined) return answer;
  }
}

/** 修复语义与寻找尚无证据的来源分开：后者仍由 Pi 自主查目录或分页历史。 */
function requiresSemanticProposal(feedback: SemanticFeedback): boolean {
  return feedback.continuation.actor === "pi" && feedback.continuation.action === "revise_proposal"
    && !feedback.issues.some(issue => issue.remediation === "pi" && (issue.category === "reference" || issue.category === "catalog"
      || ["ANALYSIS_CATALOG_EVIDENCE_REQUIRED", "ANALYSIS_EVIDENCE_PENDING"].includes(issue.code)));
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
