import {expect, it} from "vitest";
import type {AgentMessage, Entry} from "@earendil-works/pi-agent-core";
import {reduceRuntime, receiptRole, runtimeToolAdmission} from "../src/runtime/control.js";
import {publicTextProblem, receiptDelivery, RUNTIME_INCOMPLETE} from "../src/runtime/delivery.js";
import {recoveryDecision, RUNTIME_LIMITS} from "../src/runtime/recovery.js";
import type {SemanticPlan} from "../src/semantic-task/store.js";
import {projectEntries, projectWatchEvent} from "../src/sessionProjection.js";
import {hasTurnAction} from "../src/tools/turnContract.js";
import {fixture} from "./semantic-task/fixtures.js";

const receipt = (details: unknown, toolName = "resolve_business_turn", isError = false): Extract<AgentMessage, {role: "toolResult"}> =>
  ({role: "toolResult", toolName, toolCallId: "call-1", details, isError, content: [], timestamp: 1});
const plan = (status: "ready" | "succeeded" | "unknown" = "ready"): SemanticPlan => ({ref: "plan-1", revision: 1,
  owner: "synthetic", operationId: "op-1", intent: "query", originalMessage: "合成问题", status: "active", completion: "unmet", issues: [],
  steps: [{id: "s1", targetRef: "t1", operationId: "op-1", kind: "query", source: {kind: "new"}, sourceQuestion: "合成问题",
    operations: [], dependencies: [], status, required: true, issues: []}]});
const semantic = (status: string) => ({protocol_version: 2, status, state: {targets: [], completion: "unmet"}, issues: [],
  continuation: {actor: "none", action: "stop"}, pending_questions: [], answer_receipts: []});
const entry = (message: unknown, seq: number): Entry => ({id: `e${seq}`, type: "message", seq, timestamp: seq, message} as Entry);

it.each(["analysis_catalog", "catalog", "business_context_read", "business_skill_read", "business_topic_read"])("辅助读取%s不能完成业务动作义务", tool => {
  const message = receipt({kind: tool, status: "succeeded"}, tool);
  expect(receiptRole(message)).toBe("preparation"); expect(hasTurnAction([message])).toBe(false);
  expect(reduceRuntime("合成问题", [message])).toMatchObject({phase: "prepare", execution_complete: false, delivery_complete: false});
});
it("取数完成仍要经过正式交付；准备步骤成功不能冒充完整答案", () => {
  const p = plan("succeeded"), messages = [receipt({kind: "metric_query_structured", status: "succeeded", result_id: "r", public_answer: "合成结果"})];
  const first = reduceRuntime("合成问题", messages, p);
  expect(first).toMatchObject({phase: "verify", completed: 1, execution_complete: true, delivery_complete: false});
  const delivered = receipt({kind: "runtime_delivery", version: 1, operation_id: "op-1", status: "delivered", outcome: "result",
    source_call_ids: ["call-1"], public_answer: "合成结果", history_sources: {tasks: [], organizationScopes: []}}, "runtime_finalize_turn");
  expect(reduceRuntime("合成问题", [...messages, delivered], p, first)).toMatchObject({phase: "deliver", delivery_complete: true});
});
it("计划修订记录版本引用，成功步骤和原目标由现有计划保留", () => {
  const p = plan("succeeded"), initial = reduceRuntime("原目标", [], p);
  const revised = {...p, revision: 2, steps: [...p.steps, {...p.steps[0]!, id: "s2", targetRef: "t2", status: "ready" as const, dependencies: ["s1"]}]};
  const state = reduceRuntime("原目标", [], revised, initial);
  expect(state.goal).toBe("原目标"); expect(state.completed).toBe(1); expect(state.unresolved).toEqual(["t2"]);
  expect(state.revisions.map(item => item.revision)).toEqual([1, 2]);
  expect(reduceRuntime("原目标", [], revised, state).revisions).toEqual(state.revisions);
});
it.each([["unknown", "reconcile_execution"], ["denied", "stop_permission"], ["unsupported", "stop_capability"], ["needs_user", "await_user"]])("%s不能被当成普通参数重试", (status, kind) => {
  const messages = [receipt(semantic(status))];
  expect(recoveryDecision(messages)).toMatchObject({kind, canRetry: false, changeScope: false, preserveEvidence: true});
  expect(reduceRuntime("合成问题", messages, plan("unknown")).execution_complete).toBe(false);
});
it("预算与纠错次数从原生回执恢复，准备读取也计入工具预算", () => {
  const messages = Array.from({length: RUNTIME_LIMITS.toolCalls}, () => receipt({kind: "analysis_catalog", status: "succeeded"}, "analysis_catalog"));
  expect(reduceRuntime("合成问题", messages).budget).toMatchObject({tools_used: 24, tools_left: 0});
});
it.each(["让我构造resolve_business_turn，top_n=null。", "用户提出四项指标，我应该先回答待确认问题，然后调用工具。", "<think>内部内容</think>"])("内部文字不能通过正式正文入口：%s", text => {
  expect(publicTextProblem(text)).toBeTruthy();
  expect(receiptDelivery(receipt({kind: "conversation_reply", status: "answered", answer: text}))).toBeUndefined();
});
it("正常业务分析、条件限定和关键数字不被规划检查误伤", () => {
  expect(publicTextProblem("存款增幅高于贷款，但两者的统计日期不同，需要核对时点后再比较。" )).toBeUndefined();
});
it.each(["frame_v1", "semantic_v2"])("%s历史里的普通文本规划不复活，跨轮也不继承上轮正文", protocol => {
  const user = (text: string) => ({role: "user", businessProtocol: protocol, content: text});
  const planning = {role: "assistant", content: [{type: "text", text: "让我构造resolve_business_turn，top_n=null。"}], stopReason: "stop"};
  const entries = [entry(user("合成问题"), 1), entry(receipt({kind: "analysis_catalog", status: "succeeded"}, "analysis_catalog"), 2), entry(planning, 3)];
  expect(projectEntries(entries).at(-1)).toMatchObject({text: RUNTIME_INCOMPLETE});
  expect(projectWatchEvent({type: "message_update", frame: {type: "text_delta", delta: "内部规划"}})).toBeNull();
});

