/**
 * HTTP 路由（协议 V3）：会话管理与提问的 SSE 事件流。
 * 鉴权采用与前端一致的 Bearer，每次请求经后端 /api/v1/auth/me 校验，不缓存身份。
 * 页面状态是原生与业务状态的派生投影，本地不保存权威运行状态。
 */
import { BACKGROUND_CONTEXT, operationResult } from "@earendil-works/pi-agent-core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BackendClient, BackendApiError, type BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import { HarnessHost, type HostedSession, type PromptInput } from "./harnessHost.js";
import { getLegacySession, listLegacySessions, projectLegacyMessages } from "./legacySessions.js";
import type { NativeSessionStore } from "./nativeSessions.js";
import { NativeSemanticTaskStore } from "./semantic-task/store.js";
import { normalizeAnswerInput, type ClickAnswerInput } from "./semantic-task/questions.js";
import { projectEntries, projectSnapshot, projectWatchEvent, projectBusinessTasks, projectQuestionStates, type ProjectedMessage } from "./sessionProjection.js";
import {AnswerStreamProjector} from "./answerStream.js";
import { compileInquiryReportDraft, createInquiryReportPreview } from "./inquiry/reportTool.js";
import { receiptDelivery } from "./runtime/delivery.js";
import {historySources, resolveHistoryOrganizationScopes, type HistoryQuestionReader} from "./historySources.js";
import {isCalendarDate} from "./tools/shared.js";
import { createEvaluationRoutes } from "./evaluation/routes.js";
import type { EvaluationService } from "./evaluation/service.js";
import { createBusinessSkillRoutes } from "./businessSkillRoutes.js";
import type { BusinessSkillStore } from "./businessSkillStore.js";
import { SessionCoordinationError } from "./databaseSessionStorage.js";

type Variables = { user: BackendUser; token: string; startedAt: number; authMs: number };

const MESSAGE_MAX_LENGTH = 4000;

async function storedOperationResults(hosted: HostedSession) {
  const results = await hosted.session.scanValues(operationResult(""), BACKGROUND_CONTEXT);
  return results.map(record => record.value);
}

