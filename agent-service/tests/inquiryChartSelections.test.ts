import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { BackendClient } from "../src/backendClient.js";
import { createInquiryChartTool, inquiryCharts } from "../src/inquiry/chartTool.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

function fixture() {
  const messages: AgentMessage[] = [{ role: "user", content: "比较经营指标", timestamp: 0 }];
  const evidence = {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: "run",
    execution_turn_id: "op-1",
    metric_descriptors: ["M1", "M2"].map((code) => ({
      code,
      name: code,
      unit: "元",
      value_basis: "当日数",
    })),
    evidence_items: ["M1", "M2"].flatMap((metric) =>
      ["A", "B"].map((org) => ({
        ref: `${metric}.${org}`,
        type: "fact",
        metric_code: metric,
        metric_name: metric,
        org_code: org,
        org_name: org,
        date: "2026-08-31",
        unit: "元",
        value: "1.25",
        display: "1.25元",
      })),
    ),
  };
  const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {
    answerEvidence: () => Promise.resolve([{ ref: "e1", evidence }]),
    turnMessages: () => Promise.resolve(messages),
  });
  async function prepare(refs: string[]) {
    const result = (await runTool(
      createInquiryChartTool(),
      { type: "bar", evidence_refs: refs },
      request,
    )) as Pick<Extract<AgentMessage, { role: "toolResult" }>, "content"> & { details: unknown };
    messages.push({
      role: "toolResult",
      toolName: "analysis_chart",
      toolCallId: `chart-${messages.length}`,
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: messages.length,
    });
    return result;
  }
  return { messages, prepare };
}

describe("本轮选图回执集合", () => {
  it("多次独立选图按本轮顺序保留，引用重排的重复选择只保留首次", async () => {
    const test = fixture();
    await test.prepare(["M1.B", "M1.A"]);
    await test.prepare(["M2.A", "M2.B"]);
    await test.prepare(["M1.A", "M1.B"]);
    expect(inquiryCharts(test.messages).map((item) => item.source_refs)).toEqual([
      ["M1.B", "M1.A"],
      ["M2.A", "M2.B"],
    ]);
  });

  it("忽略旧回合和失败回执，不把失败选择覆盖当前成功图", async () => {
    const test = fixture();
    await test.prepare(["M1.A", "M1.B"]);
    test.messages.push({ role: "user", content: "再比较另一指标", timestamp: 10 });
    await test.prepare(["M2.A", "M2.B"]);
    await test.prepare(["M2.A", "missing"]);
    expect(inquiryCharts(test.messages).map((item) => item.source_refs)).toEqual([
      ["M2.A", "M2.B"],
    ]);
  });

  it("单次多指标选择回执保留全部小图的引用，用于最终来源鉴权", async () => {
    const test = fixture();
    const result = await test.prepare(["M2.B", "M1.A", "M2.A", "M1.B"]);
    expect(result.details).toMatchObject({
      status: "succeeded",
      source_refs: ["M2.B", "M2.A", "M1.A", "M1.B"],
      run_refs: ["run"],
      selection: { type: "bar", evidence_refs: ["M2.B", "M2.A", "M1.A", "M1.B"] },
    });
    expect(inquiryCharts(test.messages)).toHaveLength(1);
  });
});
