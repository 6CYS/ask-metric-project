/**
 * 请求上下文：通过原生 Context 传递当次请求的身份、后端客户端与标识。
 * 承载本轮可信输入以及原生业务 Frame/结果存储桥接；模型消息和压缩仍由 Pi 管理。
 */
import { createContextKey, withContextValue, type Context } from "@earendil-works/pi-agent-core";
import type { BackendClient, BackendUser } from "./backendClient.js";
import type { EvidenceReference } from "./answerEvidence.js";

/** 一次独立业务写意图的登记：同一 operation 最多一个；重复相同命令返回原任务 */
export interface WriteCommandRecord {
  commandKey: string;
  action: "new" | "clarify" | "followup";
  /** rejected 仅表示后端明确未写入的独立问题澄清拒绝，允许同轮纠正为 new。 */
  status: "pending" | "completed" | "conflict" | "rejected";
  taskId?: string;
  resultId?: string;
  /** clarify 受控版本刷新：同一 operation 最多一次 */
  refreshed?: boolean;
}

/** 工具可见的会话级持久桥接：写命令登记与业务 conversation 映射（宿主实现） */
export interface CommandBridge {
  getWriteCommand(): Promise<WriteCommandRecord | undefined>;
  setWriteCommand(record: WriteCommandRecord): Promise<void>;
  getConversationId(): Promise<string | null>;
  setConversationId(conversationId: string): Promise<void>;
}

export interface HistoryEntrySummary {
  entry_id: string;
  seq: number;
  type: string;
  preview: string;
}

/**
 * 原生分支历史的受控只读访问（宿主实现，落在当前 lane 的 findEntries/findEntry）。
 * 只读当前分支祖先；不暴露隐藏思考、凭据、SQL/debug。
 */
export interface HistoryBridge {
  list(
    beforeSeq?: number,
    limit?: number,
  ): Promise<{ entries: HistoryEntrySummary[]; next_before_seq: number | null; has_more: boolean }>;
  read(
    entryId: string,
    offset?: number,
    length?: number,
  ): Promise<{ entry_id: string; seq: number; type: string; text: string; next_offset: number | null } | null>;
}

/** 单次用户请求的可信绑定，由宿主在接纳前装配，模型与工具参数不得改写 */
export interface AskMetricRequestContext {
  /** 当前认证用户（后端 /auth/me 校验结果） */
  actor: BackendUser;
  /** 按当次请求 Bearer 创建的后端客户端 */
  backend: BackendClient;
  /** 本轮原始用户输入原文 */
  originalMessage: string;
  /** 当前请求的目录算法结果；不写入跨用户缓存或替代原生会话状态。 */
  metricMentions?: Promise<import("./business-context/metricMentions.js").MetricMentions>;
  /** 完整 PromptInput 的确定性指纹（宿主计算） */
  promptFingerprint: string;
  sessionId: string;
  requestId: string;
  operationId: string;
  /** 用户显式回复某张澄清卡片时的目标（发送时快照） */
  clarificationTarget?: { task_id: string; version: number; clarification_id: string };
  /** 结构化澄清的显式选择（前端 composer 已校验输出） */
  selectedAnswers?: Record<string, unknown>;
  /** 从本轮用户消息之前的原生业务回执投影；目录工具不能改变来源。 */
  queryCandidate?: { task_id: string; version: number } | undefined;
  frames?: import("./business-context/types.js").FrameStore;
  businessResults?: Pick<import("./business-context/store.js").NativeBusinessResultStore, "get" | "save">;
  /** 仅服务端执行适配器绑定，绝不从模型参数读取。 */
  businessExecutionFrame?: string;
  commands: CommandBridge;
  /** 原生历史受控回读；供 read 历史分支及旧工具恢复使用 */
  history: HistoryBridge;
  /** 当前原生回合的证据只读投影；用于 pi 选择最终交付内容。 */
  answerEvidence?: () => Promise<EvidenceReference[]>;
  /** 原生模型步骤，仅用于诊断及隔离摘要请求，不保存业务状态。 */
  modelCall?: { model: string; step: "assistant" | "deferred" | "compaction" | "branch_summary"; attempt: number; startedAt: number; payloadBytes?: number };
  /** 仅本次驱动的诊断耗时，不承载业务状态或模型记忆。 */
  timings?: { startedAt: number; modelStartedAt?: number; toolStartedAt?: Record<string, number>; model_ms: number[]; tool_ms: number[] };
}

const REQUEST_KEY = createContextKey<AskMetricRequestContext>("askmetric.request");

/** 将本次请求绑定到派生 Context；父 Context 不被修改 */
export function withRequestContext(request: AskMetricRequestContext, parent: Context): Context {
  return withContextValue(REQUEST_KEY, request, parent);
}

/** 读取请求绑定；缺失说明调用链绕过了宿主装配，直接报错而不是放行 */
export function requireRequestContext(context: Context): AskMetricRequestContext {
  const request = context.value(REQUEST_KEY);
  if (!request) {
    throw new Error("缺少当前请求上下文：业务工具只能在宿主接纳的请求中执行");
  }
  return request;
}
