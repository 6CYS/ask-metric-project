import {semanticDisplay} from "./display.js";
import {randomUUID} from "node:crypto";
import {BACKGROUND_CONTEXT, setValue, value, type Session} from "@earendil-works/pi-agent-core";
import type {ResolvedField, MentionResolution} from "../business-context/types.js";
import type {SemanticOperation, SemanticSource} from "./protocol.js";

const NS = "askmetric.semantic.v2";
export interface SemanticIssue {code: string; category: string; message: string; remediation: "pi" | "user" | "retry" | "stop"; field?: string;
  /** 仅宿主从冻结入场状态签发，供Pi显式修正来源；不能自动改写提案。 */
  source_options?: Array<{task_ref: string; target_ref: string}>}
export interface SemanticTarget {
  ref: string; fields: Record<string, ResolvedField>; pending: Record<string, string>;
  status: "draft" | "blocked" | "ready" | "executing" | "succeeded" | "failed" | "unknown";
  frameId?: string; coverage?: {question: string; mentions: MentionResolution[]; removed: MentionResolution[]};
  baseFrameId?: string;
  /** 宿主从冻结基线与实际字段规范化生成；模型不能填入。 */
  transition?: import("./transition.js").SemanticTransition;
  metricSource?: string;
  pendingChanges?: Record<string, {operations: SemanticOperation[]; baseline?: ResolvedField; sourceMessage: string}>;
}
export interface SemanticTask {
  ref: string; owner: string; revision: number; target: SemanticTarget; originalMessage: string;
  status: "active" | "waiting_input" | "waiting_dependency" | "completed" | "stopped";
  completion: "unmet" | "partial" | "full"; issues: SemanticIssue[];
  permit?: {operationId: string; revision: number; frameId: string; digest: string; actor: string; consumed: boolean};
  parentPlan?: string;
  capability?: "metric_query" | "data_availability" | "metric_calculate";
}
export interface SemanticPlanStep {
  id: string; targetRef: string; taskRef?: string; operationId: string;
  kind: "query" | "availability" | "calculation"; calendar?: {ranges: Array<{start: string; end: string; dates?: string[]}>; unresolved: string[]}; source: SemanticSource; sourceQuestion: string;
  operations: SemanticOperation[]; label?: string; aliases?: string[]; dependencyTargets?: string[]; dependencies: string[];
  /** 旧持久化记录兼容字段；运行器不再通过此字段向new目标注入条件。 */
  inheritedFields?: Record<string, ResolvedField>;
  status: SemanticTarget["status"] | "waiting_dependency"; required: boolean;
  issues: SemanticIssue[]; evidence?: {frameId: string; resultRef?: string; truncated: boolean};
}
export interface SemanticPlan {
  ref: string; owner: string; revision: number; operationId: string; goalOperationId?: string; referenceYear?: number; intent: string; originalMessage: string;
  topicRef?: string;
  /** 旧持久化记录兼容字段；当前入场基准统一使用SemanticTurn.context。 */
  contextFields?: Record<string, ResolvedField>; proposalOperationId?: string;
  status: SemanticTask["status"]; completion: SemanticTask["completion"]; issues: SemanticIssue[];
  steps: SemanticPlanStep[]; supersededSteps?: SemanticPlanStep[];
  requirements: Array<{id: string; question: string; stepIds: string[]; checks?: Array<{metric: string; name: string; orgs: string[]; ranges: Array<{start: string; end: string}>}>}>;
  admitted?: {operationId: string; revision: number; digest: string};
}
export interface HistoryTarget {task_ref: string; target_ref: string; topic_ref: string; query_number: number; goal: string; status: string;
  organizations: string[]; metrics: string[]; names: string[]; scope?: string[]; time?: unknown; kind: string; label?: string}
export interface SemanticHistoryQuery {cursor?: string; limit?: number; task_ref?: string; query_number?: number; topic_ref?: string;
  query?: string; latest_per_organization?: boolean; status?: "succeeded" | "waiting_input"}
