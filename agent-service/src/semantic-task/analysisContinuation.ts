import type {AskMetricRequestContext} from "../requestContext.js";
import {validateAnalysisPlanShape} from "../analysis/contracts.js";
import type {SemanticRequest} from "./protocol.js";
import type {SemanticPlan} from "./store.js";

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
