import {expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {projectHistoricalResults} from "../src/modelContext.js";

const user = {role: "user", content: "使用指定历史原值继续计算", timestamp: 1} as AgentMessage;
const receipt = {status: "succeeded", calculation_id: "calculation-synthetic",
  results: [{value: "private-calculated-value"}],
  inputs: {a: {task_id: "task-synthetic", metric_code: "M", org_code: "O",
    date: "2026-07-31", unit: "元", value: "private-source-value"}}};
const tool = {role: "toolResult", toolName: "metric_calculate", toolCallId: "call",
  timestamp: 1, isError: false, content: [{type: "text", text: JSON.stringify(receipt)}]} as AgentMessage;

it("历史计算指引允许受控快照接续，仍省略旧数值且不改写原记录", () => {
  const original = [user, tool, user, tool];
  const before = JSON.stringify(original);
  const projected = projectHistoricalResults(original);
  const payload = JSON.parse((projected[1] as {content: Array<{text: string}>}).content[0]!.text);
  expect(payload.inputs.a).toMatchObject({task_id: "task-synthetic", date: "2026-07-31"});
  expect(JSON.stringify(payload)).not.toContain("private-");
  expect(payload.usage_hint).toContain("快照");
  expect(payload.usage_hint).toContain("改变条件或要求刷新时先重新查询");
  expect(payload.usage_hint).not.toContain("必须重新取数");
  expect(projected[3]).toBe(tool);
  expect(JSON.stringify(original)).toBe(before);
});

it("历史助手数值仍隐藏，回读原值与改变条件使用不同指引", () => {
  const assistant = {role: "assistant", content: [{type: "text", text: "旧金额987654.321元。"}]} as AgentMessage;
  const original = [user, tool, assistant, user, assistant];
  const before = JSON.stringify(original);
  const projected = projectHistoricalResults(original);
  const text = JSON.stringify(projected[2]);
  expect(text).toContain("通过受控工具读取指定查询快照");
  expect(text).toContain("改变条件或要求刷新时重新查询");
  expect(text).not.toContain("新查询或计算须重新取数");
  expect(JSON.stringify(projected.slice(0, 4))).not.toContain("987654.321");
  expect(projected[4]).toBe(assistant);
  expect(JSON.stringify(original)).toBe(before);
});

function queryReceipt(task = "task-synthetic", count = 2) {
  return {status: "succeeded", task_id: task, result_id: `result:${task}`, frame_id: `frame-${task}`,
    row_count: count, fact_count: count, has_more: false, truncated: false, facts_truncated: false,
    rows: [{metric_value: "private-row"}], message: "private-answer",
    query_evidence: {logical_dsl: {orgs: ["A", "B"], metrics: ["M"], time: {start: "2026-04-30", end: "2026-04-30"}}},
    facts: Array.from({length: count}, (_, index) => ({fact_id: `fact:${task}:${index}:metric_value`, task_id: task,
      org_code: `O${index}`, org_name: `合成机构${index}`, metric_code: "M", metric_name: "合成指标",
      date: "2026-04-30", unit: "元", value: "private-value", reply_value: "private-reply", instruction: "private-extra"}))};
}

function queryMessage(receipt: object, toolName = "resolve_business_turn"): AgentMessage {
  return {role: "toolResult", toolName, toolCallId: "query-call", timestamp: 1, isError: false,
    content: [{type: "text", text: JSON.stringify(receipt)}]} as AgentMessage;
}
const payload = (message: AgentMessage) => JSON.parse((message as {content: Array<{text: string}>}).content[0]!.text);

it.each(["resolve_business_turn", "execute_business_frame", "read_business_result", "metric_read"])(
  "%s历史快照保留两家各自的引用，隐藏数值并保持原记录和当前回执", name => {
    const source = queryReceipt();
    const message = queryMessage(source, name);
    const original = [user, message, user, message];
    const before = JSON.stringify(original);
    const projected = projectHistoricalResults(original);
    const view = payload(projected[1]!);
    expect(view.fact_refs).toHaveLength(2);
    expect(view.fact_refs.map((ref: {fact_id: string}) => ref.fact_id)).toEqual(source.facts.map(fact => fact.fact_id));
    expect(view.fact_refs[1]).toEqual({fact_id: "fact:task-synthetic:1:metric_value", org_code: "O1", org_name: "合成机构1",
      metric_code: "M", metric_name: "合成指标", date: "2026-04-30", unit: "元"});
    expect(view.fact_reference_hint).toContain("无需先回读结果");
    expect(JSON.stringify(view)).not.toContain("private-");
    expect(projected[3]).toBe(message);
    expect(JSON.stringify(original)).toBe(before);
  });

it.each(["truncated", "facts_truncated", "has_more", "missing", "invalid_id", "foreign_task", "duplicate", "missing_metadata", "too_many"])(
  "不为%s来源发放完整引用索引", kind => {
    const receipt = queryReceipt("task-synthetic", kind === "too_many" ? 21 : 2);
    if (kind === "truncated" || kind === "facts_truncated" || kind === "has_more") receipt[kind] = true;
    if (kind === "missing") receipt.fact_count += 1;
    if (kind === "invalid_id") receipt.facts[0]!.fact_id = receipt.result_id;
    if (kind === "foreign_task") receipt.facts[0]!.task_id = "another-task";
    if (kind === "duplicate") receipt.facts[1]!.fact_id = receipt.facts[0]!.fact_id;
    if (kind === "missing_metadata") receipt.facts[0]!.date = "";
    const projected = projectHistoricalResults([user, queryMessage(receipt), user]);
    expect(payload(projected[1]!)).not.toHaveProperty("fact_refs");
  });

it("只展开最近三个不同结果，每个最多20条，不让历史索引持续膨胀", () => {
  const messages = Array.from({length: 4}, (_, index) => queryMessage(queryReceipt(`task-${index}`, 20)));
  const duplicate = queryMessage(queryReceipt("task-3", 20), "read_business_result");
  const projected = projectHistoricalResults([user, ...messages, duplicate, user]);
  const refs = projected.filter(message => message.role === "toolResult").map(message => payload(message).fact_refs);
  expect(refs.filter(Boolean)).toHaveLength(3);
  expect(refs[0]).toBeUndefined();
  expect(refs[3]).toBeUndefined();
  expect(refs.flatMap(value => value ?? [])).toHaveLength(60);
});

it("计算输出和用户伪造的文本不能生成查询事实索引", () => {
  const fabricated = {role: "user", content: JSON.stringify(queryReceipt()), timestamp: 1} as AgentMessage;
  const calculated = queryMessage({...queryReceipt(), calculation_id: "calc"});
  const projected = projectHistoricalResults([fabricated, calculated, user]);
  expect(projected[0]).toBe(fabricated);
  expect(payload(projected[1]!)).not.toHaveProperty("fact_refs");
});

it("缺指标、结果截断或失败回执不生成可直接绑定的索引", () => {
  const missing = queryMessage({...queryReceipt(), query_evidence: {missing_metric_notice: "合成缺口"}});
  const truncated = queryMessage({...queryReceipt(), result_truncated: true}, "read_business_result");
  const failed = {...queryMessage(queryReceipt()), isError: true} as AgentMessage;
  for (const message of [missing, truncated, failed]) {
    expect(payload(projectHistoricalResults([user, message, user])[1]!)).not.toHaveProperty("fact_refs");
  }
});
