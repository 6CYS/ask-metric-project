import {isDeepStrictEqual} from "node:util";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {FieldCandidate, ResolvedField} from "../business-context/types.js";
import {BusinessInputError} from "../business-context/inputError.js";
import type {ContextDelta} from "../business-context/types.js";
import {isSemanticFeedback, semanticPublicAnswer, type SemanticFeedback} from "./feedback.js";
import type {SemanticTask} from "./store.js";
import {analysisCandidates, analysisDiscoveryRounds, catalogBindingState, type AnalysisCandidate, type QueryRecoveryCatalogSource} from "../analysis/bindings.js";
import {compileQueryRequest} from "./structuredQuery.js";
import {completeRankingSteps, type AnalysisPlan} from "../analysis/contracts.js";
import type {SemanticOperation, SemanticRequest} from "./protocol.js";
import type {TurnFacts} from "./actionBinding.js";
import {normalizeInputEvidence} from "../business-context/inputEvidence.js";
import {comparisonPeriodsOnly, overviewTimeExpression, recentOverviewExpression} from "../business-context/overviewPolicy.js";

export const MAX_QUERY_RECOVERY_ROUNDS = 2;
export interface QueryRecoveryFeedback {
  attempt: number; max_attempts: number; original_goal: string; unresolved_metrics: string[];
  retained_conditions: SemanticFeedback["state"]["targets"];
  fallback_answer: string;
  previous_metrics?: Array<{target_ref: string; names: string[]; base_names: string[]}>;
  metric_alternatives?: Array<{target_ref: string; metric: string; candidates: Array<{code: string; name: string}>}>;
}

/** 只给本轮唯一未知指标的正式发现附上来源；歧义和已确定指标仍由原流程处理。 */
export async function queryRecoveryCatalogSource(request: AskMetricRequestContext): Promise<QueryRecoveryCatalogSource | undefined> {
  const operationId = request.semanticStep?.rootOperationId ?? request.operationId;
  const turn = await request.semanticTasks?.turn(operationId), recovery = turn?.queryRecovery;
  if (!recovery || recovery.scopes.length !== 1 || turn?.answerSnapshots?.length) return;
  const plan = await request.semanticTasks?.plan(recovery.planRef), scope = recovery.scopes[0]!;
  const metric = scope.fields.metrics;
  if (!plan || plan.owner !== request.actor.id || plan.operationId !== operationId || plan.intent !== "query"
    || plan.steps.length !== 1 || !["draft", "blocked"].includes(plan.steps[0]!.status)
    || metric && (!["missing", "not_found"].includes(metric.resolutionStatus) || metric.candidates?.length)
    || (scope.fields.operation?.resolvedValue as {kind?: string})?.kind !== "value"
    || scope.fields.comparison_organizations?.resolutionStatus === "resolved") return;
  return {operation_id: operationId, plan_ref: plan.ref, step_id: plan.steps[0]!.id, target_ref: scope.targetRef,
    original_message: plan.originalMessage, metric_expression: typeof metric?.rawValue === "string" ? metric.rawValue : plan.originalMessage};
}

/** 模型选择正式条目，宿主核对本轮来源；不把目录中的所有候选视为用户已确认。 */
export async function recoveredQueryMetric(request: AskMetricRequestContext, task: SemanticTask,
  operations: SemanticOperation[], facts: TurnFacts | undefined): Promise<AnalysisCandidate | undefined> {
  const source = await queryRecoveryCatalogSource(request);
  if (!source || task.parentPlan !== source.plan_ref || request.semanticStep?.planRef !== source.plan_ref
    || request.semanticStep.analysis || request.semanticStep.kind !== "query"
    || !facts || facts.question !== source.original_message || facts.fragments.length !== 1
    || facts.fragments[0]!.mentions.length) return;
  const plan = await request.semanticTasks!.plan(source.plan_ref);
  // target_ref 在计划修订时会变化；同一计划的稳定步骤与子操作才是续接依据。
  if (plan?.steps[0]?.operationId !== request.operationId) return;
  const proposed = operations.filter(operation => operation.field === "metrics");
  if (proposed.length !== 1 || proposed[0]!.action !== "set") return;
  const operation = proposed[0]!, names = "values" in operation && operation.values ? operation.values : [operation.value];
  if (names.length !== 1) return;
  const name = normalizeInputEvidence(names[0]!), bindings = catalogBindingState(request);
  const eligible = analysisCandidates(request).filter(candidate =>
    [candidate.name, candidate.code].some(value => normalizeInputEvidence(value) === name)
    && ["exact", "contains", "lexical", "domain_mapping"].includes(candidate.match_type ?? "")
    && isDeepStrictEqual(candidate.query_recovery, source)
    && !!bindings[candidate.binding_ref] && bindings[candidate.binding_ref] === bindings[`code:${candidate.code}`]);
  return eligible.length === 1 ? eligible[0] : undefined;
}

