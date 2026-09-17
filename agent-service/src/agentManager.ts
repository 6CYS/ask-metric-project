/**
 * 会话与 Agent 生命周期管理：每个会话一个 pi-agent-core Agent 实例，
 * 事件流经 subscribe 转发为前端 SSE 事件。
 * 会话经 SessionStore 持久化（完整消息列表，含工具结果明细），重启后恢复；
 * 用户令牌只保存在内存、不落盘，恢复会话的首次提问会绑定当次请求的 Bearer 重建工具。
 */
import { sessionPreview } from "./sessionPreview.js";
import { assistantFailure } from "./assistantFailure.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { AgentServiceConfig } from "./config.js";
import type { ModelBundle } from "./models.js";
import { BackendClient, type BackendUser } from "./backendClient.js";
import { createAskMetricTools } from "./tools.js";
import { SessionStore, deriveSessionTitle, type PersistedSession } from "./sessionStore.js";

function buildSystemPrompt(currentDate: string): string {
  return `你是行内经营指标智能问数助手。当前业务日期：${currentDate}。回答用户关于经营指标的问题时遵守以下规则：
1. 所有指标数值必须通过工具获取，不得凭记忆编造任何数值、机构、编码或日期。即使本会话上下文中存在历史查询结果，也不得凭记忆回答数值：每次给出数值前，当轮必须有对应的取数工具调用。
2. 取数通道选择：
   - 指标、机构、日期都能确定为正式编码和绝对日期时（包括从本会话上下文继承），先用 metric_catalog_search / org_catalog_search 确认编码，再调 metric_query_structured 结构化取数；
   - 叫法拿不准、条件可能缺失、需要语义理解或澄清的问题，调 metric_ask 并把澄清提示转告用户，不代填条件；
   - 不确定走哪条通道时，一律用 metric_ask，不硬猜编码。
3. 多轮追问：用户省略条件的追问（如"那启东呢？""4月末的呢？"）从本会话最近的已确认条件继承全部未提及的槽位（指标编码、机构编码、日期），只替换用户新提到的部分，且任何条件发生变化（机构、日期、指标任一）都必须当轮重新调用 metric_query_structured 取数，禁止沿用记忆中的旧数值回答新条件；回答时先用一句话说明本次按什么条件查询（机构、日期、指标），再给结果。上下文跨了话题或拿不准继承哪些条件时，退回 metric_ask。
4. 日期换算依据当前业务日期：明确的"X月末/月底/最后一天"是该月最后一天单日；"X年X月"是该月完整区间（1日至月末日）；"最新/最近一期"用 metric_ask 处理。月末日期必须按实际月份天数计算（2月注意闰年），算不准就用 metric_ask。
5. 变化额、百分比、贡献度等计算由后端受控计算完成，你只引用工具返回的结果，不自行计算。
6. 引用数值必须保留工具返回的原始数值与单位（例如 "15147420074 元"），不得自行做单位换算（如元转万元），也不要在括号里附注换算后的数值。
7. 工具返回 unsupported 或错误信息时，如实告知用户当前不支持或失败原因，不要改写成普通取值结果；工具返回的错误原文（含 HTTP 状态码、英文术语）不要直接引用给用户，要用通俗中文说明。
8. 工具提示登录状态失效时，引导用户刷新页面重新登录后再提问。
9. 回答使用简体中文，简洁准确。
10. 正文不使用 markdown 表格和明细列表；多行查询结果（超过 3 条明细）不要逐条罗列数值，只用简洁自然语言概括（如有序结果可提及前 1-3 名），明细数值一律引导用户查看下方的数据明细表。`;
}

export interface SessionRecord {
  id: string;
  userId: string;
  username: string;
  title: string;
  agent: Agent;
  createdAt: number;
  lastActiveAt: number;
  running: boolean;
}

