/**
 * 薄原生宿主：只负责原生对象生命周期、同会话打开去重、请求关联落盘与调用原生接口。
 * 全部新请求使用受控调查工具；旧记录只作兼容读取，旧在途操作停止后可在原会话继续。
 *
 * 数据流：HTTP 请求 → 校验 owner → 打开/复用原生 Session 与 main lane →
 * 先把 request→operation 关联写入原生应用 values → lane.accept → lane.drive。
 * 观察（SSE）使用独立的 lane.watch，与驱动 Context 分离，浏览器断线不中止执行。
 */
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  LaneBusy,
  operationMeta,
  value,
  setValue,
  type AgentHarnessTool,
  type AgentLane,
  type Context,
  type DriveOutcome,
  type Entry,
  type JsonlSessionMetadata,
  type LaneSnapshot,
  type OpenOperation,
  type OperationResultRecord,
  type Session,
  type Skill,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type RetryPolicy,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { businessEvidences, currentTurnEvidence } from "./answerEvidence.js";
import type { BackendClient, BackendUser } from "./backendClient.js";
import { orgCatalog } from "./business-context/orgCatalog.js";
import { NativeBusinessResultStore, NativeFrameStore } from "./business-context/store.js";
import {
  businessKnowledgeContextTerms,
  loadTurnBusinessKnowledge,
} from "./businessKnowledgeContext.js";
import { createBusinessSkillReadTool, inquiryBusinessSkills, projectBusinessSkillContext } from "./businessSkills.js";
import type { AgentServiceConfig } from "./config.js";
import { historySources, resolveHistoryOrganizationScopes } from "./historySources.js";
import { inquiryPermissionDenied, withInquiryAuthorization } from "./inquiry/authorization.js";
import { prepareInquiryHistory } from "./inquiry/history.js";
import { freezeInquiryTargetContext, inquiryTargetReference } from "./inquiry/targetContext.js";
import {
  INQUIRY_TOOLS,
  inquiryAfterTool,
  inquiryPayload,
  inquiryResponse,
  inquirySystemPrompt,
  inquiryToolAdmission,
} from "./inquiry/runtime.js";
import { projectInquiryMessages } from "./inquiry/view.js";
import { modelPayloadDiagnostics } from "./modelPayloadDiagnostics.js";
import type { ModelBundle } from "./models.js";
import { modelUsage } from "./modelUsage.js";
import { NativeSessionStore } from "./nativeSessions.js";
import { SessionCoordinationError } from "./databaseSessionStorage.js";
import {
  requireRequestContext,
  withRequestContext,
  type AskMetricRequestContext,
  type CommandBridge,
  type HistoryBridge,
  type HistoryEntrySummary,
  type WriteCommandRecord,
} from "./requestContext.js";
import { authenticationFailure, withBackendAuthentication } from "./runtime/authentication.js";
import { safeWorkingHistory } from "./semantic-task/contextMemory.js";
import { isSemanticFeedback } from "./semantic-task/feedback.js";
import {
  normalizeAnswerInput,
  QuestionAnswerError,
  type AnswerErrorCode,
  type ClickAnswerInput,
  type PendingQuestion,
} from "./semantic-task/questions.js";
import { NativeSemanticTaskStore } from "./semantic-task/store.js";
import { auditToolCall, withToolExecutionAudit } from "./toolAudit.js";
import {
  admitInquiryInput,
  InquiryAdmissionError,
  type InquiryAdmission,
} from "./inquiry/admission.js";
import {
  stopLegacyOperation,
  LEGACY_OPERATION_INTERRUPTED_MESSAGE,
} from "./inquiry/legacyRecovery.js";
import { businessDate } from "./business-context/resolvers.js";
import { PARTIAL_ANALYSIS } from "./tools/partialAnalysis.js";

/** 原生应用 values 的命名空间；此命名空间只存归属与请求关联；业务状态使用独立 business 命名空间 */
const NS = "askmetric";

/**
 * 常驻内存治理：会话数量不设上限（历史只是磁盘文件），只回收内存中的 harness 与文件句柄。
 * 空闲超时或超过常驻上限时，从最久未用的空闲会话开始关闭；运行中、接纳中的会话不回收。
 */
const DEFAULT_RESIDENCY = { idleMs: 30 * 60_000, maxResident: 200, sweepIntervalMs: 60_000 };
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
  /** 保留旧协议身份以便回放；执行链路由 executionFlow 区分，旧工具不再续跑。 */
  toolProtocol?: "fixed_v1" | "semantic_v2";
  executionFlow?: "inquiry_v1";
  inquiryAdmission?: InquiryAdmission;
  inquiryTargetContext?: import("./inquiry/target.js").InquiryTargetContext;
  /** 本请求已接纳的独立业务写意图（同一 operation 最多一个） */
  write?: WriteCommandRecord;
  input?: PromptInput;
  timings_ms?: { model: number[]; tools: number[]; drive_total: number };
}

const requestValue = (requestId: string) => value<RequestAssociation>(NS, `request/${requestId}`);
const cancelledRequestValue = (requestId: string) =>
  value<boolean>(NS, `cancelled-request/${requestId}`);
/** operation → request 反查：重启恢复时凭 operationId 找回已接纳输入 */
const operationRequestValue = (operationId: string) =>
  value<string>(NS, `operation/${operationId}`);

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
  /** 仅供在途观察读取本轮证据与调用序号，不持久化，也不参与会话业务决策。 */
  activeRequest?: AskMetricRequestContext;
  readOnlyReason?: "LEGACY_QUERY_REQUIRES_NEW_TURN";
  /** 共享库只读观察句柄不能接纳、续跑或修改原生状态。 */
  observer?: boolean;
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

type PromptFailureCode =
  | "SESSION_BUSY"
  | "INVALID_MESSAGE"
  | "REQUEST_CONFLICT"
  | "REQUEST_CANCELLED"
  | "SESSION_CLOSED"
  | "LEGACY_QUERY_REQUIRES_NEW_TURN"
  | AnswerErrorCode
  | "LEGACY_CLARIFICATION_UNSUPPORTED";

export type AdmitOutcome =
  | {
      ok: true;
      operationId: string;
      context: Context;
      request: AskMetricRequestContext;
      /** 同一 request_id 的操作已结束：重试只回放原终态，不再接纳或驱动 */
      completed?: OperationResultRecord;
    }
  | { ok: false; code: PromptFailureCode; message: string };

export type DriveOutcomeResult =
  | { ok: true; operationId: string; outcome: DriveOutcome }
  | { ok: false; code: PromptFailureCode; message: string };

