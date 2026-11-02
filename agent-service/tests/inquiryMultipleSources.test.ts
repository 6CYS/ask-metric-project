import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { businessEvidences } from "../src/answerEvidence.js";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost } from "../src/harnessHost.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { createInquiryAnswerTool } from "../src/inquiry/runtime.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { projectEntries } from "../src/sessionProjection.js";
import { createPartialAnalysisTool, PARTIAL_ANALYSIS } from "../src/tools/partialAnalysis.js";
import { createConversationReplyTool } from "../src/tools/turnContract.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";

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
const descriptors = Array.from({ length: 13 }, (_, index) => ({
  code: `M${index + 1}`,
  name: `隔离指标${index + 1}`,
  unit: "元",
  binding_ref: `signed:M${index + 1}`,
}));
const runRefs = descriptors.map((_, index) => `analysis:run-${index + 1}`);
const factRefs = runRefs.map((ref) => `${ref}.f1`);
const body = descriptors.map((item, index) => `${item.name}为{{e${index + 1}.v1}}。`).join("\n\n");
const confirmed = descriptors.map((item, index) => `${item.name}为${index + 1}元。`).join("\n\n");
type Scenario =
  | "success"
  | "model-failure"
  | "source-rejected"
  | "recovery-source-rejected"
  | "recovery-forbidden"
  | "recovery-unauthenticated";

