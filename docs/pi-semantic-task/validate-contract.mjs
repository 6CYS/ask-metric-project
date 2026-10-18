/** 阶段一协议检查；使用当前 Pi 依赖的验证器，不执行工具、模型或数据库。 */
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = new URL("../../", import.meta.url);
const localRequire = createRequire(new URL("agent-service/package.json", root));
const {Compile} = await import(pathToFileURL(localRequire.resolve("typebox/compile")).href);
// pi-ai 的包入口仅导出 ESM；文档检查位于工作区外层，按已安装入口定位。
const {validateToolArguments} = await import(new URL("agent-service/node_modules/@earendil-works/pi-ai/dist/index.js", root).href);
const read = async name => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const schema = await read("request.schema.json");
const examplesFile = await read("request-examples.json");
const examples = Array.isArray(examplesFile) ? examplesFile : examplesFile.examples;
assert(Array.isArray(examples) && examples.length > 0, "缺少正向样例");
assert.deepEqual(Object.keys(schema.properties).sort(), ["answers", "context_action", "intent", "protocol_version", "targets"]);
assert.equal(schema.additionalProperties, false);
const validate = Compile(schema);
const tool = {name: "resolve_business_turn", description: "阶段一待接入契约", parameters: schema};
const result = {scope: "schema_and_examples_only", runtime_enabled: false, positive: [], negative: [], feedback: [], feedback_negative: [], semantic_guards: []};
for (const example of examples) {
  const request = example.request;
  assert(request, `样例 ${example.id} 缺少 request`);
  assert(validate.Check(request), `${example.id}: ${JSON.stringify([...validate.Errors(request)])}`);
  const accepted = validateToolArguments(tool, {id: example.id, name: tool.name, arguments: request});
  assert.deepEqual(accepted, request, `${example.id}: Pi 验证器不应改变合法提议`);
  result.positive.push({id: example.id, strict_schema: "passed", pi_validator: "passed"});
}

const baseline = examples.find(example => example.request.targets[0]?.source.kind === "new"
  && example.request.targets[0]?.operations?.some(operation => operation.action === "set"));
assert(baseline, "需要包含新建目标和 set 的样例");
const invalid = (id, mutate) => {
  const request = structuredClone(baseline.request);
  mutate(request);
  assert.equal(validate.Check(request), false, `${id}: 非法参数被严格 Schema 接受`);
  let piAccepted = false;
  try {
    validateToolArguments(tool, {id, name: tool.name, arguments: request});
    piAccepted = true;
  } catch { /* 预期形状错误，不向日志输出原始输入。 */ }
  result.negative.push({id, strict_schema: "rejected", pi_validator: piAccepted ? "accepted_with_sdk_normalization" : "rejected"});
};
invalid("legacy_protocol", request => {request.protocol_version = 1;});
invalid("string_protocol_version", request => {request.protocol_version = "2";});
invalid("legacy_base", request => {request.base = "current";});
invalid("missing_targets", request => {delete request.targets;});
invalid("empty_targets", request => {request.targets = [];});
invalid("null_source", request => {request.targets[0].source = null;});
invalid("natural_language_history", request => {request.targets[0].source = {kind: "history", reference: "刚才那次"};});
invalid("partial_reference", request => {request.targets[0].source = {kind: "reference", task_ref: "synthetic-task"};});
invalid("index_metric_value", request => {request.targets[0].operations = [{action: "set", field: "metrics", value: {mentionIndexes: [1]}}];});
invalid("source_text_proof", request => {request.targets[0].operations[0].source_text = "合成原文";});
invalid("expected_count_proof", request => {request.targets[0].operations[0].expected_count = 2;});
invalid("code_value", request => {request.targets[0].operations = [{action: "set", field: "metrics", value: {code: "SYNTHETIC"}}];});
invalid("replace_missing_subject", request => {request.targets[0].operations = [{action: "replace", field: "metrics", value: "合成指标乙"}];});
invalid("exclude_missing_subject", request => {request.targets[0].operations = [{action: "exclude", field: "metrics"}];});
invalid("clear_with_value", request => {request.targets[0].operations = [{action: "clear", field: "metrics", value: "合成指标甲"}];});
invalid("unknown_action", request => {request.targets[0].operations = [{action: "guess", field: "metrics", value: "合成指标甲"}];});
invalid("unknown_field", request => {request.targets[0].operations = [{action: "set", field: "sql", value: "synthetic"}];});

