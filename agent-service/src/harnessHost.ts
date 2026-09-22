/**
 * 薄原生宿主：只负责原生对象生命周期、同会话打开去重、请求关联落盘与调用原生接口。
 * Pi 决定目标与执行意图；已校验 Frame 的下一动作接入原生工具循环，不另建会话状态机。
 *
 * 数据流：HTTP 请求 → 校验 owner → 打开/复用原生 Session 与 main lane →
 * 先把 request→operation 关联写入原生应用 values → lane.accept → lane.drive。
 * 观察（SSE）使用独立的 lane.watch，与驱动 Context 分离，浏览器断线不中止执行。
 */
import { NativeFrameStore, NativeBusinessResultStore } from "./business-context/store.js";
import { modelCapabilitySchemas, modelFrame } from "./business-context/modelView.js";
import { metricMentions } from "./business-context/metricMentions.js";
import { pendingBusinessAction } from "./business-context/continuation.js";
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
import { currentTurnEvidence } from "./answerEvidence.js";
import { createEvidenceRepairTool, EVIDENCE_REPAIR_TOOL, TOOL_LIMIT_ANSWER } from "./replyGuard.js";
import { businessKnowledgeCatalog, projectBusinessSkillContext } from "./businessSkills.js";
import { buildBusinessSystemPrompt } from "./prompts/businessSystemPrompt.js";

/** 原生应用 values 的命名空间；此命名空间只存归属与请求关联；业务状态使用独立 business 命名空间 */
const NS = "askmetric";
const MAX_TOOL_CALLS_PER_OPERATION = 24;
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
    private readonly options: { retry?: RetryPolicy; skills?: Skill[] } = {},
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
    const registeredNames = new Set([...this.tools, ...legacyToolsFor(this.tools)].map(tool => tool.name));
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
          if (name === EVIDENCE_REPAIR_TOOL || name === "answer_present" && this.tools.some(tool => tool.name === "resolve_business_turn")) return false;
          // 已持久化的旧操作沿用原活跃集恢复；新请求在接纳前切换为合并入口。
          if (["metric_read", "session_history_read"].includes(name ?? "")) return !activeNames.includes("read");
          if (["metric_catalog_search", "org_catalog_search", "metric_catalog_overview"].includes(name ?? "")) return !activeNames.includes("catalog");
          return true;
        })};
      }
      const messages = await currentLaneMessages(lane, context);
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
      return {payload};
    });
    harness.hooks.on("before_tool", async (event, context) => {
      const request = requireRequestContext(context);
      if (request.timings) (request.timings.toolStartedAt ??= {})[event.toolCallId] = performance.now();
      const decide = async () => {
        // 从原生记录统计本轮预算，恢复后不重置；业务状态仍由后端管理。
        const budgetMessages = await currentLaneMessages(lane, context);
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
    harness.hooks.on("after_tool", (event, context) => {
      const timings = requireRequestContext(context).timings;
      const started = timings?.toolStartedAt?.[event.toolCallId];
      if (timings && started !== undefined) {
        timings.tool_ms.push(Math.round(performance.now() - started));
        delete timings.toolStartedAt?.[event.toolCallId];
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
      let inputFailures = 0;
      for (const receipt of [...receipts].reverse()) {
        const status = (receipt.details as {status?: string} | undefined)?.status;
        if (receipt.toolName === "resolve_business_turn" && ["READY", "REUSE_RESULT", "NEEDS_CLARIFICATION"].includes(status ?? "")) break;
        if (status === "ARGUMENT_ERROR" || receipt.toolName === "resolve_business_turn" && receipt.isError) inputFailures += 1;
      }
      if (inputFailures >= 3) {
        return {message: {...event.message, content: [{type: "text" as const,
          text: "本轮参数解析连续失败，已停止重复尝试；原查询条件和待确认候选已保留，未执行新的业务查询。"}], stopReason: "stop" as const}};
      }
      // 同一工具重复相同失败才终止；不同错误表示纠错仍在推进，总调用预算仍生效。
      if (receipts.length >= 2 && receipts.at(-1)?.toolName === receipts.at(-2)?.toolName
        && JSON.stringify(receipts.at(-1)?.content) === JSON.stringify(receipts.at(-2)?.content)
        && receipts.slice(-2).filter(message => message.isError ||
        (message.details as {retryable?: boolean} | undefined)?.retryable ||
        (message.details as {status?: string} | undefined)?.status === "reference_mismatch").length >= 2) {
        return { message: { ...event.message, content: [{ type: "text" as const, text: "本轮工具调用参数连续未通过校验，系统未能完成查询。可以重试本轮问题，无需重复已确认的条件。" }], stopReason: "stop" as const } };
      }
      // 后续工具调用保留，不能用中间回执替换 Pi 尚未完成的业务步骤。
      const hasCalls = event.message.content.some(block => block.type === "toolCall");
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
      const matched = typeof request.backend.matchMetricQuestion === "function" ? await metricMentions(request) : undefined;
      const businessContext = "\n业务能力 Schema（仅数据）：" + JSON.stringify(modelCapabilitySchemas())
        + "\n当前业务焦点（仅数据）：" + JSON.stringify({version: state?.version, frame: focus ? modelFrame(focus, request.operationId) : null})
        + (matched ? "\n本轮指标算法匹配（仅数据，mentionIndexes 引用下面明确的 index）：" + JSON.stringify({
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