/** 只将可独立查询的相关正式候选交给发现，不把基础指标身份或不同日期的选择直接合并。 */
export function parallelMetricAlternatives(field: ResolvedField | undefined, question: string) {
  if (!field || !["ambiguous", "needs_confirmation"].includes(field.resolutionStatus)
    || /先(?:让我|请我)?(?:确认|选择)|只(?:查|要|选)(?:一个|一种)|不要(?:展开|并列|多个)/u.test(question)) return [];
  const candidates = field.candidates ?? [];
  if (candidates.some(item => ["base", "base_only"].includes(String(item.metadata?.kind)) || item.metadata?.calendar)) return [];
  const formal = candidates.filter((item): item is FieldCandidate & {code: string; value: string} =>
    typeof item.code === "string" && !!item.code && typeof item.value === "string" && !!item.value.trim());
  const unique = [...new Map(formal.map(item => [item.code, {code: item.code, name: item.value}])).values()];
  if (formal.length !== candidates.length || unique.length < 2 || unique.length > 12) return [];
  const raw = Array.isArray(field.rawValue) && field.rawValue.length === 1 ? field.rawValue[0] : field.rawValue;
  const related = typeof raw === "string" && raw.trim().length >= 2 && unique.every(item => item.name.includes(raw.trim()));
  const overview = /信息|情况|概况|概览|表现|现状|怎么样|如何|分析|了解|看看|都查|全部|分别|一起/u.test(question);
  return related || overview ? unique : [];
}

/** 目录工具按可信冻结候选补引用，不再要求模型反复搜索名称或猜测分页。 */
export async function recoveryMetricCandidates(request: AskMetricRequestContext) {
  const recovery = (await request.semanticTasks?.turn(request.operationId))?.queryRecovery;
  if (!recovery) return [];
  const plan = await request.semanticTasks?.plan(recovery.planRef);
  if (!plan || plan.owner !== request.actor.id || plan.operationId !== request.operationId
    || plan.steps.some(step => !["draft", "blocked"].includes(step.status))) return [];
  return [...new Map(recovery.scopes.flatMap(scope => parallelMetricAlternatives(scope.fields.metrics, plan.originalMessage))
    .map(item => [item.code, item])).values()];
}

