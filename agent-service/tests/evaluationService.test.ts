import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendUser } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { EvaluationService } from "../src/evaluation/service.js";
import { createSessionEvaluationClient } from "../src/evaluation/sessionClient.js";
import { EvaluationError, EvaluationStore } from "../src/evaluation/store.js";
import type {
  EvaluationRequest,
  ExecutionResult,
  SessionEvaluationClient,
} from "../src/evaluation/types.js";

const user: BackendUser = {
  id: "a",
  username: "alice",
  display_name: "甲",
  org_code: "100",
  org_name: "机构",
  role_code: "user",
};
const config = () =>
  loadConfig({
    AGENT_MODEL_API_KEY: "isolated-secret",
    AGENT_MODEL_BASE_URL: "https://unused.invalid",
    AGENT_MODEL_NAME: "isolated-model",
  });
const datasetInput = {
  name: "隔离问题集",
  description: "",
  groups: [
    {
      id: "g1",
      name: "组一",
      turns: [
        { id: "q1", question: "第一问", expected: "期望一" },
        { id: "q2", question: "继续追问", expected: "" },
      ],
    },
    { id: "g2", name: "组二", turns: [{ id: "q3", question: "另一组", expected: "" }] },
  ],
};
const success: ExecutionResult = {
  status: "completed",
  run_status: "succeeded",
  user_entry_id: "entry",
  operation_id: "operation",
  answer_status: "answered",
  error_code: null,
  error_message: null,
  timings_ms: { total: 3 },
};

function boundary(onExecute?: SessionEvaluationClient["executeTurn"]): SessionEvaluationClient {
  let sequence = 0;
  return {
    createSession: () => Promise.resolve(`session-${++sequence}`),
    executeTurn: onExecute ?? (() => Promise.resolve(success)),
    readTurn: () => Promise.resolve([]),
    cancelTurn: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
  };
}

