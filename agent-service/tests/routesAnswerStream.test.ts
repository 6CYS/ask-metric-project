import {
  BACKGROUND_CONTEXT,
  operationResult,
  type Entry,
  type HarnessEvent,
  type LaneSnapshot,
  type OperationResultRecord,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendApiError, BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import type {
  AdmitOutcome,
  DriveOutcomeResult,
  HarnessHost,
  HostedSession,
} from "../src/harnessHost.js";
import type { NativeSessionStore } from "../src/nativeSessions.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import { createApp } from "../src/routes.js";
import { MemoryCommandBridge, TEST_ACTOR, testRequestContext } from "../src/tools/testUtils.js";

const preview = vi.hoisted(() =>
  vi.fn<
    (
      body: string,
      request: AskMetricRequestContext,
      signal: AbortSignal,
    ) => Promise<string | undefined>
  >(),
);
vi.mock("../src/inquiry/reportTool.js", async (original) => ({
  ...(await original<typeof import("../src/inquiry/reportTool.js")>()),
  createInquiryReportPreview: () => preview,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const reportBody = "已取得事实{{e1.v1}}。\n\n";
const planningText = "让我检查当前查询结果，再整理业务结论。";
const message: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: planningText },
    { type: "toolCall", id: "answer-1", name: "analysis_answer", arguments: { body: reportBody } },
  ],
  api: "openai-completions",
  provider: "isolated",
  model: "isolated",
  timestamp: 0,
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
  },
};
const update: HarnessEvent = {
  type: "message_update",
  runId: "op-1",
  lane: "main",
  message,
  event: {
    type: "toolcall_delta",
    contentIndex: 1,
    delta: JSON.stringify({ body: reportBody }),
    partial: message,
  },
};

// 路由使用真实 Hono SSE 与投影器；原生宿主和报告校验是独立边界，不调用模型或业务服务。
function fixture(snapshotAnswer = false) {
  const storedResults: OperationResultRecord[] = [];
  const backend = new BackendClient("https://unused.invalid", "previous-token", 1000);
  const request = testRequestContext(backend, new MemoryCommandBridge(), {
    answerStream: { callSeq: 1, mode: "text" },
  });
  const snapshot = {
    transcript: [],
    operation: {
      id: "op-1",
      kind: "run",
      runningTools: [],
      ...(snapshotAnswer ? { streamingMessage: message } : {}),
    },
  } as unknown as LaneSnapshot;
  let listener: Parameters<WatchHandle<LaneSnapshot>["start"]>[0] | undefined;
  const ready = deferred<void>();
  const unsubscribe = vi.fn();
  const watch: WatchHandle<LaneSnapshot> = {
    snapshot,
    start: (callback) => {
      listener = callback;
      ready.resolve();
    },
    unsubscribe,
    resnapshot: () => Promise.resolve(snapshot),
  };
  const hosted = {
    sessionId: "session-1",
    ownerUserId: TEST_ACTOR.id,
    activeRequest: request,
    open: [],
    session: {
      getName: () => Promise.resolve("已有会话"),
      scanValues: () => Promise.resolve(storedResults.map((value, seq) => ({
        address: operationResult(value.operationId), value, seq,
      }))),
    },
    lane: {
      findEntries: () => Promise.resolve(snapshot.transcript),
      inspectExecution: () => Promise.resolve({ current: snapshot.operation }),
    },
  } as unknown as HostedSession;
  const admitted: Extract<AdmitOutcome, { ok: true }> = {
    ok: true,
    operationId: "op-1",
    request,
    context: BACKGROUND_CONTEXT,
  };
  const drive = deferred<DriveOutcomeResult>();
  const admitPrompt = vi.fn(() => Promise.resolve(admitted));
  const drivePrompt = vi.fn(() => drive.promise);
  const resumeOpenOperations = vi.fn(() => Promise.resolve(0));
  const abort = vi.fn(() => Promise.resolve());
  const host = {
    openSession: () => Promise.resolve(hosted),
    watch: () => Promise.resolve(watch),
    admitPrompt,
    drivePrompt,
    resumeOpenOperations,
    abort,
    recordRequestTiming: () => Promise.resolve(),
  } as unknown as HarnessHost;
  const config = loadConfig({
    AGENT_MODEL_API_KEY: "unused",
    AGENT_MODEL_BASE_URL: "https://unused.invalid",
    AGENT_MODEL_NAME: "isolated",
    AGENT_ANSWER_STREAMING: "true",
  });
  const app = createApp(config, host, {} as NativeSessionStore);
  const emit = async (event: HarnessEvent) => {
    await ready.promise;
    await listener?.(event, BACKGROUND_CONTEXT);
  };
  const finish = async () => {
    drive.resolve({ ok: false, code: "SESSION_CLOSED", message: "隔离测试完成" });
    await emit({
      type: "run_end",
      lane: "main",
      runId: "op-1",
      status: "completed",
      fromTipId: null,
      tipId: null,
      endedAt: 0,
    });
  };
  const open = (method: "GET" | "POST", declared = true) =>
    app.request(`/sessions/session-1/${method === "GET" ? "stream" : "prompt"}`, {
      method,
      headers: {
        Authorization: "Bearer current-token",
        "Content-Type": "application/json",
        ...(declared ? { "X-Agent-Answer-Streaming": "v1" } : {}),
      },
      ...(method === "POST"
        ? {
            body: JSON.stringify({ protocol_version: 3, request_id: "req-1", message: "查询指标" }),
          }
        : {}),
    });
  const detail = () =>
    app.request("/sessions/session-1", {
      headers: { Authorization: "Bearer current-token" },
    });
  return {
    snapshot,
    storedResults,
    request,
    hosted,
    unsubscribe,
    admitPrompt,
    drivePrompt,
    abort,
    emit,
    finish,
    open,
    detail,
  };
}