interface ContextFocus {business?: string; discussion?: string; display?: string}
interface PlanIndex {version: number; focus?: string; order: string[]; operations: Record<string, string>; history?: Record<string, HistoryTarget[]>}
export interface CatalogObservation {operationId: string; keyword: string; codes: string[]; names: string[]}
export interface SemanticClarification {
  operationId: string; originalMessage: string; question: string;
  alternatives: Array<{task_ref: string; target_ref: string; label: string}>;
}
export interface SemanticTurn {
  operationId: string; originalMessage: string; businessDate: string; admittedTask?: string; boundTask?: string;
  /** 接纳时冻结，重启或配置回退不得改变已在途 operation 的交付规则；旧记录缺省为 off。 */
  directQueryDelivery?: "off" | "observe" | "on";
  /** 本轮只读交付的签发来源；与旧计划隔离，不能把历史operation改成当前operation。 */
  readDelivery?: {planRef: string; revision: number; digest: string; targetRefs: string[]; source: "query_ordinal" | "admitted_focus"};
  /** 在原生Session事务中冻结入场来源；本轮重提、工具执行或焦点移动不能改变它。 */
  context?: {plan?: SemanticPlan; tasks: SemanticTask[]; clarification?: SemanticClarification};
  contextAction?: "resume" | "defer" | "abandon"; source?: SemanticSource; baseline?: SemanticTarget; operations: Record<string, SemanticOperation[]>;
}
interface Index {version: number; focus?: string; order: string[]}
const indexAddress = value<Index>(NS, "index");
const taskAddress = (ref: string) => value<SemanticTask>(NS, `task/${ref}`);
const turnAddress = (id: string) => value<SemanticTurn>(NS, `turn/${id}`);
const referenceAddress = (ref: string) => value<{task: string; target: SemanticTarget}>(NS, `reference/${ref}`);
export const semanticRef = () => randomUUID();

