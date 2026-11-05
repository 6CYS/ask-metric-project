import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  type AgentMessage,
  type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisPlan } from "../src/analysis/contracts.js";
import { currentTurnEvidence } from "../src/answerEvidence.js";
import {
  BackendApiError,
  type AvailabilityRequest,
  type BackendClient,
} from "../src/backendClient.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { inquiryResponse, inquiryToolAdmission } from "../src/inquiry/runtime.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { projectEntries } from "../src/sessionProjection.js";
import { createPartialAnalysisTool, PARTIAL_ANALYSIS } from "../src/tools/partialAnalysis.js";
import { createConversationReplyTool } from "../src/tools/turnContract.js";
import {
  MemoryCommandBridge,
  runTool,
  testRequestContext,
  TEST_ACTOR,
} from "../src/tools/testUtils.js";

const metrics = [
  { code: "M1", name: "贷款市场份额", unit: "%", binding_ref: "signed:M1" },
  { code: "M2", name: "存款余额", unit: "元", binding_ref: "signed:M2" },
];
const names = ["测试甲行", "测试乙行"];
const codes = ["3200", "3201"];
const query = { purpose: "分析贷款市场份额", metric_refs: ["k1"], method: "observe" };
const initialQuery = {
  ...query,
  metric_refs: ["k1", "k2"],
  target_change: {
    mode: "new",
    topic: "市占率与存款",
    organizations: { mode: "replace", scope: "named", names },
    time: { expression: "2026-07-31" },
  },
};
const confirmed = "2026-07-31测试甲行存款余额100元。";

async function executeTool(...args: Parameters<typeof runTool>) {
  const result: unknown = await runTool(...args);
  return result as AgentToolResult<Record<string, unknown>> & { isError?: boolean };
}

// 仅隔离业务 HTTP；目录绑定、目标解析、查询复用和部分交付均执行真实工具。
function backendFixture() {
  return {
    analysisCatalog: vi.fn().mockResolvedValue({ items: metrics }),
    analysisMethods: vi.fn().mockResolvedValue({ methods: [] }),
    createAgentQueryContext: vi.fn().mockResolvedValue({ conversation_id: "conv-1" }),
    resolveBusinessField: vi.fn((entity: string, values: string[]) =>
      Promise.resolve(
        entity === "organization"
          ? {
              status: "resolved",
              value: {
                codes: values.map((value) => codes[names.indexOf(value)] ?? value),
                names: values.map((value) => names[codes.indexOf(value)] ?? value),
              },
            }
          : { status: "resolved", value: { start: values[0], end: values[0] } },
      ),
    ),
    analysisExecute: vi.fn((payload: Record<string, unknown>, key: string) => {
      const plan = payload.plan as AnalysisPlan;
      const requested = metrics.filter((metric) =>
        plan.steps.some((step) => step.metric_refs.includes(metric.binding_ref)),
      );
      const date = typeof payload.start === "string" ? payload.start : "2026-07-31";
      return Promise.resolve({
        kind: "analysis_evidence",
        status: "succeeded",
        run_ref: `analysis:${key}`,
        scope_id: (payload.calculation_context as { scope_id: string }).scope_id,
        conversation_id: "conv-1",
        complete: true,
        plan,
        org_codes: codes,
        analysis_date: date,
        rows: [],
        tasks: [],
        metric_descriptors: requested,
        facts: [],
        observations: [],
        gaps: [],
        evidence_items: requested.flatMap((metric) =>
          codes.map((org_code) => ({
            ref: `${key}:${metric.code}:${org_code}`,
            type: "fact",
            metric_code: metric.code,
            org_code,
            date,
            unit: metric.unit,
            value: metric.code === "M1" ? "0.1" : "100",
            display: metric.code === "M1" ? "比例编码待确认" : "100元",
          })),
        ),
      });
    }),
    dataAvailability: vi.fn((spec: AvailabilityRequest) =>
      Promise.resolve({
        status: "succeeded",
        request: spec,
        mode: "overview",
        metric_count: spec.metric_codes?.length ?? 0,
        org_count: spec.org_codes.length,
        org_names: names,
        metric_names: metrics.map((metric) => metric.name),
        page: spec.page ?? 1,
        page_size: spec.page_size ?? 12,
        notice: "日期记录不证明数值有效。",
        groups: [
          {
            date_count: 1,
            earliest: "2026-07-31",
            latest: "2026-07-31",
            dates: ["2026-07-31"],
            has_more: false,
          },
        ],
      }),
    ),
    analysisReport: vi
      .fn<
        (
          payload: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => Promise<Record<string, unknown>>
      >()
      .mockResolvedValue({
        kind: "business_report",
        status: "succeeded",
        answer_policy: "verified_report_v1",
        public_answer: confirmed,
        columns: [],
        rows: [],
        org_codes: codes,
        tasks: [],
        gaps: [],
        report: {
          summary: confirmed,
          sections: [],
          presentation: { scope: "测试甲行 · 2026-07-31" },
        },
      }),
  };
}

function nextAction(
  name = "metric_query",
  args: Record<string, unknown> = query,
): ReturnType<typeof inquiryResponse> {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "next-call", name, arguments: args }],
    api: "openai-completions",
    provider: "isolated",
    model: "isolated",
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
}

