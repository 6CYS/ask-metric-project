import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendUser } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { EvaluationService } from "../src/evaluation/service.js";
import { createSessionEvaluationClient } from "../src/evaluation/sessionClient.js";
import { EvaluationError, EvaluationStore } from "../src/evaluation/store.js";
import type { EvaluationRequest, EvaluationRun } from "../src/evaluation/types.js";

const actor: BackendUser = {
  id: "cancellation-owner",
  username: "isolated-owner",
  display_name: "隔离账号",
  org_code: "100",
  org_name: "隔离机构",
  role_code: "USER",
};
const datasetInput = {
  name: "取消范围隔离样本",
  description: "",
  groups: [
    {
      id: "g1",
      name: "依赖组",
      turns: [
        { id: "q1", question: "首题", expected: "" },
        { id: "q2", question: "依赖追问", expected: "" },
      ],
    },
    { id: "g2", name: "独立组", turns: [{ id: "q3", question: "独立问题", expected: "" }] },
  ],
};

// 文件记录使用真实存储；仅隔离共享执行槽边界，复现数据库确认取消后不清除取消意图的契约。
// 这些检查不连接 GoldenDB，也不代表实际业务数据或模型验收。
class SharedExecutionStore extends EvaluationStore {
  readonly shared = true;
  slot: {
    owner: string;
    runId: string;
    cancelRequested: boolean;
    cancelConfirmed: boolean;
  } | null = null;
  readonly cancellationWrites: string[] = [];

  override recoverInterruptedRuns(): void {}

  override getRun(owner: string, id: string): EvaluationRun {
    const run = super.getRun(owner, id);
    if (
      this.slot?.owner === owner &&
      this.slot.runId === id &&
      this.slot.cancelRequested &&
      ["running", "cancelling"].includes(run.status)
    )
      run.status = "cancelling";
    return run;
  }

  startExecution(owner: string, run: EvaluationRun): Promise<void> {
    if (this.slot) throw new EvaluationError(409, "EVALUATION_BUSY", "已有测评批次执行中");
    this.slot = { owner, runId: run.id, cancelRequested: false, cancelConfirmed: false };
    this.saveRun(owner, run);
    return Promise.resolve();
  }

  maintainExecution(run: EvaluationRun) {
    const slot = this.executionSlot(run.actor.id, run.id);
    return Promise.resolve({
      cancelRequested: slot.cancelRequested,
      cancelConfirmed: slot.cancelConfirmed,
    });
  }

  requestExecutionCancellation(owner: string, id: string) {
    const slot = this.executionSlot(owner, id);
    slot.cancelRequested = true;
    this.cancellationWrites.push("requested");
    return Promise.resolve({ run: this.getRun(owner, id), canFinalize: true });
  }

  confirmExecutionCancellation(owner: string, id: string): Promise<void> {
    const slot = this.executionSlot(owner, id);
    if (!slot.cancelRequested)
      throw new EvaluationError(409, "EVALUATION_NOT_RUNNING", "没有整批停止意图");
    slot.cancelConfirmed = true;
    this.cancellationWrites.push("confirmed");
    return Promise.resolve();
  }

  endExecution(run: EvaluationRun): Promise<void> {
    this.executionSlot(run.actor.id, run.id);
    const saved = this.getRun(run.actor.id, run.id);
    if (["running", "cancelling"].includes(saved.status))
      throw new EvaluationError(409, "EVALUATION_RUN_ACTIVE", "停止未确认，不能释放执行槽");
    this.slot = null;
    return Promise.resolve();
  }

  private executionSlot(owner: string, id: string) {
    if (!this.slot || this.slot.owner !== owner || this.slot.runId !== id)
      throw new EvaluationError(409, "EVALUATION_LEASE_LOST", "执行槽已变更");
    return this.slot;
  }
}

type FirstResponse = "timeout" | "incomplete" | "running";

function pendingCancellation() {
  let release: (response: Response) => void = () => {
    throw new Error("取消请求尚未初始化");
  };
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: (response: Response) => release(response) };
}