/** 指纹前只规范形状与顺序；问题是否存在、是否仍可答由核心在幂等查询后判断。 */
async function normalizePromptAnswers(
  input: PromptInput,
  store: NativeSemanticTaskStore,
): Promise<PromptInput> {
  const { answers: rawAnswers, ...rest } = input;
  if (rawAnswers === undefined) return rest;
  if (!Array.isArray(rawAnswers) || rawAnswers.length > 20) {
    throw new QuestionAnswerError("ANSWER_INPUT_SHAPE_INVALID", "一轮最多提交 20 条回答。");
  }
  const answers = rawAnswers.map((raw) => {
    const answer = normalizeAnswerInput(raw, { channel: "click", operation_id: "http" });
    return {
      question_id: answer.question_id,
      version: answer.version,
      choice: answer.choice,
    };
  });
  const questions = new Map<string, PendingQuestion | undefined>();
  for (const answer of answers) {
    if (answer.choice.type !== "select") continue;
    const key = `${answer.question_id}/${answer.version}`;
    if (!questions.has(key))
      questions.set(key, (await store.question(answer.question_id, answer.version))?.question);
    const question = questions.get(key);
    if (!question) continue;
    const order = new Map(question.options.map((option, index) => [option.option_id, index]));
    answer.choice = {
      type: "select",
      option_ids: [...answer.choice.option_ids].sort(
        (left, right) =>
          (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          (left < right ? -1 : left > right ? 1 : 0),
      ) as [string, ...string[]],
    };
  }
  answers.sort(
    (left, right) =>
      (left.question_id < right.question_id ? -1 : left.question_id > right.question_id ? 1 : 0) ||
      left.version - right.version ||
      (canonicalJson(left.choice) < canonicalJson(right.choice)
        ? -1
        : canonicalJson(left.choice) > canonicalJson(right.choice)
          ? 1
          : 0),
  );
  return { ...rest, ...(answers.length ? { answers } : {}) };
}

export class HarnessHost {
  /** 同会话打开 Promise 去重：并发请求共享同一次打开，不重复打开同一 Session */
  private readonly live = new Map<string, Promise<HostedSession>>();
  /** 会话级授权状态：撤权后该会话的后续模型请求（含压缩）在 provider 边界被拒 */
  private readonly authorization = new Map<string, { authorized: boolean }>();
  /** 同会话接纳串行化：请求关联的“读→写→accept”跨多个 await，并发时会互相覆盖 */
  private readonly admissions = new Map<string, Promise<void>>();
  /** 恢复包含原生终态后的兼容提示；观察方共享同一次恢复，避免提前发送终态快照。 */
  private readonly recoveries = new Map<string, Promise<number>>();
  /** 已打开会话的最近使用时间；回收只看这里，列表读取不延长常驻 */
  private readonly lastUsed = new Map<string, number>();
  /** 列表读取标题时的临时打开；正式打开须等其释放，避免复用即将被关闭的 Session */
  private readonly peeks = new Map<string, Promise<unknown>>();
  private readonly readers = new Map<string, number>();
  private readonly titles = new Map<string, string | undefined>();
  private readonly residency: typeof DEFAULT_RESIDENCY;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AgentServiceConfig,
    private readonly createModels: (authorize: () => boolean) => ModelBundle,
    private readonly store: NativeSessionStore,
    private readonly tools: AgentHarnessTool<AskMetricRequestContext>[],
    private readonly options: {
      retry?: RetryPolicy;
      skills?: Skill[];
      getSkills?: () => readonly Skill[];
      residency?: Partial<typeof DEFAULT_RESIDENCY>;
    } = {},
  ) {
    this.residency = { ...DEFAULT_RESIDENCY,
      ...(store.cluster ? { idleMs: 1_000, sweepIntervalMs: 1_000 } : {}), ...options.residency };
    store.cluster?.onCancellation(async (id, kind, target) => {
      const hosted = await this.live.get(id)?.catch(() => undefined);
      if (!hosted || !store.cluster?.isWriter(id)) return false;
      if (kind === "request") await this.cancelRequest(hosted, target);
      else await this.abort(hosted, target);
      return true;
    });
    this.sweeper = setInterval(() => {
      void this.evictIdle().catch((error: unknown) =>
        console.error(
          JSON.stringify({
            event: "session_eviction_failed",
            reason: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
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
  async openSession(actor: BackendUser, sessionId: string, allowRecovery = false): Promise<HostedSession | undefined> {
    if (this.store.cluster && this.live.has(sessionId) && !this.store.cluster.isWriter(sessionId))
      await this.closeSession(sessionId);
    const known = await this.liveFor(actor, sessionId);
    if (known !== null) return known;
    if (this.store.cluster && !allowRecovery) {
      const row = await this.store.cluster.state(actor.id, sessionId);
      if (row?.current_operation_id) throw new SessionCoordinationError("SESSION_BUSY", "会话存在未完成的提问，请重新打开会话查看或恢复执行");
    }
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

  /** 已在别的实例执行时只读打开；租约过期后的恢复仍走原有重新授权链路。 */
  async viewSession(actor: BackendUser, sessionId: string, allowRecovery = true): Promise<HostedSession | undefined> {
    const shared = this.store.cluster;
    if (!shared) return this.openSession(actor, sessionId);
    const row = await shared.state(actor.id, sessionId);
    if (!row) return undefined;
    if (shared.isWriter(sessionId)) return this.openSession(actor, sessionId);
    if (allowRecovery && row.current_operation_id && Number(row.lease_until_ms) <= await shared.database.now()) {
      try { return await this.openSession(actor, sessionId, true); }
      catch (error) {
        // 多个浏览器同时恢复时只有一个获得执行权，其余继续只读观察。
        if (!(error instanceof Error && "code" in error && error.code === "SESSION_BUSY")) throw error;
      }
    }
    const session = await shared.observe(actor.id, sessionId);
    return session ? this.attach(actor, session, true) : undefined;
  }

  async releaseView(hosted: HostedSession): Promise<void> {
    if (hosted.observer) await hosted.harness.close(BACKGROUND_CONTEXT);
  }

  async releaseIdle(sessionId: string): Promise<void> {
    if (!this.store.cluster) return;
    await this.exclusiveAdmission(sessionId, async () => {
      if (this.readers.has(sessionId)) return;
      const hosted = await this.live.get(sessionId)?.catch(() => undefined);
      if (hosted && !(await hosted.lane.inspectExecution(BACKGROUND_CONTEXT)).current)
        await this.closeSession(sessionId);
    });
  }

  retain(sessionId: string): () => void {
    this.readers.set(sessionId, (this.readers.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.readers.get(sessionId) ?? 1) - 1;
      if (count) this.readers.set(sessionId, count); else this.readers.delete(sessionId);
    };
  }

  /** 删除与本机接纳共用入口锁；共享库还会在同一事务检查 operation 与写入墓碑。 */
  async deleteSession(actor: BackendUser, sessionId: string): Promise<"deleted" | "missing" | "busy"> {
    return this.exclusiveAdmission(sessionId, async () => {
      if (this.store.cluster) {
        const metadata = await this.store.findMetadata(actor.id, sessionId);
        if (!metadata) return "missing";
        // 删除不接管失联节点的运行租约，否则拒绝删除后会留下无人驱动的活动操作。
        await this.store.delete(actor.id, metadata);
        await this.closeSession(sessionId);
        return "deleted";
      }
      const hosted = await this.openSession(actor, sessionId);
      if (!hosted) return "missing";
      if ((await hosted.lane.inspectExecution(BACKGROUND_CONTEXT)).current) return "busy";
      const metadata = await this.store.findMetadata(actor.id, sessionId);
      await this.closeSession(sessionId);
      if (metadata) await this.store.delete(actor.id, metadata);
      return "deleted";
    });
  }

  /** 已在打开或已打开：返回归属校验后的结果；null 表示尚未打开 */
  private async liveFor(
    actor: BackendUser,
    sessionId: string,
  ): Promise<HostedSession | undefined | null> {
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
      if (this.admissions.has(sessionId) || this.readers.has(sessionId)) continue;
      const hosted = await this.live.get(sessionId)?.catch(() => undefined);
      if (!hosted) {
        this.lastUsed.delete(sessionId);
        continue;
      }
      if (this.store.cluster && !this.store.cluster.isWriter(sessionId)) {
        await this.closeSession(sessionId);
        resident -= 1;
        evicted.push(sessionId);
        continue;
      }
      const execution = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
      if (
        execution.current ||
        this.admissions.has(sessionId) ||
        this.lastUsed.get(sessionId) !== usedAt
      )
        continue;
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
  async sessionTitle(
    ownerUserId: string,
    metadata: JsonlSessionMetadata,
  ): Promise<string | undefined> {
    if (this.store.cluster) return this.store.cluster.title(ownerUserId, metadata.id);
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
      try {
        title = await peek;
      } finally {
        if (this.peeks.get(metadata.id) === peek) this.peeks.delete(metadata.id);
      }
    }
    if (this.titles.size >= TITLE_CACHE_LIMIT) this.titles.clear();
    this.titles.set(cacheKey, title);
    return title;
  }

  /** 已创建会话的打开结果登记；调用方负责 this.live 去重，这里不再查表（避免自引用死锁） */
  private async attach(
    actor: BackendUser,
    session: Session<JsonlSessionMetadata>,
    observer = false,
  ): Promise<HostedSession> {
    const sessionId = session.metadata.id;
    const opening = (async (): Promise<HostedSession> => {
      // 授权状态对象按会话共享引用，撤权即刻对该会话全部后续模型请求生效
      const authorization = { authorized: true };
      if (!observer) this.authorization.set(sessionId, authorization);
      const bundle = this.createModels(() => authorization.authorized && !observer &&
        (!this.store.cluster || this.store.cluster.isWriter(sessionId)));
      // 协议只读判定：无标记或 fixed_v1 的历史会话一律只读，不再按其协议恢复执行。
      const businessProtocol =
        (await session.getValue(businessProtocolValue, BACKGROUND_CONTEXT))?.value ?? "fixed_v1";
      if (!["fixed_v1", "semantic_v2"].includes(businessProtocol))
        throw new Error("SESSION_PROTOCOL_UNSUPPORTED");
      const skills = this.skillSnapshot();
      const sessionTools = this.tools
        .filter((tool) => INQUIRY_TOOLS.has(tool.name) || tool.name === PARTIAL_ANALYSIS)
        .map((tool) =>
          tool.name === "business_skill_read" ? createBusinessSkillReadTool(skills) : tool,
        );
      const runtimeTools = sessionTools
        .map(withInquiryAuthorization)
        .map(withBackendAuthentication)
        .map(withToolExecutionAudit);
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
          systemPrompt: () =>
            inquirySystemPrompt(
              new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Shanghai",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(new Date()),
              false,
              this.config.answerStreaming,
              this.config.topicQueryEnabled,
            ),
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
      const retired = businessProtocol !== "semantic_v2";
      if (!observer && !execution.current && !retired)
        await lane.setActiveTools(
          sessionTools.map((tool) => tool.name),
          BACKGROUND_CONTEXT,
        );
      this.registerHooks(harness, lane, session, sessionTools, skills);
      return {
        businessProtocol,
        sessionId,
        ownerUserId: actor.id,
        session,
        harness,
        lane,
        open,
        createdAt: session.metadata.createdAt,
        ...(observer ? { observer: true } : {}),
        ...(retired ? { readOnlyReason: "LEGACY_QUERY_REQUIRES_NEW_TURN" as const } : {}),
      };
    })();
    if (!observer) {
      this.live.set(sessionId, opening);
      opening.catch(() => this.live.delete(sessionId));
    }
    return opening;
  }

  /** /no_think 等提供方兼容只作用于发送副本，不改用户原文与原生历史 */
  private registerHooks(
    harness: AgentHarness<AskMetricRequestContext>,
    lane: AgentLane,
    session: Session,
    sessionTools: AgentHarnessTool<AskMetricRequestContext>[],
    skills: Skill[],
  ): void {
    const registeredNames = new Set(sessionTools.map((tool) => tool.name));
    // 原生 usage 事件同时覆盖业务调用、自动压缩和分支摘要；after_response 不覆盖原生摘要。
    harness.events.on("usage", (event, context) => {
      if (event.row.adjustment) return;
      const request = requireRequestContext(context);
      console.info(
        JSON.stringify({
          event: "model_usage",
          layer: "agent",
          usage_id: event.row.id,
          request_id: request.requestId,
          session_id: request.sessionId,
          operation_id: request.operationId,
          step: request.modelCall?.step ?? "unknown",
          attempt: request.modelCall?.attempt ?? null,
          model: request.modelCall?.model ?? null,
          payload_bytes: request.modelCall?.payloadBytes ?? null,
          final_payload_bytes: request.modelCall?.finalPayloadBytes ?? null,
          duration_ms: request.modelCall
            ? Math.round(performance.now() - request.modelCall.startedAt)
            : null,
          ...modelUsage(event.row.usage),
        }),
      );
    });
    harness.hooks.on("before_request", (event, context) => {
      const request = requireRequestContext(context);
      invalidateAnswerStream(request);
      request.modelCall = {
        step: event.step,
        model: event.model.id,
        attempt: event.attempt,
        startedAt: performance.now(),
      };
      const timings = request.timings;
      if (timings) {
        timings.modelStartedAt = performance.now();
        timings.modelFirstTokenRecorded = false;
      }
      return undefined;
    });
    harness.events.on("retry_start", (_event, context) => {
      invalidateAnswerStream(requireRequestContext(context));
    });
    harness.events.on("message_update", (event, context) => {
      const request = requireRequestContext(context);
      if (event.message.role === "assistant") {
        const calls = event.message.content.filter((block) => block.type === "toolCall");
        if (calls.length > 1 || calls.some((call) => call.name && call.name !== "analysis_answer"))
          invalidateAnswerStream(request);
      }
      const timings = request.timings;
      if (timings?.modelStartedAt !== undefined && !timings.modelFirstTokenRecorded) {
        timings.modelFirstTokenMs.push(Math.round(performance.now() - timings.modelStartedAt));
        timings.modelFirstTokenRecorded = true;
      }
    });
    harness.events.on("message_end", (event, context) => {
      if (
        event.message.role === "assistant" &&
        ["error", "aborted", "length"].includes(event.message.stopReason)
      )
        invalidateAnswerStream(requireRequestContext(context));
    });
    harness.events.on("tool_start", (event, context) => {
      // 报告核验期间仍可保留已发布正文；转回调查工具则不能继续展示旧草稿。
      if (event.toolName !== "analysis_answer")
        invalidateAnswerStream(requireRequestContext(context));
    });
    harness.events.on("tool_end", (event, context) => {
      const request = requireRequestContext(context);
      invalidateAnswerStream(request);
      if (
        !authenticationFailure(event.result.details) &&
        !inquiryPermissionDenied(event.result.details)
      )
        return;
      // 权限失效立即停止旁支；正常交付由 terminate 与后续工具准入结束，不能标成用户取消。
      // 事件仍在原生命令提交中，不能同步等待后续取消命令。
      const operationId = request.operationId;
      void lane.requestAbort(operationId, BACKGROUND_CONTEXT).catch((error) => {
        console.error(
          JSON.stringify({
            event: "operation_stop_failed",
            operation_id: operationId,
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      });
    });
    harness.hooks.on("before_payload", async (event, context) => {
      const request = requireRequestContext(context);
      const callSeq = (request.answerStream?.callSeq ?? 0) + 1;
      const raw = event.payload as Record<string, unknown>;
      if (request.modelCall)
        request.modelCall.payloadBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
      const summary =
        request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary";
      request.answerStream = {
        callSeq,
        mode: this.config.answerStreaming && !summary ? "text" : "none",
      };
      const payload = summary
        ? raw
        : inquiryPayload(
            raw,
            await currentLaneMessages(lane, context),
            this.config.answerStreaming,
          );
      const diagnostics = modelPayloadDiagnostics(payload);
      if (request.modelCall) request.modelCall.finalPayloadBytes = diagnostics.final_payload_bytes;
      console.info(
        JSON.stringify({
          event: "model_request_payload",
          request_id: request.requestId,
          session_id: request.sessionId,
          operation_id: request.operationId,
          call_seq: callSeq,
          step: request.modelCall?.step,
          attempt: request.modelCall?.attempt,
          ...diagnostics,
        }),
      );
      return { payload };
    });
    harness.hooks.on("before_tool", async (event, context) => {
      const request = requireRequestContext(context);
      if (request.timings)
        (request.timings.toolStartedAt ??= {})[event.toolCallId] = performance.now();
      const decision = inquiryToolAdmission(
        await currentLaneMessages(lane, context),
        event.toolName,
        event.args,
        { operationId: request.operationId, toolCallId: event.toolCallId },
      );
      auditToolCall(
        request,
        event.toolCallId,
        event.toolName,
        decision?.block ? "blocked" : "admitted",
        event.args,
      );
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
      if (authenticationFailure(event.details)) return { isError: true, terminate: true };
      return inquiryAfterTool(event, request, await currentLaneMessages(lane, context));
    });
    harness.hooks.on("after_response", async (event, context) => {
      const request = requireRequestContext(context);
      if (["error", "aborted", "length"].includes(event.message.stopReason))
        invalidateAnswerStream(request);
      if (request.modelCall?.step === "compaction" || request.modelCall?.step === "branch_summary")
        return undefined;
      // 在业务恢复改写前记录终止原因和体积，诊断截断时不保存正文或工具参数。
      console.info(
        JSON.stringify({
          event: "model_response",
          request_id: request.requestId,
          session_id: request.sessionId,
          operation_id: request.operationId,
          call_seq: request.answerStream?.callSeq ?? null,
          step: request.modelCall?.step ?? null,
          attempt: request.modelCall?.attempt ?? null,
          stop_reason: event.message.stopReason,
          raw_stop_reason: event.message.rawStopReason ?? null,
          content_block_count: event.message.content.length,
          content_blocks: event.message.content.map((block) => ({
            type: block.type,
            bytes: Buffer.byteLength(
              block.type === "text"
                ? block.text
                : block.type === "thinking"
                  ? block.thinking
                  : JSON.stringify(block.arguments),
            ),
          })),
        }),
      );
      const retry = this.options.retry ?? this.config.modelRetry;
      const terminalModelFailure =
        event.message.stopReason === "error" &&
        !isContextOverflow(event.message) &&
        (!isRetryableAssistantError(event.message) ||
          !retry?.enabled ||
          (request.modelCall?.attempt ?? 1) > (retry.maxRetries ?? 0));
      for (const block of event.message.content)
        if (block.type === "toolCall")
          auditToolCall(
            request,
            block.id,
            registeredNames.has(block.name) ? block.name : "unknown",
            "proposed",
            block.arguments,
          );
      if (request.timings?.modelStartedAt !== undefined)
        request.timings.model_ms.push(
          Math.round(performance.now() - request.timings.modelStartedAt),
        );
      return {
        message: inquiryResponse(
          event.message,
          request,
          await currentLaneMessages(lane, context),
          terminalModelFailure,
        ),
      };
    });
    const suffix = this.config.model.userMessageSuffix;
    harness.hooks.on("transform_context", async (event, context) => {
      const request = requireRequestContext(context);
      const currentSkills = request.businessSkills ?? skills;
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      try {
        let contextMessages = event.messages;
        if (contextMessages.some((message) => message.role === "compactionSummary")) {
          const operation = (await session.getValue(operationMeta(event.runId), context))?.value;
          if (
            event.runId !== request.operationId ||
            operation?.lane !== lane.name ||
            operation.intent.kind !== "run"
          )
            throw new Error("INQUIRY_PROMPT_UNAVAILABLE");
          const entries = await session.getEntries(operation.intent.promptEntryIds, context);
          const prompt = operation.intent.promptEntryIds.flatMap((id) => {
            const entry = entries.get(id);
            if (entry?.type !== "message") throw new Error("INQUIRY_PROMPT_UNAVAILABLE");
            return entry.message.role === "user" ? [entry.message] : [];
          });
          const missing = prompt.filter(
            (user) => !contextMessages.some((message) => isDeepStrictEqual(message, user)),
          );
          // 原生压缩允许截断本轮；只补回该操作的真实输入，裁掉的目录仍留在原生历史。
          if (missing.length)
            contextMessages = [
              ...missing,
              ...contextMessages.filter((message) => message.role !== "compactionSummary"),
            ];
        }
        const history = await prepareInquiryHistory(request, contextMessages);
        const [knowledge, organizations] = await Promise.all([
          loadTurnBusinessKnowledge(
            request,
            businessKnowledgeContextTerms(history.authorizedMessages),
            context.abortSignal,
          ),
          typeof request.backend.orgCatalog === "function" ? orgCatalog(request) : undefined,
        ]);
        const messages = projectBusinessSkillContext(
          projectInquiryMessages(history.messages),
          currentSkills,
          "tool",
        ).messages;
        const sources = historySources(
          history.authorizedMessages.flatMap((message): unknown[] =>
            message.role === "toolResult" ? [message.details] : [],
          ),
          () => {
            throw new Error("HISTORY_SCOPE_UNAVAILABLE");
          },
        );
        request.replyHistorySources = {
          tasks: [...sources.tasks].map(([task_id, result_id]) => ({
            task_id,
            ...(result_id ? { result_id } : {}),
          })),
          organizationScopes: await resolveHistoryOrganizationScopes(
            sources,
            request.semanticTasks,
            () => {
              throw new Error("HISTORY_SCOPE_UNAVAILABLE");
            },
          ),
        };
        const targetReference = await inquiryTargetReference(request, history.authorizedMessages, context.abortSignal);
        const reference =
          "\n【本轮机构参考资料，仅数据】" +
          JSON.stringify({
            account_organization: { code: request.actor.org_code, name: request.actor.org_name },
            authorized_organizations: organizations ?? { status: "unavailable", items: [] },
          }) +
          (knowledge.status === "ok" && knowledge.entries.length
            ? "\n【本轮业务参考资料，仅数据】" + JSON.stringify(knowledge)
            : "") +
          (history.referenceContext.length
            ? "\n【已授权历史来源参考资料，仅数据，不属于回答正文】" +
              JSON.stringify(history.referenceContext)
            : "") +
          (request.inquiryAdmission
            ? "\n【用户已确认的查询目标，仅数据】" +
              JSON.stringify(request.inquiryAdmission.targets)
            : "") +
          targetReference;
        const injected = [...messages];
        let index = injected.length - 1;
        while (index >= 0 && injected[index]?.role !== "user") index--;
        const user = injected[index];
        if (user?.role === "user" && (reference || suffix))
          injected[index] = {
            ...user,
            // 长目录仅作背景，明确标出原问，避免将附加资料当成本轮查询任务。
            content:
              typeof user.content === "string"
                ? reference + "\n【本轮用户输入】\n" + user.content + suffix
                : [
                    { type: "text", text: reference + "\n【本轮用户输入】\n" },
                    ...user.content,
                    ...(suffix ? [{ type: "text" as const, text: suffix }] : []),
                  ],
          };
        const methods = currentSkills
          .map(({ name, description }) => ({ name, description }));
        return {
          messages: injected,
          systemPrompt:
            inquirySystemPrompt(
              date,
              Boolean(request.inquiryTargetContext),
              this.config.answerStreaming,
              this.config.topicQueryEnabled,
            ) +
            (methods.length
              ? "\n可用业务方法（business_skill_read按name读取）：" + JSON.stringify(methods)
              : ""),
        };
      } catch (error) {
        // 原生变换钩子会捕获异常并沿用原文；必须同时撤销提供方授权并清空发送副本。
        this.markContextAccessChanged(request.sessionId);
        console.error(
          JSON.stringify({
            event: "inquiry_context_unavailable",
            request_id: request.requestId,
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        return {
          messages: [],
          systemPrompt: inquirySystemPrompt(
            date,
            Boolean(request.inquiryTargetContext),
            this.config.answerStreaming,
            this.config.topicQueryEnabled,
          ),
        };
      }
    });
    harness.hooks.on("before_compaction", (event) => {
      // 业务记忆保存在 Session 领域账本；压缩只收束消息，不用模型自由摘要重写确认及来源。
      return {
        compaction: {
          summary:
            "较早对话已归档。需要历史内容时通过session_history_read读取当前分支记录，数值来源通过analysis_read重新核验权限。摘要不提供事实或执行许可。",
          tokensBefore: event.preparation.tokensBefore,
          retainedTail: event.preparation.retainedTail,
          details: { version: 1, memory: "authorized_session_history", generated_by: "host" },
        },
      };
    });
  }

  private skillSnapshot(): Skill[] {
    return inquiryBusinessSkills(this.options.getSkills?.() ?? this.options.skills ?? [])
      .map((skill) => ({ ...skill }));
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
    return this.exclusiveAdmission(hosted.sessionId, () =>
      this.admitPromptExclusive(hosted, input, deps),
    );
  }

  /**
   * 单写实例内按会话串行接纳（Node 单线程，进程内 Promise 链即可互斥）。
   * 只覆盖接纳阶段，驱动与观察不在锁内，不阻塞同会话的读取和停止。
   */
  private async exclusiveAdmission<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    if (hosted.observer || !this.live.has(hosted.sessionId) ||
      (this.store.cluster && !this.store.cluster.isWriter(hosted.sessionId)))
      return { ok: false, code: "SESSION_CLOSED", message: "会话执行权已变更，请重新打开会话。" };
    if (
      (await hosted.session.getValue(cancelledRequestValue(input.request_id), BACKGROUND_CONTEXT))
        ?.value
    ) {
      return { ok: false, code: "REQUEST_CANCELLED", message: "此次提问已停止，未接纳新的执行。" };
    }
    if (hosted.readOnlyReason)
      return {
        ok: false,
        code: hosted.readOnlyReason,
        message:
          "此会话使用已停用的旧查询协议，历史记录保留只读。请新建会话重新提问；在途旧任务需先核对原结果，不能自动续跑。",
      };
    const semanticTasks = new NativeSemanticTaskStore(hosted.session);
    try {
      input = await normalizePromptAnswers(input, semanticTasks);
    } catch (error) {
      if (error instanceof QuestionAnswerError)
        return { ok: false, code: error.code, message: error.message };
      throw error;
    }
    if (
      !input.message &&
      !input.answers?.length &&
      !input.clarification_selection &&
      !input.selected_answers
    ) {
      return { ok: false, code: "INVALID_MESSAGE", message: "空文本必须伴随结构化回答。" };
    }
    const fingerprint = promptFingerprint({ ...input });
    const existing = await hosted.session.getValue(
      requestValue(input.request_id),
      BACKGROUND_CONTEXT,
    );
    if (existing && existing.value.fingerprint !== fingerprint) {
      return { ok: false, code: "REQUEST_CONFLICT", message: "同一 request_id 提交了不同输入" };
    }
    if (existing && (existing.value.toolProtocol ?? "fixed_v1") !== hosted.businessProtocol) {
      return {
        ok: false,
        code: "REQUEST_CONFLICT",
        message: "原操作绑定的业务协议与当前会话不一致，已停止自动执行。",
      };
    }
    const operationId = existing?.value.operationId ?? hosted.session.idGenerator.next();
    const executionFlow = "inquiry_v1" as const;
    const bridge = this.createCommandBridge(hosted, input.request_id);
    const trustedAnswers = input.answers ?? [];
    const requestContext: AskMetricRequestContext = {
      actor: deps.actor,
      backend: deps.backend.withTraceId?.(input.request_id) ?? deps.backend,
      originalMessage: input.message,
      businessSkills: this.skillSnapshot(),
      promptFingerprint: fingerprint,
      sessionId: hosted.sessionId,
      requestId: input.request_id,
      operationId,
      executionFlow,
      ...(existing?.value.inquiryTargetContext
        ? { inquiryTargetContext: structuredClone(existing.value.inquiryTargetContext) }
        : {}),
      commands: bridge,
      frames: new NativeFrameStore(hosted.session),
      semanticTasks,
      businessResults: new NativeBusinessResultStore(hosted.session),
      history: createHistoryBridge(hosted, () => requestContext),
      answerEvidence: async () =>
        currentTurnEvidence(await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT)),
      turnMessages: async () =>
        safeWorkingHistory(
          requestContext,
          await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT, 4),
        ),
      questionPublicationProof: createQuestionPublicationProof(hosted, operationId),
      timings: { startedAt: performance.now(), modelFirstTokenMs: [], model_ms: [], tool_ms: [] },
      ...(trustedAnswers.length ? { trustedAnswers: structuredClone(trustedAnswers) } : {}),
      ...(input.clarification_target ? { clarificationTarget: input.clarification_target } : {}),
      ...(input.selected_answers ? { selectedAnswers: input.selected_answers } : {}),
      ...(input.clarification_selection
        ? { clarificationSelection: input.clarification_selection }
        : {}),
      ...(input.time_override ? { timeOverride: input.time_override } : {}),
    };
    const context = withRequestContext(requestContext, BACKGROUND_CONTEXT);
    if (existing) {
      const completed = await hosted.lane.getResult(operationId, context);
      if (completed) return { ok: true, operationId, context, request: requestContext, completed };
    }
    const active = await hosted.lane.inspectExecution(context);
    if (active.current && active.current.id !== operationId)
      return { ok: false, code: "SESSION_BUSY", message: "该会话正在处理上一个提问，请等待完成" };
    if (existing && existing.value.executionFlow !== "inquiry_v1") {
      if (active.current?.id === operationId) {
        const completed = await this.interruptLegacyOperation(hosted, operationId, context);
        return { ok: true, operationId, context, request: requestContext, completed };
      }
      return {
        ok: false,
        code: "LEGACY_QUERY_REQUIRES_NEW_TURN",
        message: LEGACY_OPERATION_INTERRUPTED_MESSAGE,
      };
    }
    try {
      if (existing) {
        if (existing.value.inquiryAdmission)
          requestContext.inquiryAdmission = existing.value.inquiryAdmission;
      } else {
        const priorAnswers = trustedAnswers.length
          ? await priorInquiryAnswers(hosted, trustedAnswers, semanticTasks)
          : [];
        const admission = await admitInquiryInput(input, {
          actorId: deps.actor.id,
          sessionId: hosted.sessionId,
          operationId,
          priorAnswers,
          semanticTasks,
          frames: requestContext.frames!,
          questionPublicationProof: createQuestionPublicationProof(hosted, operationId),
          framePublicationProof: async (frame) =>
            publishedReceipt(
              hosted,
              (details) =>
                details.frame_id === frame.frameId && details.status === "NEEDS_CLARIFICATION",
            ),
          taskPublicationProof: async (target) =>
            publishedReceipt(hosted, (details) => {
              const clarification = details.clarification as { id?: unknown } | undefined;
              return (
                details.task_id === target.task_id &&
                details.version === target.version &&
                clarification?.id === target.clarification_id
              );
            }),
          getTask: (id) => requestContext.backend.getTask(id),
          resolveMetric: (values) => requestContext.backend.resolveBusinessField("metric", values),
          resolveOrganization: (values) =>
            requestContext.backend.resolveBusinessField("organization", values),
          resolveDate: (text) =>
            requestContext.backend.resolveBusinessField("date", [text], undefined, undefined, {
              business_date: businessDate(),
              source_question: text,
            }),
        });
        if (admission) requestContext.inquiryAdmission = admission;
        if (
          !admission &&
          !trustedAnswers.length &&
          !input.clarification_target &&
          !input.selected_answers &&
          !input.clarification_selection
        )
          requestContext.inquiryTargetContext = await freezeInquiryTargetContext(
            hosted.lane,
            requestContext,
          );
      }
    } catch (error) {
      if (error instanceof QuestionAnswerError || error instanceof InquiryAdmissionError)
        return { ok: false, code: error.code, message: error.message };
      throw error;
    }
    // 请求和反查原子落盘；重试也修复旧版本在两次写入之间崩溃留下的缺失反查。
    const association: RequestAssociation = existing?.value ?? {
      fingerprint,
      input,
      originalMessage: input.message,
      operationId,
      lane: "main",
      createdAt: Date.now(),
      toolProtocol: hosted.businessProtocol,
      executionFlow,
      ...(requestContext.inquiryAdmission
        ? { inquiryAdmission: requestContext.inquiryAdmission }
        : {}),
      ...(requestContext.inquiryTargetContext
        ? { inquiryTargetContext: requestContext.inquiryTargetContext }
        : {}),
    };
    await hosted.session.mutate(async (tx, mutationContext) => {
      const reverse = await tx.getValue(operationRequestValue(operationId), mutationContext);
      if (reverse && reverse.value !== input.request_id)
        throw new Error("OPERATION_REQUEST_CONFLICT");
      await tx.commit(
        [
          setValue(requestValue(input.request_id), association),
          setValue(operationRequestValue(operationId), input.request_id),
        ],
        mutationContext,
      );
    }, context);
    const displayText = input.message
      ? ""
      : requestContext.inquiryAdmission?.answerReceipts
          .map((receipt) => receipt.notice)
          .join("\n") || "提交结构化回答";

    const desiredTools = this.tools
      .map((tool) => tool.name)
      .filter((name) => INQUIRY_TOOLS.has(name) || name === PARTIAL_ANALYSIS);
    const activeTools = await hosted.lane.getActiveTools(context);
    // 仅旧操作恢复后需要同步，普通请求不重复写原生配置。
    if (
      activeTools.length !== desiredTools.length ||
      activeTools.some((name, index) => name !== desiredTools[index])
    ) {
      const execution = await hosted.lane.inspectExecution(context);
      if (!execution.current) await hosted.lane.setActiveTools(desiredTools, context);
    }
    // 原文、可信点击与页面展示分别持久化；纯点击不向模型或后端伪造用户原文。
    const prompt = {
      role: "user" as const,
      content: input.message,
      timestamp: Date.now(),
      businessProtocol: "semantic_v2",
      ...(trustedAnswers.length ? { clickAnswers: structuredClone(trustedAnswers) } : {}),
      ...(requestContext.inquiryAdmission
        ? { inquiryAdmission: structuredClone(requestContext.inquiryAdmission) }
        : {}),
      ...(trustedAnswers.length ||
      requestContext.inquiryAdmission ||
      input.clarification_target ||
      input.selected_answers ||
      input.clarification_selection
        ? { inquiryTargetBarrier: true }
        : {}),
      ...(!input.message && displayText ? { displayText } : {}),
    };
    const admitted = await hosted.lane.accept({ kind: "prompt", operationId, prompt }, context);
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
  async drivePrompt(
    hosted: HostedSession,
    admitted: Extract<AdmitOutcome, { ok: true }>,
  ): Promise<DriveOutcomeResult> {
    await this.store.cluster?.drainCancellations(hosted.sessionId);
    if (admitted.completed) {
      return {
        ok: true,
        operationId: admitted.operationId,
        outcome: { kind: "settled", outcome: admitted.completed },
      };
    }
    const ownsActiveRequest = !hosted.activeRequest;
    if (ownsActiveRequest) hosted.activeRequest = admitted.request;
    const driven = await hosted.lane
      .drive(
        { operationId: admitted.operationId, waitForRetry: true, pollDeferred: false },
        admitted.context,
      )
      .finally(() => {
        if (ownsActiveRequest && hosted.activeRequest === admitted.request)
          delete hosted.activeRequest;
        this.touch(hosted.sessionId);
      });
    if (!admitted.request.timings?.reportAtSnapshot)
      await this.recordRequestTiming(hosted, admitted.request);
    if (!driven.ok) {
      return { ok: false, code: "SESSION_CLOSED", message: driven.error.message };
    }
    return { ok: true, operationId: admitted.operationId, outcome: driven.value };
  }

  /** 提问路由在正式快照发送后记录，关闭流式时也能取得首字耗时。 */
  async recordRequestTiming(
    hosted: HostedSession,
    request: AskMetricRequestContext,
  ): Promise<void> {
    const timings = request.timings;
    if (!timings) return;
    const stored = await hosted.session.getValue(
      requestValue(request.requestId),
      BACKGROUND_CONTEXT,
    );
    const summary = {
      model: timings.model_ms,
      tools: timings.tool_ms,
      drive_total: Math.round(performance.now() - timings.startedAt),
      first_visible_ms:
        timings.firstVisibleAt === undefined
          ? null
          : Math.round(timings.firstVisibleAt - (timings.receivedAt ?? timings.startedAt)),
      model_first_token_ms: timings.modelFirstTokenMs,
    };
    if (stored)
      await hosted.session.setValue(
        requestValue(request.requestId),
        { ...stored.value, timings_ms: summary },
        BACKGROUND_CONTEXT,
      );
    console.info(
      JSON.stringify({
        event: "agent_request_timing",
        session_id: hosted.sessionId,
        operation_id: request.operationId,
        request_id: request.requestId,
        timings_ms: summary,
      }),
    );
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
  resumeOpenOperations(
    hosted: HostedSession,
    deps: { actor: BackendUser; backend: BackendClient },
  ): Promise<number> {
    if (hosted.observer) return Promise.resolve(0);
    const current = this.recoveries.get(hosted.sessionId);
    if (current) return current;
    if (!hosted.open.length && !hosted.readOnlyReason) return Promise.resolve(0);
    const release = this.retain(hosted.sessionId);
    const recovery = Promise.resolve().then(() => this.store.cluster?.drainCancellations(hosted.sessionId))
      .then(() => this.resumePendingOperations(hosted, deps)).finally(() => {
      release();
      if (this.recoveries.get(hosted.sessionId) === recovery)
        this.recoveries.delete(hosted.sessionId);
    });
    this.recoveries.set(hosted.sessionId, recovery);
    return recovery;
  }

  private async resumePendingOperations(
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
      if (!requestRef) {
        hosted.open.push(operation);
        throw new Error("OPERATION_REQUEST_MISSING");
      }
      const association = await hosted.session.getValue(
        requestValue(requestRef.value),
        BACKGROUND_CONTEXT,
      );
      if (!association) {
        hosted.open.push(operation);
        throw new Error("OPERATION_ASSOCIATION_MISSING");
      }
      if (
        association.value.operationId !== operation.operationId ||
        association.value.lane !== operation.lane
      ) {
        hosted.open.push(operation);
        throw new Error("OPERATION_ASSOCIATION_CONFLICT");
      }
      if ((association.value.toolProtocol ?? "fixed_v1") !== hosted.businessProtocol) {
        hosted.open.push(operation);
        throw new Error("OPERATION_PROTOCOL_CONFLICT");
      }
      const requestContext: AskMetricRequestContext = {
        actor: deps.actor,
        backend: deps.backend.withTraceId?.(requestRef.value) ?? deps.backend,
        originalMessage: association.value.originalMessage,
        businessSkills: this.skillSnapshot(),
        executionFlow: "inquiry_v1",
        ...(association.value.inquiryAdmission
          ? { inquiryAdmission: association.value.inquiryAdmission }
          : {}),
        ...(association.value.inquiryTargetContext
          ? { inquiryTargetContext: structuredClone(association.value.inquiryTargetContext) }
          : {}),
        questionPublicationProof: createQuestionPublicationProof(hosted, operation.operationId),
        ...(association.value.input?.answers?.length
          ? { trustedAnswers: structuredClone(association.value.input.answers) }
          : {}),
        ...(association.value.input?.clarification_target
          ? { clarificationTarget: association.value.input.clarification_target }
          : {}),
        ...(association.value.input?.selected_answers
          ? { selectedAnswers: association.value.input.selected_answers }
          : {}),
        ...(association.value.input?.clarification_selection
          ? { clarificationSelection: association.value.input.clarification_selection }
          : {}),
        ...(association.value.input?.time_override
          ? { timeOverride: association.value.input.time_override }
          : {}),
        promptFingerprint: association.value.fingerprint,
        sessionId: hosted.sessionId,
        requestId: requestRef.value,
        operationId: operation.operationId,
        commands: this.createCommandBridge(hosted, requestRef.value),
        frames: new NativeFrameStore(hosted.session),
        semanticTasks: new NativeSemanticTaskStore(hosted.session),
        businessResults: new NativeBusinessResultStore(hosted.session),
        history: createHistoryBridge(hosted, () => requestContext),
        answerEvidence: async () =>
          currentTurnEvidence(await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT)),
        turnMessages: async () =>
          requestContext.executionFlow === "inquiry_v1"
            ? safeWorkingHistory(
                requestContext,
                await currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT, 4),
              )
            : currentLaneMessages(hosted.lane, BACKGROUND_CONTEXT),
        timings: { startedAt: performance.now(), modelFirstTokenMs: [], model_ms: [], tool_ms: [] },
      };
      try {
        if (association.value.executionFlow !== "inquiry_v1") {
          await this.exclusiveAdmission(hosted.sessionId, () =>
            this.interruptLegacyOperation(
              hosted,
              operation.operationId,
              withRequestContext(requestContext, BACKGROUND_CONTEXT),
            ),
          );
          resumed += 1;
          continue;
        }
        // 恢复可能从已落盘的工具调用继续，先重读自动资料中的正式候选，不能依赖进程内目录状态。
        await loadTurnBusinessKnowledge(
          requestContext,
          businessKnowledgeContextTerms(await requestContext.turnMessages?.() ?? []),
        );
        const ownsActiveRequest = !hosted.activeRequest;
        if (ownsActiveRequest) hosted.activeRequest = requestContext;
        const result = await hosted.lane
          .drive(
            { operationId: operation.operationId, waitForRetry: true, pollDeferred: false },
            withRequestContext(requestContext, BACKGROUND_CONTEXT),
          )
          .finally(() => {
            if (ownsActiveRequest && hosted.activeRequest === requestContext)
              delete hosted.activeRequest;
          });
        if (!result.ok) throw new Error("原生操作恢复暂时失败");
        resumed += 1;
      } catch (error) {
        hosted.open.push(operation);
        throw error;
      }
    }
    return resumed;
  }

  private async interruptLegacyOperation(
    hosted: HostedSession,
    operationId: string,
    context: Context,
  ) {
    const result = await stopLegacyOperation(hosted.lane, operationId, context);
    if (result.status !== "aborted") return result;
    const notices = await hosted.lane.findEntries(
      { type: "custom", customType: "askmetric.legacy-interrupted" },
      context,
    );
    if (
      !notices.some(
        (entry) =>
          entry.type === "custom" &&
          (entry.data as { operation_id?: unknown })?.operation_id === operationId,
      )
    )
      await hosted.lane.appendCustomEntry(
        "askmetric.legacy-interrupted",
        { operation_id: operationId },
        context,
      );
    return result;
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
    // 共享信箱可能稍晚送达；旧操作的停止请求不能落到下一轮，也无需让原生 lane 报错。
    if ((await hosted.lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id !== operationId) return;
    if (hosted.activeRequest?.operationId === operationId)
      invalidateAnswerStream(hosted.activeRequest);
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

/** 只认当前父链上的工具回执，不能把模型正文或其他会话的任务ID作为发布依据。 */
async function publishedReceipt(
  hosted: HostedSession,
  matches: (details: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const entries = await hosted.lane.findEntries(
    { type: "message", order: "newestFirst" },
    BACKGROUND_CONTEXT,
  );
  return entries.some((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError)
      return false;
    const details: unknown = entry.message.details;
    return (
      !!details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      matches(details as Record<string, unknown>)
    );
  });
}

/** 只恢复当前父链已受理的同目标选择；旧题目账本仍保持只读。 */
async function priorInquiryAnswers(
  hosted: HostedSession,
  answers: readonly ClickAnswerInput[],
  store: NativeSemanticTaskStore,
): Promise<ClickAnswerInput[]> {
  const targetKey = (taskRef: string, targetRef: string) => JSON.stringify([taskRef, targetRef]);
  const requested = new Set<string>();
  for (const answer of answers) {
    const view = await store.question(answer.question_id);
    if (view) requested.add(targetKey(view.binding.taskRef, view.binding.targetRef));
  }
  const supplied = new Set(answers.map((answer) => answer.question_id));
  const prior = new Map<string, ClickAnswerInput>();
  const entries = await hosted.lane.findEntries(
    { type: "message", order: "newestFirst" },
    BACKGROUND_CONTEXT,
  );
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const prompt = entry.message as typeof entry.message & {
      inquiryAdmission?: InquiryAdmission;
      clickAnswers?: ClickAnswerInput[];
    };
    for (const answer of answers) {
      const receipt = prompt.inquiryAdmission?.answerReceipts.find(
        (item) =>
          item.question_id === answer.question_id &&
          item.version === answer.version &&
          ["applied", "declined"].includes(item.outcome),
      );
      if (!receipt) continue;
      const previous = prompt.clickAnswers?.find(
        (item) => item.question_id === answer.question_id && item.version === answer.version,
      );
      if (!previous) continue;
      throw new QuestionAnswerError(
        canonicalJson(previous?.choice) === canonicalJson(answer.choice)
          ? "ANSWER_ALREADY_APPLIED"
          : "QUESTION_SUPERSEDED",
        "此项选择已经受理，请继续提问；无需再次提交旧选项。",
        "user",
      );
    }
    if (
      !prompt.inquiryAdmission?.targets.some(
        (item) =>
          item.source.kind === "semantic" &&
          requested.has(targetKey(item.source.taskRef, item.targetRef)),
      )
    )
      continue;
    for (const answer of prompt.clickAnswers ?? []) {
      if (supplied.has(answer.question_id) || prior.has(answer.question_id)) continue;
      const receipt = prompt.inquiryAdmission?.answerReceipts.find(
        (item) =>
          item.question_id === answer.question_id &&
          item.version === answer.version &&
          ["applied", "declined"].includes(item.outcome),
      );
      if (!receipt) continue;
      const view = await store.question(answer.question_id);
      // 换版或关闭后的旧确认不继承；剩余字段由本轮入场重新标为待确认。
      if (
        !view ||
        view.question.version !== answer.version ||
        view.question.status !== "open" ||
        !requested.has(targetKey(view.binding.taskRef, view.binding.targetRef))
      )
        continue;
      const target = prompt.inquiryAdmission?.targets.find(
        (item) =>
          item.targetRef === view.binding.targetRef &&
          item.source.kind === "semantic" &&
          item.source.taskRef === view.binding.taskRef,
      );
      if (target) prior.set(answer.question_id, structuredClone(answer));
    }
  }
  return [...prior.values()].reverse();
}

/** 只接受当前分支、本轮之前、签发 operation 内的最终 resolve 回执。 */
function createQuestionPublicationProof(hosted: HostedSession, operationId: string) {
  return async (question: PendingQuestion): Promise<boolean> => {
    if (!question.issued_operation_id || question.issued_operation_id === operationId) return false;
    const result = await hosted.lane.getResult(question.issued_operation_id, BACKGROUND_CONTEXT);
    if (!result || result.kind !== "run" || !result.tipId) return false;
    const currentBranch = await hosted.lane.findEntries(
      { order: "oldestFirst", stopAtId: result.tipId },
      BACKGROUND_CONTEXT,
    );
    if (currentBranch.at(-1)?.id !== result.tipId) return false;
    const from = result.fromTipId
      ? await hosted.session.getEntry(result.fromTipId, BACKGROUND_CONTEXT)
      : undefined;
    if (result.fromTipId && !from) return false;
    // findEntries 沿父链从 start 向旧回溯；oldestFirst 会把 stopAtId 之前的整段历史也扫进来，
    // 叠加 seq 下界过滤后恒为空——跨轮签发（fromTipId 非空）的回执因此全部漏检。
    // 正确区间是签发 operation 实际写入的条目：从完成点向旧扫到起始点，再用 seq 排除起始点本身。
    const entries = await hosted.lane.findEntries(
      {
        start: result.tipId,
        order: "newestFirst",
        type: "message",
        ...(result.fromTipId ? { stopAtId: result.fromTipId } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    return entries.some((entry) => {
      if (entry.type !== "message" || (from && entry.seq <= from.seq)) return false;
      const message = entry.message;
      if (
        message.role !== "toolResult" ||
        message.toolName !== "resolve_business_turn" ||
        message.isError ||
        !isSemanticFeedback(message.details)
      )
        return false;
      return (message.details.pending_questions ?? []).some(
        (candidate) =>
          candidate.question_id === question.question_id && candidate.version === question.version,
      );
    });
  };
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
function sliceByCodePoints(
  text: string,
  offset: number,
  length: number,
): { text: string; next: number | null } {
  const chars = [...text];
  const slice = chars.slice(offset, offset + length).join("");
  const consumed = offset + [...slice].length;
  return { text: slice, next: consumed < chars.length ? consumed : null };
}

/** 原生历史受控回读：只读当前 lane 分支祖先；read 通过分页扫描命中，伪造/跨分支 ID 返回 null */
export function createHistoryBridge(
  hosted: HostedSession,
  request: () => AskMetricRequestContext,
): HistoryBridge {
  const { lane } = hosted;
  type Sources = import("./requestContext.js").HistoryReadSources;
  let original: Promise<{ entries: Entry[]; turns: Map<string, Entry[]> }> | undefined;
  const checked = new Map<Entry[], Promise<{ entries: Entry[]; sources: Sources }>>();
  const view = () =>
    (original ??= (async () => {
      const entries = await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
      const turns = new Map<string, Entry[]>();
      let turn: Entry[] = [];
      for (const entry of entries)
        if (entry.type === "message") {
          if (entry.message.role === "user") turn = [];
          turn.push(entry);
          turns.set(entry.id, turn);
        }
      return { entries, turns };
    })());
  const check = (turn: Entry[]) => {
    if (!checked.has(turn))
      checked.set(
        turn,
        (async () => {
          const messages = turn.filter((entry) => entry.type === "message");
          const sentinel = { role: "user" as const, content: "", timestamp: 0 };
          const safe = (
            await safeWorkingHistory(request(), [
              sentinel,
              ...messages.map((entry) => entry.message),
              sentinel,
            ])
          ).slice(1, -1);
          const refs = historySources(
            safe.flatMap((message): unknown[] =>
              message.role === "toolResult" ? [message.details] : [],
            ),
            () => {
              throw new Error("HISTORY_SCOPE_UNAVAILABLE");
            },
          );
          const sources: Sources = {
            tasks: [...refs.tasks].map(([task_id, result_id]) => ({
              task_id,
              ...(result_id ? { result_id } : {}),
            })),
            organizationScopes: await resolveHistoryOrganizationScopes(
              refs,
              request().semanticTasks,
              () => {
                throw new Error("HISTORY_SCOPE_UNAVAILABLE");
              },
            ),
          };
          return {
            entries: messages.map((entry, index) => ({ ...entry, message: safe[index] }) as Entry),
            sources,
          };
        })(),
      );
    return checked.get(turn)!;
  };
  // 先本地定位涉及的完整回合，再查权限；百轮会话读取一条旧记录只复核其来源。
  const authorized = async (entries: Entry[], turns: Map<string, Entry[]>) => {
    const groups = [
      ...new Set(entries.flatMap((entry) => (turns.get(entry.id) ? [turns.get(entry.id)!] : []))),
    ];
    const decisions = await Promise.all(groups.map(check));
    const safe = new Map<string, Entry>(),
      sources = new Map<string, Sources>();
    for (const decision of decisions)
      for (const entry of decision.entries) {
        safe.set(entry.id, entry);
        sources.set(entry.id, decision.sources);
      }
    return { entries: entries.map((entry) => safe.get(entry.id) ?? entry), sources };
  };
  const joined = (ids: string[], sources: Map<string, Sources>): Sources => {
    const tasks = new Map<string, { task_id: string; result_id?: string }>(),
      scopes = new Map<string, string[]>();
    for (const id of ids) {
      for (const ref of sources.get(id)?.tasks ?? []) tasks.set(ref.task_id, ref);
      for (const scope of sources.get(id)?.organizationScopes ?? [])
        scopes.set(JSON.stringify([...scope].sort()), scope);
    }
    return { tasks: [...tasks.values()], organizationScopes: [...scopes.values()] };
  };
  const analysisSource = (entry: Entry, runRef: string) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError)
      return undefined;
    for (const source of businessEvidences(entry.message.details)) {
      if (
        source.kind === "analysis_evidence" &&
        source.status === "succeeded" &&
        "run_ref" in source &&
        source.run_ref === runRef &&
        "scope_id" in source &&
        typeof source.scope_id === "string"
      ) {
        return {
          run_ref: runRef,
          scope_id: source.scope_id,
          ...(source.execution_turn_id ? { execution_turn_id: source.execution_turn_id } : {}),
        };
      }
    }
    return undefined;
  };
  return {
    async analysisSource(runRef) {
      const snapshot = await view();
      const entry = snapshot.entries.find((entry) => analysisSource(entry, runRef));
      if (!entry) return null;
      // 查找范围来自当前 lane，不能只凭会话归属读取其他分支；先复核原回合，再由后端重读结果。
      const permitted = await authorized([entry], snapshot.turns);
      const source = permitted.entries[0] && analysisSource(permitted.entries[0], runRef);
      return source ?? null;
    },
    async list(beforeSeq, limit = 10) {
      const capped = Math.min(Math.max(limit ?? 10, 1), 20);
      const snapshot = await view();
      const found = [...snapshot.entries]
        .reverse()
        .filter((entry) => beforeSeq === undefined || entry.seq < beforeSeq);
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
        sources: joined(
          page.map((entry) => entry.id),
          permitted.sources,
        ),
      };
    },
    async read(entryId, offset = 0, length = 4000) {
      const cappedLength = Math.min(Math.max(length, 1), 8000);
      const snapshot = await view();
      const originalHit = snapshot.entries.find((entry) => entry.id === entryId);
      if (originalHit?.type === "message") {
        const permitted = await authorized([originalHit], snapshot.turns);
        const hit = permitted.entries[0]!;
        const sliced = sliceByCodePoints(entryVisibleText(hit), offset, cappedLength);
        return {
          entry_id: hit.id,
          seq: hit.seq,
          type: hit.type,
          text: sliced.text,
          next_offset: sliced.next,
          sources: joined([hit.id], permitted.sources),
        };
      }
      return null;
    },
  };
}

function invalidateAnswerStream(request: AskMetricRequestContext): void {
  if (request.answerStream) request.answerStream = { ...request.answerStream, mode: "none" };
}

/** 默认仅取本轮；调查工具最多再取最近三轮，用于核验并继承真实来源，不扫描全部会话。 */
async function currentLaneMessages(lane: AgentLane, context: Context, turnCount = 1) {
  const messages: import("@earendil-works/pi-agent-core").AgentMessage[] = [];
  let cursor: number | undefined;
  let userTurns = 0;
  for (;;) {
    const page = await lane.findEntries(
      {
        type: "message",
        order: "newestFirst",
        limit: 32,
        ...(cursor !== undefined ? { cursor: { seq: cursor } } : {}),
      },
      context,
    );
    for (const entry of page) {
      if (entry.type !== "message") continue;
      messages.push(entry.message);
      if (entry.message.role === "user" && ++userTurns >= turnCount) return messages.reverse();
    }
    if (page.length < 32) return messages.reverse();
    cursor = page.at(-1)!.seq;
  }
}