const feedbackSchema = await read("feedback.schema.json");
const feedbackExamples = (await read("feedback-examples.json")).examples;
const validateFeedback = Compile(feedbackSchema);
assert.deepEqual(Object.keys(feedbackSchema.properties).sort(), ["answer_receipts", "continuation", "issues", "pending_questions", "protocol_version", "state", "status"]);
assert.deepEqual(feedbackSchema.definitions.field.enum, schema.definitions.field.enum, "输入与反馈必须使用同一业务槽位");
for (const {id, feedback} of feedbackExamples) {
  assert(validateFeedback.Check(feedback), `${id}: 反馈结构错误`);
  if (feedback.state.task_status === "unbound") {
    assert.equal(feedback.state.task_ref, undefined);
    assert.deepEqual(feedback.state.targets, []);
  } else assert(feedback.state.task_ref, `${id}: 已绑定状态缺少引用`);
  if (["full", "partial_accepted"].includes(feedback.state.completion)) assert.equal(feedback.state.task_status, "completed");
  const expectedContinuation = {
    needs_user: {actor: "user", action: "ask_user"},
    ready: {actor: "host", action: "execute_permitted_step"},
    unknown: {actor: "host", action: "reconcile_execution"},
  }[feedback.status];
  if (expectedContinuation) assert.deepEqual(feedback.continuation, expectedContinuation);
  result.feedback.push({id, schema: "passed", sample_state_consistency: "passed", runtime_tested: false});
}
const invalidFeedback = (id, mutate) => {
  const feedback = structuredClone(feedbackExamples[0].feedback);
  mutate(feedback);
  assert.equal(validateFeedback.Check(feedback), false, `${id}: 非法反馈形状被接受`);
  result.feedback_negative.push({id, schema: "rejected"});
};
invalidFeedback("missing_saved_state", feedback => {delete feedback.state;});
invalidFeedback("legacy_frame_root", feedback => {feedback.frame_id = "synthetic-frame";});
invalidFeedback("unknown_outcome", feedback => {feedback.status = "everything_ok";});
invalidFeedback("unknown_completion", feedback => {feedback.state.completion = "model_said_done";});
invalidFeedback("invalid_retention_type", feedback => {feedback.state.raw_message_retained = "true";});
invalidFeedback("missing_continuation_actor", feedback => {delete feedback.continuation.actor;});
invalidFeedback("unknown_continuation", feedback => {feedback.continuation.action = "run_sql";});
invalidFeedback("missing_issue_code", feedback => {delete feedback.issues[0].code;});

// 引用的真实性、否定归属和任务完整性无法从 JSON 形状推出。
const semanticGuard = structuredClone(baseline.request);
semanticGuard.targets[0].source = {kind: "reference", task_ref: "synthetic-unissued-task", target_ref: "synthetic-unissued-target"};
assert(validate.Check(semanticGuard), "引用形状合法性应独立于 Session 中的真实性");
result.semantic_guards.push({id: "unissued_reference", schema_valid: true, required_runtime_outcome: "reject_reference_no_execution", runtime_tested: false});
const audit = JSON.parse(await readFile(new URL("docs/verification/parameter-stability-audit-20261014/audit.json", root), "utf8"));
const acceptance = await readFile(new URL("acceptance.md", import.meta.url), "utf8");
for (const defect of audit.implementation_defects) {
  assert(acceptance.includes(defect.id), `验收条件漏列 ${defect.id}`);
}
assert.equal(audit.implementation_defects.length, 14);
result.audit_defects_mapped = audit.implementation_defects.length;
result.generated_at = new Date().toISOString();
result.sdk_normalization_requires_strict_prepare = result.negative.some(item => item.pi_validator === "accepted_with_sdk_normalization");
const output = new URL("docs/verification/pi-semantic-task-phase1-20261014/", root);
await mkdir(output, {recursive: true});
await writeFile(new URL("contract-checks.json", output), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({positive: result.positive.length, negative: result.negative.length, feedback: result.feedback.length,
  feedback_negative: result.feedback_negative.length, audit_defects_mapped: result.audit_defects_mapped,
  sdk_normalization_requires_strict_prepare: result.sdk_normalization_requires_strict_prepare,
  runtime_enabled: false, report: fileURLToPath(new URL("contract-checks.json", output))}));
