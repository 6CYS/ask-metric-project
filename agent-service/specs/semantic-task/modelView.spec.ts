import {expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {projectSemanticFeedback, projectSemanticModelMessages, appendSemanticRuntimeContext} from "../../src/semantic-task/modelView.js";

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

const analysisReceipt = (kind: "business_overview" | "analysis_evidence") => {
  const body = {kind, status: "succeeded", evidence_ref: "e2", evidence_items: [{ref: "e2.v1", display: "9007199254740993.1200元",
    metric_code: "M1", date: "2025-12-31", unit: "元"}], gaps: ["合成机构乙无记录"], next_action: "按证据交付，保留缺口",
    org_codes: ["O1", "O2"], complete: false, followup_metrics: [{binding_ref: "k1", name: "合成明细"}],
    table_rows: [{value: null}], source_notice: "合成来源", coverage_review: {missing: ["结构"]}};
  return {kind, status: "succeeded", answer_policy: kind === "business_overview" ? "overview_evidence_v2" : "general_analysis_evidence_v1",
    evidence_items: [{ref: "internal-ref", value: "9007199254740993.1200"}], facts: [{fact_id: "f1"}], rows: [{value: "9007199254740993.1200"}],
    calculations: [{input_fact_refs: ["f1"]}], binding_map: {k1: "signed-server-binding"}, candidate_map: {k1: {server_only: true}},
    payloads: [body], custom_provenance: {receipt: "source-a"}, delivery: "analyze"};
};

it.each(["business_overview", "analysis_evidence"] as const)("%s使用工具正式模型正文，引用和补查能力不丢失，存档不变", kind => {
  const original = feedback(analysisReceipt(kind)), before = JSON.stringify(original);
  const projected = projectSemanticFeedback(original) as {state: {evidence: Record<string, unknown>; targets: unknown}};
  const view = projected.state.evidence;
  expect(view).toMatchObject(original.state.evidence.payloads[0]!);
  expect(view).toMatchObject({custom_provenance: {receipt: "source-a"}, delivery: "analyze"});
  for (const field of ["payloads", "facts", "rows", "calculations", "binding_map", "candidate_map"]) expect(view).not.toHaveProperty(field);
  expect(projected.state.targets).toEqual(original.state.targets);
  expect(JSON.stringify(original)).toBe(before);
});

it.each(["missing_body", "missing_ref", "invalid_ref", "missing_atoms", "missing_gaps", "wrong_kind", "failed", "unknown_policy", "multiple_payloads", "scope_conflict", "gap_conflict"])("分析正文不兼容时保留完整内部事实：%s", variant => {
  const value: Record<string, any> = analysisReceipt("analysis_evidence");
  if (variant === "missing_body") value.payloads = [];
  if (variant === "missing_ref") delete value.payloads[0].evidence_ref;
  if (variant === "invalid_ref") value.payloads[0].evidence_ref = "bad-ref";
  if (variant === "missing_atoms") delete value.payloads[0].evidence_items;
  if (variant === "missing_gaps") delete value.payloads[0].gaps;
  if (variant === "wrong_kind") value.payloads[0].kind = "unknown";
  if (variant === "failed") value.status = "failed";
  if (variant === "unknown_policy") value.answer_policy = "future_v3";
  if (variant === "multiple_payloads") value.payloads.push({unique: "another-source"});
  if (variant === "scope_conflict") value.org_codes = ["another-scope"];
  if (variant === "gap_conflict") value.gaps = ["另一来源的缺口"];
  const projected = projectSemanticFeedback(feedback(value)) as {state: {evidence: Record<string, unknown>}};
  expect(projected.state.evidence).toMatchObject({facts: value.facts, rows: value.rows, binding_map: value.binding_map, candidate_map: value.candidate_map});
});

it("多目标混合回执逐一投影，保留普通查询、空记录和失败目标", () => {
  const bundle = {kind: "semantic_results", status: "partial", results: [analysisReceipt("business_overview"), evidence(),
    {kind: "analysis_evidence", status: "failed", error_code: "UPSTREAM_FAILED", gaps: ["目标三未完成"]}]};
  const projected = projectSemanticFeedback(feedback(bundle)) as {state: {evidence: typeof bundle}};
  expect(projected.state.evidence.results).toHaveLength(3);
  expect(projected.state.evidence.results[0]).toHaveProperty("evidence_ref", "e2");
  expect(projected.state.evidence.results[1]).toHaveProperty("rows", evidence().rows);
  expect(projected.state.evidence.results[2]).toEqual(bundle.results[2]);
});

it("动态状态仅追加到发送尾部，历史消息前缀和完整工具配对稳定，原记录及当前授权目录不变", () => {
  const user = {role: "user", content: "合成机构最近情况", timestamp: 1} as AgentMessage;
  const call = {role: "assistant", content: [{type: "toolCall", id: "call-a", name: "read", arguments: {}}]} as AgentMessage;
  const result = {role: "toolResult", toolName: "read", toolCallId: "call-a", isError: false, content: [{type: "text", text: "完整事实"}], timestamp: 2} as AgentMessage;
  const original = [user, call, result], before = JSON.stringify(original);
  const first = appendSemanticRuntimeContext(original, "状态甲", "当前有权机构目录", "尾缀");
  const second = appendSemanticRuntimeContext(original, "状态乙", "当前有权机构目录", "尾缀");
  expect(first.slice(0, -1)).toEqual(second.slice(0, -1));
  expect(first[1]).toBe(call); expect(first[2]).toBe(result);
  expect(first[0]).toMatchObject({content: "合成机构最近情况当前有权机构目录"});
  expect(first.at(-1)).toMatchObject({role: "user", content: expect.stringContaining("状态甲")});
  expect(second.at(-1)).toMatchObject({content: expect.stringContaining("状态乙")});
  expect(JSON.stringify(first.at(-1))).toContain("尾缀");
  expect(JSON.stringify(original)).toBe(before);
  // 下一次授权结果不同仍立即生效，不以缓存节约为理由复用旧权限数据。
  expect(appendSemanticRuntimeContext(original, "状态", "权限已收窄", "")[0]).toMatchObject({content: "合成机构最近情况权限已收窄"});
});
