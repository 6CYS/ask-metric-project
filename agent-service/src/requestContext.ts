/**
 * 请求上下文：通过原生 Context 传递当次请求的身份、后端客户端与标识。
 * 只承载本轮可信输入，不保存历史消息、槽位或摘要——模型上下文由原生 Session 管理。
 */
import { createContextKey, withContextValue, type Context } from "@earendil-works/pi-agent-core";
import type { BackendClient, BackendUser } from "./backendClient.js";

/** 一次独立业务写意图的登记：同一 operation 最多一个；重复相同命令返回原任务 */
export interface WriteCommandRecord {
  commandKey: string;
  action: "new" | "clarify" | "followup";
  /** pending=已登记未完成；completed=业务效果已提交；conflict=澄清遇版本冲突待受控刷新 */
  status: "pending" | "completed" | "conflict";
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
  /** 完整 PromptInput 的确定性指纹（宿主计算） */
  promptFingerprint: string;
  sessionId: string;
  requestId: string;
  operationId: string;
  /** 用户显式“作为新问题发送”时禁止消费旧澄清 */
  sendAs?: "new_question";
  /** 用户显式回复某张澄清卡片时的目标（发送时快照） */
  clarificationTarget?: { task_id: string; version: number; clarification_id: string };
  /** 结构化澄清的显式选择（前端 composer 已校验输出） */
  selectedAnswers?: Record<string, unknown>;
  commands: CommandBridge;
  /** 原生历史受控回读；仅供 session_history_read 工具使用 */
  history: HistoryBridge;
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
