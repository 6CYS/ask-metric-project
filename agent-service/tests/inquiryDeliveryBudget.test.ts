import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  Type,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import { createInquiryAnswerTool } from "../src/inquiry/runtime.js";
import { createInquiryCalculationTool } from "../src/inquiry/calculationTool.js";
import { projectEntries } from "../src/sessionProjection.js";
import { CONVERSATION_REPLY, createConversationReplyTool } from "../src/tools/turnContract.js";
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

// 重放真实失败的工具次序；仅隔离模型与业务HTTP边界，使用真实宿主、工具和会话投影。
async function replayDelivery(
  scenario:
    | "corrected"
    | "schema"
    | "schema-corrected"
    | "wrong-exit-loop"
    | "full-investigation"
    | "calculated"
    | "calculation-rejected"
    | "empty-query"
    | "oversized",
) {
  const directory = await mkdtemp(join(tmpdir(), "inquiry-delivery-budget-"));
  const store = new NativeSessionStore(directory);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let modelCalls = 0,
    queryCalls = 0,
    reportCalls = 0,
    calculationCalls = 0;
  const contexts: string[] = [];
  const reportPayloads: Record<string, unknown>[] = [];
  const stream: ProviderStreams["streamSimple"] = (_model, context) => {
    contexts.push(JSON.stringify(context.messages));
    const maxCalls = {
      corrected: 4,
      schema: 5,
      "schema-corrected": 4,
      "wrong-exit-loop": 4,
      "full-investigation": 18,
      calculated: 3,
      "calculation-rejected": 3,
      "empty-query": 2,
      oversized: 4,
    }[scenario];
    if (++modelCalls > maxCalls) throw new Error("UNEXPECTED_INQUIRY_CONTINUATION");
    const name = ["calculated", "calculation-rejected"].includes(scenario)
      ? ["metric_query", "analysis_calculate", "analysis_answer"][modelCalls - 1]!
      : scenario === "empty-query"
        ? modelCalls === 1
          ? "metric_query"
          : "analysis_answer"
        : scenario === "schema-corrected"
          ? modelCalls === 1
            ? "metric_query"
            : "analysis_answer"
          : scenario === "full-investigation"
            ? modelCalls <= 16
              ? "metric_query"
              : "analysis_answer"
            : modelCalls === 1
              ? "metric_query"
              : scenario === "wrong-exit-loop" || modelCalls === 2
                ? CONVERSATION_REPLY
                : "analysis_answer";
    const args =
      name === "analysis_calculate"
        ? { current_ref: "e1.v1", base_ref: "e1.v2" }
        : name === "metric_query"
          ? {}
          : name === CONVERSATION_REPLY
            ? {
                answer:
                  scenario === "oversized" ? "重复的未执行参数。".repeat(1600) : "本期余额为10元。",
              }
            : scenario === "calculated"
              ? { body: "差额{{e2.v1}}。" }
              : scenario === "empty-query"
                ? { body: "指定日期没有可用数据，无法计算变化。" }
                : scenario === "schema-corrected"
                  ? {
                      body:
                        modelCalls === 2
                          ? ""
                          : modelCalls === 3
                            ? "存款余额为{{e1.v1}}，较上期增长六成。"
                            : "存款余额为{{e1.v1}}，高于上期的{{e1.v2}}；存款规模有所增加。",
                    }
                  : scenario === "schema"
                    ? { body: "" }
                    : { body: "本期余额为{{e1.v1}}。" };
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${modelCalls}`, name, arguments: args }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
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
  const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
    {
      name: "metric_query",
      label: "查询指标",
      description: "隔离后端查询边界",
      parameters: Type.Object({}),
      execute: async (_id, _input, _update, request) => {
        queryCalls++;
        const runRef = scenario === "full-investigation" ? `run-${queryCalls}` : "run";
        await request.commands.setConversationId("isolated-conversation");
        return {
          content: [
            {
              type: "text",
              text: scenario === "empty-query" ? "指定日期没有可用数据" : "隔离测试引用e1.v1",
            },
          ],
          details: {
            kind: "analysis_evidence",
            status: "succeeded",
            run_ref: runRef,
            scope_id: request.operationId,
            execution_turn_id: request.operationId,
            org_codes: [TEST_ACTOR.org_code],
            tasks: [],
            evidence_items: [
              {
                ref: `${runRef}.f1`,
                type: "fact",
                metric_code: "M1",
                metric_name: "存款余额",
                org_code: TEST_ACTOR.org_code,
                org_name: TEST_ACTOR.org_name,
                date: "2026-08-27",
                unit: "元",
                value: "10",
                display: "10元",
              },
              ...(["calculated", "calculation-rejected", "schema-corrected"].includes(scenario)
                ? [
                    {
                      ref: "run.f2",
                      type: "fact",
                      metric_code: "M1",
                      metric_name: "存款余额",
                      org_code: TEST_ACTOR.org_code,
                      org_name: TEST_ACTOR.org_name,
                      date: "2026-07-27",
                      unit: "元",
                      value: "6",
                      display: "6元",
                    },
                  ]
                : []),
            ],
            ...(scenario === "empty-query"
              ? {
                  row_count: 0,
                  analysis_date: null,
                  evidence_items: [],
                  gaps: ["指定日期没有可用数据"],
                }
              : {}),
          },
        };
      },
    },
    createInquiryCalculationTool(),
    createInquiryAnswerTool(),
    createConversationReplyTool(),
  ];
  const backend = {
    analysisReport: (payload: Record<string, unknown>) => {
      reportCalls++;
      reportPayloads.push(payload);
      if (scenario === "schema-corrected") {
        if (reportCalls === 1) {
          expect(payload).toMatchObject({
            run_refs: ["run"],
            summary: "存款余额为{{run.f1}}，较上期增长六成。",
          });
          return Promise.reject(
            new BackendApiError(
              422,
              "增长比例没有对应计算依据，请保留已查询数值并修正该句。",
              "ANALYSIS_REPORT_NUMBER",
            ),
          );
        }
        const summary =
          payload.fallback === true
            ? "存款余额10元。"
            : "存款余额为10元，高于上期的6元；存款规模有所增加。";
        if (payload.fallback !== true)
          expect(payload).toMatchObject({
            run_refs: ["run"],
            summary: "存款余额为{{run.f1}}，高于上期的{{run.f2}}；存款规模有所增加。",
          });
        return Promise.resolve({
          kind: "business_report",
          status: "succeeded",
          answer_policy: "verified_report_v1",
          public_answer: summary,
          org_codes: [TEST_ACTOR.org_code],
          tasks: [],
          gaps: [],
          report: {
            summary,
            sections: [],
            body_evidence: [{ paragraph: 1, evidence_refs: ["run.f1", "run.f2"] }],
          },
        });
      }
      if (scenario === "empty-query") {
        expect(payload).toMatchObject({
          run_refs: ["run"],
          summary: "指定日期没有可用数据，无法计算变化。",
        });
        return Promise.resolve({
          kind: "business_report",
          status: "succeeded",
          answer_policy: "verified_report_v1",
          public_answer: "指定日期没有可用数据，无法计算变化。",
          org_codes: [TEST_ACTOR.org_code],
          tasks: [],
          report: {
            summary: "指定日期没有可用数据，无法计算变化。",
            sections: [],
            body_evidence: [],
          },
        });
      }
      if (scenario === "calculated") {
        expect(payload).toMatchObject({
          run_refs: ["run"],
          summary: "差额{{calculation.c1.difference}}。",
          calculation_refs: [{ task_id: "task", calculation_id: "c1" }],
        });
        return Promise.resolve({
          kind: "business_report",
          status: "succeeded",
          answer_policy: "verified_report_v1",
          public_answer: "差额4元。",
          org_codes: [TEST_ACTOR.org_code],
          tasks: [],
          report: {
            summary: "差额4元。",
            sections: [],
            body_evidence: [{ paragraph: 1, evidence_refs: ["calculation.c1.difference"] }],
          },
        });
      }
      const runRefs =
        scenario === "full-investigation"
          ? Array.from({ length: 16 }, (_, index) => `run-${index + 1}`)
          : ["run"];
      expect(payload).toMatchObject({
        run_refs: runRefs,
        summary: `本期余额为{{${runRefs[0]}.f1}}。`,
      });
      if (reportCalls === 1 && scenario !== "calculation-rejected")
        return Promise.reject(new BackendApiError(422, "草稿数字无依据", "ANALYSIS_REPORT_NUMBER"));
      return Promise.resolve({
        kind: "business_report",
        status: "succeeded",
        answer_policy: "verified_report_v1",
        public_answer: "本期余额为10元。",
        org_codes: [TEST_ACTOR.org_code],
        tasks: [],
        gaps: [],
        report: {
          summary: "本期余额为10元。",
          sections: [],
          body_evidence: [{ paragraph: 1, evidence_refs: [`${runRefs[0]}.f1`] }],
        },
      });
    },
    analysisCalculate: (payload: Record<string, unknown>) => {
      calculationCalls++;
      expect(payload).toMatchObject({
        conversation_id: "isolated-conversation",
        run_refs: ["run"],
        current_ref: "run.f1",
        base_ref: "run.f2",
      });
      if (scenario === "calculation-rejected")
        return Promise.reject(
          new BackendApiError(
            422,
            "本工具仅比较同一正式指标及口径的两条事实，不支持跨指标运算。",
            "ANALYSIS_CALCULATION_SOURCE",
          ),
        );
      return Promise.resolve({
        kind: "metric_calculate",
        status: "succeeded",
        calculation_ref: { task_id: "task", calculation_id: "c1" },
        run_refs: ["run"],
        inputs: {
          current: { display: "10元", task_id: "task", fact_id: "fact:task:0:metric_value" },
          base: { display: "6元", task_id: "task", fact_id: "fact:task:1:metric_value" },
        },
        limitations: [],
        evidence_items: [
          {
            ref: "calculation.c1.difference",
            type: "calculation",
            name: "difference",
            value: "4",
            unit: "元",
            display: "4元",
            input_refs: ["run.f1", "run.f2"],
          },
        ],
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
  const host = new HarnessHost(config, () => ({ models, model }), store, tools);
  try {
    const session = await host.createSession(TEST_ACTOR);
    const result = await host.runPrompt(
      session,
      { protocol_version: 3, request_id: "delivery-budget", message: "存款余额多少" },
      { actor: TEST_ACTOR, backend },
    );
    expect(result).toMatchObject({ ok: true, outcome: { kind: "settled" } });
    expect(await host.isRunning(session.sessionId)).toBe(false);
    const entries = await session.lane.findEntries(
      { type: "message", order: "oldestFirst", limit: 60 },
      BACKGROUND_CONTEXT,
    );
    const receipts = entries.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    const answers = projectEntries(entries)
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
    await host.closeSession(session.sessionId);
    const reopened = await host.openSession(TEST_ACTOR, session.sessionId);
    if (!reopened) throw new Error("SESSION_NOT_RESTORED");
    const refreshedEntries = await reopened.lane.findEntries(
      { type: "message", order: "oldestFirst", limit: 60 },
      BACKGROUND_CONTEXT,
    );
    return {
      modelCalls,
      queryCalls,
      reportCalls,
      calculationCalls,
      receipts,
      answers,
      contexts,
      reportPayloads,
      projected: projectEntries(entries),
      refreshed: projectEntries(refreshedEntries),
    };
  } finally {
    await host.close();
    await store.close();
    log.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("误用普通出口后的真实宿主交付预算", () => {
  it("正常零行查询保留成功状态并交付缺数说明", async () => {
    const result = await replayDelivery("empty-query");
    expect(result).toMatchObject({
      modelCalls: 2,
      queryCalls: 1,
      reportCalls: 1,
      calculationCalls: 0,
    });
    expect(result.receipts.find((item) => item.toolName === "metric_query")).toMatchObject({
      isError: false,
      details: { status: "succeeded", row_count: 0 },
    });
    expect(result.answers).toContain("指定日期没有可用数据，无法计算变化。");
  });
  it("业务计算拒绝保留失败状态与原因，并允许用已有可靠结果完成回答", async () => {
    const result = await replayDelivery("calculation-rejected");
    expect(result).toMatchObject({
      modelCalls: 3,
      queryCalls: 1,
      calculationCalls: 1,
      reportCalls: 1,
    });
    expect(result.receipts.find((item) => item.toolName === "analysis_calculate")).toMatchObject({
      isError: true,
      details: {
        kind: "metric_calculate",
        status: "error",
        retryable: false,
        error_code: "ANALYSIS_CALCULATION_SOURCE",
      },
    });
    expect(result.contexts[2]).toContain(
      "本工具仅比较同一正式指标及口径的两条事实，不支持跨指标运算。",
    );
    expect(
      result.projected.find((item) => item.role === "tool" && item.tool === "analysis_calculate"),
    ).toMatchObject({ is_error: true });
    expect(result.receipts.find((item) => item.toolName === "metric_query")).toMatchObject({
      isError: false,
    });
    expect(result.answers).toContain("本期余额为10元。");
  });
  it("超长参数校验失败后，模型收到具体约束但不再收到重复参数及回显，仍可修正交付", async () => {
    const result = await replayDelivery("oversized");
    expect(result).toMatchObject({ modelCalls: 4, queryCalls: 1, reportCalls: 2 });
    expect(result.contexts[2]).toContain("answer: must not have more than 4000 characters");
    expect(result.contexts[2]).not.toContain("重复的未执行参数");
    expect(result.contexts[2]).not.toContain("Received arguments:");
    expect(JSON.stringify(result.receipts.find((item) => item.toolCallId === "call-2"))).toContain(
      "重复的未执行参数",
    );
    expect(result.answers).toContain("本期余额为10元。");
    expect(result.answers.join("")).not.toContain("重复的未执行参数");
  });
  it("查询后复用事实计算并交付自然正文，不再次取数", async () => {
    const result = await replayDelivery("calculated");
    expect(result).toMatchObject({
      modelCalls: 3,
      queryCalls: 1,
      calculationCalls: 1,
      reportCalls: 1,
    });
    expect(result.answers).toContain("差额4元。");
    expect(result.receipts.at(-1)?.details).toMatchObject({
      kind: "business_report",
      status: "succeeded",
    });
  });
  it("查询成功后误用普通回复，报告首次失败仍可修正成功", async () => {
    const result = await replayDelivery("corrected");
    expect(result.modelCalls).toBe(4);
    expect(result.queryCalls).toBe(1);
    expect(result.reportCalls).toBe(2);
    expect(result.receipts.find((item) => item.toolCallId === "call-2")).toMatchObject({
      isError: true,
    });
    expect(result.receipts.find((item) => item.toolCallId === "call-3")?.details).toMatchObject({
      kind: "analysis_answer",
      status: "ARGUMENT_ERROR",
      error_code: "ANALYSIS_REPORT_NUMBER",
    });
    expect(result.receipts.find((item) => item.toolCallId === "call-3")?.isError).toBe(true);
    expect(result.receipts.at(-1)?.details).toMatchObject({
      kind: "business_report",
      status: "succeeded",
    });
    expect(result.answers).toContain("本期余额为10元。");
    expect(result.answers).not.toContain("本次未能完成回答，请稍后重试。");
  });

  it("SDK参数失败后仍可局部修正首次正文错误，保留分析且不重复查询", async () => {
    const result = await replayDelivery("schema-corrected");
    expect(result).toMatchObject({ modelCalls: 4, queryCalls: 1, reportCalls: 2 });
    expect(result.receipts.find((item) => item.toolCallId === "call-2")).toMatchObject({
      isError: true,
    });
    expect(result.receipts.find((item) => item.toolCallId === "call-2")?.details).toBeUndefined();
    expect(result.receipts.find((item) => item.toolCallId === "call-3")).toMatchObject({
      isError: true,
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        error_code: "ANALYSIS_REPORT_NUMBER",
      },
    });
    expect(result.contexts[3]).toContain("增长比例没有对应计算依据");
    expect(result.receipts.at(-1)?.details).toMatchObject({
      kind: "business_report",
      status: "succeeded",
    });
    expect(result.answers).toContain("存款余额为10元，高于上期的6元；存款规模有所增加。");
    expect(result.answers).not.toContain("存款余额10元。");
  });

  it("SDK参数持续失败在两次同类拒绝后收敛，不调用报告服务或重复查询", async () => {
    const result = await replayDelivery("schema");
    expect(result.modelCalls).toBe(5);
    expect(result.queryCalls).toBe(1);
    expect(result.reportCalls).toBe(0);
    expect(result.receipts.filter((item) => item.toolName === "analysis_answer")).toHaveLength(2);
    expect(result.receipts.slice(0, -1)).toHaveLength(4);
    expect(result.receipts.at(-1)?.details).toMatchObject({
      kind: "runtime_delivery",
      status: "delivered",
      outcome: "incomplete",
    });
    expect(result.answers).toContain("本次未能完成回答，请稍后重试。");
    expect(result.answers).not.toContain("本期余额为10元。");
  });

  it("连续两次调用已禁止的普通出口后固定交付未完成，不形成长循环", async () => {
    const result = await replayDelivery("wrong-exit-loop");
    expect(result.modelCalls).toBe(4);
    expect(result.queryCalls).toBe(1);
    expect(result.reportCalls).toBe(0);
    expect(result.receipts.at(-1)?.details).toMatchObject({
      kind: "runtime_delivery",
      status: "delivered",
      outcome: "incomplete",
    });
    expect(result.answers).toContain("本次未能完成回答，请稍后重试。");
    expect(result.answers).not.toContain("本期余额为10元。");
  });

  it("完整16次调查后仍保留两次报告机会，第二次成功正常交付", async () => {
    const result = await replayDelivery("full-investigation");
    expect(result.modelCalls).toBe(18);
    expect(result.queryCalls).toBe(16);
    expect(result.reportCalls).toBe(2);
    const runRefs = Array.from({ length: 16 }, (_, index) => `run-${index + 1}`);
    expect(result.reportPayloads.map((payload) => payload.run_refs)).toEqual([runRefs, runRefs]);
    const queryReceipts = result.receipts.filter((item) => item.toolName === "metric_query");
    expect(queryReceipts.map((item) => (item.details as { run_ref: string }).run_ref)).toEqual(
      runRefs,
    );
    expect(
      queryReceipts.map(
        (item) => (item.details as { evidence_items: { ref: string }[] }).evidence_items[0]?.ref,
      ),
    ).toEqual(runRefs.map((ref) => `${ref}.f1`));
    expect(result.refreshed).toEqual(result.projected);
    expect(result.receipts.at(-1)?.details).toMatchObject({
      kind: "business_report",
      status: "succeeded",
    });
    expect(result.answers).toContain("本期余额为10元。");
    expect(result.answers).not.toContain("本次未能完成回答，请稍后重试。");
  });
});