/** 领域状态只保存于同一Pi Session；CAS和许可消费不另建会话或后台循环。 */
export class NativeSemanticTaskStore {
  constructor(private readonly session: Session) {}
  async index() {return structuredClone((await this.session.getValue(indexAddress, BACKGROUND_CONTEXT))?.value ?? {version: 0, order: []});}
  async get(ref: string) {return structuredClone((await this.session.getValue(taskAddress(ref), BACKGROUND_CONTEXT))?.value);}
  async turn(id: string) {return structuredClone((await this.session.getValue(turnAddress(id), BACKGROUND_CONTEXT))?.value);}
  async reference(ref: string) {return structuredClone((await this.session.getValue(referenceAddress(ref), BACKGROUND_CONTEXT))?.value);}
  async admit(operationId: string, originalMessage: string, admittedTask?: string | null, directQueryDelivery?: SemanticTurn["directQueryDelivery"]) {
    return this.session.mutate(async (tx, context) => {
      const prior = (await tx.getValue(turnAddress(operationId), context))?.value;
      if (prior) {
        if (prior.originalMessage !== originalMessage) throw new Error("SEMANTIC_TURN_CONFLICT");
        return structuredClone(prior);
      }
      const index = (await tx.getValue(indexAddress, context))?.value;
      const plans = admittedTask === undefined ? (await tx.getValue(value<PlanIndex>(NS, "plans/index"), context))?.value : undefined;
      const businessDate = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
      const focus = admittedTask === undefined ? plans?.order.length && !plans.focus ? undefined : index?.focus : admittedTask;
      const turn: SemanticTurn = {operationId, originalMessage, businessDate, operations: {}, ...(directQueryDelivery ? {directQueryDelivery} : {}), ...(focus ? {admittedTask: focus} : {})};
      if (admittedTask === undefined) {
        const pointers = (await tx.getValue(value<ContextFocus>(NS, "context/focus"), context))?.value;
        const discussion = pointers?.discussion ?? plans?.focus;
        const plan = discussion ? (await tx.getValue(value<SemanticPlan>(NS, `plans/${discussion}`), context))?.value : undefined;
        const refs = plan ? plan.steps.flatMap(step => step.taskRef ? [step.taskRef] : []) : plans?.order.length ? [] : focus ? [focus] : [];
        const tasks = await Promise.all([...new Set(refs)].map(async ref => (await tx.getValue(taskAddress(ref), context))?.value));
        const clarification = (await tx.getValue(value<SemanticClarification | null>(NS, "clarification"), context))?.value;
        turn.context = structuredClone({...(clarification ? {clarification} : {}),...(plan ? {plan} : {}), tasks: tasks.filter((task): task is SemanticTask => !!task)});
      }
      await tx.commit([setValue(turnAddress(operationId), turn)], context);
      return turn;
    }, BACKGROUND_CONTEXT);
  }
  async save(task: SemanticTask, expectedVersion: number, turn?: SemanticTurn, focus = true) {
    return this.session.mutate(async (tx, context) => {
      const index = (await tx.getValue(indexAddress, context))?.value ?? {version: 0, order: []};
      if (index.version !== expectedVersion) throw new Error("SEMANTIC_STATE_CONFLICT");
      const previous = (await tx.getValue(taskAddress(task.ref), context))?.value;
      if (previous && task.owner !== previous.owner) throw new Error("SEMANTIC_OWNER_CONFLICT");
      const next = {...index, version: index.version + 1, ...(focus ? {focus: task.ref} : {}),
        order: index.order.includes(task.ref) ? index.order : [...index.order, task.ref]};
      await tx.commit([setValue(indexAddress, next), setValue(taskAddress(task.ref), task),
        setValue(referenceAddress(task.target.ref), {task: task.ref, target: structuredClone(task.target)}),
        ...(turn ? [setValue(turnAddress(turn.operationId), turn)] : [])], context);
      return structuredClone(task);
    }, BACKGROUND_CONTEXT);
  }
  async planIndex(): Promise<PlanIndex> {
    return structuredClone((await this.session.getValue(value<PlanIndex>(NS, "plans/index"), BACKGROUND_CONTEXT))?.value
      ?? {version: 0, order: [], operations: {}});
  }
  async plan(ref: string) {return structuredClone((await this.session.getValue(value<SemanticPlan>(NS, `plans/${ref}`), BACKGROUND_CONTEXT))?.value);}
  async planReference(ref: string, planRef: string) {
    // 历史派生计划可以引用同一目标；配对身份以所属计划正文为准，不能被单目标索引覆盖。
    const plan = await this.plan(planRef), step = plan?.steps.find(item => item.targetRef === ref);
    return step ? {planRef, step: structuredClone(step)} : undefined;
  }
  async savePlan(plan: SemanticPlan, expectedVersion: number, focus = true) {
    return this.session.mutate(async (tx, context) => {
      const address = value<PlanIndex>(NS, "plans/index");
      const index = (await tx.getValue(address, context))?.value ?? {version: 0, order: [], operations: {}};
      if (index.version !== expectedVersion) throw new Error("SEMANTIC_PLAN_CONFLICT");
      const previous = (await tx.getValue(value<SemanticPlan>(NS, `plans/${plan.ref}`), context))?.value;
      if (previous && previous.owner !== plan.owner) throw new Error("SEMANTIC_OWNER_CONFLICT");
      const operations = [...new Set(index.order.flatMap(ref => index.history?.[ref]?.[0]?.query_number ? [index.history[ref]![0]!.query_number] : []))];
      const queryNumber = index.history?.[plan.ref]?.[0]?.query_number ?? index.order.flatMap(ref => index.operations[plan.operationId] === ref ? index.history?.[ref]?.slice(0,1).map(item => item.query_number) ?? [] : [])[0]
        ?? Math.max(0, ...operations) + 1;
      const history = await Promise.all(plan.steps.map(async step => {
        const task = step.taskRef ? (await tx.getValue(taskAddress(step.taskRef), context))?.value : undefined;
        const entity = (field: string) => task?.target.fields[field]?.resolvedValue as {codes?: string[]; names?: string[]} | undefined;
        return {task_ref: plan.ref, target_ref: step.targetRef, topic_ref: plan.topicRef ?? plan.ref, query_number: queryNumber,
          goal: plan.originalMessage, status: plan.status === "waiting_input" ? "waiting_input" : step.status,
          organizations: entity("organizations")?.codes ?? [], metrics: entity("metrics")?.codes ?? [],
          scope: [...new Set([...(entity("organizations")?.codes ?? []), ...(entity("comparison_organizations")?.codes ?? [])])],
          names: [...(entity("organizations")?.names ?? []), ...(entity("metrics")?.names ?? [])], time: task?.target.fields.time?.resolvedValue,
          kind: step.kind, ...(step.label ? {label: step.label} : {})};
      }));
      const focusAddress = value<ContextFocus>(NS, "context/focus"), pointers = (await tx.getValue(focusAddress, context))?.value ?? {};
      await tx.commit([setValue(address, {...index, version: index.version + 1,
        order: index.order.includes(plan.ref) ? index.order : [...index.order, plan.ref],
        operations: {...index.operations, [plan.operationId]: plan.ref}, history: {...index.history, [plan.ref]: history}, ...(focus ? {focus: plan.ref} : {})}),
      ...(focus ? [setValue(focusAddress, {...pointers, ...(plan.intent === "reuse" ? {display: plan.ref} : {business: plan.ref}), discussion: plan.ref})] : []),
      setValue(value<SemanticPlan>(NS, `plans/${plan.ref}`), plan),
      ...plan.steps.map(step => setValue(value<{planRef: string; step: SemanticPlanStep}>(NS, `plans/reference/${step.targetRef}`), {planRef: plan.ref, step}))], context);
      return structuredClone(plan);
    }, BACKGROUND_CONTEXT);
  }
  async discussion(planRef: string) {
    const plan = await this.plan(planRef); if (!plan) throw new Error("REFERENCE_INVALID");
    await this.session.mutate(async (tx, context) => {
      const address = value<ContextFocus>(NS, "context/focus"), before = (await tx.getValue(address, context))?.value ?? {};
      await tx.commit([setValue(address, {...before, discussion: planRef, display: planRef})], context);
    }, BACKGROUND_CONTEXT);
  }
  async topicFor(plan: SemanticPlan, seen = new Set<string>()): Promise<string> {
    if (plan.topicRef) return plan.topicRef;
    if (seen.has(plan.ref)) throw new Error("SEMANTIC_HISTORY_SOURCE_CYCLE");
    seen.add(plan.ref);
    const parents = [...new Set(plan.steps.flatMap(step => step.source.kind === "reference" ? [step.source.task_ref] : []))];
    if (parents.length !== 1) return plan.ref;
    const parent = await this.plan(parents[0]!);
    return parent ? this.topicFor(parent, seen) : plan.ref;
  }
  async historyCatalog(): Promise<HistoryTarget[]> {
    const index = await this.planIndex(), rows: HistoryTarget[] = [], seen = new Set<string>();
    let ordinal = 0;
    for (const ref of index.order) {
      const plan = await this.plan(ref); if (!plan || seen.has(plan.operationId)) continue;
      seen.add(plan.operationId); if (plan.intent === "query") ordinal++;
      const latest = index.operations[plan.operationId] ?? ref;
      if (index.history?.[latest]) {rows.push(...index.history[latest]!.map(row => ({...row, query_number: plan.intent === "query" ? ordinal : 0}))); continue;}
      const saved = await this.plan(latest); if (!saved) continue;
      const topic = await this.topicFor(saved);
      for (const step of saved.steps) {
        const task = step.taskRef ? await this.get(step.taskRef) : undefined;
        const entities = (field: string) => task?.target.fields[field]?.resolvedValue as {codes?: string[]; names?: string[]} | undefined;
        rows.push({task_ref: saved.ref, target_ref: step.targetRef, topic_ref: topic, query_number: saved.intent === "query" ? ordinal : 0,
          goal: saved.originalMessage, status: saved.status === "waiting_input" ? "waiting_input" : step.status, organizations: entities("organizations")?.codes ?? [],
          scope: [...new Set([...(entities("organizations")?.codes ?? []), ...(entities("comparison_organizations")?.codes ?? [])])],
          metrics: entities("metrics")?.codes ?? [], names: [...(entities("organizations")?.names ?? []), ...(entities("metrics")?.names ?? [])],
          time: task?.target.fields.time?.resolvedValue, kind: step.kind, ...(step.label ? {label: step.label} : {})});
      }
    }
    return rows;
  }
  async searchContext(query: SemanticHistoryQuery = {}) {
    const limit = query.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("SEMANTIC_HISTORY_LIMIT_INVALID");
    let rows = (await this.historyCatalog()).filter(row => (!query.task_ref || row.task_ref === query.task_ref)
      && (!query.query_number || row.query_number === query.query_number) && (!query.topic_ref || row.topic_ref === query.topic_ref)
      && (!query.status || row.status === query.status));
    if (query.query) {
      const terms = query.query.normalize("NFKC").split(/[\s，,；;、]+/u).filter(Boolean);
      rows = rows.filter(row => terms.every(term => JSON.stringify([row.goal, row.names, row.time, row.label]).includes(term)));
    }
    if (query.latest_per_organization) {
      const seen = new Set<string>(); rows = rows.reverse().filter(row => {
        const key = JSON.stringify([...row.organizations].sort()); if (!row.organizations.length || seen.has(key)) return false;
        seen.add(key); return true;
      }).reverse();
    }
    const end = query.cursor ? rows.findIndex(row => `${row.task_ref}/${row.target_ref}` === query.cursor) : rows.length;
    if (end < 0) throw new Error("SEMANTIC_HISTORY_CURSOR_INVALID");
    const start = Math.max(0, end - limit), selected = rows.slice(start, end);
    const tasks = await Promise.all([...new Set(selected.map(row => row.task_ref))].map(async ref => this.projectPlan((await this.plan(ref))!)));
    return {current_task_ref: (await this.planIndex()).focus, total: rows.length,
      next_cursor: start > 0 ? `${rows[start]!.task_ref}/${rows[start]!.target_ref}` : null,
      references: selected, tasks: tasks.map(task => ({...task, targets: task.targets.filter(target => selected.some(row => row.task_ref === task.task_ref && row.target_ref === target.target_ref))}))};
  }
  async recordCatalog(observations: CatalogObservation[]) {
    if (!observations.length) return;
    await this.session.mutate(async (tx, context) => {
      const address = value<CatalogObservation[]>(NS, "catalog/observations");
      const previous = (await tx.getValue(address, context))?.value ?? [];
      await tx.commit([setValue(address, [...previous, ...observations])], context);
    }, BACKGROUND_CONTEXT);
  }
  async catalogObservations() {return structuredClone((await this.session.getValue(value<CatalogObservation[]>(NS, "catalog/observations"), BACKGROUND_CONTEXT))?.value ?? []);}
  async bindContextAction(operationId: string, action: "resume" | "defer" | "abandon") {
    await this.session.mutate(async (tx, context) => {
      const address = turnAddress(operationId), turn = (await tx.getValue(address, context))?.value;
      if (!turn) throw new Error("SEMANTIC_TURN_NOT_ADMITTED");
      await tx.commit([setValue(address, {...turn, contextAction: action})], context);
    }, BACKGROUND_CONTEXT);
  }
  async bindReadDelivery(operationId: string, binding: NonNullable<SemanticTurn["readDelivery"]>) {
    return this.session.mutate(async (tx, context) => {
      const address = turnAddress(operationId), turn = (await tx.getValue(address, context))?.value;
      if (!turn) throw new Error("SEMANTIC_TURN_NOT_ADMITTED");
      if (turn.readDelivery && JSON.stringify(turn.readDelivery) !== JSON.stringify(binding)) throw new Error("SEMANTIC_READ_DELIVERY_CONFLICT");
      if (!turn.readDelivery) await tx.commit([setValue(address, {...turn, readDelivery: structuredClone(binding)})], context);
      return structuredClone(binding);
    }, BACKGROUND_CONTEXT);
  }
  async saveClarification(input: SemanticClarification) {
    await this.session.mutate(async (tx, context) => {
      await tx.commit([setValue(value<SemanticClarification | null>(NS, "clarification"), structuredClone(input))], context);
    }, BACKGROUND_CONTEXT);
  }
  async clearClarification(operationId: string) {
    await this.session.mutate(async (tx, context) => {
      const address = value<SemanticClarification | null>(NS, "clarification"), prior = (await tx.getValue(address, context))?.value;
      if (prior?.operationId === operationId) await tx.commit([setValue(address, null)], context);
    }, BACKGROUND_CONTEXT);
  }
  async admissionContext(operationId: string) {
    const snapshot = (await this.turn(operationId))?.context;
    if (!snapshot) return;
    return {task_ref: snapshot.plan?.ref, ...(snapshot.clarification ? {pending_clarification: snapshot.clarification} : {}), targets: snapshot.tasks.map(task => ({
      target_ref: snapshot.plan?.steps.find(step => step.taskRef === task.ref)?.targetRef ?? task.target.ref,
      status: task.target.status, frame_id: task.target.frameId,
      conditions: Object.fromEntries(Object.entries(task.target.fields).map(([name, field]) => [name, {
        status: field.resolutionStatus, expression: semanticDisplay(field),
        ...(field.resolutionStatus === "resolved" ? {confirmed: (field.resolvedValue as {names?: string[]} | undefined)?.names ?? field.resolvedValue} : {}),
      }])), pending: task.target.pending,
    }))};
  }
  private async projectPlan(plan: SemanticPlan) {
    return {task_ref: plan.ref, status: plan.status, completion: plan.completion, issues: plan.issues, goal: plan.originalMessage, intent: plan.intent,
      targets: await Promise.all(plan.steps.map(async step => {
        const task = step.taskRef ? await this.get(step.taskRef) : undefined;
        return {target_ref: step.targetRef, status: step.status, kind: step.kind, label: step.label, aliases: step.aliases, dependencies: step.dependencies,
          conditions: Object.fromEntries(Object.entries(task?.target.fields ?? {}).map(([field, value]) => [field, {status: value.resolutionStatus,
            expression: semanticDisplay(value), ...(value.candidates ? {candidates: value.candidates.map(candidate => ({name: candidate.value}))} : {})}])),
          pending: task?.target.pending ?? {}};
      }))};
  }
  /** 默认投影只呈现当前业务目标；历史仍由Pi自由调用context工具分页读取，不与当前状态平铺混用。 */
  async runtimeContext() {
    const index = await this.planIndex();
    if (!index.focus) {
      // 首轮错误草案只有历史地址，不能因尚无焦点而成为默认业务上下文。
      if (index.order.length) return {tasks: [], history_available: true};
      const legacyIndex = await this.index(), legacy = await this.context();
      return {current_task_ref: legacyIndex.focus, tasks: legacy.tasks.filter(task => task.task_ref === legacyIndex.focus),
        history_available: legacyIndex.order.some(ref => ref !== legacyIndex.focus)};
    }
    const plan = await this.plan(index.focus);
    const focus = (await this.session.getValue(value<ContextFocus>(NS, "context/focus"), BACKGROUND_CONTEXT))?.value;
    const topic = plan ? await this.topicFor(plan) : undefined, history = await this.historyCatalog();
    return {current_task_ref: index.focus, focus, topic_ref: topic, tasks: plan ? [await this.projectPlan(plan)] : [], history_available: index.order.length > 1,
      related_history: history.filter(row => row.topic_ref === topic && row.task_ref !== index.focus).filter((row, index, all) =>
        !all.slice(index + 1).some(later => JSON.stringify([later.organizations, later.metrics]) === JSON.stringify([row.organizations, row.metrics]))).slice(-4),
      pending_tasks: history.filter(row => row.status === "waiting_input").slice(-5)};
  }
  async planContext(limit = 20, cursor?: string) {
    const index = await this.planIndex(), end = cursor ? index.order.indexOf(cursor) : index.order.length;
    if (end < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("SEMANTIC_HISTORY_CURSOR_INVALID");
    const start = Math.max(0, end - limit), plans = await Promise.all(index.order.slice(start, end).map(ref => this.plan(ref)));
    return {current_task_ref: index.focus, next_cursor: start > 0 ? index.order[start] : null,
      tasks: await Promise.all(plans.filter((plan): plan is SemanticPlan => !!plan).map(plan => this.projectPlan(plan)))};
  }
  async context(limit = 20, cursor?: string) {
    if ((await this.planIndex()).order.length) return this.planContext(limit, cursor);
    const index = await this.index();
    const end = cursor ? index.order.indexOf(cursor) : index.order.length;
    if (end < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("SEMANTIC_HISTORY_CURSOR_INVALID");
    const start = Math.max(0, end - limit);
    const tasks = await Promise.all(index.order.slice(start, end).map(ref => this.get(ref)));
    return {current_task_ref: index.focus, next_cursor: start > 0 ? index.order[start] : null,
      tasks: tasks.filter((task): task is SemanticTask => !!task).map(task => ({
      task_ref: task.ref, target_ref: task.target.ref, status: task.status, completion: task.completion,
      goal: task.originalMessage, conditions: Object.fromEntries(Object.entries(task.target.fields).map(([field, value]) => [field,
        {status: value.resolutionStatus, expression: semanticDisplay(value), ...(value.candidates ? {candidates: value.candidates.map(item => ({name: item.value}))} : {})}])),
      pending: task.target.pending,
    }))};
  }
}
