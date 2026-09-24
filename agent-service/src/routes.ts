/**
 * HTTP 路由（协议 V3）：会话管理与提问的 SSE 事件流。
 * 鉴权采用与前端一致的 Bearer，每次请求经后端 /api/v1/auth/me 校验，不缓存身份。
 * 页面状态是原生与业务状态的派生投影，本地不保存权威运行状态。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BackendClient, BackendApiError, type BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import { HarnessHost, type HostedSession, type PromptInput } from "./harnessHost.js";
import { getLegacySession, listLegacySessions, projectLegacyMessages } from "./legacySessions.js";
import type { NativeSessionStore } from "./nativeSessions.js";
import { projectEntries, projectSnapshot, projectWatchEvent, projectBusinessTasks, type ProjectedMessage } from "./sessionProjection.js";

type Variables = { user: BackendUser; token: string; startedAt: number; authMs: number };

const MESSAGE_MAX_LENGTH = 4000;

export function createApp(
  config: AgentServiceConfig,
  host: HarnessHost,
  store: NativeSessionStore,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((error, c) => {
    if (error instanceof HistoryAuthorizationError) return c.json({code: error.code, detail: error.message}, error.status);
    return c.json({detail: "会话服务暂时不可用"}, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // 除健康检查外均要求有效 Bearer；身份以后端当次校验为准，不使用短期缓存
  app.use("*", async (c, next) => {
    c.set("startedAt", performance.now());
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return c.json({ detail: "未提供访问令牌" }, 401);
    }
    const client = new BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs);
    try {
      const user = await client.getMe();
      c.set("authMs", Math.round(performance.now() - c.get("startedAt")));
      c.set("user", user);
      c.set("token", token);
      return next();
    } catch (error) {
      if (error instanceof BackendApiError && (error.status === 401 || error.status === 403)) {
        return c.json({ detail: "访问令牌无效或已过期" }, 401);
      }
      return c.json({ detail: "身份校验服务暂不可用" }, 503);
    }
  });

  app.post("/sessions", async (c) => {
    const user = c.get("user");
    const hosted = await host.createSession(user);
    await hosted.harness.setName("问数会话", BACKGROUND_CONTEXT);
    return c.json({ session_id: hosted.sessionId, title: "问数会话", created_at: hosted.createdAt }, 201);
  });

  app.get("/sessions", async (c) => {
    const user = c.get("user");
    const items: Array<Record<string, unknown>> = [];
    for (const metadata of await store.list(user.id)) {
      // 标题存在原生会话 name 里；列表面只读打开 Session（不挂载 harness），
      // 运行状态只可能来自本宿主已打开的会话
      const session = await store.open(user.id, metadata).catch(() => undefined);
      const title = session ? await session.getName(BACKGROUND_CONTEXT) : undefined;
      items.push({
        session_id: metadata.id,
        title: title ?? "问数会话",
        created_at: metadata.createdAt,
        last_active_at: metadata.modifiedAt,
        running: await host.isRunning(metadata.id),
        ...(await host.readOnlyReason(metadata.id) ? {legacy: true, read_only_reason: await host.readOnlyReason(metadata.id)} : {}),
      });
    }
    // 旧 JSON 会话以只读形式并入列表，标记 legacy 供前端区分
    for (const legacy of listLegacySessions(config.dataDir, user.id)) {
      items.push({
        session_id: legacy.id,
        title: legacy.title,
        created_at: legacy.createdAt,
        last_active_at: legacy.lastActiveAt,
        running: false,
        legacy: true,
      });
    }
    items.sort((a, b) => Number(b.last_active_at) - Number(a.last_active_at));
    return c.json({ items });
  });

  app.get("/sessions/:id", async (c) => {
    const user = c.get("user");
    const hosted = await host.openSession(user, c.req.param("id"));
    if (!hosted) {
      // 旧会话只读回退：不续跑、不可提问
      const legacy = getLegacySession(config.dataDir, user.id, c.req.param("id"));
      if (!legacy) return c.json({ detail: "会话不存在" }, 404);
      const messages = legacyMessagesWithVerifiableAnswers(projectLegacyMessages(legacy));
      await authorizeHistory(messages, new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs));
      return c.json({
        session_id: legacy.id,
        title: legacy.title,
        created_at: legacy.createdAt,
        running: false,
        legacy: true,
        messages,
      });
    }
    const entries = await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    const messages = projectEntries(entries);
    await authorizeHistory(messages, new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs));
    const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
    // 重启后存在未完成 operation 时，借本次已认证请求重新授权恢复
    if (!hosted.readOnlyReason && hosted.open.length > 0) {
      const backend = new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs);
      void host.resumeOpenOperations(hosted, { actor: user, backend }).catch((error: unknown) => {
        console.error(`会话 ${hosted.sessionId} 恢复未完成操作失败:`, error instanceof Error ? error.message : error);
      });
    }
    const title = await hosted.session.getName(BACKGROUND_CONTEXT);
    return c.json({
      session_id: hosted.sessionId,
      title: title ?? "问数会话",
      created_at: hosted.createdAt,
      running: !hosted.readOnlyReason && Boolean(info.current),
      operation_id: hosted.readOnlyReason ? null : info.current?.id ?? null,
      ...(hosted.readOnlyReason ? {legacy: true, read_only_reason: hosted.readOnlyReason} : {}),
      messages,
    });
  });

  app.delete("/sessions/:id", async (c) => {
    const user = c.get("user");
    const hosted = await host.openSession(user, c.req.param("id"));
    if (!hosted) return c.json({ detail: "会话不存在" }, 404);
    const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
    if (info.current) {
      return c.json({ detail: "会话正在处理提问，请先停止后再删除" }, 409);
    }
    const metadata = await store.findMetadata(user.id, hosted.sessionId);
    await host.closeSession(hosted.sessionId);
    if (metadata) await store.delete(user.id, metadata, BACKGROUND_CONTEXT);
    return c.body(null, 204);
  });

  /** 显式停止：原生取消指定 operation；业务任务取消由工具层按 created/mutated 处理 */
  app.post("/sessions/:id/cancel", async (c) => {
    const user = c.get("user");
    const hosted = await host.openSession(user, c.req.param("id"));
    if (!hosted) return c.json({ detail: "会话不存在" }, 404);
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const operationId = typeof body.operation_id === "string" ? body.operation_id : "";
    if (!operationId) return c.json({ detail: "operation_id 不能为空" }, 400);
    await host.abort(hosted, operationId);
    return c.body(null, 204);
  });

  /** 断线重连的只读观察流：快照 + 实时事件直至活动操作结束；不接纳新输入 */
  app.get("/sessions/:id/stream", async (c) => {
    const user = c.get("user");
    const hosted = await host.openSession(user, c.req.param("id"));
    if (!hosted) return c.json({ detail: "会话不存在" }, 404);
    const sessionId = hosted.sessionId;
    const backend = new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs);
    const authorize = createHistoryAuthorizer(backend);
    await authorize(projectEntries(await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)));
    return streamSSE(c, async (stream) => {
      const send = authorizedSender(authorize, async (type, data) => stream.writeSSE({
        event: type,
        data: JSON.stringify({protocol_version: 3, session_id: sessionId, ...data}),
      }));
      if (hosted.readOnlyReason) {
        const messages = projectEntries(await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
        await send("snapshot", {messages, running: false, operation_id: null, legacy: true, read_only_reason: hosted.readOnlyReason});
        await send("run_terminal", {run_status: "idle", answer_status: "idle", business_tasks: projectBusinessTasks(messages)});
        return;
      }
      const watch = await host.watch(hosted);
      const active = watch.snapshot.operation;
      try {
        await send("snapshot", projectSnapshot(watch.snapshot) as unknown as Record<string, unknown>);
        if (!active) {
          // 无活动操作：直接给出终态，前端据此停止等待
          await send("run_terminal", { run_status: "idle", answer_status: "idle", business_tasks: projectBusinessTasks(projectEntries(watch.snapshot.transcript)) });
          return;
        }
        await new Promise<void>((resolve) => {
          stream.onAbort(() => { watch.unsubscribe(); resolve(); });
          watch.start((event) => {
            const projected = projectWatchEvent(event);
            if (projected) void send(projected.type, projected as unknown as Record<string, unknown>).catch(() => {});
            if (event.type === "run_end") {
              void (async () => {
                const messages = projectEntries(await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT));
                await send("snapshot", { messages, running: false, operation_id: null });
                await send("run_terminal", {
                  run_status: event.status, answer_status: event.status === "completed" ? "ok" : "failed",
                  business_tasks: projectBusinessTasks(messages),
                });
              })().catch(() => {}).finally(resolve);
            }
          });
          if (hosted.open.length) {
            const backend = new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs);
            void host.resumeOpenOperations(hosted, { actor: user, backend }).catch(() => {
              void send("error", {message: "执行恢复暂未成功，请稍后重新打开此会话。"}).catch(() => {}).finally(resolve);
            });
          }
        });
      } finally {
        watch.unsubscribe();
      }
    });
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const user = c.get("user");
    const hosted = await host.openSession(user, c.req.param("id"));
    if (!hosted) {
      // 旧会话不可续跑；404 时前端不得自动新建重发
      return c.json({ detail: "会话不存在或为只读历史会话，请新建会话提问" }, 404);
    }
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    if (body.protocol_version !== 3) {
      return c.json({ detail: "客户端协议版本过旧，请刷新页面", code: "CLIENT_UPGRADE_REQUIRED" }, 400);
    }
    const input = parsePromptInput(body);
    if (!input) {
      return c.json({ detail: "请求参数不完整或 message 为空/过长" }, 400);
    }
    const token = c.get("token");
    const backend = new BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs);
    const authorize = createHistoryAuthorizer(backend);
    // 先复核持久化结果，再让历史进入模型或 accepted 快照；新问题不能绕过旧结果撤权。
    await authorize(projectEntries(await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)));
    const admitted = await host.admitPrompt(hosted, input, { actor: user, backend });
    if (!admitted.ok) {
      const status = ["SESSION_BUSY", "LEGACY_QUERY_REQUIRES_NEW_TURN"].includes(admitted.code) ? 409 : 400;
      return c.json({ detail: admitted.message, code: admitted.code }, status);
    }
    const sessionId = hosted.sessionId;
    const operationId = admitted.operationId;
    // 标题派生自首个问题：原生 setName，列表/详情同源读取
    const currentName = await hosted.session.getName(BACKGROUND_CONTEXT);
    if (!currentName || currentName === "问数会话") {
      await hosted.harness.setName(input.message.slice(0, 24), BACKGROUND_CONTEXT);
    }

    return streamSSE(c, async (stream) => {
      const send = authorizedSender(authorize, async (type, data) =>
        stream.writeSSE({
          event: type,
          data: JSON.stringify({
            protocol_version: 3,
            session_id: sessionId,
            operation_id: operationId,
            request_id: input.request_id,
            ...data,
          }),
        }));

      // 观察与驱动分离：浏览器断线只取消观察，不中止执行
      const watch = await host.watch(hosted);
      // 先投影原子快照，再订阅增量事件（原生 watch 的顺序约定）
      await send("accepted", { snapshot: projectSnapshot(watch.snapshot) }).catch(() => {});
      watch.start((event) => {
        const projected = projectWatchEvent(event);
        if (projected) void send(projected.type, projected as unknown as Record<string, unknown>).catch(() => {});
      });
      // 模型重试与工具执行期间没有原生事件可投影；心跳既避免代理按空闲断连，
      // 也让前端能把“仍在执行”和“卡死”区分开。
      const heartbeat = setInterval(() => {
        void send("progress", { elapsed_ms: Math.round(performance.now() - c.get("startedAt")) }).catch(() => {});
      }, 15_000);
      try {
        const driven = await host.drivePrompt(hosted, admitted);
        const record = driven.ok && driven.outcome.kind === "settled" ? driven.outcome.outcome : undefined;
        const messages = projectEntries(await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT));
        await send("snapshot", { messages, running: false, operation_id: null }).catch(() => {});
        await send("run_terminal", {
          run_status: record?.status ?? (driven.ok ? "unknown" : "failed"),
          answer_status: record?.status === "completed" ? "ok" : "failed",
          // 失败原因透传（如模型网关 402 配额不足），由前端转成通俗提示
          error_code: record?.error?.code ?? null,
          // 错误码无法覆盖所有模型侧失败；带上服务端已脱敏的原因摘要，避免前端只看到“失败了”
          error_message: driven.ok ? null : driven.message,
          business_tasks: projectBusinessTasks(messages),
          timings_ms: { auth_ms: c.get("authMs"), total_ms: Math.round(performance.now() - c.get("startedAt")), model_ms: admitted.request.timings?.model_ms, tool_ms: admitted.request.timings?.tool_ms },
        }).catch(() => {});
      } finally {
        clearInterval(heartbeat);
        watch.unsubscribe();
      }
    });
  });

  return app;
}

