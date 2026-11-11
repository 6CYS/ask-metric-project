import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { BusinessSkillStore } from "../src/businessSkillStore.js";
import { createBusinessSkillReadTool, loadBusinessSkills } from "../src/businessSkills.js";
import { loadConfig } from "../src/config.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import type { BackendClient } from "../src/backendClient.js";

it("同一会话下一轮使用新方法，执行中的读取保留本轮版本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-host-"));
  const sessions = new NativeSessionStore(directory);
  const defaults = await loadBusinessSkills();
  const skills = new BusinessSkillStore(directory, defaults);
  const models = createModels();
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
  const unavailable = () => {
    throw new Error("快照检查不应调用模型");
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
  const tool = createBusinessSkillReadTool(defaults);
  const readMethod = (request: AskMetricRequestContext) =>
    tool.execute(
      "read",
      { name: "inquiry-analysis" },
      () => {},
      request,
      {
        invocationId: "inv-1",
        operationId: request.operationId,
        turnId: "turn-1",
        getMemo: () => Promise.resolve(undefined),
        setMemo: () => Promise.resolve(),
      },
      BACKGROUND_CONTEXT,
    );
  const host = new HarnessHost(
    loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_NAME: model.id,
      AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_DATA_DIR: directory,
    }),
    () => ({ models, model }),
    sessions,
    [...createAskMetricTools(), tool],
    { getSkills: () => skills.snapshot() },
  );
  const deps = { actor: TEST_ACTOR, backend: {} as BackendClient };
  try {
    const session = await host.createSession(TEST_ACTOR);
    const first = await host.admitPrompt(
      session,
      { protocol_version: 3, request_id: "before", message: "费用情况" },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("第一轮未接纳");
    const original = skills.list().find((item) => item.name === "inquiry-analysis")!;
    skills.update(original.name, original.revision, "# 新版分析方法", "admin");
    const read = await readMethod(first.request);
    expect(read.content).toEqual([{ type: "text", text: original.content }]);
    await session.lane.abort(BACKGROUND_CONTEXT);
    const next = await host.admitPrompt(
      session,
      { protocol_version: 3, request_id: "after", message: "再看费用" },
      deps,
    );
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("下一轮未接纳");
    const latest = await readMethod(next.request);
    expect(latest.content).toEqual([{ type: "text", text: "# 新版分析方法" }]);
  } finally {
    await host.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
