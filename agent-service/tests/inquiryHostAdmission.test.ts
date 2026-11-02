import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT, value } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessHost, type PromptInput, type RequestAssociation } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { loadConfig } from "../src/config.js";
import { createAskMetricTools } from "../src/tools/index.js";
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

describe("统一入口的持久身份与旧输入迁移", () => {
  let directory: string, store: NativeSessionStore, host: HarnessHost;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "inquiry-host-"));
    store = new NativeSessionStore(directory);
    const models = createModels();
    const unavailable = () => {
      throw new Error("入场测试不得调用模型");
    };
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
        api: { stream: unavailable, streamSimple: unavailable },
      }),
    );
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id,
      AGENT_COMPACTION_ENABLED: "false",
      AGENT_DATA_DIR: directory,
    });
    host = new HarnessHost(config, () => ({ models, model }), store, createAskMetricTools());
  });
  afterEach(async () => {
    await host.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("已发布旧目录选择进入 inquiry，忙碌不占请求，已结束重放不重新校验旧卡片", async () => {
    const session = await host.createSession(TEST_ACTOR);
    const task = {
      task_id: "t1",
      conversation_id: "c1",
      version: 4,
      status: "WAITING_USER" as const,
      resolved_question: "乙行8月末存款",
      clarification: {
        id: "q1",
        fields: [{ type: "metric" }],
        understood: { orgs: ["乙行"], time: "2026年8月末" },
      },
    };
    const backend = {
      getTask: vi.fn(() => Promise.resolve(task)),
      resolveBusinessField: vi.fn((field: string) =>
        Promise.resolve({
          status: "resolved",
          value:
            field === "date"
              ? { start: "2026-08-31", end: "2026-08-31" }
              : {
                  codes: [field === "metric" ? "M1" : "O2"],
                  names: [field === "metric" ? "正式余额" : "乙行"],
                },
        }),
      ),
    };
    await session.lane.appendMessage(
      {
        role: "toolResult",
        toolName: "metric_ask",
        toolCallId: "legacy",
        content: [],
        details: { kind: "metric_ask", ...task },
        isError: false,
        timestamp: 0,
      },
      BACKGROUND_CONTEXT,
    );
    const input: PromptInput = {
      protocol_version: 3,
      request_id: "chosen",
      message: "存款余额",
      clarification_target: { task_id: "t1", version: 4, clarification_id: "q1" },
      selected_answers: {
        set: { metrics: [{ code: "M1", name: "显示名" }] },
        add_ops: [],
        remove_ops: [],
        text: "",
        catalog_selection_mode: "append",
      },
    };
    const deps = { actor: TEST_ACTOR, backend: backend as unknown as BackendClient };
    const admitted = await host.admitPrompt(session, input, deps);
    expect(admitted).toMatchObject({
      ok: true,
      request: {
        executionFlow: "inquiry_v1",
        inquiryAdmission: {
          targets: [
            {
              metrics: { codes: ["M1"] },
              organizations: { codes: ["O2"] },
              time: { start: "2026-08-31", end: "2026-08-31" },
              pending: [],
            },
          ],
        },
      },
    });
    if (!admitted.ok) throw new Error(admitted.message);
    expect(await host.admitPrompt(session, { ...input, request_id: "busy" }, deps)).toMatchObject({
      ok: false,
      code: "SESSION_BUSY",
    });
    expect(
      await session.session.getValue(value("askmetric", "request/busy"), BACKGROUND_CONTEXT),
    ).toBeUndefined();
    const saved = (await session.session.getValue(
      value<RequestAssociation>("askmetric", "request/chosen"),
      BACKGROUND_CONTEXT,
    ))!.value;
    expect(saved.inquiryAdmission).toEqual(admitted.request.inquiryAdmission);
    expect(saved.inquiryTargetContext).toBeUndefined();
    expect(admitted.request.inquiryTargetContext).toBeUndefined();
    expect(
      (
        await session.session.getValue(
          value("askmetric", `operation/${admitted.operationId}`),
          BACKGROUND_CONTEXT,
        )
      )?.value,
    ).toBe("chosen");
    await stopLegacyOperation(session.lane, admitted.operationId, admitted.context);
    backend.getTask.mockRejectedValue(new Error("旧卡片过期，不应再访问"));
    expect(await host.admitPrompt(session, input, deps)).toMatchObject({
      ok: true,
      completed: { status: "aborted" },
    });
    expect(backend.getTask).toHaveBeenCalledTimes(1);
    expect(await host.admitPrompt(session, { ...input, message: "另一问题" }, deps)).toMatchObject({
      ok: false,
      code: "REQUEST_CONFLICT",
    });
    const users = (await session.lane.findEntries({ type: "message" }, BACKGROUND_CONTEXT)).filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.type === "message" && users[0].message).toMatchObject({
      inquiryTargetBarrier: true,
    });
  });

  it("旧在途按真实取消结束，同一会话后续只接纳新工具", async () => {
    const session = await host.createSession(TEST_ACTOR);
    const deps = { actor: TEST_ACTOR, backend: {} as BackendClient };
    const input: PromptInput = { protocol_version: 3, request_id: "old", message: "原问题" };
    const admitted = await host.admitPrompt(session, input, deps);
    if (!admitted.ok) throw new Error(admitted.message);
    const address = value<RequestAssociation>("askmetric", "request/old");
    const saved = (await session.session.getValue(address, BACKGROUND_CONTEXT))!.value;
    const legacy = { ...saved };
    delete legacy.executionFlow;
    await session.session.setValue(address, legacy, BACKGROUND_CONTEXT);
    session.open.push({
      operationId: admitted.operationId,
      lane: "main",
      kind: "run",
      startedAt: Date.now(),
    });
    expect(await host.resumeOpenOperations(session, deps)).toBe(1);
    expect(await session.lane.getResult(admitted.operationId, BACKGROUND_CONTEXT)).toMatchObject({
      status: "aborted",
    });
    expect(await host.admitPrompt(session, input, deps)).toMatchObject({
      ok: true,
      completed: { status: "aborted" },
    });
    const next = await host.admitPrompt(session, { ...input, request_id: "next" }, deps);
    expect(next).toMatchObject({ ok: true, request: { executionFlow: "inquiry_v1" } });
    expect(await session.lane.getActiveTools(BACKGROUND_CONTEXT)).not.toContain(
      "resolve_business_turn",
    );
    if (next.ok) await stopLegacyOperation(session.lane, next.operationId, next.context);
  });
});
