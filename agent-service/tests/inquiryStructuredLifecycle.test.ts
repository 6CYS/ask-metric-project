import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT, value } from "@earendil-works/pi-agent-core";
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
import type { FieldResolution } from "../src/business-context/types.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost, type PromptInput, type RequestAssociation } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { projectEntries } from "../src/sessionProjection.js";
import { createAskMetricTools } from "../src/tools/index.js";
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

describe("旧卡片选择进入统一 inquiry 的跨层链路", () => {
  it("已确认条件从受理传到实际查询与回答，模型不能改写指标、机构和日期", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inquiry-structured-lifecycle-"));
    const store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const descriptor = {
      code: "M_CONFIRMED",
      name: "正式存款余额",
      unit: "元",
      binding_ref: "signed:confirmed:fresh",
    };
    const task = {
      task_id: "legacy-task",
      conversation_id: "legacy-conversation",
      version: 4,
      status: "WAITING_USER" as const,
      resolved_question: "乙行2026年8月末存款余额",
      clarification: {
        id: "legacy-card",
        fields: [{ type: "metric" }],
        understood: { orgs: ["乙行"], time: "2026年8月末" },
      },
    };
    const answer = "乙行2026年8月末正式存款余额为100.00元。";
    const backend = {
      getTask: vi.fn(() => Promise.resolve(task)),
      resolveBusinessField: vi.fn((field: string, values: string[]): Promise<FieldResolution> => {
        if (field === "metric" && values.join() === descriptor.code)
          return Promise.resolve({
            status: "resolved",
            value: { codes: [descriptor.code], names: [descriptor.name] },
          });
        if (field === "organization" && ["乙行", "O_CONFIRMED"].includes(values.join()))
          return Promise.resolve({
            status: "resolved",
            value: { codes: ["O_CONFIRMED"], names: ["乙行"] },
          });
        if (field === "date" && values.join() === "2026年8月末")
          return Promise.resolve({
            status: "resolved",
            value: { start: "2026-08-31", end: "2026-08-31" },
          });
        throw new Error(`非已确认条件进入后端解析: ${field}`);
      }),
      analysisCatalog: vi
        .fn<BackendClient["analysisCatalog"]>()
        .mockResolvedValue({ items: [descriptor], total: 1, page: 1, page_size: 30 }),
      createAgentQueryContext: vi.fn(() =>
        Promise.resolve({ conversation_id: "inquiry-conversation" }),
      ),
      analysisExecute: vi.fn((payload: Record<string, unknown>) =>
        Promise.resolve({
          kind: "analysis_evidence",
          status: "succeeded",
          run_ref: "structured-run",
          conversation_id: payload.conversation_id,
          analysis_date: "2026-08-31",
          actual_dates: ["2026-08-31"],
          org_codes: ["O_CONFIRMED"],
          tasks: [],
          rows: [],
          metric_descriptors: [descriptor],
          plan: payload.plan,
          evidence_items: [
            {
              ref: "structured-run.f1",
              type: "fact",
              metric_code: descriptor.code,
              metric_name: descriptor.name,
              org_code: "O_CONFIRMED",
              org_name: "乙行",
              date: "2026-08-31",
              unit: "元",
              value: "100.00",
              display: "100.00元",
            },
          ],
        }),
      ),
      analysisReport: vi.fn<BackendClient["analysisReport"]>().mockResolvedValue({
        kind: "business_report",
        status: "succeeded",
        delivery: "business_evidence_v1",
        answer_policy: "verified_report_v1",
        org_codes: ["O_CONFIRMED"],
        tasks: [],
        public_answer: answer,
        report: {
          summary: answer,
          sections: [],
          body_evidence: [{ paragraph: 1, evidence_refs: ["structured-run.f1"] }],
        },
      }),
    };
    let modelCalls = 0;
    const modelInputs: string[] = [];
    const stream: ProviderStreams["streamSimple"] = (_model, context) => {
      modelCalls++;
      if (modelCalls > 2) throw new Error("STRUCTURED_INQUIRY_RETRY_LOOP");
      modelInputs.push(JSON.stringify(context.messages));
      const querying = modelCalls === 1;
      const message: AssistantMessage = {
        role: "assistant",
        content: querying
          ? [
              {
                type: "toolCall",
                id: "wrong-model-conditions",
                name: "metric_query",
                arguments: {
                  purpose: "查询余额",
                  metric_refs: ["M_WRONG"],
                  scope: "named",
                  org_names: ["O_WRONG"],
                  date: "2026-07-31",
                  method: "observe",
                },
              },
            ]
          : [{ type: "text", text: "乙行2026年8月末正式存款余额为{{e1.v1}}。" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: querying ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const result = createAssistantMessageEventStream();
      result.push({ type: "start", partial: message });
      result.push({ type: "done", reason: querying ? "toolUse" : "stop", message });
      result.end(message);
      return result;
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
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id,
      AGENT_DATA_DIR: directory,
      AGENT_COMPACTION_ENABLED: "false",
      AGENT_MODEL_RETRY_ENABLED: "false",
    });
    const host = new HarnessHost(config, () => ({ models, model }), store, createAskMetricTools());
    try {
      const session = await host.createSession(TEST_ACTOR);
      // 只构造旧版持久化回执；入场、模型钩子、查询与回答工具、Pi 落盘及投影均用实际实现。
      await session.lane.appendMessage(
        { role: "user", content: task.resolved_question, timestamp: 0 },
        BACKGROUND_CONTEXT,
      );
      await session.lane.appendMessage(
        {
          role: "toolResult",
          toolName: "metric_ask",
          toolCallId: "published-legacy-card",
          content: [],
          details: { kind: "metric_ask", ...task },
          isError: false,
          timestamp: 1,
        },
        BACKGROUND_CONTEXT,
      );
      const input: PromptInput = {
        protocol_version: 3,
        request_id: "selected-card",
        message: "",
        clarification_target: {
          task_id: task.task_id,
          version: task.version,
          clarification_id: task.clarification.id,
        },
        selected_answers: {
          set: { metrics: [{ code: descriptor.code, name: "旧页面显示名" }] },
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
          inquiryAdmission: {
            targets: [
              {
                metrics: { codes: [descriptor.code], names: [descriptor.name] },
                organizations: { codes: ["O_CONFIRMED"] },
                time: { start: "2026-08-31", end: "2026-08-31" },
                pending: [],
              },
            ],
          },
        },
      });
      if (!admitted.ok) throw new Error(admitted.message);
      expect(await host.drivePrompt(session, admitted)).toMatchObject({
        ok: true,
        outcome: { kind: "settled", outcome: { status: "completed" } },
      });
      expect(modelCalls).toBe(2);
      expect(modelInputs[0]).toContain("用户已确认的查询目标");
      expect(modelInputs[0]).toContain(descriptor.code);
      expect(backend.analysisCatalog.mock.calls).toHaveLength(1);
      expect(backend.analysisCatalog).toHaveBeenCalledWith(
        descriptor.code,
        1,
        30,
        expect.anything(),
      );
      expect(backend.analysisExecute).toHaveBeenCalledTimes(1);
      expect(backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
        execution_mode: "inquiry",
        org_codes: ["O_CONFIRMED"],
        start: "2026-08-31",
        end: "2026-08-31",
        date_selection: "exact",
        plan: { steps: [{ metric_refs: [descriptor.binding_ref] }] },
        calculation_context: { scope_id: admitted.operationId },
      });
      expect(backend.resolveBusinessField.mock.calls.filter(([field]) => field === "date")).toEqual(
        [
          [
            "date",
            ["2026年8月末"],
            undefined,
            undefined,
            expect.objectContaining({ source_question: "2026年8月末" }),
          ],
        ],
      );
      expect(backend.analysisReport).toHaveBeenCalledTimes(1);
      expect(backend.analysisReport.mock.calls[0]![0]).toMatchObject({
        run_refs: ["structured-run"],
        summary: "乙行2026年8月末正式存款余额为{{structured-run.f1}}。",
      });
      const entries = await session.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
      const queries = entries.flatMap((entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "metric_query"
          ? [entry.message]
          : [],
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]?.details).toMatchObject({
        inquiry_target: {
          target_ref: task.task_id,
          metric_codes: [descriptor.code],
          organizations: { codes: ["O_CONFIRMED"] },
          time: { start: "2026-08-31", end: "2026-08-31" },
        },
      });
      const projected = projectEntries(entries);
      expect(
        projected.filter((message) => message.role === "assistant" && message.text === answer),
      ).toHaveLength(1);
      expect(
        projected.find((message) => message.role === "tool" && message.tool === "analysis_answer"),
      ).toMatchObject({
        is_error: false,
        details: { kind: "business_report", status: "succeeded", public_answer: answer },
      });
      expect(
        (
          await session.session.getValue(
            value<RequestAssociation>("askmetric", "request/selected-card"),
            BACKGROUND_CONTEXT,
          )
        )?.value,
      ).toMatchObject({
        executionFlow: "inquiry_v1",
        inquiryAdmission: admitted.request.inquiryAdmission,
      });
      expect(await host.runPrompt(session, input, deps)).toMatchObject({
        ok: true,
        outcome: { kind: "settled", outcome: { status: "completed" } },
      });
      expect(modelCalls).toBe(2);
      expect(backend.analysisExecute).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
      await store.close();
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
