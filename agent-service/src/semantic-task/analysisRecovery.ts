import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {analysisPlanDiagnostics, analysisPlanProblem, type AnalysisPlan, type AnalysisPlanDiagnostic} from "../analysis/contracts.js";
import {resolveCatalogBindings} from "../analysis/bindings.js";
import {isSemanticFeedback, type SemanticFeedback} from "./feedback.js";
import type {SemanticPlanStep, SemanticTurn} from "./store.js";
import {SemanticPlanService} from "./planService.js";
import type {EnhancedAnalysis, SemanticRequest} from "./protocol.js";

export const ANALYSIS_REPAIR = "analysis_plan_repair";
export const MAX_ANALYSIS_REPAIRS = 2;
export interface AnalysisRecoveryFeedback {
  task_ref: string; target_ref: string; revision: number; attempt: number; max_attempts: number;
  diagnostics: AnalysisPlanDiagnostic[];
  requirements: AnalysisPlan["requirements"];
  retained_step_ids: string[];
  next_action: "discover_metrics" | "repair_steps";
}
type Recovery = NonNullable<SemanticTurn["analysisRecovery"]>;

function storedAnalysis(step: SemanticPlanStep): EnhancedAnalysis | undefined {
  const operation = step.operations.find(op => op.field === "_analysis" && op.action === "set");
  if (!operation || !("value" in operation)) return;
  try {return JSON.parse(operation.value) as EnhancedAnalysis;} catch {return;}
}
function diagnostics(request: AskMetricRequestContext, plan: AnalysisPlan): AnalysisPlanDiagnostic[] {
  const result = analysisPlanDiagnostics(plan);
  for (const step of plan.steps) {
    try {resolveCatalogBindings(request, {...plan, steps: [step]});}
    catch {result.push({code: "BINDING_INVALID", requirement_ids: step.answers, step_ids: [step.id], next_action: "discover_metrics"});}
  }
  return result;
}
async function source(request: AskMetricRequestContext, recovery: Recovery) {
  const plan = await request.semanticTasks?.plan(recovery.planRef);
  const step = plan?.steps.find(item => item.targetRef === recovery.targetRef);
  if (!plan || plan.owner !== request.actor.id || plan.operationId !== request.operationId || plan.revision !== recovery.revision
    || !step || !["draft", "blocked"].includes(step.status)) return;
  const analysis = storedAnalysis(step);
  if (analysis?.kind !== "business_analysis") return;
  return {plan, step, analysis};
}
function recoveryFeedback(feedback: SemanticFeedback, recovery: Recovery, plan: AnalysisPlan, problems: AnalysisPlanDiagnostic[]): SemanticFeedback {
  const invalid = new Set(problems.flatMap(item => item.step_ids));
  return {...feedback, status: "needs_interpretation", continuation: {actor: "host", action: "repair_analysis_plan"},
    analysis_recovery: {task_ref: recovery.planRef, target_ref: recovery.targetRef, revision: recovery.revision,
      attempt: recovery.attempts, max_attempts: MAX_ANALYSIS_REPAIRS, diagnostics: problems,
      requirements: plan.requirements.filter(item => problems.some(problem => problem.requirement_ids.includes(item.id))),
      retained_step_ids: plan.steps.filter(step => !invalid.has(step.id)).map(step => step.id),
      next_action: problems.some(item => item.next_action === "discover_metrics") ? "discover_metrics" : "repair_steps"}};
}
function exhausted(feedback: SemanticFeedback, code = "ANALYSIS_REPAIR_EXHAUSTED"): SemanticFeedback {
  const {analysis_recovery: _recovery, ...rest} = feedback;
  return {...rest, status: "failed", continuation: {actor: "none", action: "stop"},
    issues: [{code, category: "input_shape", field: "plan", remediation: "stop",
      message: "分析计划局部修复未完成，原目标及已有证据保留；不能改写范围、删除子问题或放行未校验计划。"}]};
}

