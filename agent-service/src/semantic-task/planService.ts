import {createHash} from "node:crypto";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {BasicQuerySpec} from "../backendClient.js";
import {BackendApiError} from "../backendClient.js";
import {createCapabilities} from "../business-context/capabilities.js";
import {metricCoverageSource} from "../business-context/adapters.js";
import {hasInputEvidence} from "../business-context/inputEvidence.js";
import type {ResolvedField} from "../business-context/types.js";
import {SemanticConflict, SemanticTaskService, snapshotDigest, explicitOrganizationCount} from "./service.js";
import {semanticRef, type SemanticIssue, type SemanticPlan, type SemanticPlanStep, type SemanticTask, type SemanticTurn} from "./store.js";
import type {SemanticRequest, SemanticOperation, SemanticSource} from "./protocol.js";
import {semanticFeedback, type SemanticFeedback} from "./feedback.js";
import {semanticDisplay} from "./display.js";
import {completeQuery, transitionBasis} from "./transition.js";
import {parseFormula} from "./calculation.js";
import {frozenSourceOptions, pendingCompletionSource, explicitContextReset, sourceSelection} from "./sourceGuard.js";

type Goal = Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>;
const problem = (code: string, message: string, remediation: SemanticIssue["remediation"] = "pi", category = "semantic"): SemanticIssue => ({code, message, remediation, category});
const fail = (code: string, message: string, category = "semantic"): never => {throw new SemanticConflict(problem(code, message, "pi", category));};
const text = (operations: SemanticOperation[], field: string) => operations.flatMap(op => op.field === field && "value" in op ? [op.value] : []).at(-1);
const codes = (task: SemanticTask, field: string) => (task.target.fields[field]?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? [];
const field = (rawValue: string, resolvedValue: unknown): ResolvedField => ({rawValue, resolvedValue, resolutionStatus: "resolved", source: "resolved"});
const aliases = (step: SemanticPlanStep) => [...new Set([step.label, ...(step.aliases ?? [])].filter((name): name is string => !!name))];
export const semanticPlanDigest = (plan: SemanticPlan) => createHash("sha256").update(JSON.stringify(plan.steps.map(step => [step.id, step.taskRef, step.targetRef, step.operations, step.dependencies]))).digest("hex");
const digest = semanticPlanDigest;
const canonical = (task: SemanticTask): BasicQuerySpec => {
  const spec=completeQuery(task.target);if(!spec)fail("QUERY_CONDITIONS_INCOMPLETE","完整规范条件尚未确定。");return spec!;
};

/** 任务编排与单步规范化分离。所有步骤共用原生Session和Pi循环；整批获准前不能消费任何子步骤许可。 */
export class SemanticPlanService {
  constructor(private readonly request: AskMetricRequestContext, private readonly signal?: AbortSignal) {}
  private get store() {if (!this.request.semanticTasks) throw new Error("SEMANTIC_STORE_NOT_BOUND"); return this.request.semanticTasks;}
  private async save(plan: SemanticPlan, focus = false) {return this.store.savePlan(plan, (await this.store.planIndex()).version, focus);}
  private async adopt(task: SemanticTask): Promise<SemanticPlan> {
    if (task.owner !== this.request.actor.id) fail("REFERENCE_INVALID", "历史任务不可读取。", "reference");
    const plan: SemanticPlan = {ref: semanticRef(), owner: task.owner, revision: 0, operationId: this.request.operationId, goalOperationId: "legacy",
      intent: "query", originalMessage: task.originalMessage, status: task.status, completion: task.completion, issues: task.issues,
      steps: [{id: semanticRef(), targetRef: task.target.ref, taskRef: task.ref, operationId: task.permit?.operationId ?? "legacy", kind: "query", source: {kind: "new"}, sourceQuestion: task.originalMessage, operations: [], dependencies: [], status: task.target.status, required: true, issues: task.issues}], requirements: [{id: "0", question: task.originalMessage, stepIds: []}]};
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
    delete plan.admitted; await this.save(plan);
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
    if (plan.intent === "analyze" && status === "succeeded") result.continuation = {actor: "pi", action: "continue_analysis"};
    return result;
  }
  async resolve(input: SemanticRequest): Promise<SemanticFeedback> {
    input = structuredClone(input);
    for (const target of input.targets) {
      const assigned = target.operations.filter(operation => operation.action === "set").map(operation => operation.field);
      if (new Set(assigned).size !== assigned.length) fail("FIELD_MULTIPLE_ASSIGNMENTS", "同一目标同一字段只能set一次。历史组共享同一operations；需要分别命名时拆为独立reference目标。", "input_shape");
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
    const turn = await this.store.admit(this.request.operationId, this.request.originalMessage);
    const pending = turn.context?.clarification, contextAction = input.context_action ?? turn.contextAction;
    if (input.context_action) await this.store.bindContextAction(this.request.operationId, input.context_action);
    const matchesPending = (source: SemanticSource) => source.kind === "reference" && pending?.alternatives.some(option =>
      option.task_ref === source.task_ref && option.target_ref === source.target_ref);
    if (contextAction === "resume" && (!pending || input.intent === "reuse" || !input.targets.some(target => matchesPending(target.source)))) {
      fail("CLARIFICATION_SOURCE_REQUIRED", "续接待明确修改需要Pi选择已保存备选来源；只显示原结果时使用defer，放弃原修改时使用abandon。", "reference");
    }
    const resumesClarification = contextAction === "resume" && !!pending;
    const semanticMessage = resumesClarification ? pending.originalMessage + "\n" + this.request.originalMessage : this.request.originalMessage;
    const index = await this.store.planIndex();
    let plan = index.operations[this.request.operationId] ? await this.store.plan(index.operations[this.request.operationId]!) : undefined;
    let focus = plan ?? (turn.context ? turn.context.plan : index.focus ? await this.store.plan(index.focus) : undefined);
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
    const inputFacts = await this.request.backend.inspectBusinessGoal(this.request.originalMessage, turn.businessDate, {signal: this.signal});
    const reset = explicitContextReset(this.request.originalMessage);
    if (reset && input.targets.some(target => target.source.kind !== "new")) fail("CONTEXT_RESET_SOURCE_CONFLICT", "用户明确不沿用条件，本轮只能从new和已提供字段开始；删除无本轮依据的旧字段并保存真实缺项，不得改回current/reference。", "reference");
    if (!reset && !resumesClarification) {
      const selection = await sourceSelection(this.request, input, turn, inputFacts);
      if (selection) throw new SemanticConflict(selection);
    }
    const completionSources = await pendingCompletionSource(this.request, input, turn, inputFacts, this.signal);
    if (completionSources?.length) throw new SemanticConflict({...problem("CONFIRMED_CONTEXT_SOURCE_REQUIRED",
      "本轮是在补充唯一待明确目标的缺项，或已明确要求其他条件不变；已确认指标仍保留，new会丢弃这些条件。请从source_options复制reference，或用唯一current，保留本轮字段变化后重提。宿主未修改来源、未创建新目标，也未执行查询。", "pi", "reference"), source_options: completionSources});
    for (const target of input.targets.filter(target => target.source.kind === "new")) {
      const unsupported = target.operations.filter(op => "value" in op && (["organizations", "time"].includes(op.field) || input.intent === "query" && op.field === "metrics")
        && !hasInputEvidence(this.request.originalMessage, op.value) && !inputFacts.fragments.some(fragment => op.field === "organizations"
          ? fragment.organizations.length : op.field === "metrics" ? fragment.mentions.length : fragment.calendar.ranges.length || fragment.calendar.unresolved.length));
      if (unsupported.length && reset) fail("NEW_TARGET_FIELDS_UNGROUNDED", `用户明确不继承历史，请删除没有本轮依据的字段：${unsupported.map(operation => operation.field).join("、")}，保留真正提供的条件并保存缺项。`, "reference");
      if (unsupported.length && turn.context?.tasks.length) throw new SemanticConflict({...problem("NEW_TARGET_SOURCE_UNBOUND",
        "new从空条件开始，不能复述没有本轮依据的历史指标、机构或日期。沿用条件时复制source_options或admitted_context签发的reference，再提交实际变化；真正独立新问题可保留new并删除无依据字段。已知原目标仍保留，不能把模型来源错误变成用户缺项。", "pi", "reference"), source_options: frozenSourceOptions(turn, this.request.actor.id)});
    }
    if (!plan) {
      const refs = input.targets.filter(target => target.source.kind !== "new");
      const base = refs.length ? refs[0]!.source.kind === "reference" ? await this.store.plan(refs[0]!.source.task_ref) : focus : undefined;
      if (refs.some(target => target.source.kind === "current") && !focus) fail("REFERENCE_UNAVAILABLE", "当前没有可续接任务，请读取历史或新建目标。", "reference");
      const coverageTransition = base?.steps.every(step => step.kind === "availability") && ["query", "analyze"].includes(input.intent);
      const completedTransition = !!base && ["query", "prepare"].includes(input.intent) && base.operationId !== this.request.operationId;
      plan = base ? {...structuredClone(base), ...(base.ref !== focus?.ref || coverageTransition || completedTransition || input.intent === "reuse" || input.targets.some(target => target.source.kind === "reference") ? {ref: semanticRef(), revision: 0} : {})} : {ref: semanticRef(), owner: this.request.actor.id, revision: 0, operationId: this.request.operationId,
        goalOperationId: this.request.operationId, intent: input.intent, originalMessage: semanticMessage, status: "active", completion: "unmet", issues: [], steps: [], requirements: []};
      if (plan.owner !== this.request.actor.id) fail("REFERENCE_INVALID", "当前任务不可读取。", "reference");
      if (!base || plan.ref !== base.ref) plan.proposalOperationId = this.request.operationId;
      if (base && (coverageTransition || completedTransition || input.intent === "reuse" || input.targets.some(target => target.source.kind === "reference"))) {
        plan.steps = input.targets.flatMap(target => {
          const source = target.source;
          const selected = source.kind === "reference" ? base.steps.filter(step => step.targetRef === source.target_ref) : target.source.kind === "current" && base.steps.length === 1 ? base.steps : [];
          return selected.map(step => ({...structuredClone(step), id: semanticRef(), source: structuredClone(target.source)}));
        });
        plan.originalMessage = semanticMessage; plan.requirements = []; plan.goalOperationId = "history";
      }
      plan.operationId = this.request.operationId; plan.intent = input.intent;
      plan.topicRef = base ? await this.store.topicFor(base) : plan.ref;
      // 跨轮沿用原始义务，新的变更仍由各子步骤绑定真实本轮消息。
    }
    plan.intent = input.intent === "query" && plan.intent === "analyze" ? "analyze" : input.intent;
    const previouslyAdmitted = plan.admitted?.operationId === this.request.operationId;
    plan.revision++; delete plan.admitted; plan.issues = []; plan.status = "active"; plan.completion = "unmet";
    const analysis = input.intent === "analyze" || plan.intent === "analyze";
    const isNewGoal = !plan.steps.length;
    const ownedDraft = plan.goalOperationId === this.request.operationId || plan.proposalOperationId === this.request.operationId
      && ["query", "prepare"].includes(input.intent);
    const canRegroupDraft = !isNewGoal && !previouslyAdmitted && ownedDraft
      && plan.steps.every(step => ["blocked", "draft", "ready", "waiting_dependency"].includes(step.status));
    if (!isNewGoal && plan.operationId === this.request.operationId) {
      const years = new Set<string>();
      for (const step of plan.steps) if (step.taskRef) {
        const source = await this.store.get(step.taskRef), calendar = source?.target.fields.time?.resolvedValue as {start?: string; end?: string} | undefined;
        if (calendar?.start && calendar.end) {years.add(calendar.start.slice(0,4)); years.add(calendar.end.slice(0,4));}
      }
      if (years.size === 1) plan.referenceYear = Number([...years][0]); else delete plan.referenceYear;
    }
    const goal = await this.request.backend.inspectBusinessGoal(isNewGoal ? semanticMessage : plan.originalMessage, turn.businessDate, {signal: this.signal}, plan.referenceYear);
    const proposalGoal = input.targets.some(target => target.source.kind !== "new")
      ? await this.request.backend.inspectBusinessGoal(semanticMessage, turn.businessDate, {signal: this.signal}, plan.referenceYear) : goal;
    const freshGoal = resumesClarification && input.targets.some(target => target.source.kind === "new")
      ? await this.request.backend.inspectBusinessGoal(this.request.originalMessage, turn.businessDate, {signal: this.signal}, plan.referenceYear) : goal;
    const proposed: SemanticPlanStep[] = [];
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
        if (!step) {step = {...structuredClone(saved!.step), id: semanticRef()}; plan.steps.push(step);}
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
        step.sourceQuestion = target.source.kind === "new" ? await this.bindFragment(sourceGoal, step, analysis) : resumesClarification && matchesPending(target.source) ? semanticMessage : this.request.originalMessage;
      }
      const calendar = [...proposalGoal.fragments, ...goal.fragments].find(fragment => fragment.question === step.sourceQuestion)?.calendar;
      if (calendar) step.calendar = calendar; else delete step.calendar;
      if (!labelOnly && step.status === "succeeded") step.status = "draft";
      if (labelOnly) {proposed.push(step); continue;}
      proposed.push(step);
    }
    // 未获准的模型拆分可被完整新提案重组；原始用户义务仍由账本和整批准入核验，旧提案留存但不再具有执行资格。
    if (canRegroupDraft) {
      const superseded = plan.steps.filter(step => !proposed.includes(step));
      if (superseded.length) {plan.supersededSteps = [...(plan.supersededSteps ?? []), ...structuredClone(superseded)]; plan.steps = proposed;}
    }
    // 已获准或已执行目标继续存在；不能通过缩短数组获得半份许可。
    if (isNewGoal) plan.requirements = goal.fragments.map((fragment, number) => ({id: String(number), question: fragment.question, stepIds: [],
      ...({checks: fragment.mentions.flatMap(mention => {
        const value = mention.resolution.value as {codes?: string[]; names?: string[]} | undefined;
        return (value?.codes ?? []).map((metric, i) => ({metric, name: value?.names?.[i] ?? mention.text, orgs: fragment.organizations, ranges: fragment.calendar.ranges}));
      })})}));
    for (const requirement of plan.requirements) requirement.stepIds = plan.steps.filter(step => step.sourceQuestion === requirement.question).map(step => step.id);
    await this.save(plan);
    const tasks = new Map<string, SemanticTask>();
    for (const step of proposed) {
      if (step.kind === "calculation" || step.status === "succeeded") continue;
      const existing = step.taskRef ? await this.store.get(step.taskRef) : undefined;
      await this.store.admit(step.operationId, step.sourceQuestion, existing?.parentPlan === plan.ref ? existing.ref : null);
      const child = this.child(plan, step);
      const resolution = await new SemanticTaskService(child, this.signal).resolve({protocol_version: 2, intent: input.intent === "prepare" ? "prepare" : input.intent === "reuse" ? "reuse" : "query",
        targets: [{source: (await this.store.turn(step.operationId))?.source ?? (existing ? existing.parentPlan === plan.ref ? {kind: "current"} : {kind: "reference", task_ref: existing.ref, target_ref: step.targetRef} : {kind: "new"}), operations: targetChanges(input, proposed, step)}]});
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
      plan.issues.push(problem("ORGANIZATION_GROUP_COUNT_CONFLICT", `整笔请求要求${requestedCount}家机构，当前目标组未完整覆盖；请补读历史并选择完整来源集合。`, "pi", "reference"));
    }
    const binding = await this.groupAdmission(plan, goal, tasks, analysis, plan.goalOperationId === this.request.operationId, proposalGoal);
    if (binding) for (const step of proposed) {
      const task = tasks.get(step.id), receipt = binding.find(item => item.target_ref === step.targetRef)?.receipt;
      if (!task || !receipt || step.kind !== "query" || step.status === "succeeded") continue;
      const spec = canonical(task);
      const child = this.child(plan, step); child.semanticStep!.analysisSelection = {receipt, codes: spec.metric_codes, orgs: spec.org_codes!, time: spec.time};
      const resolution = await new SemanticTaskService(child, this.signal).resolve({protocol_version: 2, intent: input.intent === "prepare" ? "prepare" : "query",
        targets: [{source: (await this.store.turn(step.operationId))!.source!, operations: []}]});
      if (resolution.task) {step.taskRef = resolution.task.ref; step.targetRef = resolution.task.target.ref; tasks.set(step.id, resolution.task);
        const names = Object.fromEntries(["organizations", "time", "metrics"].map(name => [name, semanticDisplay(resolution.task!.target.fields[name])]));
        step.aliases = [...new Set([names.organizations, names.time, names.metrics, `${names.time}${names.metrics}`, `${names.organizations}${names.time}${names.metrics}`].filter((name): name is string => !!name))];
        step.label ??= ["organizations", "time", "metrics"].flatMap(name => {const value = semanticDisplay(resolution.task!.target.fields[name]); return value ? [value] : [];}).join(" / ") || step.kind;}
      step.status = resolution.task?.target.status ?? "blocked"; step.issues = resolution.task?.issues ?? resolution.issues ?? [];
    }
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
    // 整批准入已被拒绝时，步骤级的“等待对账”标记只是同一事实的复述；过滤掉它，
    // 否则它会以 remediation=pi 盖过真正的准入原因，驱动模型原样重提相同提案直至熔断。
    const admissionRejected = plan.issues.some(issue => issue.code.startsWith("TRANSITION_") || issue.code === "PLAN_NOT_ADMITTED");
    plan.issues.push(...plan.steps.flatMap(step => step.issues)
      .filter(issue => !(admissionRejected && issue.code === "TRANSITION_ADMISSION_REQUIRED")));
    const blocking = plan.steps.some(step => !["ready", "succeeded", "waiting_dependency", ...(input.intent === "prepare" ? ["draft"] : [])].includes(step.status));
    if (input.intent === "reuse" && plan.steps.some(step => step.status !== "succeeded")) plan.issues.push(problem("RESULT_NOT_READY", "目标尚无成功结果，不能重显。", "user", "reference"));
    const status = plan.issues.some(issue => issue.category === "permission") ? "denied"
      : plan.issues.some(issue => issue.category === "capability" && issue.remediation === "stop") ? "unsupported"
      : plan.issues.some(issue => issue.category === "infrastructure") ? "failed"
      : plan.issues.length || blocking ? plan.issues.some(issue => issue.remediation === "pi") ? "needs_interpretation" : plan.issues.some(issue => issue.remediation === "user") ? "needs_user" : "needs_interpretation"
      : input.intent === "prepare" ? "prepared" : input.intent === "reuse" ? "reused" : "ready";
    if (status === "ready" || status === "reused") plan.admitted = {operationId: plan.operationId, revision: plan.revision, digest: digest(plan)};
    plan.status = status === "needs_user" ? "waiting_input" : ["denied", "unsupported", "failed"].includes(status) ? "stopped" : "active";
    await this.save(plan, ["ready", "prepared", "reused", "needs_user"].includes(status));
    if (pending && (resumesClarification && ["ready", "prepared", "reused", "needs_user"].includes(status)
      || contextAction === "abandon")) await this.store.clearClarification(pending.operationId);
    return this.feedback(plan, status);
  }
  private async bindFragment(goal: Goal, step: SemanticPlanStep, analysis: boolean): Promise<string> {
    if (goal.fragments.length === 1) return goal.fragments[0]!.question;
    const org = text(step.operations, "organizations"), time = text(step.operations, "time"), metrics = text(step.operations, "metrics");
    const entity = org ? await this.request.backend.resolveBusinessField("organization", [org], {signal: this.signal}) : undefined;
    const dates = time ? await this.request.backend.resolveBusinessField("date", [time], {signal: this.signal}, goal.reference_year ?? undefined) : undefined;
    const metric = metrics ? await this.request.backend.resolveBusinessField("metric", [metrics], {signal: this.signal}) : undefined;
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
    return {...this.request, operationId: step.operationId, originalMessage: step.sourceQuestion,
      semanticStep: {planRef: plan.ref, rootOperationId: plan.operationId, revision: plan.revision, kind: step.kind, ...(step.calendar ? {calendar: step.calendar} : {}), analysis: plan.intent === "analyze", partialCalendar: plan.steps.filter(item => item.kind === "query").length > 1, jointCoverage: plan.steps.filter(item => item.kind === "query").length > 1, ...(plan.referenceYear ? {referenceYear: plan.referenceYear} : /(?<!\d)(\d{4})年/u.exec(plan.originalMessage)?.[1] ? {referenceYear: Number(/(?<!\d)(\d{4})年/u.exec(plan.originalMessage)![1])} : {})}};
  }
  private async groupAdmission(plan: SemanticPlan, goal: Goal, tasks: Map<string, SemanticTask>, analysis: boolean, initial: boolean, admissionGoal: Goal) {
    const query = plan.steps.filter(step => step.kind === "query");
    if (!query.length) return;
    const sourceIssues = new Set(["TRANSITION_ADMISSION_REQUIRED", "GOAL_OBLIGATION_UNCOVERED", "ANALYSIS_SELECTION_REQUIRED", "GOAL_SOURCE_NOT_RESOLVED"]);
    if (plan.steps.some(step => step.kind !== "calculation" && step.issues.some(issue => !sourceIssues.has(issue.code)))) return;
    if (plan.intent === "query") {
      const scopes = query.map(step => completeQuery(tasks.get(step.id)!.target));
      const overlap = scopes.some((left, index) => left?.operation?.kind === "value" && scopes.slice(index + 1).some(right =>
        right?.operation?.kind === "value" && left.selection === right.selection && left.time.start === right.time.start && left.time.end === right.time.end
        && JSON.stringify(left.time.dates ?? []) === JSON.stringify(right.time.dates ?? [])
        && left.org_codes?.some(code => right.org_codes?.includes(code)) && left.metric_codes.some(code => right.metric_codes.includes(code))));
      if (overlap) {plan.issues.push(problem("DUPLICATE_QUERY_COVERAGE", "多个来源重复覆盖同一机构、指标和日期，请去重目标或选择各成员的明确来源；不重复执行同一业务数据点。", "pi", "reference")); return;}
    }
    // 跨轮变更在继承来源之外独立核对本轮显式条件，不能因模型省略字段而继续查询旧范围。

    if (analysis) {
      const observed = new Set((await this.store.catalogObservations()).flatMap(item => item.codes));
      for (const step of query) {
        const task = tasks.get(step.id); if (!task) return;
        const explicit = new Set(goal.fragments.flatMap(fragment => fragment.mentions.flatMap(mention => (mention.resolution.value as {codes?: string[]})?.codes ?? [])));
        if (codes(task, "metrics").some(code => !explicit.has(code) && !observed.has(code) && !task.target.transition?.before.metric_codes.includes(code))) {
          plan.issues.push(problem("ANALYSIS_CATALOG_EVIDENCE_REQUIRED", "新增分析指标尚无实际目录回执；先查阅目录，再继续同一任务。")); return;
        }
      }
    }
    const fragments: Record<string, unknown[]> = {};
    const steps = query.map(step => {
      const task = tasks.get(step.id)!;
      const fragment = Math.max(0, admissionGoal.fragments.findIndex(item => item.question === step.sourceQuestion));
      const source = admissionGoal.fragments[fragment]!;
      const bound = task.target.fields.metrics?.metadata?.confirmedBindings as Record<string, string[]> | undefined;
      fragments[String(fragment)] ??= source.mentions.flatMap(mention => {
        const selected = (mention.resolution.value as {codes?: string[]; names?: string[]}) ?? {codes: bound?.[JSON.stringify([mention.start, mention.end, mention.text])], names: []};
        return selected.codes?.length ? [{text: mention.text, start: mention.start, end: mention.end, codes: selected.codes}] : [];
      });
      return {target_ref: step.targetRef, fragment, origin: analysis ? "analysis_selected" as const : task.target.transition || step.source.kind !== "new" ? "history" as const : "user_explicit" as const,
        spec: canonical(task), ...(task.target.transition ? {transition: task.target.transition} : {}), ...(typeof task.target.fields.metrics?.metadata?.semanticSelectionReceipt==="string"
          ? {source_semantic_receipt:task.target.fields.metrics.metadata.semanticSelectionReceipt} : {}),
        ...(task.target.coverage ? (() => {const coverage = metricCoverageSource(task.target.coverage!.question, task.target.coverage!.mentions, task.target.coverage!.removed);
          return {source_question: coverage.source_question, bindings: coverage.source_metric_bindings, exclusions: coverage.source_metric_exclusions};})() : {})};
    });
    if (steps.some(step => !step.spec.metric_codes.length || !step.spec.org_codes?.length || !step.spec.time || !step.spec.selection)) return;
    try {
      let conversation = await this.request.commands.getConversationId();
      if (!conversation) {conversation = (await this.request.backend.createAgentQueryContext(this.request.sessionId, {signal: this.signal})).conversation_id; await this.request.commands.setConversationId(conversation);}
      const context = (await this.store.turn(this.request.operationId))?.context;
      const sources = [...(context?.tasks ?? [])];
      for (const ref of new Set(plan.steps.flatMap(step => step.source.kind === "reference" ? [step.source.task_ref] : []))) {
        const parent = await this.store.plan(ref);
        if (parent?.owner === this.request.actor.id) for (const step of parent.steps) if (step.taskRef && !sources.some(task => task.ref === step.taskRef)) {
          const task = await this.store.get(step.taskRef); if (task) sources.push(task);
        }
      }
      const contextSources = sources.filter(task => task.owner === this.request.actor.id).flatMap(task => {
        const basis = transitionBasis(task.target); return basis ? [basis] : [];
      });
      return (await this.request.backend.admitSemanticPlan({conversation_id: conversation, session_id: this.request.sessionId, goal: admissionGoal.question,
        business_date: (await this.store.turn(this.request.operationId))!.businessDate, analysis, ...(plan.referenceYear ? {reference_year: plan.referenceYear} : {}), steps, context_sources: contextSources, fragment_bindings: fragments}, {signal: this.signal})).receipts;
    } catch (error) {
      // suggestion 通道本轮已经 resolve-field 完成目录成员校验与解析，但现行准入契约只按 goal
      // 原文扫描机构依据，无法接纳该结论；模型按 revise_proposal 原样重提只会得到同一拒绝。
      // 转为用户可操作的澄清：请用户回复机构全称，下一轮按原文路径重新登记（此时名称进入原文，对账即通过）。
      const suggestionGrounded = error instanceof BackendApiError && error.code === "TRANSITION_SOURCE_UNGROUNDED"
        ? query.flatMap(step => ["organizations", "comparison_organizations"]
            .map(name => tasks.get(step.id)?.target.fields[name])
            .filter(field => field?.resolutionStatus === "resolved"
              && ["model_inferred", "corrected"].includes(String(field.metadata?.resolution_source))
              && typeof field.metadata?.semanticTurn === "string"
              && field.metadata.semanticTurn.startsWith(`${this.request.operationId}:`)))
        : [];
      if (suggestionGrounded.length) {
        const inferred = suggestionGrounded.map(field => ({
          names: ((field!.resolvedValue as {names?: string[]} | undefined)?.names ?? []).join("、"),
          excerpt: typeof field!.metadata?.rawExcerpt === "string" ? field!.metadata.rawExcerpt : undefined}));
        plan.issues.push(problem("TRANSITION_SOURCE_UNGROUNDED",
          `按有权机构清单将${inferred.map(item => item.excerpt ? `「${item.excerpt}」` : "您提到的机构").join("、")}理解为${inferred.map(item => `「${item.names}」`).join("、")}；但跨轮变更登记暂不接受清单推断结论作为依据，本次未执行查询。请直接回复机构全称（${inferred.map(item => item.names).join("、")}）后再查。`,
          "user", "catalog"));
        return;
      }
      plan.issues.push(error instanceof BackendApiError && [401,403].includes(error.status) ? problem("PERMISSION_DENIED", "当前身份无权签发该任务范围。", "stop", "permission")
        : problem(error instanceof BackendApiError && /^[A-Z][A-Z0-9_]+$/u.test(error.code ?? "") ? error.code! : "PLAN_NOT_ADMITTED", error instanceof BackendApiError && error.status < 500 ? error.message : "整批目标事实服务暂不可用，原始义务和已解析条件仍保留。"));
    }
  }
  async locate(taskRef: string, targetRef: string) {
    const plan = await this.store.plan(taskRef), step = plan?.steps.find(item => item.targetRef === targetRef);
    if (!plan || !step || plan.owner !== this.request.actor.id) fail("REFERENCE_INVALID", "任务引用不可用或目标已修订。", "reference");
    if (!plan!.admitted || plan!.admitted.digest !== digest(plan!)) fail("PLAN_NOT_ADMITTED", "完整任务尚未获准，不能单独执行子步骤。");
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
    plan.admitted!.digest = digest(plan); await this.save(plan); return task;
  }
  async settled(planRef: string, stepId: string, task: SemanticTask, options: {readOnly?: boolean} = {}): Promise<SemanticFeedback> {
    const plan = (await this.store.plan(planRef))!, step = plan.steps.find(item => item.id === stepId)!;
    // 只重显旧证据时不重结算历史计划，也不改变当前业务焦点。
    if (options.readOnly) return this.feedback(plan, "reused");
    step.status = task.target.status;
    const origin = task.target.frameId ? await this.request.frames?.get(task.target.frameId) : undefined;
    const state = await this.request.frames!.state();
    const frame = origin ? await this.request.frames!.get(state.operations[origin.operationFrameId] ?? origin.frameId) : undefined;
    if (frame) step.evidence = {frameId: frame.frameId, ...(frame.resultRef ? {resultRef: frame.resultRef} : {}), truncated: !!frame.resultSummary?.truncated};
    const successful = plan.steps.filter(item => item.status === "succeeded" && !item.evidence?.truncated).length;
    const missing: string[] = [];
    for (const requirement of plan.requirements) for (const check of requirement.checks ?? []) {
      const matched: SemanticTask[] = [];
      for (const candidate of plan.steps) if (candidate.kind === "query" && candidate.status === "succeeded" && !candidate.evidence?.truncated && candidate.taskRef) {
        const source = await this.store.get(candidate.taskRef); if (source && codes(source, "metrics").includes(check.metric)) matched.push(source);
      }
      const orgs = check.orgs.length ? check.orgs : [undefined];
      if (orgs.some(org => {
        const scoped = matched.filter(source => !org || codes(source, "organizations").includes(org)
          || (source.target.fields.operation?.resolvedValue as {kind?: string})?.kind === "rank_position" && codes(source, "comparison_organizations").includes(org));
        return !scoped.length || check.ranges.some(range => !scoped.some(source => {
          const time = source.target.fields.time?.resolvedValue as {start?: string; end?: string}; return time?.start === range.start && time?.end === range.end;
        }));
      })) missing.push(check.name);
    }
    plan.issues = missing.length ? [problem("ANALYSIS_EVIDENCE_PENDING", `用户明确的分析依据仍有待取证：${[...new Set(missing)].join("、")}。请根据已取得结果继续规划。`)] : [];
    plan.completion = successful === plan.steps.length && !missing.length ? "full" : successful ? "partial" : "unmet";
    const unknown = plan.steps.some(item => item.status === "unknown" || item.status === "executing"), failed = plan.steps.some(item => item.status === "failed");
    plan.status = plan.completion === "full" ? "completed" : unknown ? "waiting_dependency" : failed ? "stopped" : "active";
    await this.save(plan, true);
    return this.feedback(plan, unknown ? "unknown" : failed ? "failed" : plan.completion === "full" || plan.intent === "analyze" && plan.steps.every(item => item.status === "succeeded") ? "succeeded" : "ready");
  }
}
function targetChanges(input: SemanticRequest, proposed: SemanticPlanStep[], step: SemanticPlanStep): SemanticOperation[] {
  return input.targets[proposed.indexOf(step)]?.operations ?? [];
}