export function createApp(
  config: AgentServiceConfig,
  host: HarnessHost,
  store: NativeSessionStore,
  evaluations?: EvaluationService,
  skills?: BusinessSkillStore,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((error, c) => {
    if (error instanceof HistoryAuthorizationError) return c.json({code: error.code, detail: error.message}, error.status);
    if (error instanceof SessionCoordinationError) return c.json({ code: error.code, detail: error.message },
      error.code === "SESSION_NOT_FOUND" ? 404 : error.code === "SESSION_BUSY" ? 409 : 503);
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

  if (skills) app.route("/skills", createBusinessSkillRoutes(skills, config));
  app.use("/sessions/*", async (c, next) => {
    const id = c.req.path.split("/")[2];
    if (!id) return next();
    const release = host.retain(id);
    try { await next(); }
    finally { release(); await host.releaseIdle(id); }
  });

  if (evaluations) app.route("/evaluations", createEvaluationRoutes(evaluations));
  else app.all("/evaluations/*", c => c.json({code: "EVALUATION_UNAVAILABLE", detail: "测评存储暂不可用，请联系管理员检查"}, 503));

  app.post("/sessions", async (c) => {
    const user = c.get("user");
    const hosted = await host.createSession(user);
    await hosted.harness.setName("问数会话", BACKGROUND_CONTEXT);
    await host.releaseIdle(hosted.sessionId);
    return c.json({ session_id: hosted.sessionId, title: "问数会话", created_at: hosted.createdAt }, 201);
  });

  app.get("/sessions", async (c) => {
    const user = c.get("user");
    const items: Array<Record<string, unknown>> = [];
    let evaluationSessions = new Set<string>();
    try {
      evaluationSessions = new Set(evaluations?.listSessionIds(user.id) ?? []);
    } catch {
      // 测评索引异常不能阻断原会话；列表仍由原生仓库和当前账号权限控制。
      console.warn("测评会话索引不可读取，暂按原生会话列表展示");
    }
    for (const metadata of await store.list(user.id)) {
      if (evaluationSessions.has(metadata.id)) continue;
      // 标题存在原生会话 name 里；未打开的会话临时读取后即释放，不因浏览列表常驻内存。
      // 运行状态只可能来自本宿主已打开的会话
      const title = store.cluster ? await host.sessionTitle(user.id, metadata)
        : await host.sessionTitle(user.id, metadata).catch(() => undefined);
      items.push({
        session_id: metadata.id,
        title: title ?? "问数会话",
        created_at: metadata.createdAt,
        last_active_at: metadata.modifiedAt,
        running: store.cluster ? await store.cluster.running(user.id, metadata.id) : await host.isRunning(metadata.id),
        ...(await host.readOnlyReason(metadata.id) ? {legacy: true, read_only_reason: await host.readOnlyReason(metadata.id)} : {}),
      });
    }
    // 旧 JSON 会话以只读形式并入列表，标记 legacy 供前端区分
    for (const legacy of store.cluster ? [] : listLegacySessions(config.dataDir, user.id)) {
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
    const hosted = await host.viewSession(user, c.req.param("id"), c.req.query("resume") !== "false");
    if (!hosted) {
      // 旧会话只读回退：不续跑、不可提问
      const legacy = store.cluster ? undefined : getLegacySession(config.dataDir, user.id, c.req.param("id"));
      if (!legacy) return c.json({ detail: "会话不存在" }, 404);
      const messages = await redactInaccessibleHistory(legacyMessagesWithVerifiableAnswers(projectLegacyMessages(legacy)), createHistoryAuthorizer(new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs)));
      return c.json({
        session_id: legacy.id,
        title: legacy.title,
        created_at: legacy.createdAt,
        running: false,
        answer_stream: null,
        legacy: true,
        messages,
        question_states: [],
      });
    }
    try {
    const entries = await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    const messages = await redactInaccessibleHistory(projectEntries(entries, await storedOperationResults(hosted)), createHistoryAuthorizer(
      new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs), new NativeSemanticTaskStore(hosted.session)));
    const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
    // 重启后存在未完成 operation 时，借本次已认证请求重新授权恢复
    if (c.req.query("resume") !== "false" && !hosted.readOnlyReason && hosted.open.length > 0) {
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
      answer_stream: answerStreamIdentity(hosted, info.current?.id, config.answerStreaming),
      ...(hosted.readOnlyReason ? {legacy: true, read_only_reason: hosted.readOnlyReason} : {}),
      messages,
      question_states: await projectQuestionStates(messages, new NativeSemanticTaskStore(hosted.session)),
    });
    } finally { await host.releaseView(hosted); }
  });

  app.patch("/sessions/:id", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const title = body && typeof body === "object" && "title" in body
      && typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 255) {
      return c.json({ detail: "会话名称不能为空，且不能超过255个字符" }, 400);
    }
    const hosted = await host.openSession(c.get("user"), c.req.param("id"));
    if (!hosted) return c.json({ detail: "会话不存在" }, 404);
    if (hosted.readOnlyReason) return c.json({ detail: "旧格式会话仅支持查看" }, 409);
    // 名称只写入原生会话元数据，不改写提问、分析上下文或历史正文。
    await hosted.harness.setName(title, BACKGROUND_CONTEXT);
    return c.json({ session_id: hosted.sessionId, title });
  });

  app.delete("/sessions/:id", async (c) => {
    const deleted = await host.deleteSession(c.get("user"), c.req.param("id"));
    if (deleted === "missing") return c.json({ detail: "会话不存在" }, 404);
    if (deleted === "busy") {
      return c.json({ detail: "会话正在处理提问，请先停止后再删除" }, 409);
    }
    return c.body(null, 204);
  });

  /** 显式停止：原生取消指定 operation；业务任务取消由工具层按 created/mutated 处理 */
  app.post("/sessions/:id/cancel", async (c) => {
    const user = c.get("user");
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const operationId = typeof body.operation_id === "string" ? body.operation_id : "";
    const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
    if (!!operationId === !!requestId || requestId.length > 128 || operationId.length > 128) return c.json({detail: "请指定唯一的 operation_id 或 request_id"}, 400);
    if (store.cluster) {
      if (!await store.cluster.cancel(user.id, c.req.param("id"), requestId ? "request" : "operation", requestId || operationId))
        return c.json({ detail: "会话不存在" }, 404);
      await store.cluster.drainCancellations(c.req.param("id"));
      const state = await store.cluster.state(user.id, c.req.param("id"));
      if (state?.current_operation_id && Number(state.lease_until_ms) <= await store.cluster.database.now()) {
        const recovering = await host.viewSession(user, c.req.param("id"));
        if (recovering) void host.resumeOpenOperations(recovering, {
          actor: user, backend: new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs),
        }).catch(() => { console.warn("停止请求已保留，等待会话恢复后处理"); });
      }
      return c.body(null, 202);
    }
    const hosted = await host.openSession(user, c.req.param("id"));
    if (!hosted) return c.json({ detail: "会话不存在" }, 404);
    if (requestId) await host.cancelRequest(hosted, requestId);
    else await host.abort(hosted, operationId);
    return c.body(null, 204);
  });

  /** 断线重连的只读观察流：快照 + 实时事件直至活动操作结束；不接纳新输入 */
  app.get("/sessions/:id/stream", async (c) => {
    const user = c.get("user");
    const hosted = await host.viewSession(user, c.req.param("id"));
    if (!hosted) return c.json({ detail: "会话不存在" }, 404);
    const sessionId = hosted.sessionId;
    const backend = new BackendClient(config.backendBaseUrl, c.get("token"), config.backendTimeoutMs);
    let historyView = hosted;
    // 跨节点观察是不可变快照；后续事件的题目绑定必须从同批最新快照读取。
    const questionReader: HistoryQuestionReader = {
      question: (id, version) => new NativeSemanticTaskStore(historyView.session).question(id, version),
    };
    const authorize = createHistoryAuthorizer(backend, questionReader);
    const answerStreaming = config.answerStreaming && c.req.header("X-Agent-Answer-Streaming") === "v1";
    return streamSSE(c, async (stream) => {
      const release = host.retain(sessionId);
      try {
      const send = authorizedSender(authorize, async (type, data) => stream.writeSSE({
        event: type,
        data: JSON.stringify({protocol_version: 3, session_id: sessionId, ...data}),
      }), messages => projectQuestionStates(messages, new NativeSemanticTaskStore(historyView.session)));
      if (store.cluster) {
        try {
          if (!hosted.observer && hosted.open.length) void host.resumeOpenOperations(hosted, {actor: user, backend})
            .catch(() => { console.warn("共享会话恢复未完成，请重新打开会话重试"); });
          // 重连从本轮完整日志重放；正式历史快照和原有权限投影仍是最终依据。
          const info = await hosted.lane.inspectExecution(BACKGROUND_CONTEXT);
          const operation = info.current?.id;
          const messages = projectEntries(await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT), await storedOperationResults(hosted));
          await send("snapshot", { messages, running: Boolean(operation), operation_id: operation ?? null, answer_stream: null });
          if (!operation) {
            await send("run_terminal", { run_status: "idle", answer_status: "idle", business_tasks: projectBusinessTasks(messages) });
            return;
          }
          let cursor = 0, terminal = false, lastHeartbeat = performance.now();
          while (!stream.aborted && !terminal) {
            const events = await store.cluster.events(user.id, sessionId, operation, cursor);
            const current = events.length ? await host.viewSession(user, sessionId, false) : undefined;
            if (events.length && !current) throw new SessionCoordinationError("SESSION_NOT_FOUND", "会话不存在");
            if (current) historyView = current;
            let evidence: ProjectedMessage[] | undefined;
            try {
            for (const event of events) {
              cursor = event.seq;
              if (event.type === "accepted") continue;
              if (["answer_delta", "answer_reset"].includes(event.type) && !answerStreaming) continue;
              if (["answer_delta", "message_done"].includes(event.type)) {
                // 渲染文本在原节点发布时合法，不代表当前重连身份仍有权查看其依据。
                // 一批事件共用原子读视图，避免每个文字片段都重新加载整份历史。
                evidence ??= projectEntries(await historyView.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT), await storedOperationResults(historyView));
                // 旧回合由快照逐轮脱敏；本轮及其明确引用单独核验，避免旧失权记录误拦新问题。
                let turnStart = evidence.length - 1;
                while (turnStart > 0 && evidence[turnStart]?.role !== "user") turnStart--;
                await authorize(evidence.slice(Math.max(0, turnStart)));
              }
              await send(event.type, event.data);
              if (event.type === "run_terminal") { terminal = true; break; }
            }
            } finally {
              historyView = hosted;
              if (current) await host.releaseView(current);
            }
            if (terminal) break;
            const state = await store.cluster.state(user.id, sessionId);
            if (!state) throw new SessionCoordinationError("SESSION_NOT_FOUND", "会话不存在");
            if (state.current_operation_id && state.current_operation_id !== operation) {
              await send("error", {code: "SESSION_OPERATION_CHANGED", message: "会话已开始新的提问，请重新打开以查看最新进度。"});
              break;
            }
            if (!state.current_operation_id || Number(state.lease_until_ms) <= await store.cluster.database.now()) {
              // 日志终态可能尚未来得及发送；重新读取持久化结果，不能永久等待死节点。
              if (!state.current_operation_id) {
                const latest = await host.viewSession(user, sessionId);
                if (!latest) throw new SessionCoordinationError("SESSION_NOT_FOUND", "会话不存在");
                try {
                historyView = latest;
                const finalMessages = projectEntries(await latest.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT), await storedOperationResults(latest));
                const result = await latest.session.getValue(operationResult(operation), BACKGROUND_CONTEXT);
                await send("snapshot", {messages: finalMessages, running: false, operation_id: null, answer_stream: null});
                await send("run_terminal", {run_status: result?.value.status ?? "idle", answer_status: result?.value.status === "completed" ? "ok" : "idle", business_tasks: projectBusinessTasks(finalMessages)});
                } finally { historyView = hosted; await host.releaseView(latest); }
              } else await send("error", {code: "SESSION_RECOVERY_REQUIRED", message: "执行节点已离线，请重新打开会话以恢复未完成操作。"});
              break;
            }
            if (performance.now() - lastHeartbeat > 15_000) {
              await send("progress", {elapsed_ms: Math.round(performance.now() - c.get("startedAt"))});
              lastHeartbeat = performance.now();
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch (error) {
          const code = error instanceof HistoryAuthorizationError || error instanceof SessionCoordinationError ? error.code : "SESSION_STREAM_UNAVAILABLE";
          const message = error instanceof HistoryAuthorizationError ? error.message : "共享会话进度暂时无法读取，请重新打开会话。";
          await stream.writeSSE({event: "error", data: JSON.stringify({protocol_version: 3, session_id: sessionId, code, message})});
        } finally { await host.releaseView(hosted); }
        return;
      }
      if (hosted.readOnlyReason) {
        const messages = projectEntries(await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT), await storedOperationResults(hosted));
        await send("snapshot", {messages, running: false, operation_id: null, answer_stream: null, legacy: true, read_only_reason: hosted.readOnlyReason});
        await send("run_terminal", {run_status: "idle", answer_status: "idle", business_tasks: projectBusinessTasks(messages)});
        return;
      }
      let observedOperationId: string | undefined;
      const previewReport = createInquiryReportPreview();
      const projector = new AnswerStreamProjector((type, data) => {
        if (!stream.aborted) void send(type, data).catch(() => {});
      }, (body, signal) => {
        const activeRequest = hosted.activeRequest;
        if (!activeRequest || activeRequest.operationId !== observedOperationId) return Promise.resolve(undefined);
        // 只借用本轮证据，重连的读取权限由本次认证身份与客户端重新核验。
        return previewReport(body, { ...activeRequest, actor: user, backend }, signal);
      }, (args, ended) => {
        const activeRequest = hosted.activeRequest;
        if (!activeRequest || activeRequest.operationId !== observedOperationId) return Promise.resolve(undefined);
        return compileInquiryReportDraft(args, { ...activeRequest, actor: user, backend }, ended);
      });
      let watch = await host.watch(hosted);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const closeObservation = () => {
        projector.close();
        clearInterval(heartbeat);
        watch.unsubscribe();
      };
      stream.onAbort(closeObservation);
      try {
        if (!watch.snapshot.operation) {
          // GET 可能已经推进到原生终态，但升级提示仍在持久化；完成后重新取原子快照。
          await host.resumeOpenOperations(hosted, { actor: user, backend });
          watch.unsubscribe();
          watch = await host.watch(hosted);
        }
        const active = watch.snapshot.operation;
        observedOperationId = active?.id;
        const snapshot = projectSnapshot(watch.snapshot, await storedOperationResults(hosted));
        await send("snapshot", { ...snapshot,
          answer_stream: answerStreamIdentity(hosted, active?.id, answerStreaming) });
        if (!active) {
          // 无活动操作：直接给出终态，前端据此停止等待
          await send("run_terminal", { run_status: "idle", answer_status: "idle", business_tasks: projectBusinessTasks(snapshot.messages) });
          return;
        }
        if (stream.aborted) return;
        if (answerStreaming && active.streamingMessage) {
          projector.onWatchEvent({ type: "message_update", lane: watch.snapshot.lane, runId: active.id,
            message: active.streamingMessage, event: { type: "text_delta", contentIndex: 0, delta: "", partial: active.streamingMessage } },
          activeAnswerStream(hosted, observedOperationId));
        }
        await new Promise<void>((resolve) => {
          let recoveryFailed = false;
          const recoveryFailure = async () => {
            if (recoveryFailed) return;
            recoveryFailed = true;
            closeObservation();
            await send("error", {message: "执行恢复暂未成功，请稍后重新打开此会话。"}).catch(() => {});
            resolve();
          };
          stream.onAbort(resolve);
          if (stream.aborted) { resolve(); return; }
          // 重连观察复用提问流的心跳协议，覆盖模型重试与工具执行的静默期间。
          heartbeat = setInterval(() => {
            void send("progress", { elapsed_ms: Math.round(performance.now() - c.get("startedAt")) }).catch(() => {});
          }, 15_000);
          watch.start((event) => {
            if (stream.aborted) return;
            if (event.type === "run_end") {
              projector.close();
              clearInterval(heartbeat);
            }
            const projected = projectWatchEvent(event);
            if (projected) {
              const answer = streamedToolAnswer(projected);
              if (answer) projector.close();
              void send(projected.type, projected as unknown as Record<string, unknown>).catch(() => {});
              if (answer) void send("message_done", {
                text: answer.text, entry_id: answer.entry_id,
              }).catch(() => {});
            }
            if (answerStreaming) projector.onWatchEvent(event, activeAnswerStream(hosted, observedOperationId));
            if (event.type === "run_end") {
              void (async () => {
                await host.resumeOpenOperations(hosted, { actor: user, backend });
                const messages = projectEntries(await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT), await storedOperationResults(hosted));
                await send("snapshot", { messages, running: false, operation_id: null, answer_stream: null });
                await send("run_terminal", {
                  run_status: event.status, answer_status: event.status === "completed" ? "ok" : "failed",
                  business_tasks: projectBusinessTasks(messages),
                });
              })().catch(recoveryFailure).finally(resolve);
            }
          });
          void host.resumeOpenOperations(hosted, { actor: user, backend }).catch(recoveryFailure);
        });
      } catch {
        closeObservation();
        await send("error", {message: "执行恢复暂未成功，请稍后重新打开此会话。"});
      } finally {
        closeObservation();
      }
      } finally { release(); await host.releaseIdle(sessionId); }
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
    const authorize = createHistoryAuthorizer(backend, new NativeSemanticTaskStore(hosted.session));
    // 失权历史按回合屏蔽；当前输入和真正引用的来源仍分别经过后端权限门禁。
    const admitted = await host.admitPrompt(hosted, input, { actor: user, backend });
    if (!admitted.ok) {
      const status = ["SESSION_BUSY", "LEGACY_QUERY_REQUIRES_NEW_TURN"].includes(admitted.code) ? 409 : 400;
      return c.json({ detail: admitted.message, code: admitted.code }, status);
    }
    const sessionId = hosted.sessionId;
    const operationId = admitted.operationId;
    // 旧 V3 页面把未知事件误当成 tool_end；支持声明避免灰度期间改变旧页面行为。
    const answerStreaming = config.answerStreaming && c.req.header("X-Agent-Answer-Streaming") === "v1";
    // 标题派生自首个问题：原生 setName，列表/详情同源读取
    const currentName = await hosted.session.getName(BACKGROUND_CONTEXT);
    if (input.message && (!currentName || currentName === "问数会话")) {
      await hosted.harness.setName(input.message.slice(0, 24), BACKGROUND_CONTEXT);
    }

    return streamSSE(c, async (stream) => {
      const release = host.retain(sessionId);
      try {
      const timings = admitted.request.timings;
      if (timings) {
        timings.receivedAt = c.get("startedAt");
        timings.reportAtSnapshot = true;
      }
      const streamedCalls = new Set<number>();
      const send = authorizedSender(authorize, async (type, data) =>
      {
        if (store.cluster) await store.cluster.publish(user.id, sessionId, operationId, type,
          { operation_id: operationId, request_id: input.request_id, ...data });
        if (stream.aborted) return;
        await stream.writeSSE({
          event: type,
          data: JSON.stringify({
            protocol_version: 3,
            session_id: sessionId,
            operation_id: operationId,
            request_id: input.request_id,
            ...data,
          }),
        });
        if (timings && timings.firstVisibleAt === undefined && (type === "message_done" && typeof data.text === "string" && data.text.trim() || type === "answer_delta"
          && typeof data.text === "string" && data.text.trim() || type === "snapshot"
          && hasCurrentAnswer(data.messages as ProjectedMessage[]))) timings.firstVisibleAt = performance.now();
        if (type === "answer_reset" || type === "answer_delta" && !streamedCalls.has(Number(data.call_seq))) {
          streamedCalls.add(Number(data.call_seq));
          console.info(JSON.stringify({event: type === "answer_reset" ? "answer_stream_reset" : "answer_stream_started",
            session_id: sessionId, operation_id: operationId, request_id: input.request_id,
            call_seq: data.call_seq, ...(type === "answer_reset" ? {reason: data.reason} : {mode: data.mode})}));
        }
      }, messages => projectQuestionStates(messages, new NativeSemanticTaskStore(hosted.session)));
      const previewReport = createInquiryReportPreview();
      const projector = new AnswerStreamProjector((type, data) => {
        if (store.cluster || !stream.aborted) void send(type, data).catch(() => {});
      }, (body, signal) => previewReport(body, admitted.request, signal),
      (args, ended) => compileInquiryReportDraft(args, admitted.request, ended));

      // 观察与驱动分离：浏览器断线只取消观察，不中止执行
      const watch = await host.watch(hosted);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const closeObservation = () => {
        projector.close();
        clearInterval(heartbeat);
        watch.unsubscribe();
      };
      stream.onAbort(() => { if (store.cluster) clearInterval(heartbeat); else closeObservation(); });
      // 先投影原子快照，再订阅增量事件（原生 watch 的顺序约定）
      await send("accepted", { snapshot: { ...projectSnapshot(watch.snapshot, await storedOperationResults(hosted)),
        answer_stream: answerStreamIdentity(hosted, watch.snapshot.operation?.id, answerStreaming) } }).catch(() => {});
      if (stream.aborted && !store.cluster) closeObservation();
      else watch.start((event) => {
        if (stream.aborted && !store.cluster) return;
        if (event.type === "run_end") projector.close();
        const projected = projectWatchEvent(event);
        if (projected) {
          const answer = streamedToolAnswer(projected);
          if (answer) projector.close();
          void send(projected.type, projected as unknown as Record<string, unknown>).catch(() => {});
          if (answer) void send("message_done", {
            text: answer.text, entry_id: answer.entry_id,
          }).catch(() => {});
        }
        if (answerStreaming) projector.onWatchEvent(event, admitted.request.answerStream);
      });
      // 模型重试与工具执行期间没有原生事件可投影；心跳既避免代理按空闲断连，
      // 也让前端能把“仍在执行”和“卡死”区分开。
      if (!stream.aborted) heartbeat = setInterval(() => {
        void send("progress", { elapsed_ms: Math.round(performance.now() - c.get("startedAt")) }).catch(() => {});
      }, 15_000);
      // “理解问题”阶段没有原生事件：宿主在准备模型上下文时播报读取的话题与指标识别结果。
      const reportActivity: NonNullable<typeof admitted.request.reportActivity> = (activity) => {
        if (store.cluster || !stream.aborted) void send("activity", activity as unknown as Record<string, unknown>).catch(() => {});
      };
      admitted.request.reportActivity = reportActivity;
      try {
        const driven = await host.drivePrompt(hosted, admitted)
          .catch(() => ({ok: false as const, code: "SESSION_CLOSED", message: "会话服务暂时不可用，请稍后查看最终状态。"}))
          .finally(() => projector.close());
        const record = driven.ok && driven.outcome.kind === "settled" ? driven.outcome.outcome : undefined;
        const messages = projectEntries(await hosted.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT), await storedOperationResults(hosted));
        await send("snapshot", { messages, running: false, operation_id: null, answer_stream: null }).catch(() => {});
        await host.recordRequestTiming(hosted, admitted.request).catch(() => {
          console.warn(JSON.stringify({event: "agent_request_timing_failed", request_id: input.request_id}));
        });
        await send("run_terminal", {
          run_status: record?.status ?? (driven.ok ? "unknown" : "failed"),
          answer_status: record?.status === "completed" ? "ok" : "failed",
          // 失败原因透传（如模型网关 402 配额不足），由前端转成通俗提示
          error_code: record?.error?.code ?? null,
          // 错误码无法覆盖所有模型侧失败；带上服务端已脱敏的原因摘要，避免前端只看到“失败了”
          error_message: driven.ok ? null : driven.message,
          business_tasks: projectBusinessTasks(messages),
          timings_ms: { auth_ms: c.get("authMs"), total_ms: Math.round(performance.now() - c.get("startedAt")),
            model_ms: timings?.model_ms, tool_ms: timings?.tool_ms,
            first_visible_ms: timings?.firstVisibleAt === undefined ? null : Math.round(timings.firstVisibleAt - c.get("startedAt")),
            model_first_token_ms: timings?.modelFirstTokenMs },
        }).catch(() => {});
      } finally {
        closeObservation();
        if (admitted.request.reportActivity === reportActivity) delete admitted.request.reportActivity;
      }
      } finally { release(); await host.releaseIdle(sessionId); }
    });
  });

  return app;
}