describe("EvaluationService", () => {
  let root: string;
  let store: EvaluationStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evaluation-service-"));
    store = new EvaluationStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function input() {
    const dataset = store.createDataset(user.id, datasetInput);
    return {
      dataset_id: dataset.id,
      dataset_version: 1,
      name: "第一批",
      version_label: "隔离代码",
      data_label: "隔离协议样本",
    };
  }

  it("runs group turns serially with a fresh session per group and freezes input", async () => {
    const service = new EvaluationService(store, boundary(), config());
    const request = input();
    const run = service.startRun(user, "current-token", request);
    store.updateDataset(user.id, request.dataset_id, 1, { ...datasetInput, name: "已修改问题集" });
    await service.waitForIdle();
    const saved = service.getRun(user.id, run.id);
    expect(saved.status).toBe("completed");
    expect(saved.turns.map((turn) => turn.session_id)).toEqual([
      "session-1",
      "session-1",
      "session-2",
    ]);
    expect(saved.turns.map((turn) => turn.status)).toEqual(["completed", "completed", "completed"]);
    expect(saved.turns.every((turn) => turn.review === null)).toBe(true);
    expect(saved.dataset.name).toBe("隔离问题集");
    expect(saved.dataset.version).toBe(1);
    expect(saved.dataset_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(service.listSessionIds(user.id)).toEqual(["session-1", "session-2"]);
    const owner = readdirSync(join(root, "evaluation-v1"))[0];
    const runsDir = join(root, "evaluation-v1", String(owner), "runs");
    const raw = readdirSync(runsDir)
      .map((file) => readFileSync(join(runsDir, file), "utf8"))
      .join("");
    expect(raw).not.toContain("current-token");
    expect(raw).not.toContain("isolated-secret");
  });

  it("never reuses old answers for a new run with the same dataset", async () => {
    const service = new EvaluationService(store, boundary(), config());
    const request = input();
    const first = service.startRun(user, "token", request);
    await service.waitForIdle();
    const second = service.startRun(user, "token", request);
    await service.waitForIdle();
    expect(second.id).not.toBe(first.id);
    expect(service.getRun(user.id, second.id).turns[0]?.session_id).toBe("session-3");
  });

  it("keeps a maximum-size accepted dataset readable after freezing and manual review", async () => {
    const largeInput = {
      name: "容量回归",
      description: "",
      groups: [
        {
          id: "g1",
          name: "组",
          turns: Array.from({ length: 100 }, (_, index) => ({
            id: `q${index}`,
            question: "问题".repeat(5),
            expected: "期".repeat(6_950),
          })),
        },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(largeInput))).toBeLessThanOrEqual(2 * 1024 * 1024);
    const service = new EvaluationService(
      store,
      boundary(() => Promise.resolve({ ...success, status: "failed" })),
      config(),
    );
    const dataset = service.createDataset(user.id, largeInput);
    const run = service.startRun(user, "token", {
      dataset_id: dataset.id,
      dataset_version: 1,
      name: "容量批次",
      version_label: "v1",
      data_label: "隔离协议样本",
    });
    await service.waitForIdle();
    expect(Buffer.byteLength(JSON.stringify(service.getRun(user.id, run.id)))).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    service.reviewTurn(user, run.id, "q0", { verdict: "needs_review", note: "查".repeat(4_000) });
    const reopened = new EvaluationStore(root).getRun(user.id, run.id);
    expect(reopened.turns).toHaveLength(100);
    expect(reopened.turns[0]?.review?.note).toHaveLength(4_000);
    expect(service.listSessionIds(user.id)).toEqual(["session-1"]);
    const first = reopened.turns[0];
    if (!first) throw new Error("缺少容量回归轮次");
    first.result = { ...success, error_message: "超".repeat(3_000_000) };
    expect(() => store.saveRun(user.id, reopened)).toThrow("存储容量");
    expect(store.getRun(user.id, run.id).turns[0]?.review?.note).toHaveLength(4_000);
  }, 15_000);

  it("loads historical session identities once per owner and tracks new sessions in memory", async () => {
    const service = new EvaluationService(store, boundary(), config());
    const request = input();
    service.startRun(user, "token", request);
    await service.waitForIdle();
    const reads = vi.spyOn(store, "listRuns");
    expect(service.listSessionIds(user.id)).toEqual(["session-1", "session-2"]);
    service.startRun(user, "token", request);
    await service.waitForIdle();
    expect(new Set(service.listSessionIds(user.id))).toEqual(
      new Set(["session-1", "session-2", "session-3", "session-4"]),
    );
    expect(service.listSessionIds("other-user")).toEqual([]);
    expect(service.listSessionIds(user.id)).toHaveLength(4);
    expect(reads.mock.calls.map(([owner]) => owner)).toEqual([user.id, "other-user"]);
    const restarted = new EvaluationService(new EvaluationStore(root), boundary(), config());
    expect(new Set(restarted.listSessionIds(user.id))).toEqual(
      new Set(["session-1", "session-2", "session-3", "session-4"]),
    );
  });

  it("skips dependent turns after a failure and continues the next group", async () => {
    let index = 0;
    const service = new EvaluationService(
      store,
      boundary(() =>
        Promise.resolve(
          ++index === 1
            ? { ...success, status: "failed", error_code: "EXECUTION_FAILED" }
            : success,
        ),
      ),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await service.waitForIdle();
    expect(service.getRun(user.id, run.id).turns.map((turn) => turn.status)).toEqual([
      "failed",
      "skipped",
      "completed",
    ]);
    expect(service.getRun(user.id, run.id).status).toBe("completed");
  });

  it("stops all groups when authentication fails", async () => {
    const service = new EvaluationService(
      store,
      boundary(() =>
        Promise.reject(new BackendApiError(401, "expired token must not be persisted")),
      ),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await service.waitForIdle();
    const saved = service.getRun(user.id, run.id);
    expect(saved.status).toBe("failed");
    expect(saved.turns.map((turn) => turn.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(saved.turns[0]?.result?.error_code).toBe("AUTHENTICATION_FAILED");
    expect(JSON.stringify(saved)).not.toContain("expired token");
  });

  it("stops later groups on the existing inquiry permission terminal", async () => {
    const service = new EvaluationService(
      store,
      boundary(() =>
        Promise.resolve({
          ...success,
          status: "failed",
          error_code: "INQUIRY_FORBIDDEN",
        }),
      ),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await service.waitForIdle();
    expect(service.getRun(user.id, run.id).turns.map((turn) => turn.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
    expect(service.getRun(user.id, run.id).status).toBe("failed");
  });

  it("preserves accepted identities and authorized detail after interruption", async () => {
    let release: ((result: ExecutionResult) => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = boundary((turn) => {
      turn.onIdentity?.({ operation_id: "accepted-operation", user_entry_id: "accepted-user" });
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        release = resolve;
      });
    });
    client.readTurn = (token, sessionId, entryId) =>
      Promise.resolve([
        { role: "user", entry_id: entryId, text: `${token}:${sessionId}`, timestamp: 1 },
      ]);
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "original-token", input());
    await ready;
    try {
      expect(store.getRun(user.id, run.id).turns[0]?.result?.status).toBe("running");
      store.recoverInterruptedRuns();
      const detail = await service.turnDetail(user.id, "fresh-token", run.id, "q1");
      expect(detail.turn.result).toMatchObject({
        operation_id: "accepted-operation",
        user_entry_id: "accepted-user",
        error_code: "EVALUATION_INTERRUPTED",
      });
      expect(detail.messages).toMatchObject([
        { entry_id: "accepted-user", text: "fresh-token:session-1" },
      ]);
    } finally {
      client.executeTurn = () => Promise.resolve(success);
      release?.(success);
      await service.waitForIdle();
    }
  });

  it("retains the execution slot until a current-token cancellation retry is confirmed", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = boundary((turn) => {
      turn.onIdentity?.({ operation_id: "accepted-operation", user_entry_id: "accepted-user" });
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve({ ...success, status: "cancelled" }));
      });
    });
    let cancellationConfirmed = false;
    client.cancelTurn = (token) =>
      cancellationConfirmed && token === "fresh-token"
        ? Promise.resolve()
        : Promise.reject(new BackendApiError(503, "unconfirmed", "EVALUATION_CANCEL_UNCONFIRMED"));
    const service = new EvaluationService(store, client, config());
    const request = input();
    const run = service.startRun(user, "initial-token", request);
    await ready;
    try {
      await expect(service.cancelRun(user.id, "initial-token", run.id)).rejects.toMatchObject({
        status: 503,
      });
      await service.waitForIdle();
      expect(service.getRun(user.id, run.id).status).toBe("cancelling");
      expect(() => service.startRun(user, "fresh-token", request)).toThrow("测评批次");
      cancellationConfirmed = true;
      await service.cancelRun(user.id, "fresh-token", run.id);
      const saved = service.getRun(user.id, run.id);
      expect(saved.status).toBe("cancelled");
      expect(saved.turns[0]).toMatchObject({
        status: "cancelled",
        result: {
          status: "cancelled",
          user_entry_id: "entry",
          operation_id: "operation",
          error_code: "EVALUATION_CANCELLED",
        },
      });
      client.executeTurn = () => Promise.resolve(success);
      expect(service.startRun(user, "fresh-token", request).id).not.toBe(run.id);
    } finally {
      cancellationConfirmed = true;
      await service.cancelRun(user.id, "fresh-token", run.id).catch(() => undefined);
      await service.waitForIdle();
    }
  });

  it("shares one current-token cancellation between the coordinator and the actual stream client", async () => {
    let requestId = "";
    const cancellationTokens: string[] = [];
    const request: EvaluationRequest = (path, init) => {
      if (path === "/sessions") return Promise.resolve(Response.json({ session_id: "session-1" }));
      if (path.endsWith("/prompt")) {
        if (typeof init?.body !== "string") throw new Error("缺少请求体");
        const body = JSON.parse(init.body) as { request_id: string };
        requestId = body.request_id;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: accepted\ndata: ${JSON.stringify({
                      session_id: "session-1",
                      request_id: requestId,
                      operation_id: "accepted-operation",
                      snapshot: {
                        running: true,
                        messages: [
                          { role: "user", entry_id: "accepted-user", text: "第一问", timestamp: 1 },
                        ],
                      },
                    })}\n\n`,
                  ),
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      }
      if (path.endsWith("/cancel")) {
        cancellationTokens.push(new Headers(init?.headers).get("Authorization") ?? "");
        if (typeof init?.body !== "string") throw new Error("缺少请求体");
        expect(JSON.parse(init.body)).toEqual({ request_id: requestId });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(Response.json({ running: false, messages: [] }));
    };
    const client = createSessionEvaluationClient(request);
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "original-token", input());
    await vi.waitFor(() =>
      expect(service.getRun(user.id, run.id).turns[0]?.result?.operation_id).toBe(
        "accepted-operation",
      ),
    );
    await Promise.all([
      service.cancelRun(user.id, "fresh-token", run.id),
      service.cancelRun(user.id, "fresh-token", run.id),
    ]);
    await service.waitForIdle();
    expect(cancellationTokens).toEqual(["Bearer fresh-token"]);
    expect(service.getRun(user.id, run.id)).toMatchObject({
      status: "cancelled",
      turns: [
        {
          status: "cancelled",
          result: {
            status: "cancelled",
            operation_id: "accepted-operation",
            user_entry_id: "accepted-user",
          },
        },
        { status: "skipped" },
        { status: "skipped" },
      ],
    });
  });

  it("still confirms a retained cancellation during a storage outage and reports unavailable results", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = boundary((turn) => {
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve({ ...success, status: "cancelled" }));
      });
    });
    client.cancelTurn = () =>
      Promise.reject(new BackendApiError(503, "not stopped", "EVALUATION_CANCEL_UNCONFIRMED"));
    const service = new EvaluationService(store, client, config());
    const request = input();
    const run = service.startRun(user, "original-token", request);
    await ready;
    await expect(service.cancelRun(user.id, "original-token", run.id)).rejects.toMatchObject({
      status: 503,
    });
    await service.waitForIdle();
    let confirmedToken = "";
    client.cancelTurn = (token) => {
      confirmedToken = token;
      return Promise.resolve();
    };
    const read = vi.spyOn(store, "getRun").mockImplementation(() => {
      throw new EvaluationError(503, "EVALUATION_STORAGE_UNAVAILABLE", "读取失败");
    });
    const write = vi.spyOn(store, "saveRun").mockImplementation(() => {
      throw new EvaluationError(503, "EVALUATION_STORAGE_UNAVAILABLE", "写入失败");
    });
    try {
      await expect(service.cancelRun(user.id, "fresh-token", run.id)).rejects.toMatchObject({
        status: 503,
      });
      expect(confirmedToken).toBe("fresh-token");
      read.mockRestore();
      write.mockRestore();
      expect(() => service.getRun(user.id, run.id)).toThrow("持久化失败");
      client.executeTurn = () => Promise.resolve(success);
      expect(service.startRun(user, "fresh-token", request).id).not.toBe(run.id);
    } finally {
      read.mockRestore();
      write.mockRestore();
      await service.cancelRun(user.id, "fresh-token", run.id).catch(() => undefined);
      await service.waitForIdle();
    }
  });

  it("holds the service-wide lock until actual cancellation completes", async () => {
    let finish: ((value: ExecutionResult) => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = "";
    const client = boundary((turn) => {
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        finish = resolve;
        turn.signal.addEventListener("abort", () => {
          cancelled += "aborted";
        });
      });
    });
    client.cancelTurn = (token, session, request) => {
      cancelled += `${token}:${session}:${request}`;
      return Promise.resolve();
    };
    const service = new EvaluationService(store, client, config());
    const request = input();
    const run = service.startRun(user, "token", request);
    await ready;
    expect(() =>
      new EvaluationService(store, boundary(), config()).startRun(user, "token", request),
    ).toThrow("测评批次");
    await service.cancelRun(user.id, "token", run.id);
    expect(service.getRun(user.id, run.id).status).toBe("cancelling");
    expect(cancelled).toContain("token:session-1:");
    expect(cancelled).toContain("aborted");
    expect(() => service.startRun(user, "token", request)).toThrow("测评批次");
    finish?.({ ...success, status: "cancelled" });
    await service.waitForIdle();
    expect(service.getRun(user.id, run.id).status).toBe("cancelled");
    expect(service.getRun(user.id, run.id).turns.map((turn) => turn.status)).toEqual([
      "cancelled",
      "skipped",
      "skipped",
    ]);
  });

  it("still cancels execution when persisting the cancelling status fails once", async () => {
    let started: (() => void) | undefined;
    let finish: ((result: ExecutionResult) => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelRequested = false;
    const client = boundary((turn) => {
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        finish = resolve;
        turn.signal.addEventListener("abort", () => resolve({ ...success, status: "cancelled" }));
      });
    });
    client.cancelTurn = () => {
      cancelRequested = true;
      return Promise.resolve();
    };
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "token", input());
    await ready;
    vi.spyOn(store, "saveRun").mockImplementationOnce(() => {
      throw new EvaluationError(503, "EVALUATION_STORAGE_UNAVAILABLE", "测评存储暂不可用");
    });
    await expect(service.cancelRun(user.id, "token", run.id)).rejects.toMatchObject({
      status: 503,
    });
    const cancellationWasRequested = cancelRequested;
    // 旧实现没有发出取消时也释放隔离边界，确保回归失败不会泄漏全局执行槽。
    client.executeTurn = () => Promise.resolve(success);
    finish?.(success);
    await service.waitForIdle();
    expect(cancellationWasRequested).toBe(true);
    expect(service.getRun(user.id, run.id).status).toBe("cancelled");
    expect(service.getRun(user.id, run.id).turns.map((turn) => turn.status)).toEqual([
      "cancelled",
      "skipped",
      "skipped",
    ]);
  });

  it("restores unfinished runs as interrupted without calling any session", async () => {
    const service = new EvaluationService(store, boundary(), config());
    const run = service.startRun(user, "token", input());
    await service.waitForIdle();
    const saved = service.getRun(user.id, run.id);
    store.saveRun(user.id, {
      ...saved,
      status: "running",
      finished_at: null,
      turns: saved.turns.map((turn, index) => ({
        ...turn,
        status: index === 0 ? "running" : "pending",
        result: null,
      })),
    });
    const restored = new EvaluationService(
      new EvaluationStore(root),
      boundary(() => Promise.reject(new Error("must not execute"))),
      config(),
    );
    expect(restored.getRun(user.id, run.id).status).toBe("interrupted");
    expect(restored.getRun(user.id, run.id).turns.map((turn) => turn.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
  });

  it("authorizes turn detail with the current token and only reviews terminal turns", async () => {
    let detailIdentity = "";
    const client = boundary();
    client.readTurn = (token, session, entry) => {
      detailIdentity = `${token}:${session}:${entry}`;
      return Promise.reject(new BackendApiError(403, "revoked"));
    };
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "original-token", input());
    expect(() => service.reviewTurn(user, run.id, "q1", { verdict: "passed", note: "" })).toThrow();
    await service.waitForIdle();
    await expect(service.turnDetail(user.id, "fresh-token", run.id, "q1")).rejects.toThrow(
      "revoked",
    );
    expect(detailIdentity).toBe("fresh-token:session-1:entry");
    const reviewed = service.reviewTurn(user, run.id, "q1", {
      verdict: "needs_review",
      note: "核对来源",
    });
    expect(reviewed.review?.verdict).toBe("needs_review");
    expect(service.getRun(user.id, run.id).status).toBe("completed");
    expect(() => service.getRun("other-user", run.id)).toThrow();
    expect(() =>
      service.reviewTurn({ ...user, id: "other-user" }, run.id, "q1", {
        verdict: "passed",
        note: "",
      }),
    ).toThrow();
  });

  it("does not send a question when cancellation arrives during session creation", async () => {
    let release: ((value: string) => void) | undefined;
    let started: (() => void) | undefined;
    const creating = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = boundary(() => Promise.reject(new Error("must not send a question")));
    client.createSession = () => {
      started?.();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "token", input());
    await creating;
    await service.cancelRun(user.id, "token", run.id);
    release?.("created-before-stop");
    await service.waitForIdle();
    const saved = service.getRun(user.id, run.id);
    expect(saved.status).toBe("cancelled");
    expect(saved.turns.every((turn) => turn.started_at === null)).toBe(true);
    expect(service.listSessionIds(user.id)).toContain("created-before-stop");
  });

  it("shuts down its active batch using the in-memory token and waits for cancellation", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancellationToken = "";
    const client = boundary((turn) => {
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve({ ...success, status: "cancelled" }));
      });
    });
    client.cancelTurn = (token) => {
      cancellationToken = token;
      return Promise.resolve();
    };
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "in-memory-token", input());
    await ready;
    await service.shutdown();
    expect(cancellationToken).toBe("in-memory-token");
    expect(service.getRun(user.id, run.id).status).toBe("cancelled");
    await service.shutdown();
  });

  it("stops the entire batch when real cancellation cannot be confirmed", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = boundary((turn) => {
      started?.();
      return new Promise<ExecutionResult>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve({ ...success, status: "cancelled" }));
      });
    });
    client.cancelTurn = () =>
      Promise.reject(
        new BackendApiError(503, "secret internal message", "EVALUATION_CANCEL_UNCONFIRMED"),
      );
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "token", input());
    await ready;
    await expect(service.cancelRun(user.id, "token", run.id)).rejects.toThrow();
    await service.waitForIdle();
    const saved = service.getRun(user.id, run.id);
    try {
      expect(saved.status).toBe("cancelling");
      expect(saved.turns.map((turn) => turn.status)).toEqual(["failed", "skipped", "skipped"]);
      expect(saved.turns[0]?.result?.error_code).toBe("EVALUATION_CANCEL_UNCONFIRMED");
      expect(JSON.stringify(saved)).not.toContain("secret internal");
    } finally {
      client.cancelTurn = () => Promise.resolve();
      await service.cancelRun(user.id, "fresh-token", run.id);
    }
  });

  it("treats authentication failure in a terminal result as a batch failure", async () => {
    const service = new EvaluationService(
      store,
      boundary(() =>
        Promise.resolve({ ...success, status: "failed", error_code: "AUTHENTICATION_REQUIRED" }),
      ),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await service.waitForIdle();
    expect(service.getRun(user.id, run.id).status).toBe("failed");
    expect(service.getRun(user.id, run.id).turns.map((turn) => turn.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
  });

  it("does not start another group when execution cleanup reports unconfirmed cancellation", async () => {
    const service = new EvaluationService(
      store,
      boundary(() =>
        Promise.reject(
          new BackendApiError(503, "sensitive transport details", "EVALUATION_CANCEL_UNCONFIRMED"),
        ),
      ),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await service.waitForIdle();
    const saved = service.getRun(user.id, run.id);
    try {
      expect(saved.status).toBe("cancelling");
      expect(saved.turns.map((turn) => turn.status)).toEqual(["failed", "skipped", "skipped"]);
      expect(saved.turns[0]?.result?.error_code).toBe("EVALUATION_CANCEL_UNCONFIRMED");
      expect(JSON.stringify(saved)).not.toContain("sensitive transport");
    } finally {
      await service.cancelRun(user.id, "fresh-token", run.id);
    }
  });

  it("does not erase cleanup uncertainty merely because the local signal was aborted", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new EvaluationService(
      store,
      boundary((turn) => {
        started?.();
        return new Promise<ExecutionResult>((_resolve, reject) => {
          turn.signal.addEventListener("abort", () =>
            reject(new BackendApiError(503, "internal details", "EVALUATION_CANCEL_UNCONFIRMED")),
          );
        });
      }),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await ready;
    await expect(service.cancelRun(user.id, "token", run.id)).rejects.toMatchObject({
      code: "EVALUATION_CANCEL_UNCONFIRMED",
    });
    await service.waitForIdle();
    try {
      expect(service.getRun(user.id, run.id).status).toBe("cancelling");
      expect(service.getRun(user.id, run.id).turns[0]?.result?.error_code).toBe(
        "EVALUATION_CANCEL_UNCONFIRMED",
      );
    } finally {
      await service.cancelRun(user.id, "fresh-token", run.id);
    }
  });

  it("rejects stale run inputs without creating a batch", () => {
    const service = new EvaluationService(store, boundary(), config());
    const request = input();
    store.updateDataset(user.id, request.dataset_id, 1, datasetInput);
    expect(() => service.startRun(user, "token", request)).toThrow("版本已变化");
    expect(service.listRuns(user.id)).toEqual([]);
  });

  it("keeps a review saved while later turns are still running", async () => {
    let release: ((value: ExecutionResult) => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new EvaluationService(
      store,
      boundary((turn) => {
        if (turn.question !== "继续追问") return Promise.resolve(success);
        started?.();
        return new Promise<ExecutionResult>((resolve) => {
          release = resolve;
        });
      }),
      config(),
    );
    const run = service.startRun(user, "token", input());
    await ready;
    service.reviewTurn(user, run.id, "q1", { verdict: "failed", note: "条件不符" });
    release?.(success);
    await service.waitForIdle();
    expect(service.getRun(user.id, run.id).turns[0]?.review).toMatchObject({
      verdict: "failed",
      note: "条件不符",
    });
  });

  it("reports a persistence outage rather than exposing stale running data as successful", async () => {
    const client = boundary(() => {
      vi.spyOn(store, "saveRun").mockImplementation(() => {
        throw new Error("storage unavailable with secret");
      });
      return Promise.resolve(success);
    });
    const service = new EvaluationService(store, client, config());
    const run = service.startRun(user, "token", input());
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await service.waitForIdle();
    expect(() => service.getRun(user.id, run.id)).toThrow("持久化失败");
    expect(() => service.listRuns(user.id)).toThrow("持久化失败");
    log.mockRestore();
  });
});
