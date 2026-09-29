/** 解析后就地执行的回执：单块 JSON、按结果给出下一步，且历史轮与普通执行回执一样裁剪行值。 */
import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {landedReceipt} from "./harnessHost.js";
import {projectHistoricalResults} from "./modelContext.js";

const user = {role: "user", content: "再问一次", timestamp: 1} as AgentMessage;
const executed = {
  status: "succeeded", task_id: "t1", result_id: "r1", version: 3, row_count: 2, frame_id: "done-1", result_ref: "query:t1:r1",
  sample_rows: [{org_name: "测试行", metric_value: "private-value-1"}],
  facts: [{fact_id: "fact:t1:0:v", value: "private-fact"}],
  query_evidence: {logical_dsl: {time: {start: "2026-03-31", end: "2026-03-31"}, orgs: ["O"], metrics: ["M"]}},
};
const legacyTail = {type: "text" as const, text: "条件已全部确定，查询已执行（frameId: ready-1）。请直接依据本回执组织回答，不要再向用户确认，也不要重复取数。"};

function landed(receipt: object, extra: Array<{type: "text"; text: string}> = []): AgentMessage {
  return {role: "toolResult", toolName: "resolve_business_turn", toolCallId: "call-1", isError: false, timestamp: 1,
    content: [{type: "text", text: JSON.stringify(receipt)}, ...extra],
    details: {kind: "metric_query_structured", status: receipt && (receipt as {status?: string}).status}} as AgentMessage;
}

describe("历史轮落地回执的发送副本", () => {
  it.each([
    {label: "旧版两段回执", message: landed(executed, [legacyTail])},
    {label: "新版单段回执", message: landed({...executed, ready_frame_id: "ready-1", next_step: "…"})},
  ])("按执行回执裁剪行值与事实，保留引用：$label", ({message}) => {
    const projected = projectHistoricalResults([user, message, user])[1] as Extract<AgentMessage, {role: "toolResult"}>;
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("private-fact");
    expect(serialized).not.toContain("不要重复取数");
    expect(serialized).toContain("r1");
    expect(projected.content).toHaveLength(1);
    // 工具名须与助手 toolCall 一致，分类用的名称不能进入发送副本。
    expect(projected.toolName).toBe("resolve_business_turn");
  });

  it("当前轮落地回执完整保留", () => {
    const message = landed({...executed, ready_frame_id: "ready-1", next_step: "…"});
    expect(projectHistoricalResults([user, message])[1]).toBe(message);
  });

  it("未裁剪的旧版失败回执去掉“查询已执行”的误导说明", () => {
    const message = landed({status: "failed", error_code: "QUERY_FAILED", frame_id: "done-1"}, [legacyTail]);
    const projected = projectHistoricalResults([user, message, user])[1] as Extract<AgentMessage, {role: "toolResult"}>;
    expect(projected.content).toHaveLength(1);
    expect(JSON.stringify(projected)).toContain("QUERY_FAILED");
    expect(JSON.stringify(projected)).not.toContain("查询已执行");
  });

  it("普通解析回执不受影响", () => {
    const resolve = landed({status: "READY", frameId: "ready-1", fields: {metrics: {rawValue: ["余额"], resolutionStatus: "resolved"}},
      next_action: "execute_business_frame"});
    const projected = JSON.parse((projectHistoricalResults([user, resolve, user])[1] as {content: Array<{text: string}>}).content[0]!.text);
    expect(projected).toMatchObject({status: "READY", historical: true});
    expect(projected.next_action).toBeUndefined();
  });
});

describe("落地回执的下一步说明随执行结果变化", () => {
  const content = (receipt: object) => [{type: "text" as const, text: JSON.stringify(receipt)}];
  const parse = (blocks: ReturnType<typeof landedReceipt>) => {
    expect(blocks).toHaveLength(1);
    return JSON.parse((blocks[0] as {text: string}).text) as {next_step: string; ready_frame_id: string; status: string};
  };

  it("成功：依据回执回答，不重复取数", () => {
    const receipt = parse(landedReceipt(content({status: "succeeded"}), "execute_business_frame", "ready-1", {status: "succeeded"}));
    expect(receipt).toMatchObject({status: "succeeded", ready_frame_id: "ready-1"});
    expect(receipt.next_step).toContain("不要重复取数");
  });

  it("结果未确认（可重试）：给出原 frameId 重试，不说已执行", () => {
    const receipt = parse(landedReceipt(content({status: "error", error_code: "BACKEND_503"}), "execute_business_frame", "ready-1",
      {status: "error", retryable: true, error_code: "BACKEND_503"}));
    expect(receipt.next_step).toContain("execute_business_frame（frameId: ready-1）");
    expect(receipt.next_step).not.toContain("查询已执行");
  });

  it("业务失败（不可重试）：如实说明，不声称已取得数据", () => {
    const receipt = parse(landedReceipt(content({status: "failed", error_code: "QUERY_PLAN_INVALID"}), "execute_business_frame", "ready-1",
      {status: "failed", error_code: "QUERY_PLAN_INVALID"}));
    expect(receipt.next_step).toContain("QUERY_PLAN_INVALID");
    expect(receipt.next_step).not.toContain("不要重复取数");
  });

  it("非 JSON 正文也收敛为单块", () => {
    const receipt = parse(landedReceipt([{type: "text", text: "纯文本"}], "read_business_result", "ready-1", {status: "succeeded"}));
    expect(receipt).toMatchObject({ready_frame_id: "ready-1"});
  });
});