function activeAnswerStream(hosted: HostedSession, operationId: string | undefined) {
  const request = hosted.activeRequest;
  return !hosted.readOnlyReason && operationId && request?.operationId === operationId
    ? request.answerStream : undefined;
}

function answerStreamIdentity(hosted: HostedSession, operationId: string | undefined, enabled: boolean | undefined) {
  const stream = enabled ? activeAnswerStream(hosted, operationId) : undefined;
  return stream && stream.mode !== "none" ? {call_seq: stream.callSeq, mode: stream.mode} : null;
}

function hasCurrentAnswer(messages: ProjectedMessage[]): boolean {
  if (!Array.isArray(messages)) return false;
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  return messages.slice(start + 1).some(message => message.role === "assistant" && message.text?.trim());
}

/** 实时流复用正式回执的交付入口，避免只识别旧版直出快照而漏掉调查报告。 */
function streamedToolAnswer(projected: NonNullable<ReturnType<typeof projectWatchEvent>>) {
  if (projected.type !== "tool_end") return undefined;
  if (projected.answer) return projected.answer;
  const text = receiptDelivery({ role: "toolResult", toolName: projected.tool,
    isError: projected.isError, details: projected.details });
  return text === undefined ? undefined : { text, entry_id: `live:${projected.tool_call_id}` };
}