/** 修复耗尽不撤销可独立执行的正确步骤；缺口如实记录为未执行，不声称目录无指标。 */
async function remainingAnalysis(request: AskMetricRequestContext, feedback: SemanticFeedback, recovery: Recovery, signal?: AbortSignal): Promise<SemanticFeedback> {
  const saved = await source(request, recovery);
  if (!saved) return exhausted(feedback);
  const rejected = new Set(diagnostics(request, saved.analysis.plan).flatMap(item => item.step_ids));
  let steps = saved.analysis.plan.steps.filter(step => !rejected.has(step.id));
  // 剔除依赖失败步骤的后继，不擅自删除依赖或改变计算含义。
  for (;;) {
    const ids = new Set(steps.map(step => step.id));
    const safe = steps.filter(step => (step.depends_on ?? []).every(id => ids.has(id)));
    if (safe.length === steps.length) break;
    steps = safe;
  }
  if (!steps.length) return exhausted(feedback);
  const answered = new Set(steps.flatMap(step => step.answers));
  const unresolved = saved.analysis.plan.requirements.filter(item => !answered.has(item.id) && !item.gap_reason?.trim());
  const partial: AnalysisPlan = {...saved.analysis.plan, steps, requirements: saved.analysis.plan.requirements.map(item => answered.has(item.id)
    || item.gap_reason?.trim() ? item : {...item, gap_reason: "本次尚未完成该子问题的查询，暂不作判断；不代表数据库没有相关数据。"})};
  if (analysisPlanProblem(partial)) return exhausted(feedback);
  try {resolveCatalogBindings(request, partial);} catch {return exhausted(feedback);}
  const result = await new SemanticPlanService(request, signal).resolve({protocol_version: 2, intent: "analyze", targets: [{
    source: {kind: "reference", task_ref: saved.plan.ref, target_ref: saved.step.targetRef},
    operations: saved.step.operations.filter(op => op.field !== "_analysis"), analysis: {kind: "business_analysis", plan: partial}}]});
  return result.status === "ready" ? {...result, analysis_recovery_partial: {unresolved_requirement_ids: unresolved.map(item => item.id)}} : result;
}

export async function markPartialAnalysis(request: AskMetricRequestContext, feedback: SemanticFeedback): Promise<SemanticFeedback> {
  if (feedback.status !== "succeeded") return feedback;
  const result = exhausted(feedback);
  result.state.completion = "partial";
  if (result.state.task_ref) {
    const plan = await request.semanticTasks?.plan(result.state.task_ref);
    if (plan?.owner === request.actor.id) {
      plan.completion = "partial"; plan.status = "active"; plan.issues = result.issues;
      await request.semanticTasks!.savePlan(plan, (await request.semanticTasks!.planIndex()).version);
    }
  }
  return result;
}

/** 失败提案已在SemanticPlan保存；这里只登记引用与预算，不建立另一份业务计划。 */
export async function recoverAnalysisPlan(request: AskMetricRequestContext, feedback: SemanticFeedback): Promise<SemanticFeedback> {
  if (feedback.status !== "needs_interpretation" || !feedback.state.task_ref || !request.semanticTasks
    || !feedback.issues.length || feedback.issues.some(issue => !["ANALYSIS_PLAN_INVALID", "ANALYSIS_BINDING_INVALID"].includes(issue.code))) return feedback;
  const plan = await request.semanticTasks.plan(feedback.state.task_ref);
  if (!plan || plan.owner !== request.actor.id || plan.operationId !== request.operationId) return feedback;
  const failed = plan.steps.flatMap(step => {
    const analysis = storedAnalysis(step);
    return analysis?.kind === "business_analysis" && ["draft", "blocked"].includes(step.status)
      ? [{step, analysis, problems: diagnostics(request, analysis.plan)}] : [];
  }).filter(item => item.problems.length);
  if (failed.length !== 1) return feedback;
  const item = failed[0]!;
  const recovery = await request.semanticTasks.updateAnalysisRecovery(request.operationId, previous => ({planRef: plan.ref,
    targetRef: item.step.targetRef, revision: plan.revision, attempts: previous?.attempts ?? 0,
    active: (previous?.attempts ?? 0) < MAX_ANALYSIS_REPAIRS}));
  if (!recovery?.active) return exhausted(feedback);
  return recoveryFeedback(feedback, recovery, item.analysis.plan, item.problems);
}

/** 完整重提在恢复中不能覆盖已验证步骤与机构日期；只允许走局部补丁入口。 */
export async function pendingAnalysisRecovery(request: AskMetricRequestContext): Promise<SemanticFeedback | undefined> {
  const recovery = (await request.semanticTasks?.turn(request.operationId))?.analysisRecovery;
  if (!recovery?.active) return;
  const saved = await source(request, recovery);
  const feedback = saved ? await new SemanticPlanService(request).feedback(saved.plan, "needs_interpretation") : undefined;
  if (!feedback) return exhausted({protocol_version: 2, status: "failed", state: {task_status: "active", completion: "unmet",
    raw_message_retained: true, proposals_retained: true, targets: []}, issues: [], pending_questions: [], answer_receipts: [], continuation: {actor: "none", action: "stop"}}, "ANALYSIS_REPAIR_SOURCE_CHANGED");
  return recoveryFeedback(feedback, recovery, saved!.analysis.plan, diagnostics(request, saved!.analysis.plan));
}