/** 解析并校验协议 V3 输入；非法字段整体拒绝，不猜测补齐 */
function parsePromptInput(body: Record<string, unknown>): PromptInput | null {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
  if (!message || message.length > MESSAGE_MAX_LENGTH || !requestId || requestId.length > 128) {
    return null;
  }
  const input: PromptInput = { protocol_version: 3, request_id: requestId, message };
  const allowed = new Set(["protocol_version", "request_id", "message", "clarification_target", "selected_answers"]);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  const target = body.clarification_target;
  if (target !== undefined) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return null;
    const candidate = target as Record<string, unknown>;
    if (
      typeof candidate.task_id === "string" && candidate.task_id.trim().length > 0 && candidate.task_id.length <= 128
      && typeof candidate.clarification_id === "string" && candidate.clarification_id.trim().length > 0 && candidate.clarification_id.length <= 128
      && typeof candidate.version === "number"
      && Number.isInteger(candidate.version)
      && candidate.version >= 0
    ) {
      input.clarification_target = {
        task_id: candidate.task_id,
        version: candidate.version,
        clarification_id: candidate.clarification_id,
      };
    } else return null;
  }
  if (body.selected_answers !== undefined) {
    if (!body.selected_answers || typeof body.selected_answers !== "object" || Array.isArray(body.selected_answers)) return null;
    if (!input.clarification_target) return null;
    input.selected_answers = body.selected_answers as Record<string, unknown>;
  }
  return input;
}


