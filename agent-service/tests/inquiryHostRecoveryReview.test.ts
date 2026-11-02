import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKGROUND_CONTEXT,
  value,
  type Entry,
  type OpenOperation,
} from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessHost, type PromptInput, type RequestAssociation } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { loadConfig } from "../src/config.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";
import type { BackendClient } from "../src/backendClient.js";
import { stopLegacyOperation } from "../src/inquiry/legacyRecovery.js";

const model: Model<"openai-completions"> = {
  id: "isolated",
  name: "isolated",
  api: "openai-completions",
  provider: "isolated",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const openOperation = (operationId: string): OpenOperation => ({
  operationId,
  lane: "main",
  kind: "run",
  startedAt: Date.now(),
});

describe("恢复队列与当前 operation 的身份边界", () => {
  let directory: string, store: NativeSessionStore, host: HarnessHost;
  const modelCalls = vi.fn(() => {
    throw new Error("恢复旧身份不得调用新 operation 的模型");
  });
  const deps = { actor: TEST_ACTOR, backend: {} as BackendClient };
  beforeEach(async () => {
    modelCalls.mockClear();
    directory = await mkdtemp(join(tmpdir(), "inquiry-host-recovery-"));
    store = new NativeSessionStore(directory);
    const models = createModels();
    models.setProvider(
      createProvider({
        id: "isolated",
        name: "isolated",
        models: [model],
        auth: {
          apiKey: {
            name: "isolated",
            resolve: () => Promise.resolve({ auth: { apiKey: "unused" } }),
          },
        },
        api: { stream: modelCalls, streamSimple: modelCalls },
      }),
    );
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id,
      AGENT_COMPACTION_ENABLED: "false",
      AGENT_MODEL_RETRY_ENABLED: "false",
      AGENT_DATA_DIR: directory,
    });
    host = new HarnessHost(config, () => ({ models, model }), store, []);
  });
  afterEach(async () => {
    await host.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("打开时的旧恢复队列不能用旧上下文驱动后来接纳的新请求", async () => {
    const session = await host.createSession(TEST_ACTOR);
    const input: PromptInput = { protocol_version: 3, request_id: "old", message: "先前问题" };
    const old = await host.admitPrompt(session, input, deps);
    if (!old.ok) throw new Error(old.message);
    const queued = openOperation(old.operationId);
    // 等价于恢复读取关联期间，另一请求已经收尾旧操作并接纳下一轮。
    await stopLegacyOperation(session.lane, old.operationId, old.context);
    const next = await host.admitPrompt(
      session,
      { ...input, request_id: "new", message: "后续新问题" },
      deps,
    );
    if (!next.ok) throw new Error(next.message);
    session.open.push(queued);
    await host.resumeOpenOperations(session, deps);
    expect(modelCalls).not.toHaveBeenCalled();
    expect((await session.lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe(
      next.operationId,
    );
    expect(await session.lane.getResult(old.operationId, BACKGROUND_CONTEXT)).toMatchObject({
      status: "aborted",
    });
    await stopLegacyOperation(session.lane, next.operationId, next.context);
  });

  it.each([false, true])("缺请求关联时保留恢复项并显式失败（有反查=%s）", async (reverseExists) => {
    const session = await host.createSession(TEST_ACTOR);
    const operation = openOperation("orphaned-operation");
    expect(
      await session.lane.accept(
        { kind: "prompt", operationId: operation.operationId, prompt: "待核对原问题" },
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ ok: true });
    if (reverseExists)
      await session.session.setValue(
        value("askmetric", `operation/${operation.operationId}`),
        "missing-request",
        BACKGROUND_CONTEXT,
      );
    session.open.push(operation);
    await expect(host.resumeOpenOperations(session, deps)).rejects.toThrow(
      reverseExists ? "OPERATION_ASSOCIATION_MISSING" : "OPERATION_REQUEST_MISSING",
    );
    expect(session.open).toEqual([operation]);
    expect((await session.lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe(
      operation.operationId,
    );
    expect(modelCalls).not.toHaveBeenCalled();
    await stopLegacyOperation(session.lane, operation.operationId);
  });

  it("反查指向另一 operation 的请求记录时拒绝恢复且保留队列", async () => {
    const session = await host.createSession(TEST_ACTOR);
    const admitted = await host.admitPrompt(
      session,
      { protocol_version: 3, request_id: "mismatched", message: "原问题" },
      deps,
    );
    if (!admitted.ok) throw new Error(admitted.message);
    const address = value<RequestAssociation>("askmetric", "request/mismatched");
    const association = (await session.session.getValue(address, BACKGROUND_CONTEXT))!.value;
    await session.session.setValue(
      address,
      { ...association, operationId: "unrelated-operation" },
      BACKGROUND_CONTEXT,
    );
    const operation = openOperation(admitted.operationId);
    session.open.push(operation);
    await expect(host.resumeOpenOperations(session, deps)).rejects.toThrow(
      "OPERATION_ASSOCIATION_CONFLICT",
    );
    expect(session.open).toEqual([operation]);
    expect((await session.lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe(
      admitted.operationId,
    );
    expect(modelCalls).not.toHaveBeenCalled();
    await stopLegacyOperation(session.lane, admitted.operationId, admitted.context);
  });

  it("迁移的终态快照能读取原会话继续提问的提示", async () => {
    const session = await host.createSession(TEST_ACTOR);
    const admitted = await host.admitPrompt(
      session,
      { protocol_version: 3, request_id: "legacy-notice", message: "原问题" },
      deps,
    );
    if (!admitted.ok) throw new Error(admitted.message);
    const address = value<RequestAssociation>("askmetric", "request/legacy-notice");
    const association = (await session.session.getValue(address, BACKGROUND_CONTEXT))!.value;
    const legacy = { ...association };
    delete legacy.executionFlow;
    await session.session.setValue(address, legacy, BACKGROUND_CONTEXT);
    session.open.push(openOperation(admitted.operationId));
    const watch = await host.watch(session);
    // 与重连路由一致：run_end 后读取终态快照，然后关闭观察流。
    const terminal = new Promise<Entry[]>((resolve, reject) => {
      watch.start((event) => {
        if (event.type === "run_end")
          void host
            .resumeOpenOperations(session, deps)
            .then(() => session.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT))
            .then(resolve, reject);
      });
    });
    try {
      const recovery = host.resumeOpenOperations(session, deps);
      expect(host.resumeOpenOperations(session, deps)).toBe(recovery);
      await recovery;
      expect(
        (await terminal).some(
          (entry) => entry.type === "custom" && entry.customType === "askmetric.legacy-interrupted",
        ),
      ).toBe(true);
    } finally {
      watch.unsubscribe();
    }
  });

  it("GET 已结束原生操作时，晚到的空闲观察仍等待同一次恢复的提示落盘", async () => {
    const session = await host.createSession(TEST_ACTOR);
    const admitted = await host.admitPrompt(
      session,
      { protocol_version: 3, request_id: "late-watch", message: "原问题" },
      deps,
    );
    if (!admitted.ok) throw new Error(admitted.message);
    const address = value<RequestAssociation>("askmetric", "request/late-watch");
    const legacy = { ...(await session.session.getValue(address, BACKGROUND_CONTEXT))!.value };
    delete legacy.executionFlow;
    await session.session.setValue(address, legacy, BACKGROUND_CONTEXT);
    session.open.push(openOperation(admitted.operationId));
    let release!: () => void, entered!: () => void;
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const appending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append = session.lane.appendCustomEntry.bind(session.lane);
    const gate = vi.spyOn(session.lane, "appendCustomEntry").mockImplementation(async (...args) => {
      entered();
      await allowed;
      return append(...args);
    });
    const recovery = host.resumeOpenOperations(session, deps);
    await appending;
    const initial = await host.watch(session);
    try {
      expect(initial.snapshot.operation).toBeNull();
      expect(session.open).toEqual([]);
      expect(host.resumeOpenOperations(session, deps)).toBe(recovery);
      release();
      await recovery;
      const refreshed = await host.watch(session);
      try {
        expect(
          refreshed.snapshot.transcript.some(
            (entry) =>
              entry.type === "custom" && entry.customType === "askmetric.legacy-interrupted",
          ),
        ).toBe(true);
      } finally {
        refreshed.unsubscribe();
      }
      expect(await host.resumeOpenOperations(session, deps)).toBe(0);
    } finally {
      release();
      gate.mockRestore();
      initial.unsubscribe();
    }
  });
});
