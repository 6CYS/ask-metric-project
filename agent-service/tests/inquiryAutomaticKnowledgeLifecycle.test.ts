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
import type { BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost } from "../src/harnessHost.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { createInquiryAnswerTool } from "../src/inquiry/runtime.js";
import { createTopicQueryTool } from "../src/inquiry/topics/tool.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
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
const metric = {
  code: "ORG_BAD_RT",
  name: "不良贷款比率当日数",
  unit: "%",
  value_encoding: "ratio",
  binding_ref: "signed:ORG_BAD_RT",
};
const scopeKnowledge = {
  id: "loan_quality",
  title: "隔离知识范围",
  text: "本测试的质量观察使用正式不良率。",
  role: "方法参考",
  metric_codes: [metric.code],
  batch_query_enabled: true,
};
const methodKnowledge = {
  id: "ratio-method",
  title: "隔离比率解释方法",
  text: "解释比率变化须核对可比口径的分子、分母；未核实的变化来源不能作为已知原因。",
  role: "方法参考",
};
const runRef = "analysis:knowledge-topic";
const answer = "现有事实仅支持该指标的观察，变化来源尚未核实。";

// 模型和后端 HTTP 使用隔离边界；主题执行、历史回读、知识刷新与提供方上下文均走真实实现。
describe("自动知识在主题查询和追问中的实际交付", () => {
  it.each([false, true])(
    "首轮自动资料送达，查询与回读按真实指标刷新，次轮禁用=%s",
    async (disabled) => {
      const directory = await mkdtemp(join(tmpdir(), "inquiry-auto-knowledge-"));
      const store = new NativeSessionStore(directory);
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      let calls = 0;
      let secondTurn = false;
      let savedEvidence: Record<string, unknown> | undefined;
      const contexts: string[] = [];
      const knowledgeInputs: Array<{ query: string; terms: string[] }> = [];
      const stream: ProviderStreams["streamSimple"] = (_model, context) => {
        if (++calls > 4) throw new Error("UNEXPECTED_MODEL_CONTINUATION");
        const serialized = JSON.stringify(context.messages);
        contexts.push(serialized);
        const name =
          calls === 1 ? "topic_query" : calls === 3 ? "analysis_read" : "analysis_answer";
        const args =
          calls === 1
            ? {
                topic_id: "loan_quality",
                scope: "named",
                org_names: [TEST_ACTOR.org_name],
                date: "2026-08-27",
              }
            : calls === 3
              ? { run_ref: runRef }
              : { body: answer + "{{e1.v1|cite}}" };
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "toolCall", id: `call-${calls}`, name, arguments: args }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          stopReason: "toolUse",
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
        events.push({ type: "done", reason: "toolUse", message });
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
        knowledgeAnalysisPlan: () =>
          Promise.resolve({ version: "a".repeat(64), entry: { ...scopeKnowledge, enabled: true } }),
        searchBusinessKnowledge: (query: string, terms: string[]) => {
          knowledgeInputs.push({ query, terms });
          const hasMetrics = terms.includes("ORG_BAD_RT 不良贷款比率当日数");
          const entries =
            secondTurn && disabled
              ? []
              : hasMetrics
                ? [methodKnowledge]
                : secondTurn
                  ? []
                  : [scopeKnowledge];
          return Promise.resolve({
            revision: (secondTurn ? "b" : "a").repeat(64),
            entries,
            ...(entries.includes(scopeKnowledge)
              ? {
                  linked_catalog: {
                    items: [metric],
                    total: 1,
                    has_more: false,
                    unavailable_codes: [],
                  },
                }
              : {}),
          });
        },
        analysisBindMetrics: () => Promise.resolve({ items: [metric] }),
        analysisMethods: () => Promise.resolve({ methods: [] }),
        createAgentQueryContext: () =>
          Promise.resolve({ conversation_id: "isolated-conversation" }),
        resolveBusinessField: (entity: string) =>
          Promise.resolve({
            status: "resolved",
            value:
              entity === "organization"
                ? { codes: [TEST_ACTOR.org_code], names: [TEST_ACTOR.org_name] }
                : { start: "2026-08-27", end: "2026-08-27" },
          }),
        analysisExecute: (payload: Record<string, unknown>) => {
          expect(savedEvidence).toBeUndefined();
          expect(payload).toMatchObject({
            org_codes: [TEST_ACTOR.org_code],
            start: "2026-08-27",
            end: "2026-08-27",
            plan: { steps: [{ method: "observe", metric_refs: [metric.binding_ref] }] },
          });
          const calculationContext = payload.calculation_context as { scope_id: string };
          savedEvidence = {
            kind: "analysis_evidence",
            status: "succeeded",
            run_ref: runRef,
            scope_id: calculationContext.scope_id,
            conversation_id: "isolated-conversation",
            analysis_date: "2026-08-27",
            org_codes: [TEST_ACTOR.org_code],
            org_names: [TEST_ACTOR.org_name],
            actual_dates: ["2026-08-27"],
            metric_descriptors: [metric],
            evidence_items: [
              {
                type: "fact",
                ref: "ratio.f1",
                metric_code: metric.code,
                metric_name: metric.name,
                org_code: TEST_ACTOR.org_code,
                org_name: TEST_ACTOR.org_name,
                date: "2026-08-27",
                value: "0.02",
                unit: "%",
                display: "2%",
              },
            ],
            rows: [],
            tasks: [],
            observations: [],
            gaps: [],
            plan: payload.plan,
          };
          return Promise.resolve(savedEvidence);
        },
        analysisEvidence: (ref: string, conversation: string) => {
          expect([ref, conversation]).toEqual([runRef, "isolated-conversation"]);
          return Promise.resolve(savedEvidence);
        },
        analysisReport: () =>
          Promise.resolve({
            kind: "business_report",
            status: "succeeded",
            answer_policy: "verified_report_v1",
            public_answer: answer,
            org_codes: [TEST_ACTOR.org_code],
            rows: [],
            tasks: [],
            gaps: [],
            report: { summary: answer, sections: [] },
          }),
      } as unknown as BackendClient;
      const queryTools = createInquiryQueryTools();
      const query = queryTools.find((tool) => tool.name === "metric_query");
      if (!query) throw new Error("缺少查询工具");
      const config = loadConfig({
        AGENT_MODEL_API_KEY: "unused",
        AGENT_MODEL_BASE_URL: model.baseUrl,
        AGENT_MODEL_NAME: model.id,
        AGENT_DATA_DIR: directory,
        AGENT_COMPACTION_ENABLED: "false",
        AGENT_MODEL_RETRY_ENABLED: "false",
        AGENT_TOPIC_QUERY_ENABLED: "true",
      });
      const host = new HarnessHost(config, () => ({ models, model }), store, [
        ...queryTools,
        createTopicQueryTool(query),
        createInquiryAnswerTool(),
        createConversationReplyTool(),
      ]);
      try {
        const session = await host.createSession(TEST_ACTOR);
        const dependencies = { actor: TEST_ACTOR, backend };
        expect(
          await host.runPrompt(
            session,
            { protocol_version: 3, request_id: "quality", message: "本行贷款质量如何" },
            dependencies,
          ),
        ).toMatchObject({ ok: true, outcome: { kind: "settled" } });
        expect(calls).toBe(2);
        secondTurn = true;
        expect(
          await host.runPrompt(
            session,
            { protocol_version: 3, request_id: "reason", message: "这些变化能说明原因吗" },
            dependencies,
          ),
        ).toMatchObject({ ok: true, outcome: { kind: "settled" } });
        expect(calls).toBe(4);
        expect(contexts).toHaveLength(4);
        expect(contexts[0]).toContain(scopeKnowledge.text);
        expect(contexts[0]).toContain(metric.code);
        expect(contexts[0]).not.toContain(methodKnowledge.text);
        expect(contexts[1]).toContain(methodKnowledge.text);
        expect(contexts[1]).toContain("topic_execution");
        expect(contexts[2]).not.toContain(scopeKnowledge.text);
        expect(contexts[2]).not.toContain(methodKnowledge.text);
        if (disabled) expect(contexts[3]).not.toContain(methodKnowledge.text);
        else expect(contexts[3]).toContain(methodKnowledge.text);
        expect(knowledgeInputs).toEqual([
          { query: "本行贷款质量如何", terms: [] },
          { query: "本行贷款质量如何", terms: ["ORG_BAD_RT 不良贷款比率当日数"] },
          { query: "这些变化能说明原因吗", terms: [] },
          { query: "这些变化能说明原因吗", terms: ["ORG_BAD_RT 不良贷款比率当日数"] },
        ]);
        const entries = await session.lane.findEntries(
          { type: "message", order: "oldestFirst", limit: 30 },
          BACKGROUND_CONTEXT,
        );
        expect(JSON.stringify(entries)).not.toContain(methodKnowledge.text);
      } finally {
        await host.close();
        await store.close();
        log.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