class HistoryAuthorizationError extends Error {
  constructor(readonly code: string, readonly status: 403 | 409 | 503) {
    super(status === 403 ? "历史结果涉及当前无权查看的机构，暂不能读取此会话。"
      : status === 409 ? "历史结果缺少可复核的范围或结果引用，暂不能安全读取，请新建会话查询。"
      : "历史结果权限暂时无法核验，请稍后重试。");
  }
}

/** 旧 JSON 缺少执行引用的正文无法证明权限；仅调整展示，不改写历史文件。 */
function legacyMessagesWithVerifiableAnswers(messages: ProjectedMessage[]): ProjectedMessage[] {
  let verifiedSource = false;
  return messages.map(message => {
    if (message.role === "user") verifiedSource = false;
    if (message.role === "tool") {
      const details = object(message.details);
      if (["succeeded", "SUCCEEDED"].includes(String(details?.status))
        && ["metric_query_structured", "metric_ask", "metric_read", "metric_calculate", "data_availability"].includes(String(details?.kind))) verifiedSource = true;
    }
    return message.role === "assistant" && message.text && !verifiedSource
      ? {...message, text: "此旧记录缺少可复核的结果引用，无法确认当前查看权限。原记录已保留，请重新查询。"}
      : message;
  });
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** 单轮提问内共享的复核结果：已验证的任务与机构范围不重复请求 backend。 */
export interface HistoryAuthorizationCache {
  tasks: Set<string>;
  scopes: Set<string>;
}

/** 缓存的正文不是授权票据；只复核持久化结果引用/范围，绝不重新执行指标 SQL。 */
export async function authorizeHistory(messages: ProjectedMessage[], backend: BackendClient,
  cache?: HistoryAuthorizationCache): Promise<void> {
  const tasks = new Set<string>();
  const organizationScopes: string[][] = [];
  const unknown = () => {throw new HistoryAuthorizationError("HISTORY_SCOPE_UNAVAILABLE", 409);};
  const addTask = (value: unknown) => {
    if (typeof value !== "string" || !value) unknown();
    tasks.add(value as string);
  };
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const outer = object(message.details);
    if (!outer) continue;
    const details = object(outer.result) ?? outer;
    if (!["succeeded", "SUCCEEDED"].includes(String(details.status))) continue;
    const kind = String(details.kind ?? outer.kind);
    if (["metric_query_structured", "metric_ask", "metric_read"].includes(kind)) {
      addTask(details.task_id ?? outer.task_id);
    } else if (kind === "metric_calculate") {
      const inputs = object(details.inputs);
      if (!inputs || !Object.keys(inputs).length) unknown();
      let facts = 0;
      for (const input of Object.values(inputs!)) {
        const source = object(input);
        if (source?.kind === "user_constant") continue;
        addTask(source?.task_id);
        facts += 1;
      }
      if (!facts) unknown();
    } else if (kind === "data_availability") {
      const codes = object(details.request)?.org_codes;
      if (!Array.isArray(codes) || !codes.length || !codes.every(code => typeof code === "string" && code)) unknown();
      organizationScopes.push(codes as string[]);
    } else if (Array.isArray(details.rows) || Array.isArray(details.facts)) {
      // 不把未知旧工具的成功结果当作无需权限的文本。
      unknown();
    }
  }
  try {
    const pendingTasks = [...tasks].filter(taskId => !cache?.tasks.has(taskId));
    await Promise.all(pendingTasks.map(async taskId => {
      const task = await backend.getTask(taskId);
      if (task.task_id !== taskId || task.status !== "SUCCEEDED") unknown();
    }));
    for (const taskId of pendingTasks) cache?.tasks.add(taskId);
    const scopeKey = (codes: string[]) => JSON.stringify([...codes].sort());
    const pendingScopes = organizationScopes.filter(codes => !cache?.scopes.has(scopeKey(codes)));
    await Promise.all(pendingScopes.map(async codes => {
      const resolved = await backend.resolveBusinessField("organization", codes);
      const current = object(resolved.value)?.codes;
      if (resolved.status !== "resolved" || !Array.isArray(current)
        || new Set(current).size !== new Set(codes).size || codes.some(code => !current.includes(code))) {
        throw new HistoryAuthorizationError("HISTORY_PERMISSION_DENIED", 403);
      }
    }));
    for (const codes of pendingScopes) cache?.scopes.add(scopeKey(codes));
  } catch (error) {
    if (error instanceof HistoryAuthorizationError) throw error;
    if (error instanceof BackendApiError && [401, 403].includes(error.status)) {
      throw new HistoryAuthorizationError("HISTORY_PERMISSION_DENIED", 403);
    }
    if (error instanceof BackendApiError && [404, 409, 422].includes(error.status)) {
      throw new HistoryAuthorizationError("HISTORY_SCOPE_UNAVAILABLE", 409);
    }
    throw new HistoryAuthorizationError("HISTORY_AUTHORIZATION_UNAVAILABLE", 503);
  }
}