async function fixture() {
  const messages: AgentMessage[] = [];
  const backend = backendFixture();
  const request = testRequestContext(
    backend as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      executionFlow: "inquiry_v1",
      originalMessage: "比较两行贷款市场份额与存款余额并分析原因",
      inquiryTargetContext: { version: 1, time_contract: 2 },
      turnMessages: () => Promise.resolve(messages),
      answerEvidence: () => Promise.resolve(currentTurnEvidence(messages)),
    },
  );
  const tools = createInquiryQueryTools();
  const call = async (name: string, args: unknown) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`缺少真实工具：${name}`);
    const result = await executeTool(tool, args, request);
    messages.push({
      role: "toolResult",
      toolName: name,
      toolCallId: `call-${messages.length}`,
      timestamp: 0,
      content: result.content,
      details: result.details,
      isError: result.isError ?? false,
    });
    return result;
  };
  await call("metric_search", { keywords: metrics.map((metric) => metric.name) });
  await call("metric_query", initialQuery);
  const response = (message = nextAction()) => inquiryResponse(message, request, messages);
  return { request, messages, backend, call, response };
}

describe("已确认重复调查的部分交付", () => {
  it("已有真实口径复用回执后，第三次同来源试探转内部部分交付并重新授权", async () => {
    const f = await fixture();
    const reused = await f.call("metric_query", query);
    expect(reused.details).toMatchObject({
      no_new_evidence: true,
      metadata_blockers: [{ metric_code: "M1" }],
    });
    const next = f.response();
    expect(next.content).toEqual([
      {
        type: "toolCall",
        id: `inquiry-recovery-${f.request.operationId}`,
        name: PARTIAL_ANALYSIS,
        arguments: { reason: "action_incomplete" },
      },
    ]);
    const call = next.content[0];
    if (call?.type !== "toolCall") throw new Error("缺少内部恢复动作");
    expect(
      inquiryToolAdmission(f.messages, call.name, call.arguments, {
        operationId: f.request.operationId,
        toolCallId: call.id,
      }),
    ).toBeUndefined();
    const result = await executeTool(createPartialAnalysisTool(), call.arguments, f.request);
    expect(result).toMatchObject({
      terminate: true,
      details: {
        kind: "business_report",
        status: "succeeded",
        partial_analysis: true,
        fallback_reason: "action_incomplete",
      },
    });
    expect(result.details.public_answer).toContain(confirmed);
    expect(result.details.public_answer).toContain("原问题尚未完整分析");
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(f.backend.analysisReport).toHaveBeenCalledExactlyOnceWith(
      {
        run_refs: currentTurnEvidence(f.messages).map(
          (item) => (item.evidence as { run_ref?: string }).run_ref,
        ),
        summary: "",
        sections: [],
        fallback: true,
      },
      { signal: undefined },
    );
  });

  it("首个查询复用仍留给模型解释或补查，不能提前结束", async () => {
    const f = await fixture();
    const message = nextAction();
    expect(f.response(message)).toBe(message);
    expect(f.backend.analysisReport).not.toHaveBeenCalled();
  });

  it("完整覆盖已经复用后，改变描述或继续缩放已覆盖区间仍交付已有部分", async () => {
    const f = await fixture();
    const args = { metric_refs: ["k1", "k2"] };
    await f.call("metric_availability", args);
    const first = nextAction("metric_availability", {
      ...args,
      start: "2025-01-01",
      end: "2026-11-04",
    });
    expect(f.response(first)).toBe(first);
    const reused = await f.call(
      "metric_availability",
      first.content[0]?.type === "toolCall" ? first.content[0].arguments : {},
    );
    expect(reused.details).toMatchObject({ no_new_evidence: true });
    const next = f.response(
      nextAction("metric_availability", { ...args, start: "1900-01-01", end: "2026-11-04" }),
    );
    expect(next.content).toMatchObject([
      { name: PARTIAL_ANALYSIS, arguments: { reason: "action_incomplete" } },
    ]);
    expect(f.backend.dataAvailability).toHaveBeenCalledOnce();
  });

  it("混合批次包含新的调查时保留整批动作", async () => {
    const f = await fixture();
    await f.call("metric_query", query);
    const message = nextAction();
    message.content.push({
      type: "toolCall",
      id: "new-call",
      name: "metric_query",
      arguments: { ...query, metric_refs: ["k2"], date: "2026-06-30" },
    });
    expect(f.response(message)).toBe(message);
    expect(f.backend.analysisReport).not.toHaveBeenCalled();
  });

  it.each([
    { label: "新指标", args: { ...query, metric_refs: ["k2"] } },
    { label: "新期间", args: { ...query, date: "2026-06-30" } },
    { label: "参数修正", args: { ...query, method: "compare", comparisons: [] } },
  ])("$label保留正式执行器处理", async ({ args }) => {
    const f = await fixture();
    await f.call("metric_query", query);
    const message = nextAction("metric_query", args);
    expect(f.response(message)).toBe(message);
  });

  it("未读完的分页与新范围继续执行", async () => {
    const f = await fixture();
    const args = { metric_refs: ["k1", "k2"], start: "2026-01-01", end: "2026-08-31" };
    await f.call("metric_availability", args);
    await f.call("metric_availability", args);
    const wider = nextAction("metric_availability", { ...args, end: "2026-12-31" });
    expect(f.response(wider)).toBe(wider);
    for (const message of f.messages) {
      if (message.role !== "toolResult" || message.toolName !== "metric_availability") continue;
      const details = message.details as { groups: Array<{ has_more: boolean }> };
      details.groups[0]!.has_more = true;
    }
    const page = nextAction("metric_availability", { ...args, page: 2 });
    expect(f.response(page)).toBe(page);
  });

  it.each(["无本轮来源", "仅历史来源", "已开始新回合"])("%s不能触发部分恢复", async (scenario) => {
    const f = await fixture();
    await f.call("metric_query", query);
    if (scenario === "无本轮来源") {
      f.messages.splice(
        0,
        f.messages.length,
        ...f.messages.filter(
          (message) =>
            message.role !== "toolResult" ||
            (message.details as { kind?: string })?.kind !== "analysis_evidence",
        ),
      );
    } else if (scenario === "仅历史来源") {
      for (const message of f.messages) {
        if (message.role !== "toolResult") continue;
        const evidence = message.details as {
          kind?: string;
          execution_turn_id?: string;
          result_reused?: boolean;
        };
        if (evidence.kind === "analysis_evidence") {
          evidence.execution_turn_id = "old-operation";
          evidence.result_reused = true;
        }
      }
    } else f.messages.push({ role: "user", content: "新的问题", timestamp: 1 });
    const message = nextAction();
    expect(f.response(message)).toBe(message);
    expect(f.backend.analysisReport).not.toHaveBeenCalled();
  });

  it.each([
    "ANALYSIS_REPORT_REFERENCE",
    "ANALYSIS_REPORT_SCOPE",
    "ANALYSIS_REPORT_COVERAGE",
    "ANALYSIS_FORBIDDEN",
  ])("%s未解决时不能把已取数改成成功报告", async (error_code) => {
    const f = await fixture();
    await f.call("metric_query", query);
    f.messages.push({
      role: "toolResult",
      toolName: "analysis_answer",
      toolCallId: "invalid-report",
      timestamp: 0,
      content: [],
      isError: true,
      details: { kind: "analysis_answer", status: "ARGUMENT_ERROR", retryable: true, error_code },
    });
    const message = nextAction();
    expect(f.response(message)).toBe(message);
    const result = await executeTool(
      createPartialAnalysisTool(),
      { reason: "action_incomplete" },
      f.request,
    );
    expect(result).toMatchObject({ terminate: true, details: { status: "failed" } });
    expect(result.details.public_answer).not.toContain(confirmed);
    expect(f.backend.analysisReport).not.toHaveBeenCalled();
  });

  it("模型不能自行伪造内部恢复入口或重复交付", async () => {
    const f = await fixture();
    await f.call("metric_query", query);
    expect(
      inquiryToolAdmission(
        f.messages,
        PARTIAL_ANALYSIS,
        { reason: "action_incomplete" },
        { operationId: f.request.operationId, toolCallId: "model-picked-id" },
      ),
    ).toHaveProperty("block");
    const result = await executeTool(
      createPartialAnalysisTool(),
      { reason: "action_incomplete" },
      f.request,
    );
    f.messages.push({
      role: "toolResult",
      toolName: PARTIAL_ANALYSIS,
      toolCallId: "recovery",
      timestamp: 0,
      content: result.content,
      details: result.details,
      isError: false,
    });
    expect(
      inquiryToolAdmission(
        f.messages,
        PARTIAL_ANALYSIS,
        { reason: "action_incomplete" },
        {
          operationId: f.request.operationId,
          toolCallId: `inquiry-recovery-${f.request.operationId}`,
        },
      ),
    ).toMatchObject({ block: { terminate: true } });
    expect(f.response().content).not.toMatchObject([{ name: PARTIAL_ANALYSIS }]);
    expect(f.backend.analysisReport).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("恢复时后端重新鉴权返回%s，不采用查询缓存数值", async (status) => {
    const f = await fixture();
    await f.call("metric_query", query);
    f.backend.analysisReport.mockRejectedValueOnce(
      new BackendApiError(status, "权限已变化", "ORG_SCOPE_FORBIDDEN"),
    );
    await expect(
      executeTool(createPartialAnalysisTool(), { reason: "action_incomplete" }, f.request),
    ).rejects.toMatchObject({ status, code: "ORG_SCOPE_FORBIDDEN" });
    expect(f.backend.analysisReport).toHaveBeenCalledOnce();
    expect(f.backend.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      fallback: true,
      summary: "",
      sections: [],
    });
  });
});

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

// 原生宿主实际持久化工具回执；模型边界仅按步骤给出动作，不替换被测运行链路。
async function runNativeScenario(
  scenario: "repeated" | "mixed" | "denied" | "query_denied" | "model_failure",
) {
  const directory = await mkdtemp(join(tmpdir(), "inquiry-no-progress-"));
  const store = new NativeSessionStore(directory);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const backend = backendFixture();
  if (scenario === "query_denied") {
    const execute = backend.analysisExecute.getMockImplementation();
    if (!execute) throw new Error("缺少隔离业务执行器");
    backend.analysisExecute
      .mockImplementationOnce(execute)
      .mockRejectedValueOnce(
        new BackendApiError(403, "权限已变化 O_SECRET", "ORG_SCOPE_FORBIDDEN"),
      );
  }
  if (scenario === "denied")
    backend.analysisReport.mockRejectedValueOnce(
      new BackendApiError(403, "权限已变化 O_SECRET", "ORG_SCOPE_FORBIDDEN"),
    );
  let modelCalls = 0;
  const exposedTools: string[][] = [];
  const stream: ProviderStreams["streamSimple"] = (_model, context, options) => {
    modelCalls++;
    if (modelCalls > 5) throw new Error("UNEXPECTED_RECOVERY_LOOP");
    const message =
      modelCalls === 1
        ? nextAction("metric_search", { keywords: metrics.map((metric) => metric.name) })
        : modelCalls === 2
          ? nextAction("metric_query", initialQuery)
          : nextAction();
    const failed = scenario === "model_failure" && modelCalls === 3;
    if (failed) {
      message.content = [{ type: "text", text: "未经核验的草稿987654元。" }];
      message.stopReason = "error";
      message.errorMessage = "upstream unavailable";
    }
    if (["mixed", "query_denied"].includes(scenario) && modelCalls === 4)
      message.content.push({
        type: "toolCall",
        id: "new-source",
        name: "metric_query",
        arguments: { ...query, metric_refs: ["k2"], date: "2026-06-30" },
      });
    message.timestamp = Date.now();
    for (const call of message.content)
      if (call.type === "toolCall") call.id = `${call.id}-${modelCalls}`;
    const events = createAssistantMessageEventStream();
    void (async () => {
      const payload = {
        messages: context.messages,
        tools: context.tools?.map((tool) => ({
          type: "function",
          function: { name: tool.name, parameters: tool.parameters },
        })),
      };
      const sent = ((await options?.onPayload?.(payload, model)) ?? payload) as typeof payload;
      exposedTools.push(sent.tools?.map((tool) => tool.function.name) ?? []);
      events.push({ type: "start", partial: message });
      if (failed) events.push({ type: "error", reason: "error", error: message });
      else events.push({ type: "done", reason: "toolUse", message });
      events.end(message);
    })().catch((error) =>
      events.end({ ...message, stopReason: "error", errorMessage: String(error) }),
    );
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
    createPartialAnalysisTool(),
    createConversationReplyTool(),
  ]);
  try {
    const session = await host.createSession(TEST_ACTOR);
    const result = await host.runPrompt(
      session,
      {
        protocol_version: 3,
        request_id: scenario,
        message: "比较测试甲行与测试乙行的贷款市场份额与存款余额并分析原因",
      },
      { actor: TEST_ACTOR, backend: backend as unknown as BackendClient },
    );
    expect(await host.isRunning(session.sessionId)).toBe(false);
    const entries = await session.lane.findEntries(
      { type: "message", order: "oldestFirst" },
      BACKGROUND_CONTEXT,
    );
    const receipts = entries.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    const answers = projectEntries(entries)
      .filter((message) => message.role === "assistant")
      .map((message) => message.text)
      .join("\n");
    expect(answers).not.toMatch(/987654|O_SECRET/);
    for (const tools of exposedTools) expect(tools).not.toContain(PARTIAL_ANALYSIS);
    return { result, backend, modelCalls, receipts, answers };
  } finally {
    await host.close();
    await store.close();
    log.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("原生宿主重复调查恢复", () => {
  it.each(["repeated", "mixed", "model_failure"] as const)(
    "%s通过真实工具回执结束为已核验的部分结果",
    async (scenario) => {
      const result = await runNativeScenario(scenario);
      expect(result.modelCalls).toBe(
        scenario === "mixed" ? 5 : scenario === "model_failure" ? 3 : 4,
      );
      expect(result.backend.analysisExecute).toHaveBeenCalledTimes(scenario === "mixed" ? 2 : 1);
      if (scenario === "mixed")
        expect(result.backend.analysisExecute.mock.calls[1]?.[0]).toMatchObject({
          start: "2026-06-30",
          end: "2026-06-30",
          org_codes: codes,
        });
      expect(result.backend.analysisReport).toHaveBeenCalledOnce();
      const recovery = result.receipts.filter((receipt) => receipt.toolName === PARTIAL_ANALYSIS);
      expect(recovery).toHaveLength(1);
      expect(recovery[0]?.details).toMatchObject({
        status: "succeeded",
        partial_analysis: true,
        fallback_reason: scenario === "model_failure" ? "model_failure" : "action_incomplete",
      });
      expect(result.answers).toContain(confirmed);
      expect(result.answers).toContain("原问题尚未完整分析");
      expect(result.result).toMatchObject({
        ok: true,
        outcome: { kind: "settled", outcome: { status: "completed" } },
      });
    },
  );

  it("部分交付重新授权403后停止，无事实外泄或模型续跑", async () => {
    const result = await runNativeScenario("denied");
    expect(result.modelCalls).toBe(4);
    expect(result.backend.analysisReport).toHaveBeenCalledOnce();
    expect(result.receipts.filter((receipt) => receipt.toolName === PARTIAL_ANALYSIS)).toHaveLength(
      1,
    );
    expect(result.answers).not.toContain(confirmed);
    expect(result.answers).not.toContain("100");
  });

  it("已有复用回执后必要补查遭权限拒绝，不能越过权限失败恢复旧事实", async () => {
    const result = await runNativeScenario("query_denied");
    expect(result.modelCalls).toBe(4);
    expect(result.backend.analysisExecute).toHaveBeenCalledTimes(2);
    expect(result.backend.analysisReport).not.toHaveBeenCalled();
    expect(result.receipts.some((receipt) => receipt.toolName === PARTIAL_ANALYSIS)).toBe(false);
    expect(result.answers).not.toContain(confirmed);
    expect(result.answers).not.toContain("100");
  });
});
