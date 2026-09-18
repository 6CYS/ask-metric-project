import { parseClarificationSelection } from "./clarification.js";
/**
 * HTTP 路由：会话管理与提问的 SSE 事件流。
 * 鉴权采用与前端一致的 Bearer，通过后端 /api/v1/auth/me 验证并解析用户身份。
 */
import { sessionPreview } from "./sessionPreview.js";
import { assistantFailure } from "./assistantFailure.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentManager, SessionRecord } from "./agentManager.js";
import { BackendClient, BackendApiError, type BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import { messageText } from "./sessionStore.js";

type Variables = { user: BackendUser; token: string };

interface AuthCacheEntry {
  user: BackendUser;
  expiresAt: number;
}

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

export function createApp(config: AgentServiceConfig, manager: AgentManager): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const authCache = new Map<string, AuthCacheEntry>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // 除健康检查外均要求有效 Bearer；身份以后端校验为准，短期缓存避免每次请求回源
  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return c.json({ detail: "未提供访问令牌" }, 401);
    }
    const cached = authCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      c.set("user", cached.user);
      c.set("token", token);
      return next();
    }
    const client = new BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs);
    try {
      const user = await client.getMe();
      authCache.set(token, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
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
    try {
      const record = await manager.createSessionWithCleanup(user, c.get("token"));
      return c.json({ session_id: record.id, title: record.title, created_at: record.createdAt }, 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "创建会话失败" }, 429);
    }
  });

  app.get("/sessions", (c) => {
    const sessions = manager.listSessions(c.get("user").id).map((s) => ({
      session_id: s.id,
      title: s.title,
      preview: s.preview,
      created_at: s.createdAt,
      last_active_at: s.lastActiveAt,
      running: s.running,
    }));
    return c.json({ items: sessions });
  });

  const findSession = (c: { req: { param: (name: string) => string }; get: (k: "user") => BackendUser }): SessionRecord | undefined =>
    manager.getSession(c.req.param("id"), c.get("user").id);

  app.get("/sessions/:id", (c) => {
    const record = findSession(c);
    if (!record) return c.json({ detail: "会话不存在" }, 404);
    // 历史消息保留工具结果明细（含结果表、task_id、澄清结构），供前端还原表格与导出
    const messages = record.agent.state.messages.map((message) => {
      const msg = message as {
        role: string;
        content?: unknown;
        timestamp?: number;
        toolName?: string;
        toolCallId?: string;
        executionMs?: number;
        details?: unknown;
        isError?: boolean;
        stopReason?: string;
        errorMessage?: string;
      };
      if (msg.role === "user") {
        return {
          role: "user",
          text: messageText(msg.content),
          timestamp: msg.timestamp ?? null,
        };
      }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const blocks = msg.content as Array<{ type: string; text?: string; name?: string; id?: string }>;
        return {
          role: "assistant",
          error: assistantFailure(msg),
          // 剔除工具轮次前的纯空行文本，避免前端气泡出现大片空白
          text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").replace(/^\n+/, ""),
          tools: blocks.filter((b) => b.type === "toolCall").map((b) => b.name ?? ""),
          tool_calls: blocks.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id, tool: b.name ?? "" })),
          timestamp: msg.timestamp ?? null,
        };
      }
      if (msg.role === "toolResult") {
        return {
          role: "tool",
          tool: msg.toolName ?? "",
          details: msg.details ?? null,
          call_id: msg.toolCallId,
          elapsed_ms: msg.executionMs,
          is_error: Boolean(msg.isError) || ["error", "failed"].includes((msg.details as { status?: string } | undefined)?.status ?? ""),
          timestamp: msg.timestamp ?? null,
        };
      }
      return { role: msg.role, text: "", timestamp: msg.timestamp ?? null };
    });
    return c.json({ session_id: record.id, title: record.title, preview: sessionPreview(record.agent.state.messages), created_at: record.createdAt, running: record.running, messages });
  });

  app.delete("/sessions/:id", async (c) => {
    try {
      if (!await manager.deleteSession(c.req.param("id"), c.get("user").id, c.get("token"))) {
        return c.json({ detail: "会话不存在" }, 404);
      }
      return c.body(null, 204);
    } catch {
      return c.json({ detail: "关联查询结果尚未清理完成，请重试删除。" }, 503);
    }
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const record = findSession(c);
    if (!record) return c.json({ detail: "会话不存在" }, 404);
    const body = await c.req.json<{ message?: unknown; clarification?: unknown }>().catch(() => ({}) as { message?: unknown; clarification?: unknown });
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return c.json({ detail: "message 不能为空" }, 400);
    }
    if (message.length > 4000) {
      return c.json({ detail: "message 过长" }, 400);
    }
    let selection;
    try {
      selection = parseClarificationSelection(body.clarification, message);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "无效的澄清选择" }, 400);
    }
    if (selection && selection.clarification_id !== record.pendingClarification?.clarificationId) {
      return c.json({ detail: "待补充任务已更新，请刷新会话后重试。" }, 409);
    }
    const token = c.get("token");
    return streamSSE(c, async (stream) => {
      const events = manager.promptStream(record, message, token, selection);
      try {
        for await (const event of events) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === "done" || event.type === "error") break;
        }
      } finally {
        // 客户端断开等情况下确保 agent 不再继续消耗模型调用
        if (record.running) record.agent.abort();
      }
    });
  });

  return app;
}