/**
 * 创建一轮提问复用的复核函数：同一轮内（入口复核 + SSE 各事件）已验证的任务/机构范围
 * 不重复请求 backend；下一轮提问使用新实例重新全量复核，撤权在轮间即时生效。
 */
export function createHistoryAuthorizer(backend: BackendClient): (messages: ProjectedMessage[]) => Promise<void> {
  const cache: HistoryAuthorizationCache = { tasks: new Set(), scopes: new Set() };
  return messages => authorizeHistory(messages, backend, cache);
}

/** 授权与事件发送串行，某条证据失权后不再发送后续正文或快照。 */
function authorizedSender(authorize: (messages: ProjectedMessage[]) => Promise<void>,
  write: (type: string, data: Record<string, unknown>) => Promise<unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  return (type: string, data: Record<string, unknown>): Promise<unknown> => {
    pending = pending.then(async () => {
      const snapshot = object(data.snapshot);
      const messages = data.messages ?? snapshot?.messages;
      try {
        if (Array.isArray(messages)) await authorize(messages as ProjectedMessage[]);
        if (type === "tool_end") await authorize([{
          role: "tool", tool: String(data.tool ?? ""), tool_call_id: String(data.tool_call_id ?? ""),
          details: data.details, is_error: Boolean(data.isError), timestamp: null, entry_id: "live",
        }]);
      } catch (error) {
        const failure = error instanceof HistoryAuthorizationError ? error
          : new HistoryAuthorizationError("HISTORY_AUTHORIZATION_UNAVAILABLE", 503);
        await write("error", {code: failure.code, message: failure.message});
        throw failure;
      }
      await write(type, data);
    });
    return pending;
  };
}