/** 目录已齐备时，原目标的普通重提可确定性展开为并列读取；不采纳模型自选，不改范围或用户真实回复。 */
export async function normalizeParallelMetricProposal(request: AskMetricRequestContext, input: SemanticRequest): Promise<SemanticRequest> {
  if (input.intent !== "query" || input.targets.length !== 1 || request.trustedAnswers?.length) return input;
  const target = input.targets[0]!;
  if (target.analysis || input.context_action && input.context_action !== "resume") return input;
  const recovery = (await request.semanticTasks?.turn(request.operationId))?.queryRecovery;
  if (recovery?.scopes.length !== 1) return input;
  const plan = await request.semanticTasks?.plan(recovery.planRef);
  if (!plan || plan.owner !== request.actor.id || plan.operationId !== request.operationId
    || plan.steps.length !== 1 || plan.steps.some(step => !["draft", "blocked"].includes(step.status))) return input;
  if (target.source.kind === "references" || target.source.kind === "reference"
    && (target.source.task_ref !== plan.ref || target.source.target_ref !== plan.steps[0]!.targetRef)) return input;
  const frozen = recovery.scopes[0]!.fields;
  if ((frozen.operation?.resolvedValue as {kind?: string})?.kind !== "value"
    || frozen.comparison_organizations?.resolutionStatus === "resolved") return input;
  const operations = compileQueryRequest(input).targets[0]!.operations;
  if (operations.some(op => !["metrics", "organizations", "time", "objective", "selection", "operation"].includes(op.field)
    || op.field === "selection" && (!("value" in op) || op.value !== frozen.selection?.resolvedValue)
    || op.field === "operation" && (!("queryOperation" in op) || op.queryOperation?.kind !== "value"))) return input;
  const alternatives = parallelMetricAlternatives(recovery.scopes[0]!.fields.metrics, plan.originalMessage);
  const catalog = analysisCandidates(request);
  const available = alternatives.flatMap(item => catalog.filter(entry => entry.code === item.code));
  if (!alternatives.length || !available.length
    || available.length < alternatives.length && analysisDiscoveryRounds(request) < 1) return input;
  // 原始模型调用仍保存在原生消息；这里执行的是账本原目标的安全展开，答案选择不作为用户确认入账。
  return {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    operations: operations.filter(op => !["metrics", "selection", "operation"].includes(op.field)),
    analysis: {kind: "business_analysis", plan: {objective: plan.originalMessage,
      scope_notice: "保留原机构和日期；相关正式指标分别读取并标明口径，缺数不当作零",
      requirements: [{id: "parallel", question: plan.originalMessage}],
      steps: [{id: "read_parallel", method: "observe", metric_refs: available.map(item => item.binding_ref),
        answers: ["parallel"], rationale: "按原指标完整候选清单并列读取，不替用户选定单一口径、不混算或重算排名"}]}}}]};
}

