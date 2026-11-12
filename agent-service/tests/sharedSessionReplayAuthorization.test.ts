import type { Entry } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendApiError, BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import type { HarnessHost, HostedSession } from "../src/harnessHost.js";
import type { NativeSessionStore } from "../src/nativeSessions.js";
import { createApp } from "../src/routes.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";

const protectedText = "仅旧回合有权查看的业务结果";
const oldEntries: Entry[] = [
  {
    id: "old-question",
    parentId: null,
    seq: 1,
    timestamp: 1,
    type: "message",
    message: { role: "user", content: "原问题", timestamp: 1 },
  },
  {
    id: "old-result",
    parentId: "old-question",
    seq: 2,
    timestamp: 2,
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "read",
      toolName: "metric_read",
      isError: false,
      content: [],
      timestamp: 2,
      details: {
        kind: "metric_read",
        status: "succeeded",
        task_id: "old-task",
        result_id: "old-result",
      },
    },
  },
];

function view(entries: Entry[], operation: string, running: boolean): HostedSession {
  return {
    sessionId: "session-1",
    ownerUserId: TEST_ACTOR.id,
    observer: true,
    open: [],
    session: { scanValues: () => Promise.resolve([]), getValue: () => Promise.resolve(undefined) },
    lane: {
      findEntries: () => Promise.resolve(entries),
      inspectExecution: () =>
        Promise.resolve({
          current: running ? { id: operation } : null,
          lastOperationId: operation,
        }),
    },
  } as unknown as HostedSession;
}

async function replay(
  type: "answer_delta" | "message_done",
  switched: boolean,
  running: boolean,
  denied: boolean,
) {
  vi.spyOn(BackendClient.prototype, "getMe").mockResolvedValue(TEST_ACTOR);
  vi.spyOn(BackendClient.prototype, "getTask").mockImplementation(() => {
    if (denied) return Promise.reject(new BackendApiError(403, "旧结果访问权限已撤销"));
    return Promise.resolve({
      task_id: "old-task",
      status: "SUCCEEDED",
      result: { result_id: "old-result" },
    } as Awaited<ReturnType<BackendClient["getTask"]>>);
  });
  const initial = view(oldEntries, "old-operation", true);
  const entries: Entry[] = switched
    ? [
        ...oldEntries,
        {
          id: "new-question",
          parentId: "old-result",
          seq: 3,
          timestamp: 3,
          type: "message",
          message: { role: "user", content: "新的无数值问题", timestamp: 3 },
        },
      ]
    : oldEntries;
  const latest = view(entries, switched ? "new-operation" : "old-operation", running);
  const releaseView = vi.fn(async () => {});
  const host = {
    retain: () => () => {},
    releaseIdle: async () => {},
    releaseView,
    viewSession: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(latest),
  } as unknown as HarnessHost;
  // 事件读取后会话已进入下一轮，模拟两个独立实例间的真实读取顺序。
  const store = {
    cluster: {
      events: () =>
        Promise.resolve([
          { seq: 1, type, data: { text: protectedText, call_seq: 1, mode: "text" } },
          { seq: 2, type: "run_terminal", data: { run_status: "completed", answer_status: "ok" } },
        ]),
    },
  } as unknown as NativeSessionStore;
  const app = createApp(
    loadConfig({ AGENT_MODEL_API_KEY: "unused", AGENT_ANSWER_STREAMING: "true" }),
    host,
    store,
  );
  const response = await app.request("/sessions/session-1/stream", {
    headers: {
      Authorization: "Bearer isolated",
      "X-Agent-Answer-Streaming": "v1",
    },
  });
  return { text: await response.text(), releaseView, initial, latest };
}

afterEach(() => vi.restoreAllMocks());

describe("共享会话重放只授权事件所属回合", () => {
  for (const type of ["answer_delta", "message_done"] as const) {
    it.each([true, false])(
      `${type}取出后新轮running=%s，不能借新轮证据重放已失权的旧正文`,
      async (running) => {
        const result = await replay(type, true, running, true);
        expect(result.text).toContain("SESSION_OPERATION_CHANGED");
        expect(result.text).not.toContain(protectedText);
        expect(result.releaseView).toHaveBeenCalledWith(result.initial);
        expect(result.releaseView).toHaveBeenCalledWith(result.latest);
      },
    );

    it.each([true, false])(`${type}同轮running=%s仍可重放已授权正文`, async (running) => {
      const result = await replay(type, false, running, false);
      expect(result.text).toContain(protectedText);
      expect(result.text).toContain("event: run_terminal");
      expect(result.text).not.toContain("SESSION_OPERATION_CHANGED");
    });

    it(`${type}同轮重放仍拒绝已撤销的来源权限`, async () => {
      const result = await replay(type, false, false, true);
      expect(result.text).not.toContain(protectedText);
      expect(result.text).toContain("HISTORY_PERMISSION_DENIED");
    });
  }
});