/** 解析并校验协议 V3 输入；非法字段整体拒绝，不猜测补齐 */
export function parsePromptInput(body: Record<string, unknown>): PromptInput | null {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
  if (typeof body.message !== "string" || message.length > MESSAGE_MAX_LENGTH || !requestId || requestId.length > 128) return null;
  const input: PromptInput = { protocol_version: 3, request_id: requestId, message };
  const allowed = new Set(["protocol_version", "request_id", "message", "answers", "clarification_target", "selected_answers", "clarification_selection", "time_override"]);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  const hasAnswers = body.answers !== undefined;
  if (hasAnswers && (body.clarification_target !== undefined || body.selected_answers !== undefined || body.clarification_selection !== undefined)) return null;
  if (hasAnswers) {
    if (!Array.isArray(body.answers) || body.answers.length > 20) return null;
    try {
      const answers: ClickAnswerInput[] = body.answers.map(raw => {
        const normalized = normalizeAnswerInput(raw, {channel: "click", operation_id: "http"});
        return {question_id: normalized.question_id, version: normalized.version, choice: normalized.choice};
      });
      if (answers.length) input.answers = answers;
    } catch {
      return null;
    }
  }
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
  const selection = body.clarification_selection;
  if (selection !== undefined) {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) return null;
    const {frame_id: frameId, option_ids: optionIds, ...extra} = selection as Record<string, unknown>;
    if (Object.keys(extra).length || typeof frameId !== "string" || !frameId.trim() || frameId.length > 128
      || !Array.isArray(optionIds) || !optionIds.length || optionIds.length > 20
      || !optionIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 300)) return null;
    input.clarification_selection = {frame_id: frameId, option_ids: [...new Set(optionIds as string[])]};
  }
  // 前端“切换口径”重查：显式时间覆盖，只接受真实日历日期且 start 不晚于 end。
  const timeOverride = body.time_override;
  if (timeOverride !== undefined) {
    if (!timeOverride || typeof timeOverride !== "object" || Array.isArray(timeOverride)) return null;
    const {start, end, ...extra} = timeOverride as Record<string, unknown>;
    if (Object.keys(extra).length || typeof start !== "string" || typeof end !== "string"
      || !isCalendarDate(start) || !isCalendarDate(end) || start > end) return null;
    input.time_override = {start, end};
  }
  if (!message && !input.answers?.length && !input.clarification_selection && !input.selected_answers) return null;
  return input;
}