/** 接管未执行的零命中或可并列的相关指标候选；机构歧义、权限、基础设施及空结果仍走原出口。 */
export async function recoverUnmatchedQuery(request: AskMetricRequestContext, feedback: SemanticFeedback): Promise<SemanticFeedback> {
  // 用户已拒绝且仍待补充时，不能把拒绝造成的缺项重新解释成目录零命中并继续取数。
  if (feedback.status === "needs_user" && feedback.answer_receipts.some(answer => answer.outcome === "declined")) return feedback;
  // 无界“最近”是取数策略，不是让模型猜某一天；有界期间必须继续保留完整日历。
  const requestedTime = overviewTimeExpression(request.originalMessage);
  const recent = requestedTime && recentOverviewExpression(requestedTime) === requestedTime ? requestedTime : undefined;
  const recoverableTime = (item: SemanticFeedback["issues"][number]) => !!recent
    && item.field === "time" && item.code === "TIME_EXPRESSION_UNSUPPORTED";
  const recoverableRange = (item: SemanticFeedback["issues"][number]) => item.code === "QUERY_RANGE_ANALYSIS_REQUIRED";
  const needsStrategy = feedback.issues.some(item => recoverableTime(item) || recoverableRange(item));
  const ungroundedMetric = feedback.issues.some(item => item.field === "metrics" && item.code === "FIELD_INPUT_NOT_CURRENT");
  const missingMetric = feedback.issues.some(item => item.field === "metrics"
    && ["ENTITY_NOT_DETERMINED", "FIELD_REQUIRED"].includes(item.code));
  if (!["needs_user", "needs_interpretation"].includes(feedback.status)
    || !missingMetric && !needsStrategy && !ungroundedMetric
    || feedback.issues.some(item => item.field !== "metrics" && !recoverableTime(item) && !recoverableRange(item) && (["pi", "user"].includes(item.remediation)
      || item.code === "ACCOUNT_ORGANIZATION_UNAVAILABLE"))
    || feedback.issues.some(item => item.remediation === "stop" || item.remediation === "retry"
      || ["permission", "infrastructure"].includes(item.category))) return feedback;
  const store = request.semanticTasks, planRef = feedback.state.task_ref;
  const plan = store && planRef ? await store.plan(planRef) : undefined;
  if (!store || !plan || plan.owner !== request.actor.id || plan.intent !== "query"
    || plan.steps.some(step => !["draft", "blocked"].includes(step.status))) return feedback;
  const tasks = await Promise.all(plan.steps.map(step => step.taskRef ? store.get(step.taskRef) : undefined));
  // 上轮身份只作为追问的检索参考；失败提案仍为 invalid，不能据此恢复旧值或签发查询许可。
  const previousMetrics = tasks.flatMap((task, index) => {
    const metric = task?.target.pendingChanges?.metrics?.baseline;
    if (!ungroundedMetric || !task || task.owner !== request.actor.id || plan.steps[index]?.source.kind === "new"
      || task.target.fields.metrics?.resolutionStatus !== "invalid" || metric?.resolutionStatus !== "resolved") return [];
    const names = (metric.resolvedValue as {names?: string[]})?.names ?? [];
    const baseNames = ((metric.metadata?.metrics as Array<{base_name?: string}> | undefined) ?? [])
      .flatMap(item => item.base_name ? [item.base_name] : []);
    return names.length ? [{target_ref: task.target.ref, names, base_names: [...new Set(baseNames)]}] : [];
  });
  const alternatives = tasks.flatMap(task => {
    const fields = task?.target.fields;
    const operation = fields?.operation?.resolvedValue as {kind?: string} | undefined;
    if (!task || operation?.kind && operation.kind !== "value" || fields?.comparison_organizations?.resolutionStatus === "resolved"
      || fields?.selection?.resolvedValue && fields.selection.resolvedValue !== "exact"
        && !(fields.selection.resolvedValue === "latest" && isDeepStrictEqual(fields.time?.resolvedValue, {preset: "latest"}))) return [];
    const candidates = parallelMetricAlternatives(fields?.metrics, plan.originalMessage);
    return candidates.length ? [{target_ref: task.target.ref, metric: String(fields?.metrics?.rawValue), candidates}] : [];
  });
  const unmatched = tasks.flatMap(task => task?.target.fields.metrics?.resolutionStatus === "not_found"
    ? [String(task.target.fields.metrics.rawValue)] : []);
  // 未绑定的模型别名不能冒充用户明确指标，但也不能直接清空后停止：按保留的原问题发现目录。
  const unboundMetric = feedback.issues.some(item => item.field === "metrics" && item.code === "FIELD_REQUIRED")
    && plan.steps.some(step => step.operations.some(operation => operation.field === "metrics"
      && ["set", "add", "replace"].includes(operation.action)));
  if (!unmatched.length && !alternatives.length && (unboundMetric || needsStrategy || previousMetrics.length))
    unmatched.push(plan.originalMessage);
  if (!unmatched.length && !alternatives.length) return feedback;
  const scopes = tasks.flatMap(task => task ? [{taskRef: task.ref, targetRef: task.target.ref,
    fields: Object.fromEntries(Object.entries(task.target.fields).filter(([name]) =>
      ["organizations", "metrics", "time", "selection", "operation", "comparison_organizations"].includes(name)))}] : []);
  for (const scope of scopes) {
    const time = scope.fields.time;
    if (recent && time?.resolutionStatus !== "resolved" && (time?.rawValue === recent || feedback.issues.some(recoverableTime)))
      scope.fields.time = {rawValue: recent, resolvedValue: {date_selection: "latest_snapshot"},
        resolutionStatus: "resolved", source: "resolved", resolver: "overview_date", metadata: {sourceExpression: recent}};
  }
  const recovery = await store.claimQueryRecovery(request.operationId, plan.ref, scopes, MAX_QUERY_RECOVERY_ROUNDS);
  if (!recovery) return {...feedback, status: "needs_user", continuation: {actor: "user", action: "ask_user"}};
  return {...feedback, status: "needs_interpretation", continuation: {actor: "pi", action: "discover_query"},
    pending_questions: feedback.pending_questions.filter(question => question.scope.field !== "metrics"
      || !alternatives.some(item => item.target_ref === question.scope.target_ref)),
    query_recovery: {attempt: recovery.attempts, max_attempts: MAX_QUERY_RECOVERY_ROUNDS,
      original_goal: plan.originalMessage, unresolved_metrics: [...unmatched, ...alternatives.map(item => item.metric)], retained_conditions: feedback.state.targets,
      ...(previousMetrics.length ? {previous_metrics: previousMetrics} : {}),
      ...(alternatives.length ? {metric_alternatives: alternatives} : {}),
      fallback_answer: semanticPublicAnswer({...feedback, status: "needs_user"}) ?? "请补充希望查询的指标含义或比较基期。"},
    issues: feedback.issues.map(item => recoverableRange(item)
      ? {...item, remediation: "pi", message: "保留原机构、完整区间与排名方向及条数，改用同一目标的business_analysis、ranking方法。all_in_range按区间内全部已有记录逐期排名；不把快照相加、不缩成最新一期，也不要求用户修改取数方式。"}
      : recoverableTime(item)
      ? {...item, code: "QUERY_RECENT_COVERAGE_REQUIRED", remediation: "pi", message:
        "用户仅说最近/近期，没有指定日历范围。改用同一目标的business_analysis，由服务端按真实覆盖选择最新观测；time保留该原文，不填写猜测日期或伪造calendar，不要求用户补日期。"}
      : item.field === "metrics" && item.code === "FIELD_INPUT_NOT_CURRENT" && previousMetrics.length
      ? {...item, code: "QUERY_DISCOVERY_REQUIRED", remediation: "pi", message:
        "当前指标改写没有依据。previous_metrics仅为上轮已确认指标的检索参考，先结合完整original_goal查analysis_catalog；不要用失败提案的名称或基期检索。沿用原机构和实际日期，按本轮目的选择比较或分析，不能重查上轮余额冒充回答。同比、环比、较年初各有基期，按正式目录核对，不能互相替代；原因须有相应证据。若本轮明确换指标，以本轮原意为准，不能回退上轮指标。"}
      : item.field === "metrics" && ["ENTITY_NOT_DETERMINED", "FIELD_REQUIRED"].includes(item.code)
      ? {...item, code: "QUERY_DISCOVERY_REQUIRED", remediation: "pi", message:
        "指标未直接命中唯一含义，先analysis_catalog检索原目标核心词，核对定义、单位与基期。metric_alternatives中的相关候选可分别查询，优先同一business_analysis计划observe全部正式候选并按全名标注，不让用户从余额、增量、增幅或已发布排名中单选；完整候选不受页面前四项限制，可用page_size=30一次核对。保留原机构、日期、排名与筛选；不猜编码、公式或净增基期，不扩大为无关经营报告。机构或统计范围确实不明才追问。"} : item)};
}

