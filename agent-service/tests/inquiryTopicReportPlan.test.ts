import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../src/backendClient.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import { selectedReportPlan, type SelectedReportPlan } from "../src/inquiry/reportFormat.js";
import { knowledgeTopicRegistry, readKnowledgePlan } from "../src/inquiry/topics/knowledge.js";
import { loadTopicRegistry, validateTopicRegistry } from "../src/inquiry/topics/registry.js";
import { createTopicQueryTool } from "../src/inquiry/topics/tool.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

const layout = () => ({
  title: "经营对比报告",
  sections: [
    { id: "balance", title: "规模", metric_codes: ["P", "SUPPLEMENT"], table: true },
    { id: "advice", title: "建议", metric_codes: [], table: false },
  ],
});
const metric = { code: "P", name: "测试余额", unit: "元", binding_ref: "signed:P" };
const user = (): AgentMessage => ({ role: "user", content: "经营报告", timestamp: 1 });
const message = (details: unknown): AgentMessage => ({
  role: "toolResult",
  toolName: "topic_query",
  toolCallId: "topic",
  timestamp: 2,
  content: [],
  details,
  isError: false,
});
const args = {
  topic_id: "finance",
  scope: "named",
  org_names: ["甲行", "乙行"],
  date: "2026-07-31",
};

interface TopicResult {
  content: [{ type: "text"; text: string }];
  details: {
    kind: string;
    notice?: string;
    topic_execution: { report_plan?: SelectedReportPlan; report_delivery?: string };
  };
}

async function run(setup: ReturnType<typeof fixture>) {
  return (await runTool(setup.tool, args, setup.request)) as TopicResult;
}

function fixture(
  options: { managed?: boolean; bounded?: boolean; reuse?: boolean; layout?: boolean } = {},
) {
  const definition = {
    id: "finance",
    name: "报告",
    description: "按方案逐节分析。",
    ...(options.layout === false ? {} : { report_layout: layout() }),
    metric_keys: ["balance"],
    core_keys: ["balance"],
    rank_keys: ["balance"],
    date_policy: "per_metric_latest",
  };
  const registry = validateTopicRegistry({
    ...loadTopicRegistry(),
    version: "registry-v1",
    limits: { ...loadTopicRegistry().limits, max_model_bytes: options.bounded ? 4000 : 64000 },
    metrics: { balance: { key: "balance", ...metric, change: "value" } },
    topics: [definition],
  });
  const plan = {
    version: "a".repeat(64),
    entry: {
      id: definition.id,
      title: definition.name,
      text: definition.description,
      enabled: true,
      batch_query_enabled: true,
      metric_codes: ["P"],
      ...(options.layout === false ? {} : { report_layout: layout() }),
    },
  };
  const source = {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: "run:finance",
    org_codes: ["A", "B"],
    org_names: [options.bounded ? "甲行".repeat(3000) : "甲行", "乙行"],
    analysis_date: "2026-07-31",
    rows: [],
    facts: [],
    observations: [],
    gaps: [],
    metric_descriptors: [metric],
    evidence_items: [
      {
        type: "fact",
        ref: "p-a",
        metric_code: "P",
        org_code: "A",
        date: "2026-07-31",
        value: "100",
        unit: "元",
        display: "100元",
      },
      {
        type: "fact",
        ref: "p-b",
        metric_code: "P",
        org_code: "B",
        date: "2026-07-31",
        value: "200",
        unit: "元",
        display: "200元",
      },
    ],
    plan: { objective: "报告", requirements: [], steps: [], scope_notice: "指定机构" },
  };
  const messages: AgentMessage[] = [user()];
  const backend = {
    knowledgeAnalysisPlan: vi.fn().mockResolvedValue(plan),
    analysisBindMetrics: vi.fn().mockResolvedValue({ items: [metric] }),
  };
  const request = testRequestContext(
    backend as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      turnMessages: () => Promise.resolve(messages),
      answerEvidence: () => Promise.resolve(options.reuse ? [{ ref: "e1", evidence: source }] : []),
    },
  );
  const execute = vi.fn(() =>
    Promise.resolve({
      content: [],
      details: options.reuse
        ? { kind: "inquiry_query_reuse", status: "succeeded", run_ref: source.run_ref }
        : source,
    }),
  );
  const query: AgentHarnessTool<AskMetricRequestContext> = {
    name: "metric_query",
    label: "查询",
    description: "隔离工具边界",
    parameters: Type.Object({}),
    execute,
  };
  const tool = createTopicQueryTool(query, options.managed ? undefined : registry);
  return { registry, plan, source, messages, backend, request, execute, tool };
}

