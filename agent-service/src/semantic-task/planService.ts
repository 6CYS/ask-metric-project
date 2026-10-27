import {createHash} from "node:crypto";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {hasInputEvidence} from "../business-context/inputEvidence.js";
import type {ResolvedField} from "../business-context/types.js";
import {SemanticConflict, SemanticTaskService, snapshotDigest, explicitOrganizationCount, candidateOrdinal} from "./service.js";
import {semanticRef, type SemanticAnswerApplication, type SemanticAnswerSnapshot, type SemanticIssue, type SemanticPlan,
  type SemanticPlanStep, type SemanticQuestionIssue, type SemanticQuestionView, type SemanticSaveOptions, type SemanticTask, type SemanticTurn} from "./store.js";
import type {SemanticRequest, SemanticOperation, SemanticSource} from "./protocol.js";
import {bindAnswerInputs} from "./questions.js";
import {semanticFeedback, type SemanticFeedback} from "./feedback.js";
import {semanticDisplay} from "./display.js";
import {parseFormula} from "./calculation.js";
import {bindFieldOperations, bindGroupOperations, coalesceOrganizationAssignments, inspectTurn, resolveTurnField} from "./actionBinding.js";
import {pendingCompletionSource, explicitContextReset, sourceSelection} from "./sourceGuard.js";
import {compileQueryRequest} from "./structuredQuery.js";
import {inheritAnalysisState} from "../analysis/bindings.js";
import {overviewContinuesCurrent} from "../business-context/overviewPolicy.js";
import {materializeTaskRequest} from "./taskMaterialization.js";