type QueryRecoveryTool = "analysis_catalog" | "resolve_business_turn";
/** 近似推荐允许一次正式查证；仍按原生回执计数，旁支与重启不能延长探索。 */
export function queryRecoveryPhase(messages: readonly AgentMessage[]): {tool: QueryRecoveryTool; allowedTools: QueryRecoveryTool[]; recovery: QueryRecoveryFeedback} | undefined {
  let at = messages.length - 1;
  for (; at >= 0; at--) {
    const message = messages[at];
    if (message?.role !== "toolResult" || message.toolName !== "resolve_business_turn") continue;
    if (!isSemanticFeedback(message.details) || !message.details.query_recovery
      || message.details.status !== "needs_interpretation") return;
    const discovery = messages.slice(at + 1).filter(item => item.role === "toolResult" && item.toolName === "analysis_catalog");
    const success = discovery.some(item => item.role === "toolResult" && (item.details as {status?: string})?.status === "succeeded");
    const suggestions = discovery.some(item => item.role === "toolResult"
      && (item.details as {status?: string})?.status === "succeeded"
      && ((item.details as {semantic_suggestion_count?: number}).semantic_suggestion_count ?? 0) > 0);
    const tool = success || discovery.length >= 2 ? "resolve_business_turn" : "analysis_catalog";
    return {tool, allowedTools: suggestions && discovery.length < 2 ? ["analysis_catalog", "resolve_business_turn"] : [tool],
      recovery: message.details.query_recovery};
  }
}