function snapshots(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n").flatMap((frame) => {
    if (!frame.startsWith("event: snapshot\n")) return [];
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    return data ? [JSON.parse(data.slice(6)) as Record<string, unknown>] : [];
  });
}

const backendTokens: Array<string | null> = [];
beforeEach(() => {
  backendTokens.length = 0;
  vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!address.endsWith("/api/v1/auth/me")) throw new Error("隔离路由测试不能访问业务接口");
    backendTokens.push(new Headers(init?.headers).get("Authorization"));
    return Promise.resolve(Response.json(TEST_ACTOR));
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  preview.mockReset();
  preview.mockResolvedValue("已核验的公开正文。\n\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("正文 SSE 的观察边界", () => {
  it.each(["model", "tool"] as const)("%s阶段停止后，详情刷新与只读重连均保留停止且不重新执行", async phase => {
    const test = fixture();
    const entries: Entry[] = [{id: "question", parentId: null, seq: 1, timestamp: 1, type: "message",
      message: {role: "user", content: "查看存款", timestamp: 1}}];
    if (phase === "tool") entries.push(
      {id: "calling", parentId: "question", seq: 2, timestamp: 2, type: "message", message: {
        ...message, content: [{type: "toolCall", id: "query", name: "metric_search", arguments: {keywords: ["存款"]}}],
      }},
      {id: "interrupted", parentId: "calling", seq: 3, timestamp: 3, type: "message", message: {
        role: "toolResult", toolCallId: "query", toolName: "metric_search", isError: true, timestamp: 3,
        content: [{type: "text", text: "Abort requested"}],
      }},
    );
    test.snapshot.transcript = entries;
    test.snapshot.operation = null;
    test.storedResults.push({operationId: "op-1", kind: "run", status: "aborted", fromTipId: null,
      tipId: phase === "tool" ? "interrupted" : "question", startedAt: 1, endedAt: 4});
    const detail = await (await test.detail()).json() as {messages: unknown[]};
    expect(detail.messages.at(-1)).toMatchObject({role: "assistant", text: "已停止生成。"});
    const states = snapshots(await (await test.open("GET")).text());
    expect(states[0]?.messages).toEqual(detail.messages);
    expect(states[0]).toMatchObject({running: false, answer_stream: null});
    expect(test.admitPrompt).not.toHaveBeenCalled();
    expect(test.drivePrompt).not.toHaveBeenCalled();
  });

  it("详情与重连快照提供同一活动正文身份，即使工具已开始而原生快照不再含正文", async () => {
    const test = fixture();
    expect(await (await test.detail()).json()).toMatchObject({
      operation_id: "op-1",
      answer_stream: { call_seq: 1, mode: "text" },
    });
    const response = await test.open("GET");
    const body = response.text();
    await test.finish();
    const states = snapshots(await body);
    expect(states[0]).toMatchObject({
      operation_id: "op-1",
      answer_stream: { call_seq: 1, mode: "text" },
    });
    expect(states.at(-1)).toMatchObject({ operation_id: null, answer_stream: null });
    expect(preview).not.toHaveBeenCalled();
  });

  it.each(["invalidated", "other-operation", "no-request"] as const)(
    "%s 不能让快照保留旧正文预览",
    async (state) => {
      const test = fixture(true);
      if (state === "invalidated") test.request.answerStream = { callSeq: 1, mode: "none" };
      if (state === "other-operation") test.request.operationId = "other-operation";
      if (state === "no-request") delete test.hosted.activeRequest;
      expect(await (await test.detail()).json()).toMatchObject({ answer_stream: null });
      const response = await test.open("GET");
      const body = response.text();
      await test.emit(update);
      await test.finish();
      expect(snapshots(await body)[0]).toMatchObject({ answer_stream: null });
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it("GET 仅从在途报告正文恢复预览，使用当前认证客户端且不接纳或重新驱动", async () => {
    const test = fixture(true);
    preview.mockImplementation(async (_body, request, signal) => {
      await request.backend.getMe({ signal });
      return "已核验的公开正文。\n\n";
    });
    const response = await test.open("GET");
    const body = response.text();
    try {
      await vi.waitFor(() => expect(preview).toHaveBeenCalled(), { timeout: 1000 });
      expect(preview.mock.calls[0]?.[0]).toBe("已取得事实{{e1.v1}}。");
      expect(preview.mock.calls[0]?.[0]).not.toContain(planningText);
      const projectedRequest = preview.mock.calls[0]?.[1];
      expect(projectedRequest?.backend).not.toBe(test.request.backend);
      expect(projectedRequest?.operationId).toBe("op-1");
      expect(projectedRequest?.actor).toEqual(TEST_ACTOR);
      expect(backendTokens).toEqual(["Bearer current-token", "Bearer current-token"]);
      expect(test.admitPrompt).not.toHaveBeenCalled();
      expect(test.drivePrompt).not.toHaveBeenCalled();
    } finally {
      await test.finish();
    }
    const text = await body;
    expect(text).toContain("event: answer_delta");
    expect(text).toContain("已核验的公开正文");
    expect(text).not.toContain("{{e1.v1}}");
    expect(text).not.toContain(planningText);
    expect(text).toContain("event: run_terminal");
  });

  it("未声明流式正文能力的 GET 不发送预览", async () => {
    const test = fixture(true);
    const response = await test.open("GET", false);
    const body = response.text();
    await test.emit(update);
    await test.finish();
    expect(preview).not.toHaveBeenCalled();
    expect(await body).not.toContain("event: answer_delta");
  });

  it("正式正文到达后关闭预览，迟到的校验结果不能插入正式交付", async () => {
    const test = fixture();
    const late = deferred<string | undefined>();
    preview.mockImplementation(() => late.promise);
    const response = await test.open("POST");
    const body = response.text();
    try {
      await vi.waitFor(() => expect(test.drivePrompt).toHaveBeenCalled());
      await test.emit(update);
      await vi.waitFor(() => expect(preview).toHaveBeenCalled(), { timeout: 1000 });
      await test.emit({
        type: "tool_end",
        lane: "main",
        runId: "op-1",
        turnId: "turn-1",
        toolCallId: "answer-1",
        toolName: "analysis_answer",
        isError: false,
        terminate: true,
        result: {
          content: [{ type: "text", text: "正式正文" }],
          details: {
            kind: "conversation_reply",
            status: "answered",
            answer: "正式正文",
            history_sources: { tasks: [], organizationScopes: [] },
          },
        },
      });
      expect(preview.mock.calls[0]?.[2].aborted).toBe(true);
      late.resolve("迟到预览");
    } finally {
      late.resolve(undefined);
      await test.finish();
    }
    const text = await body;
    expect(text).toContain("event: message_done");
    expect(text).toContain("正式正文");
    expect(text).not.toContain("迟到预览");
  });

  it("POST 断开只取消观察与在途预览，不取消已接纳的驱动", async () => {
    const test = fixture();
    const late = deferred<string | undefined>();
    preview.mockImplementation(() => late.promise);
    const response = await test.open("POST");
    const reader = response.body!.getReader();
    try {
      await reader.read();
      await vi.waitFor(() => expect(test.drivePrompt).toHaveBeenCalled());
      await test.emit(update);
      await vi.waitFor(() => expect(preview).toHaveBeenCalled(), { timeout: 1000 });
      await reader.cancel();
      await vi.waitFor(() => expect(test.unsubscribe).toHaveBeenCalled());
      expect(preview.mock.calls[0]?.[2].aborted).toBe(true);
      expect(test.abort).not.toHaveBeenCalled();
      expect(test.drivePrompt).toHaveBeenCalledTimes(1);
    } finally {
      late.resolve(undefined);
      await test.finish();
      await reader.cancel();
    }
  });

  it("正式回执先复核来源权限，失败后不发送 message_done 正文", async () => {
    vi.spyOn(BackendClient.prototype, "resolveBusinessField").mockRejectedValue(
      new BackendApiError(403, "当前身份无权访问", "FORBIDDEN"),
    );
    const test = fixture();
    const response = await test.open("POST");
    const body = response.text();
    await test.emit({
      type: "tool_end",
      lane: "main",
      runId: "op-1",
      turnId: "turn-1",
      toolCallId: "answer-1",
      toolName: "conversation_reply",
      isError: false,
      terminate: true,
      result: {
        content: [],
        details: {
          kind: "conversation_reply",
          status: "answered",
          answer: "不可泄露的正文",
          history_sources: { tasks: [], organizationScopes: [["denied-org"]] },
        },
      },
    });
    await test.finish();
    const text = await body;
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_done");
    expect(text).not.toContain("不可泄露的正文");
  });
});
