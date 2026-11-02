import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  value,
  type AgentHarnessTool,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  Type,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { NativeSessionStore, ownerDirName } from "../src/nativeSessions.js";
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
const owner = "isolated-legacy-recovery";
const operationId = "legacy-operation";
const requestAddress = value("askmetric", "request/legacy-request");
const input = {
  originalMessage: "甲行2026年7月末存款余额，保留原口径",
  operationId,
  input: {
    protocol_version: 3,
    request_id: "legacy-request",
    message: "甲行2026年7月末存款余额，保留原口径",
  },
};

function modelBundle(stream: ProviderStreams["streamSimple"]) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: model.name,
      models: [model],
      auth: {
        apiKey: {
          name: "isolated",
          resolve: () => Promise.resolve({ auth: { apiKey: "unused" } }),
        },
      },
      api: { stream, streamSimple: stream },
    }),
  );
  return { models, model };
}

function response(toolCalls: boolean) {
  const message: AssistantMessage = {
    role: "assistant",
    content: toolCalls
      ? ["legacy_evidence", "legacy_query"].map((name) => ({
          type: "toolCall",
          id: name,
          name,
          arguments: {},
        }))
      : [{ type: "text", text: "隔离会话已结束。" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: toolCalls ? "toolUse" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: toolCalls ? "toolUse" : "stop", message });
  stream.end(message);
  return stream;
}

/** 在真实 Pi 持久化边界复制测试快照，恢复时不改写任何 Pi 内部状态。 */
async function interruptedFixture(boundary: "planned" | "effect_pending" | "completed") {
  const directory = await mkdtemp(join(tmpdir(), "inquiry-legacy-recovery-"));
  const sourceStore = new NativeSessionStore(join(directory, "source"));
  const recoveredStore = new NativeSessionStore(join(directory, "recovered"));
  const source = await sourceStore.create(owner);
  await source.setValue(requestAddress, input, BACKGROUND_CONTEXT);
  let snapshot: Buffer | undefined,
    modelCalls = 0,
    recoveringModelCalls = 0;
  const capture = async () => {
    snapshot = await readFile(source.metadata.path);
  };
  const tools: AgentHarnessTool<undefined>[] = [
    {
      name: "legacy_evidence",
      label: "隔离已有回执",
      description: "保存测试结果",
      parameters: Type.Object({}),
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: "已有结果" }],
          details: { kind: "isolated_evidence", result_id: "kept-result" },
        }),
    },
    {
      name: "legacy_query",
      label: "隔离在途查询",
      description: "在工具边界保存快照",
      parameters: Type.Object({}),
      execute: async () => {
        if (boundary === "effect_pending") await capture();
        return {
          content: [{ type: "text", text: "隔离原进程结果" }],
          details: { kind: "isolated_evidence", result_id: "later-result" },
        };
      },
    },
  ];
  const sourceHarness = (
    await AgentHarness.create(
      {
        session: source,
        ...modelBundle(() => response(++modelCalls === 1)),
        tools,
        toolExecution: "sequential",
        compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 },
      },
      BACKGROUND_CONTEXT,
    )
  ).harness;
  sourceHarness.hooks.on("before_tool", async (event) => {
    if (boundary === "planned" && event.toolName === "legacy_query") await capture();
    return undefined;
  });
  const sourceLane = await sourceHarness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
  const admitted = await sourceLane.accept(
    { kind: "prompt", operationId, prompt: input.originalMessage },
    BACKGROUND_CONTEXT,
  );
  if (!admitted.ok) throw admitted.error;
  const driven = await sourceLane.drive({ operationId }, BACKGROUND_CONTEXT);
  if (!driven.ok) throw driven.error;
  if (boundary === "completed") await capture();
  if (!snapshot) throw new Error("未捕获工具执行边界");
  const destination = join(
    directory,
    "recovered",
    "native-v1",
    ownerDirName(owner),
    basename(dirname(source.metadata.path)),
    basename(source.metadata.path),
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, snapshot);
  await sourceHarness.close(BACKGROUND_CONTEXT);
  await sourceStore.close();
  const metadata = (await recoveredStore.list(owner))[0];
  if (!metadata) throw new Error("未找到隔离恢复快照");
  const session = await recoveredStore.open(owner, metadata);
  const restored = await AgentHarness.create(
    {
      session,
      ...modelBundle(() => {
        recoveringModelCalls++;
        throw new Error("旧在途不应请求模型");
      }),
      tools: [],
      toolContext: () => {
        throw new Error("旧在途不应进入业务上下文");
      },
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 },
    },
    BACKGROUND_CONTEXT,
  );
  const lane = await restored.harness.lane("main", BACKGROUND_CONTEXT);
  return {
    lane,
    session,
    open: restored.open,
    modelCalls: () => recoveringModelCalls,
    cleanup: async () => {
      await restored.harness.close(BACKGROUND_CONTEXT);
      await recoveredStore.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("旧在途操作的升级边界", () => {
  it("旧请求已有正式终态时原样回放，不能改成中断或再次执行", async () => {
    const fixture = await interruptedFixture("completed");
    try {
      const existing = await fixture.lane.getResult(operationId, BACKGROUND_CONTEXT);
      expect(existing).toMatchObject({ status: "completed" });
      const entries = await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
      expect(await stopLegacyOperation(fixture.lane, operationId)).toEqual(existing);
      expect(await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).toEqual(
        entries,
      );
      expect(fixture.modelCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["planned", "effect_pending"] as const)(
    "%s：真实中断且保留已保存证据和原始条件，不重放旧工具",
    async (boundary) => {
      const fixture = await interruptedFixture(boundary);
      try {
        expect(fixture.open).toMatchObject([{ operationId, kind: "run" }]);
        const before = await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
        const result = await stopLegacyOperation(fixture.lane, operationId);
        expect(result).toMatchObject({ operationId, status: "aborted" });
        expect(await fixture.lane.getResult(operationId, BACKGROUND_CONTEXT)).toEqual(result);
        expect((await fixture.lane.inspectExecution(BACKGROUND_CONTEXT)).current).toBeNull();
        expect(fixture.modelCalls()).toBe(0);
        expect((await fixture.session.getValue(requestAddress, BACKGROUND_CONTEXT))?.value).toEqual(
          input,
        );
        const after = await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(
          after.flatMap<unknown>((entry) => {
            if (
              entry.type !== "message" ||
              entry.message.role !== "toolResult" ||
              entry.message.toolName !== "legacy_evidence"
            )
              return [];
            const details: unknown = entry.message.details;
            return [details];
          }),
        ).toEqual([{ kind: "isolated_evidence", result_id: "kept-result" }]);
        const interrupted = after.flatMap((entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "legacy_query"
            ? [entry.message]
            : [],
        );
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]).toMatchObject({ isError: true });
        expect(JSON.stringify(interrupted)).not.toContain("later-result");
        if (boundary === "effect_pending")
          expect(JSON.stringify(interrupted)).toContain("external outcome is unknown");
        const retry = await stopLegacyOperation(fixture.lane, operationId);
        expect(retry).toEqual(result);
        expect(
          await fixture.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
        ).toEqual(after);
        expect(fixture.modelCalls()).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("已结束操作的重试不影响原会话后续新提问；错误操作标识不能停止当前提问", async () => {
    const fixture = await interruptedFixture("planned");
    try {
      const result = await stopLegacyOperation(fixture.lane, operationId);
      expect(
        await fixture.lane.accept(
          { kind: "prompt", operationId: "new-inquiry", prompt: "继续原问题" },
          BACKGROUND_CONTEXT,
        ),
      ).toMatchObject({ ok: true });
      expect(await stopLegacyOperation(fixture.lane, operationId)).toEqual(result);
      await expect(stopLegacyOperation(fixture.lane, "unknown-operation")).rejects.toThrow();
      expect((await fixture.lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe(
        "new-inquiry",
      );
      expect(fixture.modelCalls()).toBe(0);
      await fixture.lane.abort(BACKGROUND_CONTEXT);
    } finally {
      await fixture.cleanup();
    }
  });
});
