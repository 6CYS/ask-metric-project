import {expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {projectSemanticFeedback, projectSemanticModelMessages} from "../../src/semantic-task/modelView.js";

const evidence = () => ({kind: "metric_query_structured", status: "succeeded", task_id: "task-a", result_id: "result-a", frame_id: "frame-a",
  columns: ["org_name", "metric_value"], rows: [{org_name: "合成机构甲", metric_value: "9007199254740993.1200", unit: "元"},
    {org_name: "合成机构乙", metric_value: null, unit: "元"}], row_count: 2, truncated: false,
  public_answer: "合成正式说明：含空值", payloads: [{status: "succeeded", task_id: "task-a", result_id: "result-a", frame_id: "frame-a",
    columns: ["org_name", "metric_value"], sample_rows: [{org_name: "合成机构甲", metric_value: "9007199254740993.1200", unit: "元"},
      {org_name: "合成机构乙", metric_value: null, unit: "元"}], row_count: 2, truncated: false, message: "合成正式说明：含空值",
    facts: [{fact_id: "fact-a", value: "9007199254740993.1200", metric_code: "M1", org_code: "O1", date: "2025-12-31", unit: "元"}],
    query_evidence: {logical_dsl: {metrics: ["M1"], orgs: ["O1", "O2"], time: {start: "2025-12-31", end: "2025-12-31"}}, coverage_notice: "乙机构无可用值"},
    has_more: false, next_offset: null, custom_provenance: {receipt: "source-a"}}]});
const feedback = <T>(value: T) => ({protocol_version: 2, status: "succeeded", state: {task_ref: "plan-a", completion: "full",
  targets: [{target_ref: "target-a", conditions: [{field: "organizations", display: "合成机构甲、合成机构乙", origin: "user_explicit"}], pending: []}],
  evidence: value}, issues: [], continuation: {actor: "pi", action: "answer"}});

it("只删完全重复表示，保留精确数值、空值、事实身份、告警、分页及全部目标绑定", () => {
  const original = feedback(evidence()), before = JSON.stringify(original);
  const projected = projectSemanticFeedback(original) as typeof original;
  const view = projected.state.evidence as ReturnType<typeof evidence>;
  expect(view.rows).toEqual(evidence().rows);
  expect(view.payloads[0]).not.toHaveProperty("sample_rows");
  expect(view.payloads[0]).not.toHaveProperty("message");
  expect(view.payloads[0]).not.toHaveProperty("task_id");
  expect(view.payloads[0]).toMatchObject({facts: evidence().payloads[0]!.facts,
    query_evidence: evidence().payloads[0]!.query_evidence, has_more: false, next_offset: null, custom_provenance: {receipt: "source-a"}});
  expect(projected.state.targets).toEqual(original.state.targets);
  expect(projected.continuation).toEqual(original.continuation);
  expect(JSON.stringify(projected).length).toBeLessThan(before.length);
  expect(JSON.stringify(original)).toBe(before);
});

it("父子引用或数据不一致时原样保留差异，不能把不同范围的样本视为重复", () => {
  const value = evidence();
  value.payloads[0]!.result_id = "different-result";
  value.payloads[0]!.sample_rows = [{org_name: "合成机构乙", metric_value: "0", unit: "元"}];
  value.payloads[0]!.message = "另一份结果说明";
  const view = (projectSemanticFeedback(feedback(value)) as ReturnType<typeof feedback>).state.evidence as typeof value;
  expect(view.payloads[0]).toMatchObject({result_id: "different-result", sample_rows: value.payloads[0]!.sample_rows, message: "另一份结果说明"});
});

it("复合结果按各自来源去重，零行目标和混合失败仍单独存在", () => {
  const empty = {...evidence(), task_id: "task-empty", result_id: "result-empty", rows: [], row_count: 0, payloads: [], public_answer: "暂无匹配数据"};
  const failed = {kind: "metric_query_structured", status: "failed", task_id: "task-failed", public_answer: "范围不可用"};
  const bundle = {kind: "semantic_results", status: "partial", results: [evidence(), empty, failed]};
  const value = feedback(bundle); value.state.completion = "partial";
  const view = projectSemanticFeedback(value) as typeof value;
  expect(view.state.evidence.results).toHaveLength(3);
  expect(view.state.evidence.results[1]).toMatchObject({task_id: "task-empty", rows: [], row_count: 0});
  expect(view.state.evidence.results[2]).toEqual(failed);
  expect(view.state.completion).toBe("partial");
});

it("发送副本去重不改原生details、工具配对、未知协议或非JSON正文", () => {
  const receipt = feedback(evidence());
  const original = {role: "toolResult", toolName: "resolve_business_turn", toolCallId: "call-a", timestamp: 1, isError: false,
    details: receipt, content: [{type: "text", text: JSON.stringify(receipt)}]} as AgentMessage;
  const before = JSON.stringify(original);
  const view = projectSemanticModelMessages([original])[0]!;
  expect(view).toMatchObject({role: "toolResult", toolName: "resolve_business_turn", toolCallId: "call-a", details: receipt});
  expect(JSON.stringify(original)).toBe(before);
  const unknown = {...receipt, protocol_version: 3};
  expect(projectSemanticFeedback(unknown)).toBe(unknown);
  const text = {...original, content: [{type: "text", text: "正式直接交付正文"}]} as AgentMessage;
  expect(projectSemanticModelMessages([text])[0]).toBe(text);
});

it("紧凑模型视图完整保留问题版本、选项差异和受理回执", () => {
  const question = {question_id: "q_1", version: 2, scope: {task_ref: "plan-a", target_ref: "target-a", field: "metrics", item_ref: "item-a"},
    prompt: "请选择指标", selection_mode: "single", options: [{option_id: "opt_a", no: 1, label: "同名指标", description: "当日口径"}],
    status: "open", issued_operation_id: "op-a", kind: "choice"};
  const receipt = {question_id: "q_1", version: 1, outcome: "applied", notice: "已确认", selected_options: [{option_id: "opt_old", no: 1, label: "旧指标"}]};
  const projected = projectSemanticFeedback({...feedback(evidence()), pending_questions: [question], answer_receipts: [receipt]}) as Record<string, unknown>;
  expect(projected.pending_questions).toEqual([question]);
  expect(projected.answer_receipts).toEqual([receipt]);
});