export class HistoryAuthorizationError extends Error {
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
  tasks: Map<string, string | undefined>;
  scopes: Set<string>;
}

/** 缓存的正文不是授权票据；只复核持久化结果引用/范围，绝不重新执行指标 SQL。 */
export async function authorizeHistory(messages: ProjectedMessage[], backend: BackendClient,
  cache?: HistoryAuthorizationCache, questionReader?: HistoryQuestionReader): Promise<void> {
  const unknown = (): never => {throw new HistoryAuthorizationError("HISTORY_SCOPE_UNAVAILABLE", 409);};
  const sources = historySources(messages.flatMap(message => message.role === "tool" ? [message.details] : []), unknown);
  const {tasks} = sources;
  try {
    const organizationScopes = await resolveHistoryOrganizationScopes(sources, questionReader, unknown);
    // 同轮去重仍核对新出现的 result_id，不能借已经授权的 task_id 掩盖另一份结果引用。
    for (const [taskId, resultId] of tasks) if (cache?.tasks.has(taskId) && resultId
      && cache.tasks.get(taskId) !== resultId) unknown();
    const pendingTasks = [...tasks].filter(([taskId]) => !cache?.tasks.has(taskId));
    const checked = await Promise.all(pendingTasks.map(async ([taskId, resultId]) => {
      const task = await backend.getTask(taskId);
      if (task.task_id !== taskId || task.status !== "SUCCEEDED" || task.result?.task_id && task.result.task_id !== taskId
        || resultId && task.result?.result_id !== resultId) unknown();
      return [taskId, task.result?.result_id] as const;
    }));
    for (const [taskId, resultId] of checked) cache?.tasks.set(taskId, resultId);
    const scopeKey = (codes: string[]) => JSON.stringify([...codes].sort());
    const uniqueScopes = new Map(organizationScopes.map(codes => [scopeKey(codes), codes]));
    const pendingScopes = [...uniqueScopes.values()].filter(codes => !cache?.scopes.has(scopeKey(codes)));
    await Promise.all(pendingScopes.map(async codes => {
      const resolved = await backend.resolveBusinessField("organization", codes);
      if (resolved.status === "temporary_error") throw new HistoryAuthorizationError("HISTORY_AUTHORIZATION_UNAVAILABLE", 503);
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
export function createHistoryAuthorizer(backend: BackendClient, questionReader?: HistoryQuestionReader): (messages: ProjectedMessage[]) => Promise<void> {
  const cache: HistoryAuthorizationCache = { tasks: new Map(), scopes: new Set() };
  return messages => authorizeHistory(messages, backend, cache, questionReader);
}

/** 一条旧证据失权时屏蔽整轮正文及明细，保留问题和稳定消息身份；不修改原生账本。 */
export async function redactInaccessibleHistory(messages: ProjectedMessage[], authorize: (messages: ProjectedMessage[]) => Promise<void>): Promise<ProjectedMessage[]> {
  const turns: ProjectedMessage[][] = [];
  for (const message of messages) {if (message.role === "user" || !turns.length) turns.push([]); turns.at(-1)!.push(message);}
  return (await Promise.all(turns.map(async turn => {
    try {await authorize(turn); return turn;}
    catch (error) {
      if (!(error instanceof HistoryAuthorizationError) || ![403,409].includes(error.status)) throw error;
      return turn.map(message => {
        if (message.role === "assistant") {
          const {error: _error, ...rest} = message;
          return {...rest, text: "此轮历史结果当前不可访问。", tools: [], tool_calls: []};
        }
        return message.role === "tool" ? {...message, details: {status: "denied", error_code: error.code, history_redacted: true}, is_error: true} : message;
      });
    }
  }))).flat();
}

/** 授权与事件发送串行；问题状态在同样的脱敏结果上定向读取，失权题不随快照泄露。 */
function authorizedSender(authorize: (messages: ProjectedMessage[]) => Promise<void>,
  write: (type: string, data: Record<string, unknown>) => Promise<unknown>,
  readQuestionStates?: (messages: ProjectedMessage[]) => ReturnType<typeof projectQuestionStates>) {
  let pending: Promise<unknown> = Promise.resolve();
  return (type: string, data: Record<string, unknown>): Promise<unknown> => {
    pending = pending.then(async () => {
      const snapshot = object(data.snapshot);
      const messages = data.messages ?? snapshot?.messages;
      try {
        if (Array.isArray(messages)) {
          const safe = await redactInaccessibleHistory(messages as ProjectedMessage[], authorize);
          const states = readQuestionStates ? {question_states: await readQuestionStates(safe)} : {};
          data = data.messages ? {...data, messages: safe, ...states} : {...data, snapshot: {...snapshot, messages: safe, ...states}};
        }
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