export type AgentUiEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; tool: string; args: unknown }
  | { type: "tool_end"; tool: string; details: unknown; isError: boolean }
  | { type: "message_done"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export class AgentManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly store: SessionStore;

  constructor(
    private readonly config: AgentServiceConfig,
    private readonly modelBundle: ModelBundle,
  ) {
    this.store = new SessionStore(config.dataDir);
    // 重启后恢复历史会话与消息上下文；工具在下次提问时按当次请求令牌重建
    for (const persisted of this.store.loadAll()) {
      const agent = this.buildAgent(persisted.messages, persisted.id);
      this.sessions.set(persisted.id, {
        id: persisted.id,
        userId: persisted.userId,
        username: persisted.username,
        title: persisted.title,
        agent,
        createdAt: persisted.createdAt,
        lastActiveAt: persisted.lastActiveAt,
        running: false,
      });
    }
  }

  private buildAgent(messages: Agent["state"]["messages"], sessionId: string): Agent {
    const suffix = this.config.model.userMessageSuffix;
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(new Date().toISOString().slice(0, 10)),
        model: this.modelBundle.model,
        tools: [],
        messages,
      },
      // 模型侧要求的消息后缀（如 /no_think）只在发给模型的上下文副本上追加，不污染持久化历史
      transformContext: async (contextMessages) => {
        if (!suffix) return contextMessages;
        const cloned = [...contextMessages];
        const last = cloned[cloned.length - 1] as { role?: string; content?: unknown } | undefined;
        if (last?.role === "user" && typeof last.content === "string") {
          cloned[cloned.length - 1] = { ...last, content: last.content + suffix } as never;
        }
        return cloned;
      },
      streamFn: this.modelBundle.models.streamSimple.bind(this.modelBundle.models),
    });
    agent.sessionId = sessionId;
    return agent;
  }

  /** 工具携带后端客户端，必须按当次请求的用户令牌重建，不落盘、不复用旧令牌 */
  private bindTools(session: SessionRecord, token: string): void {
    const client = new BackendClient(this.config.backendBaseUrl, token, this.config.backendTimeoutMs);
    session.agent.state.tools = createAskMetricTools(client);
  }

  createSession(user: BackendUser, token: string): SessionRecord {
    const owned = [...this.sessions.values()].filter((s) => s.userId === user.id);
    if (owned.length >= this.config.maxSessionsPerUser) {
      // 超出上限时淘汰最旧的空闲会话，避免用户被硬错误阻断
      const idle = owned.filter((s) => !s.running).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      const victim = idle[0];
      if (!victim) {
        throw new Error("会话数量已达上限，请等待进行中的提问完成");
      }
      this.deleteSession(victim.id, user.id);
    }
    const record: SessionRecord = {
      id: randomUUID(),
      userId: user.id,
      username: user.username,
      title: "问数会话",
      agent: this.buildAgent([], ""),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      running: false,
    };
    record.agent.sessionId = record.id;
    this.bindTools(record, token);
    this.sessions.set(record.id, record);
    this.persist(record);
    return record;
  }

  getSession(sessionId: string, userId: string): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId) return undefined;
    return record;
  }

  listSessions(userId: string): Array<Omit<SessionRecord, "agent"> & { preview: string }> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .map(({ agent, ...rest }) => ({ ...rest, preview: sessionPreview(agent.state.messages) }));
  }

  deleteSession(sessionId: string, userId: string): boolean {
    const record = this.getSession(sessionId, userId);
    if (!record) return false;
    record.agent.abort();
    this.store.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  /** 以异步生成器输出一次提问的 SSE 事件流；客户端断开时由调用方中止。 */
  async *promptStream(session: SessionRecord, message: string, token: string): AsyncGenerator<AgentUiEvent> {
    if (session.running) {
      yield { type: "error", message: "该会话正在处理上一个提问，请等待完成" };
      return;
    }
    session.running = true;
    session.lastActiveAt = Date.now();
    this.bindTools(session, token);

    // subscribe 回调把 agent 事件推入队列，生成器侧按序取出
    const queue: AgentUiEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const push = (event: AgentUiEvent) => {
      queue.push(event);
      wake?.();
    };
    const unsubscribe = session.agent.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta") {
            push({ type: "text_delta", delta: assistantEvent.delta });
          }
          break;
        }
        case "tool_execution_start":
          push({ type: "tool_start", tool: event.toolName, args: event.args });
          break;
        case "tool_execution_end": {
          const result = event.result as { details?: unknown } | undefined;
          push({
            type: "tool_end",
            tool: event.toolName,
            details: result?.details ?? null,
            isError: event.isError,
          });
          break;
        }
        case "message_end": {
          const message = event.message as { role?: string; content?: unknown };
          if (message.role === "assistant" && Array.isArray(message.content)) {
            // 模型在工具轮次前常输出纯空行文本（如 "\n\n"），剔除前导空行并跳过空白轮次
            const text = (message.content as Array<{ type: string; text?: string }>)
              .filter((block) => block.type === "text")
              .map((block) => block.text ?? "")
              .join("")
              .replace(/^\n+/, "");
            if (text.trim()) push({ type: "message_done", text });
          }
          break;
        }
        // agent_end 也可能代表失败；等待 prompt 收尾后统一判定终态。
        default:
          break;
      }
    });

    const run = session.agent.prompt(message).then(() => {
      const last = session.agent.state.messages.at(-1);
      const failure = assistantFailure(last) || (session.agent.state.errorMessage ? "模型调用失败或连接中断，请重试。" : undefined);
      finished = true;
      push(failure ? { type: "error", message: failure } : { type: "done" });
    }).catch(() => {
      finished = true;
      push({ type: "error", message: "模型调用失败或连接中断，请重试。" });
    });

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as AgentUiEvent;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      unsubscribe();
      if (!finished) session.agent.abort();
      await run;
      session.running = false;
      session.lastActiveAt = Date.now();
      this.persist(session);

    }
  }

  private persist(session: SessionRecord): void {
    session.title = deriveSessionTitle(session.agent.state.messages);
    const snapshot: PersistedSession = {
      id: session.id,
      userId: session.userId,
      username: session.username,
      title: session.title,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      messages: session.agent.state.messages,
    };
    try {
      this.store.save(snapshot);
    } catch (error) {
      // 持久化失败不阻断本次回答；记录日志由运维排查磁盘/权限
      console.error(`会话 ${session.id} 持久化失败:`, error instanceof Error ? error.message : error);
    }
  }
}