function sessionTransport(firstResponse: FirstResponse) {
  const prompts: { sessionId: string; requestId: string; question: string }[] = [];
  const cancellations: { sessionId: string; requestId: string; token: string }[] = [];
  let sessions = 0;
  let cancelResponse = () => Promise.resolve(new Response(null, { status: 204 }));
  const request: EvaluationRequest = (path, init) => {
    if (path === "/sessions")
      return Promise.resolve(Response.json({ session_id: `session-${++sessions}` }));
    const sessionId = path.split("/")[2];
    if (!sessionId) throw new Error("隔离请求缺少会话身份");
    if (path.endsWith("/prompt")) {
      if (typeof init?.body !== "string") throw new Error("隔离请求缺少请求体");
      const body: unknown = JSON.parse(init.body);
      if (
        typeof body !== "object" ||
        body === null ||
        !("request_id" in body) ||
        typeof body.request_id !== "string" ||
        !("message" in body) ||
        typeof body.message !== "string"
      )
        throw new Error("隔离请求身份不完整");
      const requestId = body.request_id;
      prompts.push({ sessionId, requestId, question: body.message });
      const identity = { session_id: sessionId, request_id: requestId, operation_id: requestId };
      const messages = [
        { role: "user", entry_id: `user-${requestId}`, text: body.message, timestamp: 1 },
      ];
      const frame = (event: string, value: Record<string, unknown>) =>
        new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      const first = prompts.length === 1;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                frame("accepted", { ...identity, snapshot: { running: true, messages } }),
              );
              if (first) {
                if (firstResponse === "incomplete") controller.close();
                return;
              }
              controller.enqueue(
                frame("run_terminal", {
                  ...identity,
                  run_status: "completed",
                  answer_status: "ok",
                }),
              );
              controller.enqueue(
                frame("snapshot", {
                  ...identity,
                  running: false,
                  messages: [
                    ...messages,
                    { role: "assistant", entry_id: "answer", text: "隔离回答", timestamp: 2 },
                  ],
                }),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }
    if (path.endsWith("/cancel")) {
      if (typeof init?.body !== "string") throw new Error("取消请求缺少请求体");
      const body: unknown = JSON.parse(init.body);
      if (
        typeof body !== "object" ||
        body === null ||
        !("request_id" in body) ||
        typeof body.request_id !== "string"
      )
        throw new Error("取消请求缺少请求身份");
      cancellations.push({
        sessionId,
        requestId: body.request_id,
        token: new Headers(init?.headers).get("Authorization") ?? "",
      });
      return cancelResponse();
    }
    if (path.endsWith("?resume=false"))
      return Promise.resolve(Response.json({ running: false, messages: [] }));
    throw new Error(`未授权的隔离请求：${path}`);
  };
  return {
    request,
    prompts,
    cancellations,
    setCancelResponse(response: () => Promise<Response>) {
      cancelResponse = response;
    },
  };
}

