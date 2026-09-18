/**
 * HTTP 路由（协议 V3）：会话管理与提问的 SSE 事件流。
 * 鉴权采用与前端一致的 Bearer，每次请求经后端 /api/v1/auth/me 校验，不缓存身份。
 * 页面状态是原生与业务状态的派生投影，本地不保存权威运行状态。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { BackendClient, BackendApiError, type BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import { HarnessHost, type HostedSession, type PromptInput } from "./harnessHost.js";
import { getLegacySession, listLegacySessions, projectLegacyMessages } from "./legacySessions.js";
import type { NativeSessionStore } from "./nativeSessions.js";
import type { AskMetricRequestContext } from "./requestContext.js";
import { projectEntries, projectSnapshot, projectWatchEvent } from "./sessionProjection.js";

type Variables = { user: BackendUser; token: string };

const MESSAGE_MAX_LENGTH = 4000;

export function createApp(
  config: AgentServiceConfig,
  host: HarnessHost,
  store: NativeSessionStore,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // 除健康检查外均要求有效 Bearer；身份以后端当次校验为准，不使用短期缓存
  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return c.json({ detail: "未提供访问令牌" }, 401);
    }
    const client = new BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs);
    try {
      const user = await client.getMe();
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
      return c.json({
        session_id: legacy.id,
        title: legacy.title,
        created_at: legacy.createdAt,
        running: false,
        legacy: true,
        messages: projectLegacyMessages(legacy),
      });
    }
    const entries = await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
    // 重启后存在未完成 operation 时，借本次已认证请求重新授权恢复
    if (hosted.open.length > 0 && !info.current) {
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
      running: Boolean(info.current),
      operation_id: info.current?.id ?? null,
      messages: projectEntries(entries),
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
    return streamSSE(c, async (stream) => {
      const send = async (type: string, data: Record<string, unknown>) =>
        stream.writeSSE({
          event: type,
          data: JSON.stringify({ protocol_version: 3, session_id: sessionId, ...data }),
        });
      const watch = await host.watch(hosted);
      const active = watch.snapshot.operation;
      try {
        await send("snapshot", projectSnapshot(watch.snapshot) as unknown as Record<string, unknown>);
        if (!active) {
          // 无活动操作：直接给出终态，前端据此停止等待
          await send("run_terminal", { run_status: "idle", answer_status: "idle", business_tasks: [] });
          return;
        }
        await new Promise<void>((resolve) => {
          watch.start((event) => {
            const projected = projectWatchEvent(event);
            if (projected) void send(projected.type, projected as unknown as Record<string, unknown>);
            if (event.type === "run_end") {
              void send("run_terminal", {
                run_status: "status" in event ? event.status : "unknown",
                answer_status: "status" in event && event.status === "completed" ? "ok" : "failed",
                business_tasks: [],
              }).then(() => resolve());
            }
          });
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
    const admitted = await host.admitPrompt(hosted, input, { actor: user, backend });
    if (!admitted.ok) {
      const status = admitted.code === "SESSION_BUSY" ? 409 : 400;
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
      const send = async (type: string, data: Record<string, unknown>) =>
        stream.writeSSE({
          event: type,
          data: JSON.stringify({
            protocol_version: 3,
            session_id: sessionId,
            operation_id: operationId,
            request_id: input.request_id,
            ...data,
          }),
        });

      // 观察与驱动分离：浏览器断线只取消观察，不中止执行
      const watch = await host.watch(hosted);
      // 先投影原子快照，再订阅增量事件（原生 watch 的顺序约定）
      await send("accepted", { snapshot: projectSnapshot(watch.snapshot) });
      watch.start((event) => {
        const projected = projectWatchEvent(event);
        if (projected) void send(projected.type, projected as unknown as Record<string, unknown>);
      });
      try {
        const driven = await host.drivePrompt(hosted, admitted);
        const record = driven.ok && driven.outcome.kind === "settled" ? driven.outcome.outcome : undefined;
        const write = await admitted.request.commands.getWriteCommand();
        await send("run_terminal", {
          run_status: record?.status ?? (driven.ok ? "unknown" : "failed"),
          answer_status: record?.status === "completed" ? "ok" : "failed",
          // 失败原因透传（如模型网关 402 配额不足），由前端转成通俗提示
          error_code: record?.error?.code ?? null,
          business_tasks: write?.taskId
            ? [{ task_id: write.taskId, ...(write.resultId ? { result_id: write.resultId } : {}) }]
            : [],
        });
      } finally {
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
  if (body.send_as === "new_question") input.send_as = "new_question";
  const target = body.clarification_target;
  if (target && typeof target === "object") {
    const candidate = target as Record<string, unknown>;
    if (
      typeof candidate.task_id === "string"
      && typeof candidate.clarification_id === "string"
      && typeof candidate.version === "number"
      && Number.isInteger(candidate.version)
      && candidate.version >= 0
    ) {
      input.clarification_target = {
        task_id: candidate.task_id,
        version: candidate.version,
        clarification_id: candidate.clarification_id,
      };
    }
  }
  if (body.selected_answers && typeof body.selected_answers === "object") {
    input.selected_answers = body.selected_answers as Record<string, unknown>;
  }
  return input;
}
