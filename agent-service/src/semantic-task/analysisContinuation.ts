import type {AskMetricRequestContext} from "../requestContext.js";
import {validateAnalysisPlanShape} from "../analysis/contracts.js";
import type {SemanticRequest} from "./protocol.js";
import type {SemanticIssue, SemanticPlan, SemanticTurn} from "./store.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import {explicitContextReset} from "./sourceGuard.js";
import {contextService} from "../tools/businessContext.js";

/** 已回读的指标不能脱离来源变成新任务缺项；只退回模型修正，不替用户选择分析对象。 */
export async function analysisQuerySourceIssue(request: AskMetricRequestContext, input: SemanticRequest,
  turn: SemanticTurn, facts: Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>): Promise<SemanticIssue | undefined> {
  const parent = turn.context?.plan, target = input.targets[0];
  if (input.intent !== "query" || input.targets.length !== 1 || target?.source.kind !== "new"
    || explicitContextReset(request.originalMessage) || facts.fragments.some(fragment => fragment.mentions.length)
    || parent?.owner !== request.actor.id || parent.intent !== "analyze" || parent.steps.length !== 1) return;
  const step = parent.steps[0]!, task = turn.context?.tasks.find(item => item.ref === step.taskRef);
  if (task?.owner !== request.actor.id || task.capability !== "business_analysis" || task.target.status !== "succeeded") return;
  const metrics = target.operations.flatMap(operation => operation.field === "metrics" && operation.action === "set"
    ? operation.values ?? [operation.value] : []);
  if (!metrics.length) return;
  let frameId = task.target.frameId;
  if (!frameId) return;
  if (request.frames) {
    const source = await request.frames.get(frameId);
    if (!source || source.sessionId !== request.sessionId) return;
    // 任务保留READY许可引用，回读携带SUCCESS引用；仅统一同会话、同操作的已成功结果。
    const completed = await contextService(request).resultFrame(frameId);
    if (completed?.status !== "success" || completed.sessionId !== request.sessionId
      || completed.operationFrameId !== source.operationFrameId) return;
    frameId = completed.frameId;
  }
  const sources = (await request.answerEvidence?.() ?? []).map(item => item.evidence as AnalysisEvidence)
    .filter(item => item.kind === "analysis_evidence" && item.status === "succeeded" && item.result_reused
      && item.frame_id === frameId);
  if (!sources.some(source => metrics.every(metric => source.metric_descriptors?.some(item => item.name === metric)))) return;
  return {code: "ANALYSIS_CONTINUATION_SOURCE_REQUIRED", category: "reference", remediation: "pi",
    source_options: [{task_ref: parent.ref, target_ref: step.targetRef}],
    message: "本提案的指标来自刚回读的成功分析，不是本轮新条件。请使用source_options的reference继续分析，沿用已核验机构与实际数据日；不要让用户重新补指标和日期。若本轮问机构变化，用analysis.organizations的children_of或保留原集合，正式差额指标用observe读取完整机构明细。未要求前几名不改成需要top_n的排名；只有同口径完整对账后才能称贡献率。"};
}

/** 排名局部修改沿用已核验分析，不因模型切到query就丢失计划里的正式指标。 */
export async function normalizeRankingContinuation(request: AskMetricRequestContext, input: SemanticRequest,
  focus: SemanticPlan | undefined, facts: Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>) {
  if (!["query", "analyze"].includes(input.intent) || input.targets.length !== 1 || request.originalMessage.length > 500
    || input.answers?.length || request.trustedAnswers?.length
    || input.context_action || facts.fragments.some(fragment => fragment.mentions.length || fragment.organizations.length
      || fragment.calendar.ranges.length || fragment.calendar.unresolved.length)) return input;
  const target = input.targets[0]!;
  if (target.source.kind === "new" || target.source.kind === "references" || target.query || target.analysis
    || target.operations.length !== 1) return input;
  const operation = target.operations[0]!;
  if (operation.action !== "set" || operation.field !== "operation" || operation.queryOperation?.kind !== "ranking"
    || operation.queryOperation.position == null || operation.queryOperation.top_n == null) return input;
  const store = request.semanticTasks;
  const source = target.source;
  const parent = source.kind === "reference" ? await store?.plan(source.task_ref) : focus;
  if (!parent || parent.owner !== request.actor.id) return input;
  const selected = source.kind === "reference" ? parent.steps.filter(step => step.targetRef === source.target_ref) : parent.steps;
  if (selected.length !== 1 || !selected[0]?.taskRef) return input;
  if (source.kind === "reference" && !(await store?.planReference(source.target_ref, source.task_ref))) return input;
  const task = await store?.get(selected[0].taskRef);
  const field = task?.target.fields.plan;
  if (task?.owner !== request.actor.id || task.capability !== "business_analysis"
    && (task.capability !== "metric_query" || task.target.fields.metrics?.resolutionStatus === "resolved")
    || field?.resolutionStatus !== "resolved"
    || !validateAnalysisPlanShape(field.resolvedValue)) return input;
  const plan = structuredClone(field.resolvedValue);
  // 多指标或混合分析无法只凭一个排名动作确定要改哪一步，继续交给正常规划。
  if (plan.steps.length !== 1 || plan.steps[0]!.method !== "ranking" || plan.steps[0]!.metric_refs.length !== 1
    || plan.requirements.length !== 1) return input;
  const rank = plan.steps[0]!;
  rank.position = operation.queryOperation.position;
  rank.top_n = operation.queryOperation.top_n;
  rank.rationale = request.originalMessage;
  plan.objective = request.originalMessage;
  plan.requirements[0]!.question = request.originalMessage;
  delete plan.inquiry;
  // 原始提案留在原生调用记录；新执行仍经计划校验、原机构日期及后端权限复核。
  return {...input, intent: "analyze" as const, targets: [{source, operations: [],
    analysis: {kind: "business_analysis" as const, plan}}]};
}