describe("测评单题清理与整批停止的边界", () => {
  let directory: string;
  let store: SharedExecutionStore;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "evaluation-cancellation-scope-"));
    store = new SharedExecutionStore(directory);
  });
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(firstResponse: FirstResponse) {
    const transport = sessionTransport(firstResponse);
    const client = createSessionEvaluationClient(transport.request, {
      turnTimeoutMs: firstResponse === "timeout" ? 40 : 5_000,
      cancelTimeoutMs: 1_000,
    });
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: "https://unused.invalid",
      AGENT_MODEL_NAME: "isolated",
    });
    const service = new EvaluationService(store, client, config);
    const dataset = store.createDataset(actor.id, datasetInput);
    const input = {
      dataset_id: dataset.id,
      dataset_version: dataset.version,
      name: "取消范围回归",
      version_label: "隔离代码",
      data_label: "隔离协议样本",
    };
    cleanups.push(async () => {
      transport.setCancelResponse(() => Promise.resolve(new Response(null, { status: 204 })));
      if (store.slot) await service.cancelRun(actor.id, "cleanup-token", store.slot.runId);
      await service.shutdown();
      await service.waitForIdle();
    });
    return { service, transport, input };
  }

  it.each([
    ["timeout", "EVALUATION_TIMEOUT"],
    ["incomplete", "EVALUATION_STREAM_INCOMPLETE"],
  ] as const)("%s只清理当前题并继续下一组", async (failure, errorCode) => {
    const { service, transport, input } = fixture(failure);
    const run = await service.startRun(actor, "original-token", input);
    await service.waitForIdle();
    const saved = await service.getRun(actor.id, run.id);
    expect(saved.turns.map((turn) => turn.status)).toEqual(["failed", "skipped", "completed"]);
    expect(saved.status).toBe("completed");
    expect(saved.turns[0]?.result).toMatchObject({ status: "failed", error_code: errorCode });
    expect(transport.prompts.map((prompt) => prompt.question)).toEqual(["首题", "独立问题"]);
    expect(transport.prompts.map((prompt) => prompt.sessionId)).toEqual(["session-1", "session-2"]);
    expect(transport.cancellations).toEqual([
      {
        sessionId: "session-1",
        requestId: saved.turns[0]?.request_id,
        token: "Bearer original-token",
      },
    ]);
    expect(store.cancellationWrites).toEqual([]);
    expect(store.slot).toBeNull();
  });

  it("清理未确认时停止整批并保留执行槽，重新确认后才允许新批次", async () => {
    const { service, transport, input } = fixture("incomplete");
    transport.setCancelResponse(() => Promise.resolve(new Response(null, { status: 503 })));
    const run = await service.startRun(actor, "original-token", input);
    await service.waitForIdle();
    const saved = await service.getRun(actor.id, run.id);
    expect(saved.status).toBe("cancelling");
    expect(saved.turns.map((turn) => turn.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(saved.turns[0]?.result?.error_code).toBe("EVALUATION_CANCEL_UNCONFIRMED");
    expect(transport.prompts.map((prompt) => prompt.question)).toEqual(["首题"]);
    expect(store.slot).toMatchObject({ runId: run.id, cancelConfirmed: false });
    await expect(service.startRun(actor, "fresh-token", input)).rejects.toMatchObject({
      code: "EVALUATION_BUSY",
    });

    transport.setCancelResponse(() => Promise.resolve(new Response(null, { status: 204 })));
    await service.cancelRun(actor.id, "fresh-token", run.id);
    expect((await service.getRun(actor.id, run.id)).status).toBe("cancelled");
    expect(transport.cancellations.map((cancel) => cancel.token)).toEqual([
      "Bearer original-token",
      "Bearer fresh-token",
    ]);
    expect(store.slot).toBeNull();
    const next = await service.startRun(actor, "fresh-token", input);
    await service.waitForIdle();
    expect((await service.getRun(actor.id, next.id)).status).toBe("completed");
  });

  it("用户停止持久化整批取消意图，同一题的并发停止只发送一次取消请求", async () => {
    const { service, transport, input } = fixture("running");
    const cancellation = pendingCancellation();
    transport.setCancelResponse(() => cancellation.promise);
    const run = await service.startRun(actor, "original-token", input);
    try {
      await vi.waitFor(async () =>
        expect(
          (await service.getRun(actor.id, run.id)).turns[0]?.result?.operation_id,
        ).toBeTruthy(),
      );
      const stopping = Promise.all([
        service.cancelRun(actor.id, "fresh-token", run.id),
        service.cancelRun(actor.id, "fresh-token", run.id),
      ]);
      await vi.waitFor(() => expect(transport.cancellations).toHaveLength(1));
      expect(store.slot).toMatchObject({ cancelRequested: true, cancelConfirmed: false });
      cancellation.resolve(new Response(null, { status: 204 }));
      await stopping;
      await service.waitForIdle();
      const saved = await service.getRun(actor.id, run.id);
      expect(saved.status).toBe("cancelled");
      expect(saved.turns.map((turn) => turn.status)).toEqual(["cancelled", "skipped", "skipped"]);
      expect(saved.turns[0]?.result?.error_code).toBe("EVALUATION_CANCELLED");
      expect(transport.prompts.map((prompt) => prompt.question)).toEqual(["首题"]);
      expect(transport.cancellations).toEqual([
        {
          sessionId: "session-1",
          requestId: saved.turns[0]?.request_id,
          token: "Bearer fresh-token",
        },
      ]);
      expect(store.cancellationWrites).toContain("requested");
      expect(store.cancellationWrites).toContain("confirmed");
      expect(store.slot).toBeNull();
    } finally {
      cancellation.resolve(new Response(null, { status: 204 }));
    }
  });

  it("单题清理过程中收到用户停止仍停止整批，并复用进行中的取消请求", async () => {
    const { service, transport, input } = fixture("incomplete");
    const cancellation = pendingCancellation();
    transport.setCancelResponse(() => cancellation.promise);
    const run = await service.startRun(actor, "original-token", input);
    try {
      await vi.waitFor(() => expect(transport.cancellations).toHaveLength(1));
      const stopping = service.cancelRun(actor.id, "fresh-token", run.id);
      await vi.waitFor(() => expect(store.slot?.cancelRequested).toBe(true));
      expect(store.slot?.cancelConfirmed).toBe(false);
      expect(transport.cancellations).toHaveLength(1);
      cancellation.resolve(new Response(null, { status: 204 }));
      await stopping;
      await service.waitForIdle();
      const saved = await service.getRun(actor.id, run.id);
      expect(saved.status).toBe("cancelled");
      expect(saved.turns.map((turn) => turn.status)).toEqual(["cancelled", "skipped", "skipped"]);
      expect(saved.turns[0]?.result?.error_code).toBe("EVALUATION_CANCELLED");
      expect(transport.prompts.map((prompt) => prompt.question)).toEqual(["首题"]);
      expect(transport.cancellations).toEqual([
        {
          sessionId: "session-1",
          requestId: saved.turns[0]?.request_id,
          token: "Bearer original-token",
        },
      ]);
      expect(store.cancellationWrites).toContain("requested");
      expect(store.cancellationWrites).toContain("confirmed");
      expect(store.slot).toBeNull();
    } finally {
      cancellation.resolve(new Response(null, { status: 204 }));
    }
  });

  it("整批停止确认写入失败时保留执行槽，再次停止可恢复", async () => {
    const { service, transport, input } = fixture("running");
    const run = await service.startRun(actor, "original-token", input);
    await vi.waitFor(async () =>
      expect((await service.getRun(actor.id, run.id)).turns[0]?.result?.operation_id).toBeTruthy(),
    );
    const confirmation = vi
      .spyOn(store, "confirmExecutionCancellation")
      .mockRejectedValueOnce(new Error("隔离存储写入失败"));
    try {
      await service.cancelRun(actor.id, "fresh-token", run.id);
      await service.waitForIdle();
      const saved = await service.getRun(actor.id, run.id);
      expect(saved.status).toBe("cancelling");
      expect(saved.turns.map((turn) => turn.status)).toEqual(["failed", "skipped", "skipped"]);
      expect(saved.turns[0]?.result?.error_code).toBe("EVALUATION_CANCEL_UNCONFIRMED");
      expect(store.slot).toMatchObject({
        runId: run.id,
        cancelRequested: true,
        cancelConfirmed: false,
      });
      await expect(service.startRun(actor, "fresh-token", input)).rejects.toMatchObject({
        code: "EVALUATION_BUSY",
      });
      await service.cancelRun(actor.id, "retry-token", run.id);
      expect((await service.getRun(actor.id, run.id)).status).toBe("cancelled");
      expect(transport.prompts.map((prompt) => prompt.question)).toEqual(["首题"]);
      expect(store.cancellationWrites).toContain("confirmed");
      expect(store.slot).toBeNull();
    } finally {
      confirmation.mockRestore();
    }
  });
});