type Goal = Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>;
const problem = (code: string, message: string, remediation: SemanticIssue["remediation"] = "pi", category = "semantic"): SemanticIssue => ({code, message, remediation, category});
const fail = (code: string, message: string, category = "semantic"): never => {throw new SemanticConflict(problem(code, message, "pi", category));};
const text = (operations: SemanticOperation[], field: string) => operations.flatMap(op => op.field === field && "value" in op ? [op.value] : []).at(-1);
const codes = (task: SemanticTask, field: string) => (task.target.fields[field]?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? [];
const field = (rawValue: string, resolvedValue: unknown): ResolvedField => ({rawValue, resolvedValue, resolutionStatus: "resolved", source: "resolved"});
const aliases = (step: SemanticPlanStep) => [...new Set([step.label, ...(step.aliases ?? [])].filter((name): name is string => !!name))];
/** 回复里的序数与本题展示清单是否冲突；冲突时不能把未展示项当成用户选择。 */
export function answerOrdinalConflict(question: Pick<import("./questions.js").PendingQuestion, "options" | "scope">,
  excerpt: string, choice: import("./questions.js").AnswerChoice): boolean {
  const ordinal = excerpt.split(/[，,。；;]|但是|不过|而是|但/u).map(part => candidateOrdinal(part))
    .find(item => item && (!item.field || item.field === question.scope.field));
  if (!ordinal) return false;
  if (choice.type !== "select") return true;
  const selected = choice.option_ids.map(id => question.options.find(option => option.option_id === id)?.no);
  return selected.some(no => no === undefined || no !== ordinal.index + 1);
}
export const semanticPlanDigest = (plan: SemanticPlan) => createHash("sha256").update(JSON.stringify(plan.steps.map(step => [step.id, step.taskRef, step.targetRef, step.operations, step.dependencies]))).digest("hex");

/** 任务编排与单步规范化分离。所有步骤共用原生Session和Pi循环；子步骤执行授权统一绑定到各任务的permit。 */
export class SemanticPlanService {
  constructor(private readonly request: AskMetricRequestContext, private readonly signal?: AbortSignal) {}
  private get store() {if (!this.request.semanticTasks) throw new Error("SEMANTIC_STORE_NOT_BOUND"); return this.request.semanticTasks;}
  private async save(plan: SemanticPlan, focus = false, options: SemanticSaveOptions = {}) {
    return this.store.savePlan(plan, (await this.store.planIndex()).version, focus, options);
  }
  private async adopt(task: SemanticTask): Promise<SemanticPlan> {
    if (task.owner !== this.request.actor.id) fail("REFERENCE_INVALID", "历史任务不可读取。", "reference");
    const plan: SemanticPlan = {ref: semanticRef(), owner: task.owner, revision: 0, operationId: this.request.operationId, goalOperationId: "legacy",
      intent: "query", originalMessage: task.originalMessage, status: task.status, completion: task.completion, issues: task.issues,
      steps: [{id: semanticRef(), targetRef: task.target.ref, taskRef: task.ref, operationId: task.permit?.operationId ?? "legacy", kind: "query", source: {kind: "new"}, sourceQuestion: task.originalMessage, operations: [], dependencies: [], status: task.target.status, required: true, issues: task.issues}]};
    return this.save(plan, true);
  }
  async rejected(planRef: string, error: unknown, options: {readOnly?: boolean} = {}): Promise<SemanticFeedback> {
    const plan = (await this.store.plan(planRef))!;
    const issue = error instanceof SemanticConflict ? error.issue : error instanceof BackendApiError && [401,403].includes(error.status)
      ? problem("PERMISSION_DENIED", "当前权限已变化，结果不可读取。", "stop", "permission") : problem("STEP_NOT_COMPLETED", "步骤尚未取得完整正式证据，已保留之前的结果。", "retry", "infrastructure");
    plan.issues = [issue];
    const status = issue.category === "permission" ? "denied" : issue.remediation === "pi" ? "needs_interpretation" : "failed";
    // 历史读取失败属于本轮读取回执，不能改写原执行状态或撤销历史许可。
    if (options.readOnly) return this.feedback(plan, status);
    plan.status = issue.remediation === "stop" ? "stopped" : "active"; plan.completion = plan.steps.some(step => step.status === "succeeded") ? "partial" : "unmet";
    await this.save(plan);
    return this.feedback(plan, status);
  }
  async feedback(plan: SemanticPlan, status: string): Promise<SemanticFeedback> {
    const result = semanticFeedback(undefined, status, plan.issues);
    result.state = {task_ref: plan.ref, task_status: plan.status, completion: plan.completion, raw_message_retained: true, proposals_retained: true,
      targets: await Promise.all(plan.steps.map(async step => {
        const task = step.taskRef ? await this.store.get(step.taskRef) : undefined;
        const target = task ? semanticFeedback(task, status).state.targets[0]! : {target_ref: step.targetRef, status: step.status, conditions: [], pending: []};
        return {...target, target_ref: step.targetRef, status: step.status, ...(step.label ? {label: step.label} : {}), aliases: aliases(step), kind: step.kind};
      }))};
    const questionViews = await this.store.questionsForPlan(plan.ref);
    result.pending_questions = questionViews.filter(view => view.question.status === "open").map(view => view.question);
    result.answer_receipts = questionViews.flatMap(view => view.binding.receipts
      .filter(receipt => receipt.answer.source.operation_id === plan.operationId)
      .map(receipt => ({question_id: receipt.answer.question_id, version: receipt.answer.version, outcome: receipt.outcome,
        ...(receipt.selected_options?.length ? {selected_options: structuredClone(receipt.selected_options)} : {}),
        notice: receipt.notice, ...(receipt.code ? {code: receipt.code} : {})})));
    if (plan.intent === "analyze" && status === "succeeded") result.continuation = {actor: "pi", action: "continue_analysis"};
    return result;
  }
  async resolve(input: SemanticRequest): Promise<SemanticFeedback> {
    input = compileQueryRequest(structuredClone(input));
    const boundAnswers = bindAnswerInputs(input.answers ?? [], this.request.trustedAnswers ?? [], this.request.operationId, this.request.originalMessage);
    const answersOnly = !this.request.originalMessage && boundAnswers.answers.length > 0;
    if (!this.request.originalMessage && !boundAnswers.answers.length) fail("ANSWER_INPUT_SHAPE_INVALID", "空文本必须伴随可信点击回答。", "input_shape");
    for (const target of input.targets) {
      if (target.source.kind === "new") target.operations = coalesceOrganizationAssignments(target.operations, this.request.originalMessage);
      const assigned = target.operations.filter(operation => operation.action === "set").map(operation => operation.field);
      if (new Set(assigned).size !== assigned.length) fail("FIELD_MULTIPLE_ASSIGNMENTS", "同一目标同一字段只能set一次；多机构或多指标写入这一次set的value完整清单，不连续set。不同条件分别建targets；历史组共享operations，需要分别命名时拆为独立reference目标。", "input_shape");
    }
    // 显式历史组上的唯一公式是结构简写：保留每个来源，另建一个计算步骤，不猜业务条件或数据。
    input.targets = input.targets.flatMap(target => input.intent === "calculate" && target.source.kind === "references"
      && target.operations.length === 1 && target.operations[0]?.field === "calculation" && target.operations[0].action === "set"
      ? [...target.source.references.map(reference => ({source: {kind: "reference" as const, ...reference}, operations: [] as SemanticOperation[]})),
        {source: {kind: "new" as const}, operations: target.operations}] : [target]);
    // 集合只展开宿主可核验引用，绝不把多个来源拍平成文本后重新猜身份。
    input.targets = input.targets.flatMap(target => target.source.kind === "references"
      ? target.source.references.map(source => ({source: {kind: "reference" as const, ...source}, operations: structuredClone(target.operations)})) : [target]);
    if (input.targets.length > 100) fail("TARGET_GROUP_TOO_LARGE", "本轮目标超过执行上限，请分批选择明确目标组。", "capability");
    const identities = input.targets.filter(target => target.source.kind === "reference").map(target => JSON.stringify([target.source, target.operations]));
    if (new Set(identities).size !== identities.length) fail("DUPLICATE_TARGET_REFERENCE", "同一来源和修改重复进入目标组，请保留完整范围并去重。", "reference");
    const turn = await this.store.admit(this.request.operationId, this.request.originalMessage, undefined, undefined,
      {actorId: this.request.actor.id, answers: boundAnswers.answers, discardedAnswers: boundAnswers.discarded,
        ...(this.request.questionPublicationProof ? {publicationProof: this.request.questionPublicationProof} : {})});
    const answerSnapshots = turn.answerSnapshots ?? [];
    const hasOperations = input.targets.some(target => target.operations.length > 0);
    if (hasOperations && answerSnapshots.some(snapshot => snapshot.alreadyApplied)) {
      fail("ANSWER_OPERATION_CONFLICT", "旧点击不是新条件变更的授权；请刷新当前问题和目标绑定后再提交修改。", "input_shape");
    }
    if (answerSnapshots.length && !hasOperations && answerSnapshots.every(snapshot => snapshot.existingReceipt)) {
      const planRefs = new Set(answerSnapshots.map(snapshot => snapshot.existingReceipt!.planRef));
      const prior = planRefs.size === 1 ? await this.store.plan([...planRefs][0]!) : undefined;
      if (!prior) fail("ANSWER_TARGET_AMBIGUOUS", "重复回答不能对应唯一的原计划结果。", "reference");
      const result = await this.feedback(prior!, "reused");
      result.answer_receipts = answerSnapshots.map(snapshot => {
        const receipt = snapshot.existingReceipt!;
        const repeated = snapshot.alreadyApplied === true;
        return {question_id: receipt.answer.question_id, version: receipt.answer.version,
          outcome: repeated ? "already_applied" as const : receipt.outcome,
          ...(receipt.selected_options?.length ? {selected_options: structuredClone(receipt.selected_options)} : {}),
          notice: repeated ? "该选择此前已应用，本次未重复执行。" : receipt.notice,
          ...(repeated ? {code: "ANSWER_ALREADY_APPLIED"} : receipt.code ? {code: receipt.code} : {})};
      });
      return result;
    }
    const pending = turn.context?.clarification, contextAction = input.context_action ?? turn.contextAction;
    if (input.context_action) await this.store.bindContextAction(this.request.operationId, input.context_action);
    const matchesPending = (source: SemanticSource) => source.kind === "reference" && pending?.alternatives.some(option =>
      option.task_ref === source.task_ref && option.target_ref === source.target_ref);
    // context_action=resume 只约束 clarify_business_turn 保存的待明确备选；已发布字段问题的
    // 文字回答也可能带上 resume，此时按普通续接处理，不要求引用备选目标。
    if (contextAction === "resume" && pending && (input.intent === "reuse" || !input.targets.some(target => matchesPending(target.source)))) {
      fail("CLARIFICATION_SOURCE_REQUIRED", "续接待明确修改需要Pi选择已保存备选来源；只显示原结果时使用defer，放弃原修改时使用abandon。", "reference");
    }
    const resumesClarification = contextAction === "resume" && !!pending;
    const semanticMessage = resumesClarification ? pending.originalMessage + "\n" + this.request.originalMessage : this.request.originalMessage;
    const index = await this.store.planIndex();
    let plan = index.operations[this.request.operationId] ? await this.store.plan(index.operations[this.request.operationId]!) : undefined;
    let focus = plan ?? (turn.context ? turn.context.plan : index.focus ? await this.store.plan(index.focus) : undefined);
    let enhancedAnalysis = input.targets.some(target => target.operations.some(op => op.field === "_analysis"));
    // 在新计划写入焦点前拒绝错误来源，让模型可用current修正，不能先丢失上一轮的机构日期。
    if (!plan && focus && enhancedAnalysis && overviewContinuesCurrent(this.request.originalMessage)
      && input.targets.some(target => target.source.kind === "new")) fail("ANALYSIS_CONTINUATION_SOURCE_REQUIRED",
      "这是当前分析的延续，请将同一target.source改为{kind:current}，只提交变化的分析计划；机构日期未变化时不要重填历史名称。尚未创建新焦点。", "reference");
    if (!focus && input.targets.some(target => target.source.kind === "current")) {
      const legacyRef = (await this.store.index()).focus, legacy = legacyRef ? await this.store.get(legacyRef) : undefined;
      if (legacy && !legacy.parentPlan) focus = await this.adopt(legacy);
    }
    for (const target of input.targets) if (target.source.kind === "reference" && !await this.store.plan(target.source.task_ref)) {
      const legacy = await this.store.get(target.source.task_ref);
      if (legacy && !legacy.parentPlan && legacy.target.ref === target.source.target_ref) {
        const adopted = await this.adopt(legacy);
        target.source = {kind: "reference", task_ref: adopted.ref, target_ref: adopted.steps[0]!.targetRef};
      }
    }
    if (answersOnly && input.targets.some(target => target.source.kind === "new")) {
      fail("ANSWER_TARGET_AMBIGUOUS", "纯点击只能续接原目标，不能借答给 source=new 或创建新义务。", "reference");
    }
    const inputFacts: Goal = answersOnly ? {question: "", reference_year: null, fragments: []}
      : await inspectTurn(this.request, this.request.originalMessage, turn.businessDate, undefined, this.signal);
    const reset = explicitContextReset(this.request.originalMessage);
    if (reset && input.targets.some(target => target.source.kind !== "new")) fail("CONTEXT_RESET_SOURCE_CONFLICT", "用户明确不沿用条件，本轮只能从new和已提供字段开始；删除无本轮依据的旧字段并保存真实缺项，不得改回current/reference。", "reference");
    if (!reset && !resumesClarification && !answersOnly) {
      const selection = await sourceSelection(this.request, input, turn, inputFacts);
      if (selection?.source_options?.length && selection.remediation === "pi") {
        const original = input.targets[0]!;
        input.targets = selection.source_options.map(source => ({source: {kind: "reference" as const, ...source}, operations: structuredClone(original.operations)}));
      } else if (selection) throw new SemanticConflict({...selection, remediation: "user"});
    }
    const completionSources = answersOnly ? undefined : await pendingCompletionSource(this.request, input, turn, inputFacts);
    if (completionSources?.length === 1) for (const target of input.targets) {
      if (target.source.kind === "new") target.source = {kind: "reference", ...completionSources[0]!};
    }
    // new 只保留本轮条件；无依据的模型补值由字段绑定舍弃，不再走旧的来源打回链。
    if (reset) for (const target of input.targets) target.operations = target.operations.filter(op => !("value" in op)
      || !["organizations", "metrics", "time"].includes(op.field) || hasInputEvidence(this.request.originalMessage, op.value)
      || inputFacts.fragments.some(fragment => op.field === "organizations" ? fragment.organizations.length
        : op.field === "metrics" ? fragment.mentions.length : fragment.calendar.ranges.length || fragment.calendar.unresolved.length));
    input = await materializeTaskRequest(this.request, input, turn, turn.context?.plan ?? focus, inputFacts, this.signal);
    enhancedAnalysis = input.targets.some(target => target.operations.some(op => op.field === "_analysis"));
    bindGroupOperations(input, semanticMessage);
    const answersOnlyIntent = answersOnly ? plan?.intent ?? focus?.intent : undefined;
    if (!plan) {
      const refs = input.targets.filter(target => target.source.kind !== "new");
      const base = refs.length ? refs[0]!.source.kind === "reference" ? await this.store.plan(refs[0]!.source.task_ref) : focus : undefined;
      if (refs.some(target => target.source.kind === "current") && !focus) fail("REFERENCE_UNAVAILABLE", "当前没有可续接任务，请读取历史或新建目标。", "reference");
      const coverageTransition = base?.steps.every(step => step.kind === "availability") && ["query", "analyze"].includes(input.intent);
      const pendingContinuation = base?.status === "waiting_input";
      const referenceTransition = input.targets.some(target => target.source.kind === "reference");
      const completedTransition = !!base && (["query", "prepare"].includes(input.intent) || enhancedAnalysis) && base.operationId !== this.request.operationId;
      plan = base ? {...structuredClone(base), ...(base.ref !== focus?.ref || coverageTransition || completedTransition || input.intent === "reuse" || referenceTransition ? {ref: semanticRef(), revision: 0} : {})} : {ref: semanticRef(), owner: this.request.actor.id, revision: 0, operationId: this.request.operationId,
        goalOperationId: this.request.operationId, intent: input.intent, originalMessage: semanticMessage, status: "active", completion: "unmet", issues: [], steps: []};
      if (plan.owner !== this.request.actor.id) fail("REFERENCE_INVALID", "当前任务不可读取。", "reference");
      if (!base || plan.ref !== base.ref) plan.proposalOperationId = this.request.operationId;
      // 待补计划跨轮也派生新版本，保留旧来源；未完成义务须整组继承，不能只保留本轮确认的目标。
      if (base && !pendingContinuation && (coverageTransition || completedTransition || input.intent === "reuse" || referenceTransition)) {
        plan.steps = input.targets.flatMap(target => {
          const source = target.source;
          const selected = source.kind === "reference" ? base.steps.filter(step => step.targetRef === source.target_ref) : target.source.kind === "current" && base.steps.length === 1 ? base.steps : [];
          return selected.map(step => ({...structuredClone(step), id: semanticRef(), source: structuredClone(target.source)}));
        });
        plan.originalMessage = answersOnly ? base.originalMessage : semanticMessage; plan.goalOperationId = "history";
      }
      plan.operationId = this.request.operationId; plan.intent = input.intent;
      plan.topicRef = base ? await this.store.topicFor(base) : plan.ref;
      if (base) {
      const years = new Set<string>();
      for (const step of plan.steps) if (step.taskRef) {
        const source = await this.store.get(step.taskRef), calendar = source?.target.fields.time?.resolvedValue as {start?: string; end?: string} | undefined;
        if (calendar?.start && calendar.end) {years.add(calendar.start.slice(0,4)); years.add(calendar.end.slice(0,4));}
      }
      if (years.size === 1) plan.referenceYear = Number([...years][0]); else delete plan.referenceYear;
    }

      // 跨轮沿用原始义务，新的变更仍由各子步骤绑定真实本轮消息。
    }
    if (answersOnlyIntent && input.intent !== answersOnlyIntent) fail("ANSWER_OPERATION_CONFLICT", "纯点击必须沿用源计划 intent，不能改写成其他执行目的。", "input_shape");
    plan.intent = input.intent === "query" && plan.intent === "analyze" ? "analyze" : input.intent;
    plan.revision++; plan.issues = []; plan.status = "active"; plan.completion = "unmet";
    const analysis = input.intent === "analyze" || plan.intent === "analyze";
    const isNewGoal = !plan.steps.length;
    const ownedDraft = plan.goalOperationId === this.request.operationId || plan.proposalOperationId === this.request.operationId
      && (["query", "prepare"].includes(input.intent) || enhancedAnalysis);
    // 已签发执行许可（permit）的步骤不能再被新提案重组；同轮重放保留原步骤绑定。
    const permitIssued = (await Promise.all(plan.steps.map(step => step.taskRef ? this.store.get(step.taskRef) : undefined)))
      .some(task => task?.permit && plan.steps.some(step => step.operationId === task.permit!.operationId));
    const canRegroupDraft = !isNewGoal && !permitIssued && ownedDraft
      && (plan.goalOperationId === this.request.operationId || plan.goalOperationId === "history")
      && plan.steps.every(step => ["blocked", "draft", "ready", "waiting_dependency"].includes(step.status));
    const goal = answersOnly ? inputFacts : await inspectTurn(this.request, semanticMessage, turn.businessDate, plan.referenceYear, this.signal);
    const proposalGoal = goal;
    const freshGoal = resumesClarification ? inputFacts : goal;
    // 完整独立片段直接构造各自条件，机构、指标和日期不交叉配对。
    if (["query", "prepare"].includes(input.intent) && input.targets.every(target => target.source.kind === "new"
      && target.operations.every(op => op.action === "set") && !target.operations.some(op => ["calculation", "operation"].includes(op.field)))
      && freshGoal.fragments.length > 1 && freshGoal.fragments.every(fragment => fragment.organizations.length
        && fragment.mentions.length && fragment.calendar.ranges.length === 1 && !fragment.calendar.unresolved.length)) {
      const original = input.targets;
      input.targets = freshGoal.fragments.map((fragment, number) => ({source: {kind: "new" as const},
        operations: bindFieldOperations(original[number]?.operations ?? original[0]!.operations,
          {...freshGoal, question: fragment.question, fragments: [fragment]}, {}).operations}));
    }
    const proposed: SemanticPlanStep[] = [];
    const originalSourceQuestions = new Map<string, string>();
    for (let number = 0; number < input.targets.length; number++) {
      const target = input.targets[number]!;
      const proposedKind = target.operations.some(op => op.field === "calculation") ? "calculation" : input.intent === "availability" || target.operations.some(op => op.field === "availability") ? "availability" : "query";
      let step: SemanticPlanStep | undefined;
      if (target.source.kind === "reference") {
        const saved = await this.store.planReference(target.source.target_ref, target.source.task_ref);
        if (!saved || saved.planRef !== target.source.task_ref) fail("REFERENCE_INVALID", "目标引用未签发或与任务不配对。", "reference");
        const parent = await this.store.plan(saved!.planRef);
        if (!parent || parent.owner !== this.request.actor.id || !parent.steps.some(item => item.targetRef === (target.source as {target_ref: string}).target_ref)) fail("REFERENCE_REVISION_CONFLICT", "目标已修订，请重新读取上下文。", "reference");
        const eligible = plan.steps.filter(item => !proposed.includes(item) && (item.id === saved!.step.id || item.source.kind === "reference"
          && item.source.task_ref === saved!.planRef && item.source.target_ref === saved!.step.targetRef));
        step = eligible.find(item => JSON.stringify(item.operations) === JSON.stringify(target.operations))
          ?? eligible.find(item => text(item.operations, "time") && text(item.operations, "time") === text(target.operations, "time")) ?? eligible[0];
        if (!step) {
          // 同轮从同一来源派生多个目标时，不能继承来源的执行编号；否则子turn绑定同一task，
          // 后一个计划会覆盖前一个许可，并留下无法唯一定位的重复targetRef。
          step = {...structuredClone(saved!.step), id: semanticRef(), operationId: ""};
          plan.steps.push(step);
        }
      } else if (target.source.kind === "current") {
        const bound = plan.steps.filter(item => item.source.kind === "current" && !proposed.includes(item));
        if (bound.length === 1) step = bound[0];
        else if (plan.steps.length === 1 && !proposed.includes(plan.steps[0]!)) step = plan.steps[0];
        else fail("TARGET_REFERENCE_REQUIRED", "当前来源没有唯一已绑定目标，请读取上下文并由Pi明确引用要修改的目标。", "reference");
      } else {
        const available = plan.steps.filter(item => item.source.kind === "new" && item.kind === proposedKind && !proposed.includes(item));
        step = available.find(item => JSON.stringify(item.operations) === JSON.stringify(target.operations));
        if (!step) step = available.find(item => item.status !== "succeeded" && text(target.operations, "objective") && item.label === text(target.operations, "objective"));
        if (!step && proposedKind === "query") step = available.find(item => item.status !== "succeeded" && ["organizations", "time"].every(name => text(item.operations, name) === text(target.operations, name)));
        if (!step) step = available.find(item => item.status !== "succeeded");
      }
      if (!step) {
        const kind = proposedKind;
        step = {id: semanticRef(), targetRef: semanticRef(), operationId: "", kind, source: structuredClone(target.source), sourceQuestion: semanticMessage,
          operations: [], dependencies: [], required: true, status: "draft", issues: []};
        plan.steps.push(step);
      }
      originalSourceQuestions.set(step.id, step.sourceQuestion);
      step.source = structuredClone(target.source);
      if (step.status === "succeeded" && JSON.stringify(step.operations) === JSON.stringify(target.operations) && step.operationId.startsWith(`${this.request.operationId}:`)) {proposed.push(step); continue;}
      if (["executing", "unknown"].includes(step.status)) fail("EXECUTION_RESULT_UNKNOWN", "步骤仍在途或结果未知，应回查原命令。");
      if (step.kind === "availability" && proposedKind === "query" && ["query", "analyze"].includes(input.intent)) step.kind = "query";
      if (step.kind !== "calculation" && target.operations.some(op => op.field === "calculation")) fail("CALCULATION_SOURCE_REQUIRED", "引用查询来源作为独立目标并用objective命名，再以new提交引用这些名称的计算目标。");
      const labelOnly = step.status === "succeeded" && target.operations.every(op => op.field === "objective") && ["analyze", "calculate", "reuse"].includes(input.intent);
      step.operations = target.operations.length ? structuredClone(target.operations) : step.operations;
      const label = text(step.operations, "objective") ?? step.label; if (label) step.label = label;
      if (!step.operationId || !step.operationId.startsWith(`${this.request.operationId}:`)) {
        step.operationId = `${this.request.operationId}:${step.id}`;
        const sourceGoal = target.source.kind === "new" ? freshGoal : proposalGoal;
        step.sourceQuestion = target.source.kind === "new" ? await this.bindFragment(sourceGoal, step, analysis, turn.businessDate)
          : answersOnly ? originalSourceQuestions.get(step.id)! : resumesClarification && matchesPending(target.source) ? semanticMessage : this.request.originalMessage;
      }
      if (!labelOnly && step.status === "succeeded") step.status = "draft";
      if (labelOnly) {proposed.push(step); continue;}
      proposed.push(step);
    }
    // 未执行的模型拆分可被完整新提案重组；原始用户义务由账本和字段绑定核验，旧提案留存但不再具有执行资格。
    if (canRegroupDraft) {
      const superseded = plan.steps.filter(step => !proposed.includes(step));
      if (superseded.length) {plan.supersededSteps = [...(plan.supersededSteps ?? []), ...structuredClone(superseded)]; plan.steps = proposed;}
    }
    const answerTargets = this.mapAnswers(answerSnapshots, proposed, input, turn);
    const currentChanges = new Map(proposed.map(step => [step.id, targetChanges(input, proposed, step)]));
    await this.save(plan);
    const tasks = new Map<string, SemanticTask>();
    for (const step of proposed) {
      if (step.kind === "calculation" || step.status === "succeeded") continue;
      const existing = step.taskRef ? await this.store.get(step.taskRef) : undefined;
      await this.store.admit(step.operationId, step.sourceQuestion, existing?.parentPlan === plan.ref ? existing.ref : null);
      const child = this.child(plan, step);
      const fragment = [...proposalGoal.fragments, ...freshGoal.fragments].find(item => item.question === step.sourceQuestion);
      child.semanticStep!.facts = fragment ? {...proposalGoal, question: step.sourceQuestion, fragments: [fragment]}
        : await inspectTurn(this.request, step.sourceQuestion, turn.businessDate, plan.referenceYear, this.signal);
      child.semanticAnswers = (answerTargets.get(step.id) ?? []).filter(snapshot => snapshot.binding.reason === "candidate_choice");
      const resolution = await new SemanticTaskService(child, this.signal).resolve({protocol_version: 2, intent: input.intent === "prepare" ? "prepare" : input.intent === "reuse" ? "reuse" : "query",
        targets: [{source: (await this.store.turn(step.operationId))?.source ?? (existing ? existing.parentPlan === plan.ref ? {kind: "current"} : {kind: "reference", task_ref: existing.ref, target_ref: step.targetRef} : {kind: "new"}), operations: currentChanges.get(step.id) ?? []}]});
      if (resolution.task) {step.taskRef = resolution.task.ref; step.targetRef = resolution.task.target.ref; tasks.set(step.id, resolution.task);
        const names = Object.fromEntries(["organizations", "time", "metrics"].map(name => [name, semanticDisplay(resolution.task!.target.fields[name])]));
        step.aliases = [...new Set([names.organizations, names.time, names.metrics, `${names.time}${names.metrics}`, `${names.organizations}${names.time}${names.metrics}`].filter((name): name is string => !!name))];
        const objective = resolution.task.target.fields.objective;
        step.label = objective?.resolutionStatus === "resolved" && typeof objective.resolvedValue === "string" ? objective.resolvedValue
          : ["organizations", "time", "metrics"].flatMap(name => {const value = semanticDisplay(resolution.task!.target.fields[name]); return value ? [value] : [];}).join(" / ") || step.kind;}
      step.status = resolution.task?.target.status ?? "blocked"; step.issues = resolution.issues ?? resolution.task?.issues ?? [];
    }
    for (const step of plan.steps) if (step.taskRef && !tasks.has(step.id)) {const task = await this.store.get(step.taskRef); if (task) tasks.set(step.id, task);}
    const requestedCount = explicitOrganizationCount(semanticMessage);
    const queryTasks = plan.steps.filter(step => step.kind === "query").flatMap(step => tasks.get(step.id) ? [tasks.get(step.id)!] : []);
    if (requestedCount !== undefined && queryTasks.length > 1 && queryTasks.every(task => task.target.fields.organizations?.resolutionStatus === "resolved")
      && queryTasks.every(task => (task.target.fields.operation?.resolvedValue as {kind?: string})?.kind === "value")
      && new Set(queryTasks.flatMap(task => codes(task, "organizations"))).size !== requestedCount) {
      plan.issues.push(problem("ORGANIZATION_GROUP_COUNT_CONFLICT", `整笔请求要求${requestedCount}家机构，请补充尚未确定的机构。`, "user", "reference"));
    }
    const sourceAnswers = await this.prepareSourceAnswers(plan, answerTargets, tasks, turn, currentChanges);
    const sourceQuestions: SemanticQuestionIssue[] = [];
    await this.continueSourceConstraints(plan, tasks, turn, sourceAnswers, currentChanges, sourceQuestions);
    await this.issueSourceConfirmations(plan, tasks, sourceQuestions);
    for (const step of plan.steps) if (input.intent !== "reuse" && step.kind === "calculation" && step.status === "succeeded"
      && step.dependencies.some((dependency, i) => plan.steps.find(item => item.id === dependency)?.targetRef !== step.dependencyTargets?.[i])) {
      step.status = "draft"; delete step.taskRef; delete step.evidence; step.operationId = `${this.request.operationId}:${step.id}`;
    }
    for (const step of plan.steps.filter(item => item.kind === "calculation" && item.status !== "succeeded")) {
      delete step.taskRef; delete step.evidence;
      try {
        const formula = parseFormula(text(step.operations, "calculation") ?? "", plan.steps.filter(item => item.kind === "query").flatMap(aliases), this.request.originalMessage);
        if ((step.label?.length ?? 0) > 80) fail("CALCULATION_LABEL_TOO_LONG", "计算结果名称需在80字以内。");
        step.dependencies = formula.labels.map(label => plan.steps.find(item => item.kind === "query" && aliases(item).includes(label))!.id);
        step.status = "waiting_dependency"; step.issues = [];
      } catch (error) {
        step.status = "blocked";
        const multiple = plan.steps.some(item => item.kind === "query" && tasks.has(item.id) &&
          (codes(tasks.get(item.id)!, "organizations").length > 1 || codes(tasks.get(item.id)!, "metrics").length > 1 ||
           (tasks.get(item.id)!.target.fields.time?.resolvedValue as {dates?: string[]})?.dates?.length));
        step.issues = [error instanceof SemanticConflict ? {...error.issue, message:error.issue.message + (multiple
          ? " 当前来源含多个成员；逐成员相减时请把来源重组为各自条件完整的查询目标，用objective命名后引用。尚未执行的草案可用完整new提案重组，不能读取尚未执行的结果。"
          : "")} : problem("CALCULATION_INVALID", "计算目标尚未确定。")];
      }
    }
    if ((input.intent === "calculate" || goal.requires_calculation) && !plan.steps.some(step => step.kind === "calculation")) plan.issues.push(problem("CALCULATION_REQUIRED", "计算请求必须明确计算含义，不能仅执行查询。"));
    plan.issues.push(...plan.steps.flatMap(step => step.issues));
    const blocking = plan.steps.some(step => !["ready", "succeeded", "waiting_dependency", ...(input.intent === "prepare" ? ["draft"] : [])].includes(step.status));
    if (input.intent === "reuse" && plan.steps.some(step => step.status !== "succeeded")) plan.issues.push(problem("RESULT_NOT_READY", "目标尚无成功结果，不能重显。", "user", "reference"));
    const status = plan.issues.some(issue => issue.category === "permission") ? "denied"
      : plan.issues.some(issue => issue.category === "capability" && issue.remediation === "stop") ? "unsupported"
      : plan.issues.some(issue => issue.category === "infrastructure") ? "failed"
      : plan.issues.length || blocking ? plan.issues.some(issue => issue.remediation === "pi") ? "needs_interpretation" : plan.issues.some(issue => issue.remediation === "user") ? "needs_user" : "needs_interpretation"
      : input.intent === "prepare" ? "prepared" : input.intent === "reuse" ? "reused"
      : enhancedAnalysis && plan.steps.length > 0 && plan.steps.every(step => step.status === "succeeded") ? "succeeded" : "ready";
    plan.status = status === "succeeded" ? "completed" : status === "needs_user" ? "waiting_input" : ["denied", "unsupported", "failed"].includes(status) ? "stopped" : "active";
    if (status === "succeeded") {
      plan.completion = plan.steps.some(step => step.evidence?.complete === false) ? "partial" : "full";
      if (plan.completion === "partial") plan.status = "active";
    }
    for (const application of sourceAnswers) {
      const stepId = [...answerTargets].find(([, snapshots]) => snapshots.some(snapshot =>
        snapshot.answer.question_id === application.snapshot.answer.question_id))?.[0];
      const step = plan.steps.find(item => item.id === stepId), task = stepId ? tasks.get(stepId) : undefined;
      if (!step || !task) continue;
      const replaced = application.outcome === "declined" && this.hasSourceReplacement(step, task, application.snapshot.question.scope.field,
        turn, currentChanges, application.snapshot.binding.planRef, application.snapshot.binding.targetRef);
      application.planRef = plan.ref; application.targetRef = step.targetRef;
      if (!replaced) application.snapshot = {...application.snapshot,
        binding: {...application.snapshot.binding, planRef: plan.ref, targetRef: step.targetRef, taskRef: task.ref}};
      if (application.outcome === "applied") {
        const condition = application.snapshot.binding.sourceConfirmation?.organizationCondition as {codes?: unknown} | undefined;
        application.expectedTaskRevision = task.revision;
        application.expectedOrganizationCodes = Array.isArray(condition?.codes)
          ? condition.codes.filter((code): code is string => typeof code === "string") : [];
      }
    }
    await this.save(plan, ["ready", "prepared", "reused", "needs_user"].includes(status),
      {...(sourceQuestions.length ? {questions: sourceQuestions} : {}), ...(sourceAnswers.length ? {answers: sourceAnswers} : {}),
        ...(contextAction === "abandon" ? {abandonQuestions: true} : {})});
    if (pending && (resumesClarification && ["ready", "prepared", "reused", "needs_user"].includes(status)
      || contextAction === "abandon")) await this.store.clearClarification(pending.operationId);
    return this.feedback(plan, status);
  }
  private hasSourceReplacement(step: SemanticPlanStep, task: SemanticTask, field: string, turn: SemanticTurn,
    changes: ReadonlyMap<string, SemanticOperation[]>, sourcePlanRef: string, sourceTargetRef: string): boolean {
    const current = task.target.fields[field];
    if (!current) return false;
    if (current.metadata?.semanticTurn !== step.operationId && current.metadata?.proposalTurn !== step.operationId) return false;
    return (changes.get(step.id) ?? []).some(operation => {
      if (operation.field !== field) return false;
      if (operation.action === "set") {
        const extracted = Array.isArray(current.metadata?.extractedRawValues) ? current.metadata.extractedRawValues : [];
        const excerpts = [operation.value,
          ...("suggestion" in operation && typeof operation.suggestion?.excerpt === "string" ? [operation.suggestion.excerpt] : []),
          ...(typeof current.metadata?.rawExcerpt === "string" ? [current.metadata.rawExcerpt] : []),
          ...extracted.filter((value): value is string => typeof value === "string")];
        return excerpts.some(value => value && hasInputEvidence(turn.originalMessage, value));
      }
      return operation.action === "copy" && !!current.metadata?.fieldSource
        && (operation.reference.task_ref !== sourcePlanRef || operation.reference.target_ref !== sourceTargetRef);
    });
  }
  /** 机构结论由模型建议通道（suggestion）命中且来源标记为推断/纠错时，绑定层首发来源确认题：
   * 后端确定性纠错（无 suggested）已由目录核验，不再追问；已有 applied 回执或 open/rejected 旧题不重复签发。 */
  private async issueSourceConfirmations(plan: SemanticPlan, tasks: ReadonlyMap<string, SemanticTask>, result: SemanticQuestionIssue[]): Promise<void> {
    const planRefs = new Set([plan.ref, ...plan.steps.flatMap(step => step.source.kind === "reference" ? [step.source.task_ref] : [])]);
    const views = (await Promise.all([...planRefs].map(ref => this.store.questionsForPlan(ref)))).flat();
    for (const step of plan.steps.filter(item => item.kind === "query")) {
      const task = tasks.get(step.id); if (!task) continue;
      for (const fieldName of ["organizations", "comparison_organizations"] as const) {
        const field = task.target.fields[fieldName];
        if (field?.resolutionStatus !== "resolved" || field.metadata?.semanticTurn !== step.operationId
          || !["model_inferred", "corrected"].includes(String(field.metadata?.resolution_source))
          || !Array.isArray(field.metadata?.suggested) || !(field.metadata.suggested as unknown[]).length) continue;
        const existing = views.filter(view => view.binding.reason === "source_confirmation" && view.question.scope.field === fieldName
          && (view.binding.taskRef === task.ref || view.binding.targetRef === step.targetRef));
        if (existing.some(view => ["open", "answered", "rejected"].includes(view.question.status))) continue;
        const entity = field.resolvedValue as {codes: string[]; names: string[]};
        if (!entity.codes.length) continue;
        const label = entity.names.join("、"), key = `source_confirmation:${fieldName}`;
        const rawValues = Array.isArray(field.metadata?.extractedRawValues)
          ? (field.metadata.extractedRawValues as unknown[]).filter((value): value is string => typeof value === "string")
          : typeof field.rawValue === "string" ? [field.rawValue] : [];
        const suggested = Array.isArray(field.metadata?.suggested)
          ? field.metadata.suggested as Array<{code?: string; name?: string; excerpt?: string}> : undefined;
        const excerpt = typeof field.metadata?.rawExcerpt === "string" ? field.metadata.rawExcerpt : undefined;
        const prompt = `请确认是否将${excerpt ?? "您提到的机构"}理解为「${label}」。`;
        const businessBasis = {field: fieldName, kind: "confirm" as const, confirmation_key: key, prompt, selection_mode: "single" as const,
          rawValue: field.rawValue, resolutionInput: {rawValues, suggested, sourceQuestion: step.sourceQuestion},
          catalog: {codes: entity.codes}, permission: {codes: entity.codes}, options: [{key, label}]};
        result.push({itemKey: `source:${task.ref}:${fieldName}:${rawValues.join("\u0001")}`, owner: plan.owner,
          draft: {version: 1, scope: {task_ref: plan.ref, target_ref: step.targetRef, field: fieldName,
            item_ref: `source:${task.ref}:${fieldName}`}, prompt, selection_mode: "single", issued_operation_id: plan.operationId,
            kind: "confirm", confirmation_key: key, businessBasis,
            options: [{key, no: 1, label, binding: {value: label, metadata: {sourceConfirmation: true}}}]},
          binding: {reason: "source_confirmation", planRef: plan.ref, targetRef: step.targetRef, taskRef: task.ref,
            sourceQuestion: step.sourceQuestion, pendingItem: {rawValue: field.rawValue},
            sourceConfirmation: {option_id: "", organizationCondition: structuredClone(field.resolvedValue)},
            resolutionBasis: {rawValues, suggested, sourceQuestion: step.sourceQuestion, codes: entity.codes, names: entity.names}}});
        if (!plan.issues.some(item => item.code === "SOURCE_CONFIRMATION_REQUIRED")) plan.issues.push(problem("SOURCE_CONFIRMATION_REQUIRED",
          `按有权机构清单将${excerpt ? `「${excerpt}」` : "您提到的机构"}理解为「${label}」，该对应关系尚未确认，本次未执行查询。请确认；若理解有误，请直接回复正确的机构名称。`,
          "user", "catalog"));
      }
    }
  }
  private async continueSourceConstraints(plan: SemanticPlan, tasks: ReadonlyMap<string, SemanticTask>, turn: SemanticTurn,
    applications: readonly SemanticAnswerApplication[], changes: ReadonlyMap<string, SemanticOperation[]>, result: SemanticQuestionIssue[]): Promise<void> {
    const planRefs = new Set([plan.ref, ...(turn.context?.plan ? [turn.context.plan.ref] : []),
      ...plan.steps.flatMap(step => step.source.kind === "reference" ? [step.source.task_ref] : [])]);
    const views = [...new Map((await Promise.all([...planRefs].map(ref => this.store.questionsForPlan(ref)))).flat()
      .map(view => [`${view.question.question_id}/${view.question.version}`, view])).values()];
    const handled = new Set(applications.map(application => application.snapshot.answer.question_id));
    for (const step of plan.steps.filter(item => item.kind === "query")) {
      const task = tasks.get(step.id); if (!task) continue;
      for (const view of views) {
        const questionId = view.question.question_id, field = view.question.scope.field;
        if (handled.has(questionId) || view.binding.reason !== "source_confirmation" || !["open", "rejected"].includes(view.question.status)
          || !["organizations", "comparison_organizations"].includes(field)) continue;
        const contextStep = turn.context?.plan?.steps.find(item => item.id === step.id);
        const bound = view.binding.taskRef === step.taskRef || view.binding.targetRef === step.targetRef
          || step.source.kind === "reference" && view.binding.planRef === step.source.task_ref && view.binding.targetRef === step.source.target_ref
          || !!contextStep && (view.binding.taskRef === contextStep.taskRef || view.binding.targetRef === contextStep.targetRef);
        const current = task.target.fields[field];
        const replacedEarlier = view.question.status === "rejected" && current?.resolutionStatus === "resolved"
          && typeof current.metadata?.semanticTurn === "string"
          && current.metadata?.resolution_source !== "model_inferred"
          && (Array.isArray(current.metadata?.source_codes) || !!current.metadata?.fieldSource);
        if (!bound || replacedEarlier || this.hasSourceReplacement(step, task, field, turn, changes, view.binding.planRef, view.binding.targetRef)) continue;
        if (!plan.issues.some(item => item.code === "SOURCE_CONFIRMATION_REQUIRED")) plan.issues.push(problem("SOURCE_CONFIRMATION_REQUIRED",
          "机构来源尚未确认，已保留完整机构解析集合；请确认来源或给出正确机构名称。", "user", "catalog"));
        if (view.binding.planRef === plan.ref && view.binding.targetRef === step.targetRef && view.binding.taskRef === task.ref
          || result.some(issue => issue.itemKey === view.itemKey)) continue;
        const options = view.question.options.map(option => {
          const binding = view.binding.options.find(item => item.option_id === option.option_id);
          return {key: binding?.candidateKey ?? option.option_id, no: option.no, label: option.label,
            ...(option.description !== undefined ? {description: option.description} : {}), binding: structuredClone(binding?.candidate)};
        });
        const confirmationKey = view.question.kind === "confirm"
          ? view.binding.options.find(option => option.option_id === view.question.confirmation_option_id)?.candidateKey : undefined;
        if (!confirmationKey) continue;
        const draft = {version: view.question.version,
          scope: {task_ref: plan.ref, target_ref: step.targetRef, field, item_ref: view.binding.item_ref},
          prompt: view.question.prompt, selection_mode: view.question.selection_mode, options,
          issued_operation_id: view.question.issued_operation_id, kind: "confirm", confirmation_key: confirmationKey,
          businessBasis: structuredClone(view.binding.businessBasis)} as SemanticQuestionIssue["draft"];
        result.push({itemKey: view.itemKey, owner: plan.owner, draft,
          binding: {reason: "source_confirmation", planRef: plan.ref, targetRef: step.targetRef, taskRef: task.ref,
            ...(view.binding.sourceQuestion ? {sourceQuestion: view.binding.sourceQuestion} : {}),
            ...(view.binding.pendingItem ? {pendingItem: structuredClone(view.binding.pendingItem)} : {}),
            ...(view.binding.sourceConfirmation ? {sourceConfirmation: structuredClone(view.binding.sourceConfirmation)} : {}),
            resolutionBasis: structuredClone(view.binding.resolutionBasis)}});
      }
    }
  }
  private async prepareSourceAnswers(plan: SemanticPlan, targets: ReadonlyMap<string, SemanticAnswerSnapshot[]>,
    tasks: ReadonlyMap<string, SemanticTask>, turn: SemanticTurn, changes: ReadonlyMap<string, SemanticOperation[]>): Promise<SemanticAnswerApplication[]> {
    const result: SemanticAnswerApplication[] = [];
    for (const [stepId, snapshots] of targets) {
      const step = plan.steps.find(item => item.id === stepId)!, task = tasks.get(stepId);
      for (const snapshot of snapshots.filter(item => item.binding.reason === "source_confirmation")) {
        if (!task || !["organizations", "comparison_organizations"].includes(snapshot.question.scope.field)) {
          fail("ANSWER_TARGET_AMBIGUOUS", "来源确认题必须绑定已解析机构条件的唯一任务。", "reference");
        }
        const field = snapshot.question.scope.field;
        if (!["accept", "reject", "none_of_these"].includes(snapshot.answer.choice.type)) {
          fail("ANSWER_SELECTION_INVALID", "来源确认题只能 accept 或拒绝，不能改成普通子集选择。", "input_shape");
        }
        const current = task!.target.fields[field], currentCodes = codes(task!, field);
        const basis = snapshot.binding.resolutionBasis as {rawValues?: unknown; suggested?: Array<{code?: string; name?: string; excerpt?: string}>};
        const condition = snapshot.binding.sourceConfirmation?.organizationCondition as {codes?: unknown} | undefined;
        const expectedCodes = Array.isArray(condition?.codes) && condition.codes.every(code => typeof code === "string") ? condition.codes as string[] : [];
        let outcome: SemanticAnswerApplication["outcome"] = snapshot.alreadyApplied ? "already_applied" : snapshot.existingReceipt?.outcome
          ?? (snapshot.answer.choice.type === "accept" ? "not_applied" : "declined");
        if (!snapshot.existingReceipt && snapshot.answer.choice.type === "accept") {
          const rawValues = Array.isArray(basis.rawValues) && basis.rawValues.every(value => typeof value === "string") ? basis.rawValues as string[]
            : typeof current?.rawValue === "string" ? [current.rawValue] : [];
          const sourceQuestion = snapshot.binding.sourceQuestion ?? step.sourceQuestion;
          const response = basis.suggested?.length
            ? await this.request.backend.resolveBusinessFieldSuggestion("organization", basis.suggested, {signal: this.signal}, sourceQuestion, rawValues)
            : await this.request.backend.resolveBusinessField("organization", rawValues, {signal: this.signal}, undefined,
              {business_date: turn.businessDate, source_question: sourceQuestion});
          const value = response.value as {codes?: unknown; names?: unknown} | undefined;
          const valid = response.status === "resolved" && Array.isArray(value?.codes) && Array.isArray(value.names)
            && value.codes.length === value.names.length && value.codes.every(code => typeof code === "string" && code)
            && JSON.stringify([...value.codes].sort()) === JSON.stringify([...expectedCodes].sort())
            && JSON.stringify([...currentCodes].sort()) === JSON.stringify([...expectedCodes].sort());
          outcome = valid ? "applied" : "not_applied";
        }
        const replaced = outcome === "declined" && this.hasSourceReplacement(step, task!, field, turn, changes, snapshot.binding.planRef, snapshot.binding.targetRef);
        if (outcome === "not_applied" || outcome === "declined" && !replaced) {
          if (!plan.issues.some(item => item.code === "SOURCE_CONFIRMATION_REQUIRED")) plan.issues.push(problem("SOURCE_CONFIRMATION_REQUIRED",
            "机构来源尚未确认，已保留完整机构解析集合；请确认来源或给出正确机构名称。", "user", "catalog"));
        }
        const continuedSnapshot = replaced ? snapshot : {...snapshot, binding: {...snapshot.binding, planRef: plan.ref, targetRef: step.targetRef, taskRef: task!.ref}};
        result.push({snapshot: continuedSnapshot, outcome, planRef: plan.ref, targetRef: step.targetRef,
          ...(outcome === "not_applied" ? {code: "ANSWER_SOURCE_REVALIDATION_FAILED"} : {}),
          ...(outcome === "applied" ? {expectedTaskRevision: task!.revision, expectedOrganizationCodes: expectedCodes} : {})});
      }
    }
    return result;
  }
  private mapAnswers(snapshots: readonly SemanticAnswerSnapshot[], steps: SemanticPlanStep[], input: SemanticRequest,
    turn: SemanticTurn) {
    const result = new Map<string, SemanticAnswerSnapshot[]>();
    for (const snapshot of snapshots) {
      const binding = snapshot.binding;
      const matches = steps.filter(step => {
        if (step.source.kind === "new") return false;
        const reference = step.source.kind === "reference" && step.source.task_ref === binding.planRef && step.source.target_ref === binding.targetRef;
        const current = step.source.kind === "current" && steps.filter(item => item.source.kind === "current").length === 1
          && (step.taskRef === binding.taskRef || step.targetRef === binding.targetRef
            || turn.context?.plan?.steps.length === 1 && turn.context.plan.steps[0]?.targetRef === binding.targetRef);
        return reference || current || step.taskRef === binding.taskRef || step.targetRef === binding.targetRef;
      });
      if (matches.length !== 1) fail("ANSWER_TARGET_AMBIGUOUS",
        `问题 ${snapshot.answer.question_id} 不能映射到唯一本轮步骤；禁止 source=new 借答和分叉广播。`, "reference");
      const step = matches[0]!;
      // 序号必须落在本轮实际展示的候选清单内：隐藏候选不能借未展示序号被选中，
      // 日期等其它字段的数字也不作为选择序号（candidateOrdinal 已排除年月语境）。
      const excerpt = snapshot.answer.source.excerpt ?? "";
      if (answerOrdinalConflict(snapshot.question, excerpt, snapshot.answer.choice)) {
        const labels = snapshot.question.options.map(option => `${option.no}. ${option.label}`).join("；");
        throw new SemanticConflict({code: "ANSWER_SELECTION_MISMATCH", field: snapshot.question.scope.field, category: "input_shape",
          message: `回复中的序号与已展示候选不一致；本轮仅展示 ${snapshot.question.options.length} 项：${labels}。请选择已展示项或补充完整业务名称。`,
          remediation: "user"});
      }
      const operations = targetChanges(input, steps, step).filter(operation => operation.field === snapshot.question.scope.field);
      if (operations.some(operation => operation.action === "confirm")) {
        fail("ANSWER_OPERATION_CONFLICT", "结构化 Answer 与同字段旧 confirm 重复，请删除冗余 confirm。", "input_shape");
      }
      if (["select", "accept"].includes(snapshot.answer.choice.type) && operations.length) {
        fail("ANSWER_OPERATION_CONFLICT", "选择候选与同字段 operations 冲突，请保留明确的一种变更。", "input_shape");
      }
      result.set(step.id, [...(result.get(step.id) ?? []), snapshot]);
    }
    return result;
  }
  private async bindFragment(goal: Goal, step: SemanticPlanStep, analysis: boolean, businessDate: string): Promise<string> {
    if (goal.fragments.length === 1) return goal.fragments[0]!.question;
    const org = text(step.operations, "organizations"), time = text(step.operations, "time"), metrics = text(step.operations, "metrics");
    const entity = org ? await resolveTurnField(this.request, "organization", [org], {signal: this.signal}) : undefined;
    // 时间换算随原文一并参与片段绑定，与主解析路径同一 model_value 通道；businessDate 用本轮冻结值，跨环节一致。
    const modelCalendar = step.operations.flatMap(op => op.field === "time" && "modelCalendar" in op && op.modelCalendar ? [op.modelCalendar] : []).at(-1);
    const dates = time ? await resolveTurnField(this.request, "date", [time], {signal: this.signal}, goal.reference_year ?? undefined,
      {business_date: businessDate, source_question: goal.question}, modelCalendar) : undefined;
    const metric = metrics ? await resolveTurnField(this.request, "metric", [metrics], {signal: this.signal}) : undefined;
    const organizations = (entity?.value as {codes?: string[]})?.codes ?? [];
    const range = dates?.value as {start?: string; end?: string} | undefined;
    const metricCodes = (metric?.value as {codes?: string[]})?.codes ?? [];
    const matches = goal.fragments.filter(fragment => (!organizations.length || organizations.every(code => fragment.organizations.includes(code)))
      && (!range?.start || fragment.calendar.ranges.some(value => range.start === value.start && range.end === value.end))
      && (analysis || !metricCodes.length || fragment.mentions.some(mention => (mention.resolution.value as {codes?: string[]})?.codes?.some(code => metricCodes.includes(code)))));
    if (matches.length !== 1) fail("TARGET_BINDING_AMBIGUOUS", "机构、日期和指标的目标绑定尚不唯一，请按原始并列条件修正完整提案。");
    return matches[0]!.question;
  }
  private child(plan: SemanticPlan, step: SemanticPlanStep): AskMetricRequestContext {
    const child = {...this.request, operationId: step.operationId, originalMessage: step.sourceQuestion,
      semanticStep: {planRef: plan.ref, rootOperationId: plan.operationId, revision: plan.revision, kind: step.kind, analysis: plan.intent === "analyze", multipleTargets: plan.steps.filter(item => item.kind === "query").length > 1, ...(plan.referenceYear ? {referenceYear: plan.referenceYear} : /(?<!\d)(\d{4})年/u.exec(plan.originalMessage)?.[1] ? {referenceYear: Number(/(?<!\d)(\d{4})年/u.exec(plan.originalMessage)![1])} : {})}};
    // 子任务沿用本轮正式目录签发的短引用，不能把请求对象变化误判为未发现指标。
    inheritAnalysisState(this.request, child);
    return child;
  }
  async locate(taskRef: string, targetRef: string) {
    const plan = await this.store.plan(taskRef), step = plan?.steps.find(item => item.targetRef === targetRef);
    if (!plan || !step || plan.owner !== this.request.actor.id) fail("REFERENCE_INVALID", "任务引用不可用或目标已修订。", "reference");
    // 派生计划（reuse/续接）会继承来源计划的 taskRef，task.parentPlan 仍指向源计划属合法绑定；
    // 配对一致性由 targetRef 与 task.target.ref 相等保证（taskFor 复核），执行授权只认 permit digest。
    const task = step!.taskRef ? await this.store.get(step!.taskRef) : undefined;
    if (step!.taskRef && (!task || task.target.ref !== targetRef)) fail("REFERENCE_INVALID", "任务引用不可用或目标已修订。", "reference");
    if (task?.permit && !task.permit.consumed && task.permit.digest !== snapshotDigest(task.target)) {
      fail("EXECUTION_PERMIT_INVALID", "执行许可与当前条件不一致，请读取最新回执后重试。");
    }
    return {plan: plan!, step: step!, request: this.child(plan!, step!)};
  }
  async prepareCalculation(plan: SemanticPlan, step: SemanticPlanStep): Promise<SemanticTask> {
    const formula = parseFormula(text(step.operations, "calculation") ?? "", plan.steps.filter(item => item.kind === "query").flatMap(aliases), this.request.originalMessage);
    const bindings: Record<string, {fact_id: string}> = {};
    let expression = formula.expression;
    for (const [number, label] of formula.labels.entries()) {
      const dependency = plan.steps.find(item => item.kind === "query" && aliases(item).includes(label))!, source = dependency.taskRef ? await this.store.get(dependency.taskRef) : undefined;
      if (dependency.status !== "succeeded" || !source?.target.frameId) fail("CALCULATION_DEPENDENCY_PENDING", `计算来源“${label}”尚未成功。`);
      const origin = await this.request.frames!.get(source!.target.frameId!), state = await this.request.frames!.state();
      const frame = origin ? await this.request.frames!.get(state.operations[origin.operationFrameId] ?? origin.frameId) : undefined;
      if (!frame?.resultRef?.startsWith("query:") || frame.resultSummary?.truncated) fail("CALCULATION_INPUT_INCOMPLETE", "计算来源不完整，不能使用截断结果。");
      const result = await this.request.backend.getTaskResult(decodeURIComponent(frame!.resultRef!.split(":")[1] ?? ""), 0, 100, {signal: this.signal});
      const facts = result.facts ?? [];
      if (result.truncated || result.has_more || !facts.length || facts.length < result.row_count || facts.some(fact => fact.value === null)) fail("CALCULATION_INPUT_INCOMPLETE", "计算需要完整、有效的正式数值事实，不能用展示样本或空值代替。");
      const names = facts.map((fact, index) => {const variable = `v${number}_${index}`; bindings[variable] = {fact_id: fact.fact_id}; return variable;});
      const token = `v${number}`;
      if (names.length === 1) expression = expression.replace(new RegExp(`\\b${token}\\b`, "gu"), names[0]!);
      else {
        const aggregate = new RegExp(`\\b(sum|avg|min|max)\\s*\\(\\s*${token}\\s*\\)`, "gu");
        expression = expression.replace(aggregate, (_all, fn: string) => `${fn}(${names.join(",")})`);
        if (new RegExp(`\\b${token}\\b`, "u").test(expression)) fail("CALCULATION_SOURCE_AMBIGUOUS", `来源“${label}”包含多个数值，请明确聚合方式或拆分来源。`);
      }
    }
    const child = this.child(plan, step);

    const task: SemanticTask = {ref: semanticRef(), owner: this.request.actor.id, parentPlan: plan.ref, capability: "metric_calculate", revision: 1,
      originalMessage: plan.originalMessage, status: "active", completion: "unmet", issues: [], target: {ref: step.targetRef, status: "ready", pending: {}, fields: {
        expressions: field(text(step.operations, "calculation")!, [{name: "result", label: step.label ?? "计算结果", expression, display: formula.display}]), ...(Object.keys(formula.constants).length ? {constants: field("用户原句常量", formula.constants)} : {}), bindings: field("正式查询事实", bindings),
        scope_policy: field("用户目标的比较范围", "explicit"),
      }}};
    const frame = await new SemanticTaskService(child, this.signal).compile(task); task.target.frameId = frame.frameId;
    task.permit = {operationId: step.operationId, revision: task.revision, actor: this.request.actor.id, digest: snapshotDigest(task.target), frameId: frame.frameId, consumed: false};
    await this.store.save(task, (await this.store.index()).version, undefined, false);
    step.taskRef = task.ref; step.status = "ready"; step.dependencyTargets = step.dependencies.map(id => plan.steps.find(item => item.id === id)!.targetRef);
    await this.save(plan); return task;
  }
  async settled(planRef: string, stepId: string, task: SemanticTask, options: {readOnly?: boolean} = {}): Promise<SemanticFeedback> {
    const plan = (await this.store.plan(planRef))!, step = plan.steps.find(item => item.id === stepId)!;
    // 只重显旧证据时不重结算历史计划，也不改变当前业务焦点。
    if (options.readOnly) return this.feedback(plan, "reused");
    step.status = task.target.status;
    const origin = task.target.frameId ? await this.request.frames?.get(task.target.frameId) : undefined;
    const state = await this.request.frames!.state();
    const frame = origin ? await this.request.frames!.get(state.operations[origin.operationFrameId] ?? origin.frameId) : undefined;
    if (frame) step.evidence = {frameId: frame.frameId, ...(frame.resultRef ? {resultRef: frame.resultRef} : {}), truncated: !!frame.resultSummary?.truncated,
      ...(typeof frame.resultSummary?.fields?.analysis_complete === "boolean" ? {complete: frame.resultSummary.fields.analysis_complete} : {})};
    const successful = plan.steps.filter(item => item.status === "succeeded" && !item.evidence?.truncated && item.evidence?.complete !== false).length;
    // 完成度只取已绑定目标的正式执行状态，不再复扫原话或重建另一份覆盖义务。
    plan.issues = [];
    plan.completion = successful === plan.steps.length ? "full" : plan.steps.some(item => item.status === "succeeded") ? "partial" : "unmet";
    const unknown = plan.steps.some(item => item.status === "unknown" || item.status === "executing"), failed = plan.steps.some(item => item.status === "failed");
    plan.status = plan.completion === "full" ? "completed" : unknown ? "waiting_dependency" : failed ? "stopped" : "active";
    await this.save(plan, true);
    return this.feedback(plan, unknown ? "unknown" : failed ? "failed" : plan.completion === "full" || plan.intent === "analyze" && plan.steps.every(item => item.status === "succeeded") ? "succeeded" : "ready");
  }
}
function targetChanges(input: SemanticRequest, proposed: SemanticPlanStep[], step: SemanticPlanStep): SemanticOperation[] {
  return input.targets[proposed.indexOf(step)]?.operations ?? [];
}