describe("主题报告方案执行快照", () => {
  it("正式方案读取布局但不扩展基础指标，并拒绝非法章节身份", () => {
    const f = fixture({ managed: true });
    const plan = readKnowledgePlan(f.plan, "finance");
    const compiled = knowledgeTopicRegistry(plan, { items: [metric] }, loadTopicRegistry());
    expect(compiled.registry?.topics[0]?.report_layout).toEqual(layout());
    expect(Object.values(compiled.registry!.metrics).map((item) => item.code)).toEqual(["P"]);
    const invalid = structuredClone(f.plan);
    invalid.entry.report_layout!.sections[1]!.id = "balance";
    expect(() => readKnowledgePlan(invalid, "finance")).toThrow("INVALID_KNOWLEDGE_ANALYSIS_PLAN");
  });

  it.each([false, true])("正常和有界投影均公开固定布局及报告引导：bounded=%s", async (bounded) => {
    const f = fixture({ bounded });
    const result = await run(f);
    const body = JSON.parse(result.content[0].text) as TopicResult["details"];
    const snapshot = result.details.topic_execution.report_plan!;
    expect(snapshot).toEqual({
      id: "finance",
      version: "registry-v1",
      text: "按方案逐节分析。",
      report_layout: layout(),
      org_codes: ["A", "B"],
    });
    expect(body.topic_execution.report_plan).toEqual(snapshot);
    expect(body.topic_execution.report_delivery).toContain("analysis_answer.report");
    expect(body.topic_execution.report_delivery).toContain("section_id");
    if (bounded) expect(body.notice).toContain("模型展示超过预算");
    f.registry.topics[0]!.report_layout!.sections[0]!.title = "后续配置";
    f.source.org_codes.push("C");
    expect(snapshot.report_layout.sections[0]?.title).toBe("规模");
    expect(snapshot.org_codes).toEqual(["A", "B"]);
  });

  it("管理方案保留后端条目版本，补查码不进入正式绑定请求", async () => {
    const f = fixture({ managed: true });
    const result = await run(f);
    expect(result.details.topic_execution.report_plan?.version).toBe(f.plan.version);
    expect(f.backend.analysisBindMetrics.mock.calls[0]?.[0]).toEqual(["P"]);
  });

  it("主题重复执行沿用本轮原快照和实际机构，即使无需重新注入证据", async () => {
    const f = fixture();
    const first = await run(f);
    f.messages.push(message(first.details));
    const reused = await run(f);
    expect(reused.details.kind).toBe("inquiry_query_reuse");
    expect(reused.details.topic_execution.report_plan).toEqual(
      first.details.topic_execution.report_plan,
    );
    expect(selectedReportPlan([...f.messages, message(reused.details)])?.org_codes).toEqual([
      "A",
      "B",
    ]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("底层查询复用仍从真实来源取得机构范围和本次布局", async () => {
    const f = fixture({ reuse: true });
    const result = await run(f);
    expect(result.details.topic_execution.report_plan?.org_codes).toEqual(["A", "B"]);
    expect(result.details.topic_execution.report_plan?.report_layout).toEqual(layout());
  });

  it("上一用户轮的相同主题回执不能自动成为当前轮已完成方案", async () => {
    const f = fixture();
    const first = await run(f);
    f.messages.push(message(first.details), user());
    expect(selectedReportPlan(f.messages)).toBeUndefined();
    await run(f);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("无布局补查保持原回执，不覆盖已选主报告", async () => {
    const main = fixture();
    const first = await run(main);
    const supplement = fixture({ layout: false });
    const second = await run(supplement);
    expect(second.details.topic_execution).not.toHaveProperty("report_plan");
    expect(second.details.topic_execution).not.toHaveProperty("report_delivery");
    expect(selectedReportPlan([user(), message(first.details), message(second.details)])).toEqual(
      first.details.topic_execution.report_plan,
    );
  });
});