it("规划文字即使出现在声称已核验的旧报告回执中，也不能由兼容分支重新放出", () => {
  const leak = "让我构造resolve_business_turn，operation=value。";
  const messages = [entry({role: "user", businessProtocol: "semantic_v2", content: "合成问题"}, 1),
    entry(receipt({kind: "business_report", status: "succeeded", answer_policy: "verified_report_v1", public_answer: leak}, "analysis_report_present"), 2)];
  expect(projectEntries(messages).some(message => message.role === "assistant" && message.text.includes(leak))).toBe(false);
});
it("阶段准入阻止无证据报告、交付后的同批追加，以及未知执行结果的自动重跑", () => {
  expect(runtimeToolAdmission([receipt({kind: "analysis_catalog", status: "succeeded"}, "analysis_catalog")], "analysis_report_present"))
    .toMatchObject({terminate: false});
  expect(runtimeToolAdmission([receipt(semantic("unknown"))], "resolve_business_turn")).toMatchObject({terminate: true});
  expect(runtimeToolAdmission([receipt({kind: "conversation_reply", status: "answered", answer: "你好"}, "respond_without_business_action")], "resolve_business_turn"))
    .toMatchObject({terminate: true});
  expect(runtimeToolAdmission([receipt({kind: "analysis_evidence", status: "succeeded"}, "resolve_business_turn")], "analysis_report_present")).toBeUndefined();
});

it("原生账本拒绝同数量但丢失先前回执的并行观察，完整记录到达后再合并", async () => {
  const f = await fixture();
  try {
    const request = f.request("parallel-observation", "合成问题"), store = request.semanticTasks!;
    await store.admit(request.operationId, request.originalMessage);
    const delivered = receipt({kind: "conversation_reply", status: "answered", answer: "你好"}, "respond_without_business_action");
    const stale = {...receipt({kind: "catalog", status: "succeeded"}, "catalog"), toolCallId: "call-2"};
    const before = await store.reconcileRuntime(request.operationId, [delivered]);
    expect(before).toMatchObject({delivery_complete: true, phase: "deliver"});
    expect(await store.reconcileRuntime(request.operationId, [stale])).toEqual(before);
    const complete = await store.reconcileRuntime(request.operationId, [delivered, stale]);
    expect(complete).toMatchObject({delivery_complete: true, phase: "deliver", observed_calls: ["call-1", "call-2"]});
    expect((await store.turn(request.operationId))?.runtime).toEqual(complete);
  } finally {await f.close();}
});