export function analysisRecoveryPhase(messages: readonly AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || !isSemanticFeedback(message.details)) continue;
    if (!message.details.analysis_recovery) return;
    const recovery = message.details.analysis_recovery;
    const reads = messages.slice(index + 1).filter(item => item.role === "toolResult" && item.toolName === "analysis_catalog");
    const discovered = reads.some(item => item.role === "toolResult" && !item.isError && (item.details as {status?: string})?.status === "succeeded");
    const tool = recovery.next_action === "discover_metrics" && !discovered && reads.length < 2 ? "analysis_catalog" : ANALYSIS_REPAIR;
    // 优先复用此前目录请求中与缺失子问题相符的关键词；没有匹配时保留完整业务疑问。
    const keywords = [...new Set(messages.flatMap(item => item.role === "toolResult" && item.toolName === "analysis_catalog"
      ? ((item.details as {keywords?: string[]})?.keywords ?? []).filter(word => recovery.requirements.some(req => req.question.includes(word))) : []))];
    return {tool, recovery, discovery: {keywords: (keywords.length ? keywords : recovery.requirements.map(item => item.question)).slice(0, 4).map(word => word.slice(0, 200)), page_size: 30}};
  }
}

/** 模型只提交待修步骤，范围、目标、inquiry与正确步骤全部从原计划合并并再次走完整校验。 */
export async function repairAnalysisPlan(request: AskMetricRequestContext, patch: {task_ref: string; target_ref: string; revision: number; steps: AnalysisPlan["steps"]}, signal?: AbortSignal): Promise<SemanticFeedback> {
  const current = await pendingAnalysisRecovery(request);
  if (!current?.analysis_recovery) throw new Error("ANALYSIS_REPAIR_NOT_PENDING");
  const previous = (await request.semanticTasks!.turn(request.operationId))!.analysisRecovery!;
  const saved = await source(request, previous);
  if (!saved) return exhausted(current, "ANALYSIS_REPAIR_SOURCE_CHANGED");
  const claimed = await request.semanticTasks!.updateAnalysisRecovery(request.operationId, value => {
    if (!value?.active || value.revision !== previous.revision || value.attempts !== previous.attempts) throw new Error("ANALYSIS_REPAIR_CONFLICT");
    return {...value, attempts: value.attempts + 1};
  });
  if (patch.task_ref !== previous.planRef || patch.target_ref !== previous.targetRef || patch.revision !== previous.revision) {
    if (claimed!.attempts >= MAX_ANALYSIS_REPAIRS) {
      await request.semanticTasks!.updateAnalysisRecovery(request.operationId, value => value && ({...value, active: false}));
      return remainingAnalysis(request, current, previous, signal);
    }
    return {...current, analysis_recovery: {...current.analysis_recovery, attempt: claimed!.attempts, next_action: "repair_steps"},
      issues: [{code: "ANALYSIS_REPAIR_REFERENCE_INVALID", field: "plan", category: "reference", remediation: "pi",
        message: "补丁必须引用当前analysis_recovery签发的计划、目标与版本，不能使用历史补丁。"}]};
  }
  const problems = current.analysis_recovery.diagnostics;
  const replace = new Set(problems.flatMap(item => item.step_ids));
  const allowed = new Set(problems.flatMap(item => item.requirement_ids));
  const retained = saved.analysis.plan.steps.filter(step => !replace.has(step.id));
  const collision = new Set(retained.map(step => step.id));
  const invalidPatch = !patch.steps.length || patch.steps.some(step => collision.has(step.id) || !step.answers.length || step.answers.some(id => !allowed.has(id)));
  const originalIds = new Set(saved.analysis.plan.steps.map(step => step.id));
  const merged: AnalysisPlan = {...saved.analysis.plan, steps: [...saved.analysis.plan.steps.flatMap(step => replace.has(step.id)
    ? patch.steps.filter(item => item.id === step.id) : [step]), ...patch.steps.filter(step => !originalIds.has(step.id))]};
  const problem = invalidPatch ? "补丁只能修复指定子问题，不得覆盖正确步骤。" : analysisPlanProblem(merged);
  let bindingError = false;
  if (!problem) {try {resolveCatalogBindings(request, merged);} catch {bindingError = true;}}
  if (problem || bindingError) {
    if (claimed!.attempts >= MAX_ANALYSIS_REPAIRS) {
      await request.semanticTasks!.updateAnalysisRecovery(request.operationId, value => value && ({...value, active: false}));
      return remainingAnalysis(request, current, previous, signal);
    }
    const feedback = recoveryFeedback(current, claimed!, saved.analysis.plan, problems);
    feedback.analysis_recovery!.next_action = bindingError ? "discover_metrics" : "repair_steps";
    feedback.issues = [{code: "ANALYSIS_REPAIR_PATCH_INVALID", field: "plan", category: "input_shape", remediation: "pi",
      message: problem ?? "补丁包含未发现的指标引用，请使用正式目录引用。"}];
    return feedback;
  }
  const operations = saved.step.operations.filter(op => op.field !== "_analysis");
  const input: SemanticRequest = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "reference",
    task_ref: saved.plan.ref, target_ref: saved.step.targetRef}, operations,
    analysis: {kind: "business_analysis", plan: merged}}]};
  const result = await new SemanticPlanService(request, signal).resolve(input);
  await request.semanticTasks!.updateAnalysisRecovery(request.operationId, value => value && ({...value, active: false}));
  return recoverAnalysisPlan(request, result);
}