export async function frozenQueryScope(request: AskMetricRequestContext, task: SemanticTask) {
  const turn = await request.semanticTasks?.turn(request.semanticStep?.rootOperationId ?? request.operationId);
  const recovery = turn?.queryRecovery;
  if (!recovery) return undefined;
  const scope = recovery.scopes.find(item => item.taskRef === task.ref)
    ?? (recovery.scopes.length === 1 ? recovery.scopes[0] : undefined);
  if (!scope) throw new BusinessInputError("QUERY_RECOVERY_TARGET_REQUIRED", "source", "恢复分析必须逐一保留原目标来源与范围，不能合并丢失未完成目标。");
  return scope.fields;
}

/** 升级能力时从可信账本补齐原范围，模型仍只负责业务指标与分析计划。 */
export async function retainedQueryScope(request: AskMetricRequestContext, task: SemanticTask, changes: ContextDelta["fieldChanges"], plan?: AnalysisPlan) {
  const fields = await frozenQueryScope(request, task);
  if (!fields) return undefined;
  const operation = fields.operation?.resolvedValue as {kind?: string; position?: string; top_n?: number} | undefined;
  // 升级后的省略不表示改变目标；仅从已解析账本补空槽，显式冲突仍由下方拒绝。
  const preservesRanking = fields.operation?.resolutionStatus === "resolved" && completeRankingSteps(plan, operation);
  if (operation?.kind && operation.kind !== "value" && !preservesRanking
    || fields.comparison_organizations?.resolutionStatus === "resolved")
    throw new BusinessInputError("QUERY_RECOVERY_OPERATION_REQUIRED", "operation", operation?.kind === "ranking"
      ? `原查询的排名条件为${JSON.stringify(operation)}。在同一business_analysis计划使用ranking步骤并保留该方向及条数；不在范围operations中重复operation，不退回不支持近期覆盖的基础query。`
      : "原问题包含比较总体或特殊操作，须检索后修复原query；不能升级为普通观察而丢失操作。");
  // 取数选择属于目标，不是模型可省略的表达偏好；传入分析执行链并核对整个范围。
  if (fields.time?.resolutionStatus === "resolved" && fields.time.resolvedValue
    && fields.selection?.resolvedValue !== "exact"
    && (fields.time.resolvedValue as {date_selection?: string}).date_selection !== "latest_snapshot") {
    const selection = fields.selection?.resolvedValue;
    if (["all_in_range", "latest_in_range"].includes(String(selection))) fields.time = {...fields.time,
      resolvedValue: {...fields.time.resolvedValue as object, record_selection: selection}};
  }
  for (const name of ["organizations", "time"] as const) {
    const frozen = fields[name];
    if (!frozen?.rawValue) continue;
    if (changes.some(change => change.fieldHint === name && change.operation === "clear"))
      throw new BusinessInputError("QUERY_RECOVERY_SCOPE_CHANGED", name, "恢复必须保留原机构和日期，不能清除后采用默认范围。");
    if (!changes.some(change => change.fieldHint === name)) changes.push({fieldHint: name, operation: "set", rawValue: frozen.rawValue});
  }
  return fields;
}

export function assertRetainedQueryScope(frozen: Record<string, ResolvedField> | undefined, fields: Record<string, ResolvedField>) {
  if (!frozen) return;
  for (const name of ["organizations", "time"] as const) {
    const before = frozen[name], after = fields[name];
    if (!before?.rawValue) continue;
    let equal = after?.resolutionStatus === "resolved";
    if (before.resolutionStatus === "resolved") {
      const canonical = (value: unknown) => name === "organizations"
        ? {codes: [...((value as {codes?: string[]})?.codes ?? [])].sort(), scope: (value as {scope?: unknown})?.scope}
        // 两种能力的无界最新策略等价；附带日期、范围或其它筛选时仍逐项严格比较。
        : isDeepStrictEqual(value, {preset: "latest"}) ? {date_selection: "latest_snapshot"} : value;
      equal &&= isDeepStrictEqual(canonical(before.resolvedValue), canonical(after?.resolvedValue));
    } else equal &&= isDeepStrictEqual(before.rawValue, after?.rawValue);
    if (!equal) throw new BusinessInputError("QUERY_RECOVERY_SCOPE_CHANGED", name,
      "恢复分析必须先确定并保留原机构、原日期与取数范围；不能改用账号默认机构、最近有数日或扩大日期。请修正同一目标的范围条件。");
  }
}