// 使用真实检索、取数、报告、恢复与会话投影，只在模型和后端 HTTP 客户端边界隔离。
async function replayMultipleSources(scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "inquiry-multiple-sources-"));
  const store = new NativeSessionStore(directory);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let modelCalls = 0;
  const executions: Record<string, unknown>[] = [];
  const reportPayloads: Record<string, unknown>[] = [];
  const stream: ProviderStreams["streamSimple"] = () => {
    modelCalls++;
    if (modelCalls > 16) throw new Error("UNEXPECTED_MODEL_CONTINUATION");
    const search = modelCalls === 1;
    const query = modelCalls >= 2 && modelCalls <= 14;
    const report = modelCalls === 15 && ["success", "source-rejected"].includes(scenario);
    const failed = !search && !query && !report;
    const name = search ? "metric_search" : query ? "metric_query" : "analysis_answer";
    const args = search
      ? { keywords: ["隔离业务指标"], page_size: 30 }
      : query
        ? {
            purpose: "查询指定指标",
            metric_refs: [`k${modelCalls - 1}`],
            method: "observe",
            ...(modelCalls === 2
              ? {
                  target_change: {
                    mode: "new",
                    topic: "隔离业务指标分析",
                    organizations: {
                      mode: "replace",
                      scope: "named",
                      names: [TEST_ACTOR.org_code],
                    },
                    date: "2026-08-27",
                  },
                }
              : {}),
          }
        : { body };
    const message: AssistantMessage = {
      role: "assistant",
      content: failed
        ? [{ type: "text", text: "未核验草稿987654元。" }]
        : [{ type: "toolCall", id: `call-${modelCalls}`, name, arguments: args }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: failed ? "error" : "toolUse",
      ...(failed ? { errorMessage: "upstream unavailable" } : {}),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const events = createAssistantMessageEventStream();
    events.push({ type: "start", partial: message });
    if (failed) events.push({ type: "error", reason: "error", error: message });
    else events.push({ type: "done", reason: "toolUse", message });
    events.end(message);
    return events;
  };
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
  const backend = {
    analysisCatalog: () =>
      Promise.resolve({ items: descriptors, total: 13, page: 1, page_size: 30 }),
    analysisMethods: () => Promise.resolve({ methods: [] }),
    createAgentQueryContext: () => Promise.resolve({ conversation_id: "isolated-conversation" }),
    resolveBusinessField: (entity: string) =>
      Promise.resolve({
        status: "resolved",
        value:
          entity === "organization"
            ? { codes: [TEST_ACTOR.org_code], names: [TEST_ACTOR.org_name] }
            : { start: "2026-08-27", end: "2026-08-27" },
      }),
    analysisExecute: (payload: Record<string, unknown>) => {
      const index = executions.length;
      const descriptor = descriptors[index];
      if (!descriptor) throw new Error("UNEXPECTED_QUERY_CONTINUATION");
      executions.push(payload);
      expect(payload).toMatchObject({
        conversation_id: "isolated-conversation",
        org_codes: [TEST_ACTOR.org_code],
        start: "2026-08-27",
        end: "2026-08-27",
        plan: { steps: [{ method: "observe", metric_refs: [descriptor.binding_ref] }] },
      });
      const fact = {
        ref: factRefs[index],
        type: "fact",
        metric_code: descriptor.code,
        metric_name: descriptor.name,
        org_code: TEST_ACTOR.org_code,
        org_name: TEST_ACTOR.org_name,
        date: "2026-08-27",
        unit: "元",
        value: String(index + 1),
        display: `${index + 1}元`,
      };
      const calculationContext = payload.calculation_context as { scope_id: string };
      return Promise.resolve({
        kind: "analysis_evidence",
        status: "succeeded",
        run_ref: runRefs[index],
        scope_id: calculationContext.scope_id,
        conversation_id: "isolated-conversation",
        analysis_date: "2026-08-27",
        org_codes: [TEST_ACTOR.org_code],
        metric_descriptors: [descriptor],
        evidence_items: [fact],
        rows: [],
        tasks: [],
        facts: [],
        observations: [],
        gaps: [],
        plan: payload.plan,
      });
    },
    analysisReport: (payload: Record<string, unknown>) => {
      reportPayloads.push(payload);
      expect(payload.run_refs).toEqual(runRefs);
      if (["success", "source-rejected"].includes(scenario)) {
        expect(payload.fallback).not.toBe(true);
        expect(payload).toMatchObject({
          context_run_refs: [],
          summary: descriptors
            .map((item, index) => `${item.name}为{{${factRefs[index]}}}。`)
            .join("\n\n"),
        });
      } else expect(payload).toMatchObject({ fallback: true, summary: "", sections: [] });
      if (["source-rejected", "recovery-source-rejected"].includes(scenario))
        return Promise.reject(
          new BackendApiError(422, "来源已失效，请重新查询。", "ANALYSIS_REPORT_REFERENCE"),
        );
      if (scenario === "recovery-forbidden")
        return Promise.reject(new BackendApiError(403, "internal O_SECRET", "ANALYSIS_FORBIDDEN"));
      if (scenario === "recovery-unauthenticated")
        return Promise.reject(new BackendApiError(401, "internal O_SECRET", "AUTH_TOKEN_EXPIRED"));
      return Promise.resolve({
        kind: "business_report",
        status: "succeeded",
        answer_policy: "verified_report_v1",
        public_answer: confirmed,
        org_codes: [TEST_ACTOR.org_code],
        columns: ["metric_code", "value"],
        rows: descriptors.map((item, index) => ({
          metric_code: item.code,
          value: String(index + 1),
        })),
        tasks: [],
        gaps: [],
        report: {
          summary: confirmed,
          sections: [],
          body_evidence: factRefs.map((ref, index) => ({
            paragraph: index + 1,
            evidence_refs: [ref],
          })),
        },
      });
    },
  } as unknown as BackendClient;
  const config = loadConfig({
    AGENT_MODEL_API_KEY: "unused",
    AGENT_MODEL_BASE_URL: model.baseUrl,
    AGENT_MODEL_NAME: model.id,
    AGENT_DATA_DIR: directory,
    AGENT_COMPACTION_ENABLED: "false",
    AGENT_MODEL_RETRY_ENABLED: "false",
  });
  const host = new HarnessHost(config, () => ({ models, model }), store, [
    ...createInquiryQueryTools(),
    createInquiryAnswerTool(),
    createPartialAnalysisTool(),
    createConversationReplyTool(),
  ]);
  try {
    const session = await host.createSession(TEST_ACTOR);
    const result = await host.runPrompt(
      session,
      { protocol_version: 3, request_id: scenario, message: "查询隔离业务指标并分析" },
      { actor: TEST_ACTOR, backend },
    );
    expect(await host.isRunning(session.sessionId)).toBe(false);
    const entries = await session.lane.findEntries(
      { type: "message", order: "oldestFirst", limit: 60 },
      BACKGROUND_CONTEXT,
    );
    const receipts = entries.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    const projected = projectEntries(entries);
    await host.closeSession(session.sessionId);
    const reopened = await host.openSession(TEST_ACTOR, session.sessionId);
    if (!reopened) throw new Error("SESSION_NOT_RESTORED");
    const refreshed = projectEntries(
      await reopened.lane.findEntries(
        { type: "message", order: "oldestFirst", limit: 60 },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(refreshed).toEqual(projected);
    const answers = refreshed
      .filter((item) => item.role === "assistant")
      .map((item) => item.text)
      .join("\n");
    expect(answers).not.toMatch(/987654|O_SECRET|internal/);
    return { result, modelCalls, executions, reportPayloads, receipts, answers, refreshed };
  } finally {
    await host.close();
    await store.close();
    log.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("多次独立查询的完整来源交付", () => {
  it.each(["success", "model-failure"] as const)(
    "%s 保留 13 个当前来源及刷新后的正文和表格",
    async (scenario) => {
      const result = await replayMultipleSources(scenario);
      expect(result.modelCalls).toBe(15);
      expect(result.executions).toHaveLength(13);
      expect(result.reportPayloads).toHaveLength(1);
      const sources = result.receipts
        .filter((item) => item.toolName === "metric_query")
        .flatMap((item) => businessEvidences(item.details))
        .filter((item) => item.kind === "analysis_evidence");
      expect(sources).toMatchObject(
        runRefs.map((runRef, index) => ({
          run_ref: runRef,
          evidence_items: [{ ref: factRefs[index] }],
        })),
      );
      expect(result.answers).toContain(confirmed);
      expect(result.receipts.at(-1)?.details).toMatchObject({
        kind: "business_report",
        status: "succeeded",
      });
      const lastProjected = result.refreshed.filter((item) => item.role === "tool").at(-1);
      expect(lastProjected?.details).toMatchObject({
        rows: descriptors.map((item, index) => ({
          metric_code: item.code,
          value: String(index + 1),
        })),
      });
      if (scenario === "model-failure") {
        expect(result.receipts.at(-1)).toMatchObject({
          toolName: PARTIAL_ANALYSIS,
          details: { partial_analysis: true, fallback_reason: "model_failure" },
        });
        expect(result.answers).toContain("未能完成分析");
      } else expect(result.receipts.at(-1)?.toolName).toBe("analysis_answer");
    },
  );

  it("报告来源拒绝后模型失败，不通过部分恢复越过未解决的来源错误", async () => {
    const result = await replayMultipleSources("source-rejected");
    expect(result.reportPayloads).toHaveLength(1);
    expect(result.receipts.some((item) => item.toolName === PARTIAL_ANALYSIS)).toBe(false);
    expect(result.receipts.find((item) => item.toolName === "analysis_answer")).toMatchObject({
      isError: true,
      details: { error_code: "ANALYSIS_REPORT_REFERENCE" },
    });
    expect(result.answers).not.toContain(confirmed);
  });

  it.each(["recovery-source-rejected", "recovery-forbidden", "recovery-unauthenticated"] as const)(
    "%s 保留服务端拒绝且不重试或交付旧值",
    async (scenario) => {
      const result = await replayMultipleSources(scenario);
      expect(result.modelCalls).toBe(15);
      expect(result.executions).toHaveLength(13);
      expect(result.reportPayloads).toHaveLength(1);
      expect(result.receipts.filter((item) => item.toolName === PARTIAL_ANALYSIS)).toHaveLength(1);
      expect(result.answers).not.toContain(confirmed);
      if (scenario === "recovery-source-rejected")
        expect(result.receipts.at(-1)?.details).toMatchObject({
          status: "failed",
          error_code: "ANALYSIS_REPORT_REFERENCE",
          retryable: false,
        });
      if (scenario === "recovery-forbidden")
        expect(result.receipts.at(-1)?.details).toMatchObject({
          error_code: "INQUIRY_FORBIDDEN",
          outcome: "incomplete",
        });
      if (scenario === "recovery-unauthenticated")
        expect(result.receipts.at(-1)?.details).toMatchObject({
          error_code: "AUTH_TOKEN_EXPIRED",
          http_status: 401,
        });
    },
  );
});