/** 修复基础query也要保留操作和取数方式，不能借“重试”改变已确定的业务范围。 */
export function assertRecoveredQueryConditions(frozen: Record<string, ResolvedField> | undefined, fields: Record<string, ResolvedField>,
  followup?: {question: string; previousMetric: ResolvedField | undefined}) {
  assertRetainedQueryScope(frozen, fields);
  for (const name of ["selection", "operation", "comparison_organizations"] as const) {
    if (frozen?.[name]?.resolutionStatus === "resolved" && !isDeepStrictEqual(frozen[name].resolvedValue, fields[name]?.resolvedValue))
      throw new BusinessInputError("QUERY_RECOVERY_SCOPE_CHANGED", name, "恢复原查询须保留已确定的取数方式、排名操作与比较总体，只修正未匹配的指标解释。");
  }
  // 同机构同日期的原值不能完成新增比较；普通换机构或重看原值仍可纠错后继续query。
  const previous = (followup?.previousMetric?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? [];
  const current = (fields.metrics?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? [];
  if (frozen?.metrics?.resolutionStatus === "invalid" && followup && previous.length
    && (comparisonPeriodsOnly(followup.question) || /同比|环比/u.test(followup.question))
    && isDeepStrictEqual([...previous].sort(), [...current].sort()))
    throw new BusinessInputError("QUERY_RECOVERY_ANALYSIS_REQUIRED", "metrics",
      "本轮要求比较变化，重查原指标在同一日期的数值不能完成追问。保留原机构日期，按已查证目录选择正式比较指标，或用business_analysis的compare步骤完成所问基期；原因只能根据已取得证据说明。");
}

/** 只补齐已有目录引用的候选读取，避免让模型反复重填清单；不补公式、身份或统计范围。 */
export function completeRecoveryMetricAlternatives(request: AskMetricRequestContext, frozen: Record<string, ResolvedField> | undefined, plan: AnalysisPlan) {
  const alternatives = parallelMetricAlternatives(frozen?.metrics, request.originalMessage);
  if (!alternatives.length) return;
  const catalog = analysisCandidates(request);
  const undiscovered = alternatives.filter(item => !catalog.some(entry => entry.code === item.code));
  const available = alternatives.flatMap(item => catalog.filter(entry => entry.code === item.code));
  if (undiscovered.length && (!available.length || analysisDiscoveryRounds(request) < 1)) throw new BusinessInputError("QUERY_RECOVERY_ALTERNATIVES_REQUIRED", "plan",
    "这些指标可分别读取，无需让用户单选。先用analysis_catalog补齐正式引用，不能猜编码："
    + undiscovered.map(item => item.name).join("；"));
  const saved = plan.requirements.find(item => item.id.startsWith("parallel_gap")
    && item.gap_reason?.startsWith("暂未取得") && !plan.steps.some(step => step.answers.includes(item.id)));
  if (!undiscovered.length && saved) plan.requirements.splice(plan.requirements.indexOf(saved), 1);
  if (undiscovered.length) {
    // 缺少辅助候选不能阻止已签发指标取数；明确保留未覆盖义务，不假称完整回答。
    const names = undiscovered.map(item => item.name).join("、");
    const label = names.length <= 230 ? names : `${names.slice(0, 180)}等${undiscovered.length}项指标`;
    const question = `补充${label}`;
    const gap = `暂未取得${label}，本次结果未包含这些指标。`;
    if (saved) {saved.question = question; saved.gap_reason = gap;}
    else if (plan.requirements.length < 8) {
      let id = "parallel_gap";
      while (plan.requirements.some(item => item.id === id)) id += "_next";
      plan.requirements.push({id, question, gap_reason: gap});
    } else throw new BusinessInputError("QUERY_RECOVERY_ALTERNATIVES_REQUIRED", "plan", "保留已发现指标，并为未取得引用的候选留出一个明确缺口，不能隐去未完成要求。");
  }
  const observed = new Set(plan.steps.filter(step => step.method === "observe").flatMap(step => step.metric_refs));
  const missing = available
    .filter(candidate => !observed.has(candidate.binding_ref) && !observed.has(candidate.code));
  if (!missing.length) return;
  const existing = plan.steps.find(step => step.method === "observe" && step.metric_refs.length + missing.length <= 12);
  if (!existing && plan.steps.length >= 12) throw new BusinessInputError("QUERY_RECOVERY_ALTERNATIVES_REQUIRED", "plan",
    "请合并observe步骤，保留完整候选读取；计划已达十二步上限，不新增无关分析或让用户单选。");
  const uniqueId = (prefix: string, used: string[]) => {
    let suffix = 1;
    while (used.includes(`${prefix}${suffix}`)) suffix++;
    return `${prefix}${suffix}`;
  };
  const question = `并列展示${String(frozen!.metrics!.rawValue)}的相关正式指标，分别说明含义与缺数`;
  let requirement = plan.requirements.find(item => item.question === question);
  if (!requirement && plan.requirements.length < 8) {
    requirement = {id: uniqueId("parallel_q", plan.requirements.map(item => item.id)), question};
    plan.requirements.push(requirement);
  }
  const answer = requirement?.id ?? plan.requirements[0]!.id;
  if (existing) {
    existing.metric_refs.push(...missing.map(item => item.binding_ref));
    if (!existing.answers.includes(answer)) existing.answers.push(answer);
  } else plan.steps.push({id: uniqueId("parallel_s", plan.steps.map(item => item.id)), method: "observe",
    metric_refs: missing.map(item => item.binding_ref), answers: [answer], rationale: "按原指标完整候选并列读取正式发布值，不合并口径或重算排名"});
}

/** 净增需要比较基期。只核验目录已经声明的比较关系，不根据名称发明公式或默认环比。 */
export function assertRecoveryComparisonBasis(request: AskMetricRequestContext, frozen: Record<string, ResolvedField> | undefined, plan: AnalysisPlan) {
  const question = request.originalMessage;
  if (!frozen || !/净增|净减|净变化/u.test(question)
    || /环比|同比|(?:较|比|对比|相比)(?:上个?月|上年|去年|年初|\d{4})|年初以来|今年以来|本年以来/u.test(question)) return;
  const candidates = analysisCandidates(request);
  const groups = new Set(plan.steps.flatMap(step => step.metric_refs.flatMap(ref => {
    const candidate = candidates.find(item => item.binding_ref === ref || item.code === ref);
    return candidate?.analysis_hint ? [`${candidate.analysis_hint.topic}:${candidate.analysis_hint.metric_id}`] : [];
  })));
  for (const group of groups) {
    const alternatives = candidates.filter(item => item.analysis_hint
      && `${item.analysis_hint.topic}:${item.analysis_hint.metric_id}` === group
      && item.analysis_hint.comparison_role === "difference"
      && ["mom", "yoy", "ytd"].includes(item.analysis_hint.comparison ?? ""));
    const choices = new Set(alternatives.map(item => item.analysis_hint!.comparison));
    if (choices.size < 2) continue;
    const members = new Set(candidates.filter(item => item.analysis_hint
      && `${item.analysis_hint.topic}:${item.analysis_hint.metric_id}` === group).flatMap(item => [item.binding_ref, item.code]));
    const selected = new Set(plan.steps.filter(step => step.metric_refs.some(ref => members.has(ref))).flatMap(step => [
      ...step.metric_refs.flatMap(ref => alternatives.filter(item => item.binding_ref === ref || item.code === ref).map(item => item.analysis_hint!.comparison)),
      ...(step.method === "compare" ? step.comparisons ?? [] : []),
    ]));
    if ([...choices].some(comparison => !selected.has(comparison))) throw new BusinessInputError(
      "QUERY_RECOVERY_COMPARISON_BASIS_REQUIRED", "plan",
      `原问题未指定净增基期，不能只选一个比较代替原问题。请在同一小范围计划并列读取并明确标注已发现的正式比较：${alternatives.map(item => `${item.binding_ref}=${item.name}`).join("；")}。没有记录分别说明，不改机构或日期，不查询无关结构；不能把净增默认写成环比。`);
  }
}
