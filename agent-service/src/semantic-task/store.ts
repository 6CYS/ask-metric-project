import {candidateOptions, displayedCandidates} from "./candidateOptions.js";
import {semanticDisplay} from "./display.js";
import {randomUUID} from "node:crypto";
import {BACKGROUND_CONTEXT, setValue, value, type Context, type Session, type SessionMutator} from "@earendil-works/pi-agent-core";
import type {ResolvedField} from "../business-context/types.js";
import type {SemanticOperation, SemanticSource} from "./protocol.js";
import {reduceRuntime, type RuntimeControl} from "../runtime/control.js";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {normalizeAnswerChoiceForQuestion, normalizeAnswerForQuestion, publishQuestionSnapshot, sameAnswerChoiceForQuestion,
  sameQuestionBusinessBasis, QuestionAnswerError, type Answer, type AnswerAcceptanceRecord, type AnswerReceipt, type PendingQuestion,
  type QuestionBinding, type QuestionOption, type QuestionSnapshotDraft, type QuestionStatus} from "./questions.js";

const NS = "askmetric.semantic.v2";
export interface SemanticIssue {code: string; category: string; message: string; remediation: "pi" | "user" | "retry" | "stop"; field?: string;
  /** 仅宿主从冻结入场状态签发，供Pi显式修正来源；不能自动改写提案。 */
  source_options?: Array<{task_ref: string; target_ref: string}>}
export interface SemanticTarget {
  ref: string; fields: Record<string, ResolvedField>; pending: Record<string, string>;
  status: "draft" | "blocked" | "ready" | "executing" | "succeeded" | "failed" | "unknown";
  frameId?: string;
  baseFrameId?: string;
  metricSource?: string;
  pendingChanges?: Record<string, {operations: SemanticOperation[]; baseline?: ResolvedField; sourceMessage: string}>;
}
export interface SemanticTask {
  ref: string; owner: string; revision: number; target: SemanticTarget; originalMessage: string;
  status: "active" | "waiting_input" | "waiting_dependency" | "completed" | "stopped";
  completion: "unmet" | "partial" | "full"; issues: SemanticIssue[];
  permit?: {operationId: string; revision: number; frameId: string; digest: string; actor: string; consumed: boolean};
  parentPlan?: string;
  capability?: "metric_query" | "data_availability" | "metric_calculate" | "business_overview" | "business_analysis";
  /** 当前反馈使用的公共快照；权威版本、状态和受理事实仍在独立问题记录中。 */
  questionSnapshots?: PendingQuestion[];
  answerReceipts?: AnswerReceipt[];
}
export interface SemanticPlanStep {
  id: string; targetRef: string; taskRef?: string; operationId: string;
  kind: "query" | "availability" | "calculation"; source: SemanticSource; sourceQuestion: string;
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
}
export interface HistoryTarget {task_ref: string; target_ref: string; topic_ref: string; query_number: number; goal: string; status: string;
  organizations: string[]; metrics: string[]; names: string[]; scope?: string[]; time?: unknown; kind: string; label?: string}
export interface SemanticHistoryQuery {cursor?: string; limit?: number; task_ref?: string; query_number?: number; topic_ref?: string;
  query?: string; latest_per_organization?: boolean; status?: "succeeded" | "waiting_input"}
interface ContextFocus {business?: string; discussion?: string; display?: string}
interface PlanIndex {version: number; focus?: string; order: string[]; operations: Record<string, string>; history?: Record<string, HistoryTarget[]>}
export interface SemanticClarification {
  operationId: string; originalMessage: string; question: string;
  alternatives: Array<{task_ref: string; target_ref: string; label: string}>;
}

export interface SemanticAnswerSnapshot {
  answer: Answer;
  question: PendingQuestion;
  binding: QuestionBinding;
  questionRevision: number;
  existingReceipt?: AnswerAcceptanceRecord;
  alreadyApplied?: boolean;
}
export interface SemanticQuestionIssue {
  draft: QuestionSnapshotDraft;
  itemKey: string;
  owner: string;
  binding: Omit<QuestionBinding, "question_id" | "version" | "item_ref" | "options" | "businessBasis" | "receipts">;
}
export interface SemanticAnswerApplication {
  snapshot: SemanticAnswerSnapshot;
  outcome: AnswerReceipt["outcome"];
  planRef: string;
  targetRef: string;
  notice?: string;
  code?: string;
  expectedTaskRevision?: number;
  expectedOrganizationCodes?: string[];
}
export interface SemanticSaveOptions {
  questions?: SemanticQuestionIssue[];
  answers?: SemanticAnswerApplication[];
  abandonQuestions?: boolean;
}
export interface SemanticQuestionView {question: PendingQuestion; binding: QuestionBinding; revision: number; itemKey: string}
interface QuestionRef {question_id: string; version: number}
interface QuestionPointer extends QuestionRef {itemKey: string}
interface QuestionVersionRecord {
  owner: string;
  itemKey: string;
  question: PendingQuestion;
  binding: QuestionBinding;
  status: QuestionStatus;
  revision: number;
}
export interface SemanticTurn {
  operationId: string; originalMessage: string; businessDate: string; admittedTask?: string; boundTask?: string;
  /** 控制状态和计划版本引用附着现有账本；不保存另一份业务条件或模型规划正文。 */
  runtime?: RuntimeControl;
  /** 接纳时冻结，重启或配置回退不得改变已在途 operation 的交付规则；旧记录缺省为 off。 */
  directQueryDelivery?: "off" | "observe" | "on";
  /** 本轮只读交付的签发来源；与旧计划隔离，不能把历史operation改成当前operation。 */
  readDelivery?: {planRef: string; revision: number; digest: string; targetRefs: string[]; source: "query_ordinal" | "admitted_focus"};
  /** 基础指标未命中后的有限恢复；范围在首次恢复时冻结，重启和重提不能重置预算。 */
  queryRecovery?: {planRef: string; attempts: number; scopes: Array<{taskRef: string; targetRef: string;
    fields: Record<string, ResolvedField>}>};
  /** 在原生Session事务中冻结入场来源；本轮重提、工具执行或焦点移动不能改变它。 */
  context?: {plan?: SemanticPlan; tasks: SemanticTask[]; clarification?: SemanticClarification};
  contextAction?: "resume" | "defer" | "abandon"; source?: SemanticSource; baseline?: SemanticTarget; operations: Record<string, SemanticOperation[]>;
  answers?: Answer[];
  discardedAnswers?: Answer[];
  answerSnapshots?: SemanticAnswerSnapshot[];
}
interface Index {version: number; focus?: string; order: string[]}
const indexAddress = value<Index>(NS, "index");
const taskAddress = (ref: string) => value<SemanticTask>(NS, `task/${ref}`);
const turnAddress = (id: string) => value<SemanticTurn>(NS, `turn/${id}`);
const referenceAddress = (ref: string) => value<{task: string; target: SemanticTarget}>(NS, `reference/${ref}`);
const questionAddress = (id: string, version: number) => value<QuestionVersionRecord>(NS, `questions/${id}/${version}`);
const questionPointerAddress = (id: string) => value<QuestionPointer>(NS, `questions/current/${id}`);
const questionPlanIndexAddress = (ref: string) => value<QuestionRef[]>(NS, `questions/plan/${ref}`);
const questionTaskIndexAddress = (ref: string) => value<QuestionRef[]>(NS, `questions/task/${ref}`);
type SessionWrites = Parameters<SessionMutator["commit"]>[0];
export const semanticRef = () => randomUUID();

/** 领域状态只保存于同一Pi Session；CAS和许可消费不另建会话或后台循环。 */
export class NativeSemanticTaskStore {
  constructor(private readonly session: Session) {}
  async index() {return structuredClone((await this.session.getValue(indexAddress, BACKGROUND_CONTEXT))?.value ?? {version: 0, order: []});}
  async get(ref: string) {return structuredClone((await this.session.getValue(taskAddress(ref), BACKGROUND_CONTEXT))?.value);}
  async turn(id: string) {return structuredClone((await this.session.getValue(turnAddress(id), BACKGROUND_CONTEXT))?.value);}
  async reconcileRuntime(operationId: string, messages: readonly AgentMessage[]) {
    return this.session.mutate(async (tx, context) => {
      const turn = (await tx.getValue(turnAddress(operationId), context))?.value;
      if (!turn) return;
      const index = (await tx.getValue(value<PlanIndex>(NS, "plans/index"), context))?.value;
      const ref = index?.operations[operationId];
      const plan = ref ? (await tx.getValue(value<SemanticPlan>(NS, `plans/${ref}`), context))?.value : undefined;
      const runtime = reduceRuntime(turn.originalMessage, messages, plan, turn.runtime);
      // 并行工具后到达的旧观察不能倒退控制状态；下一边界仍从完整原生记录重新结算。
      if (turn.runtime && (runtime.budget.tools_used < turn.runtime.budget.tools_used
        || turn.runtime.observed_calls?.some(id => !runtime.observed_calls.includes(id)))) return structuredClone(turn.runtime);
      if (JSON.stringify(runtime) === JSON.stringify(turn.runtime)) return structuredClone(runtime);
      runtime.revision++;
      await tx.commit([setValue(turnAddress(operationId), {...turn, runtime})], context);
      return structuredClone(runtime);
    }, BACKGROUND_CONTEXT);
  }
  async reference(ref: string) {return structuredClone((await this.session.getValue(referenceAddress(ref), BACKGROUND_CONTEXT))?.value);}
  async question(questionId: string, version?: number): Promise<SemanticQuestionView | undefined> {
    const pointer = (await this.session.getValue(questionPointerAddress(questionId), BACKGROUND_CONTEXT))?.value;
    const selected = version ?? pointer?.version;
    if (!selected) return;
    const record = (await this.session.getValue(questionAddress(questionId, selected), BACKGROUND_CONTEXT))?.value;
    return record ? structuredClone(this.questionView(record)) : undefined;
  }
  /** 只按调用方明确给出的题目读取最新状态，不扫描会话历史。 */
  async questionStates(questionIds: readonly string[]) {
    if (questionIds.length > 100) throw new Error("QUESTION_STATE_LIMIT_INVALID");
    const rows = [];
    for (const questionId of new Set(questionIds)) {
      const pointer = (await this.session.getValue(questionPointerAddress(questionId), BACKGROUND_CONTEXT))?.value;
      if (!pointer) continue;
      const record = (await this.session.getValue(questionAddress(questionId, pointer.version), BACKGROUND_CONTEXT))?.value;
      if (record) rows.push({question_id: questionId, version: pointer.version, status: record.status});
    }
    return rows;
  }
  async questionsForPlan(planRef: string): Promise<SemanticQuestionView[]> {return this.questionsAt(questionPlanIndexAddress(planRef));}
  async questionsForTask(taskRef: string): Promise<SemanticQuestionView[]> {return this.questionsAt(questionTaskIndexAddress(taskRef));}
  private async questionsAt(address: ReturnType<typeof questionPlanIndexAddress>) {
    const refs = (await this.session.getValue(address, BACKGROUND_CONTEXT))?.value ?? [];
    const rows = await Promise.all(refs.slice(-100).map(async ref => this.question(ref.question_id, ref.version)));
    return rows.filter((row): row is SemanticQuestionView => !!row);
  }
  private questionView(record: QuestionVersionRecord): SemanticQuestionView {
    const question = {...structuredClone(record.question), status: record.status,
      scope: {task_ref: record.binding.planRef, target_ref: record.binding.targetRef, field: record.question.scope.field, item_ref: record.binding.item_ref}};
    return {question, binding: structuredClone(record.binding), revision: record.revision, itemKey: record.itemKey};
  }
  private async questionRecords(tx: SessionMutator, context: Context, scope: "plan" | "task", ref: string) {
    const address = scope === "plan" ? questionPlanIndexAddress(ref) : questionTaskIndexAddress(ref);
    const refs = (await tx.getValue(address, context))?.value ?? [];
    const records = new Map<string, QuestionVersionRecord>();
    for (const ref of refs.slice(-100)) {
      const record = (await tx.getValue(questionAddress(ref.question_id, ref.version), context))?.value;
      if (record) records.set(ref.question_id, structuredClone(record));
    }
    return records;
  }
  private async writeQuestionRef(tx: SessionMutator, context: Context, writes: SessionWrites,
    scope: "plan" | "task", ownerRef: string, ref: QuestionRef) {
    const address = scope === "plan" ? questionPlanIndexAddress(ownerRef) : questionTaskIndexAddress(ownerRef);
    const previous = (await tx.getValue(address, context))?.value ?? [];
    writes.push(setValue(address, [...previous.filter(item => item.question_id !== ref.question_id), ref]));
  }
  private publicReceipt(record: AnswerAcceptanceRecord): AnswerReceipt {
    return {question_id: record.answer.question_id, version: record.answer.version, outcome: record.outcome,
      ...(record.selected_options?.length ? {selected_options: structuredClone(record.selected_options)} : {}), notice: record.notice,
      ...(record.code ? {code: record.code} : {})};
  }
  private selectedOptions(question: PendingQuestion, answer: Answer): QuestionOption[] {
    if (answer.choice.type === "select") return question.options.filter(option => answer.choice.type === "select" && answer.choice.option_ids.includes(option.option_id));
    if (answer.choice.type === "accept" && question.kind === "confirm") {
      const selected = question.options.find(option => option.option_id === question.confirmation_option_id);
      return selected ? [selected] : [];
    }
    return [];
  }
  private receiptNotice(outcome: AnswerReceipt["outcome"], selected: QuestionOption[], code?: string) {
    if (outcome === "applied") return `已按${selected.map(option => `第 ${option.no} 项「${option.label}」`).join("、")}确认。`;
    if (outcome === "declined") return "已拒绝该提案，未应用原候选。";
    if (outcome === "already_applied") return "该选择此前已应用，本次未重复执行。";
    return `本次选择未应用${code ? `（${code}）` : ""}。`;
  }
  async admit(operationId: string, originalMessage: string, admittedTask?: string | null, directQueryDelivery?: SemanticTurn["directQueryDelivery"],
    answerOptions: {actorId: string; answers?: Answer[]; discardedAnswers?: Answer[];
      publicationProof?: (question: PendingQuestion) => Promise<boolean>} | undefined = undefined) {
    return this.session.mutate(async (tx, context) => {
      const prior = (await tx.getValue(turnAddress(operationId), context))?.value;
      if (prior) {
        if (prior.originalMessage !== originalMessage) throw new Error("SEMANTIC_TURN_CONFLICT");
        if (!prior.answers?.length && !answerOptions?.answers?.length) return structuredClone(prior);
        const frozen = await this.freezeAnswers(tx, context, operationId, prior, answerOptions);
        const next = {...prior, ...frozen};
        await tx.commit([setValue(turnAddress(operationId), next)], context);
        return structuredClone(next);
      }
      const index = (await tx.getValue(indexAddress, context))?.value;
      const plans = admittedTask === undefined ? (await tx.getValue(value<PlanIndex>(NS, "plans/index"), context))?.value : undefined;
      const businessDate = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
      const focus = admittedTask === undefined ? plans?.order.length && !plans.focus ? undefined : index?.focus : admittedTask;
      const turn: SemanticTurn = {operationId, originalMessage, businessDate, operations: {}, ...(directQueryDelivery ? {directQueryDelivery} : {}), ...(focus ? {admittedTask: focus} : {})};
      if (admittedTask === undefined) {
        const pointers = (await tx.getValue(value<ContextFocus>(NS, "context/focus"), context))?.value;
        // 冻结工作任务与模型当前任务投影使用同一业务指针；展示历史不改变后续增量的基线。
        const business = pointers?.business ?? plans?.focus;
        const plan = business ? (await tx.getValue(value<SemanticPlan>(NS, `plans/${business}`), context))?.value : undefined;
        const refs = plan ? plan.steps.flatMap(step => step.taskRef ? [step.taskRef] : []) : plans?.order.length ? [] : focus ? [focus] : [];
        const tasks = await Promise.all([...new Set(refs)].map(async ref => (await tx.getValue(taskAddress(ref), context))?.value));
        const clarification = (await tx.getValue(value<SemanticClarification | null>(NS, "clarification"), context))?.value;
        turn.context = structuredClone({...(clarification ? {clarification} : {}),...(plan ? {plan} : {}), tasks: tasks.filter((task): task is SemanticTask => !!task)});
      }
      if (answerOptions?.answers?.length) Object.assign(turn, await this.freezeAnswers(tx, context, operationId, turn, answerOptions));
      await tx.commit([setValue(turnAddress(operationId), turn)], context);
      return turn;
    }, BACKGROUND_CONTEXT);
  }
  private async freezeAnswers(tx: SessionMutator, context: Context, operationId: string, turn: SemanticTurn,
    options: {actorId: string; answers?: Answer[]; discardedAnswers?: Answer[]; publicationProof?: (question: PendingQuestion) => Promise<boolean>} | undefined) {
    const equivalent = async (left: Answer, right: Answer) => {
      if (left.question_id !== right.question_id || left.version !== right.version) return false;
      const record = (await tx.getValue(questionAddress(left.question_id, left.version), context))?.value;
      return !!record && sameAnswerChoiceForQuestion(record.question, record.binding.reason, left.choice, right.choice);
    };
    const merged = new Map<string, Answer>((turn.answers ?? []).map(answer => [answer.question_id, structuredClone(answer)]));
    const discarded = [...(turn.discardedAnswers ?? []), ...(options?.discardedAnswers ?? [])];
    for (const incoming of options?.answers ?? []) {
      const previous = merged.get(incoming.question_id);
      if (!previous) {merged.set(incoming.question_id, structuredClone(incoming)); continue;}
      if (await equivalent(previous, incoming)) continue;
      if (previous.source.channel === "click" && incoming.source.channel === "model") {discarded.push(structuredClone(incoming)); continue;}
      if (previous.source.channel === "model" && incoming.source.channel === "click") {
        discarded.push(structuredClone(previous)); merged.set(incoming.question_id, structuredClone(incoming)); continue;
      }
      throw new QuestionAnswerError("ANSWER_OPERATION_CONFLICT", "同一 operation 对已提交问题改选或改版本。");
    }
    const snapshots: SemanticAnswerSnapshot[] = [], answers: Answer[] = [];
    for (const original of merged.values()) {
      let answer = structuredClone(original);
      const pointer = (await tx.getValue(questionPointerAddress(answer.question_id), context))?.value;
      const record = (await tx.getValue(questionAddress(answer.question_id, answer.version), context))?.value;
      if (!record || options?.actorId && record.owner !== options.actorId) {
        throw new QuestionAnswerError("QUESTION_NOT_PUBLISHED", "问题不存在或当前身份不可读取。", "stop");
      }
      const view = this.questionView(record);
      answer = normalizeAnswerChoiceForQuestion(answer, view.question, record.binding.reason);
      const receipts = record.binding.receipts ?? [];
      const operationReceipts = receipts.filter(receipt => receipt.answer.source.operation_id === operationId);
      if (operationReceipts.some(receipt => !sameAnswerChoiceForQuestion(view.question, record.binding.reason, receipt.answer.choice, answer.choice))) {
        throw new QuestionAnswerError("ANSWER_OPERATION_CONFLICT", "同一 operation 已受理其他选择，不能覆盖。");
      }
      const sameOperation = operationReceipts.reverse().find(receipt => ["applied", "declined", "already_applied"].includes(receipt.outcome));
      if (sameOperation) {
        snapshots.push({answer, ...view, questionRevision: record.revision, existingReceipt: structuredClone(sameOperation)});
        answers.push(answer); continue;
      }
      const applied = receipts.find(receipt => receipt.outcome === "applied"
        && sameAnswerChoiceForQuestion(view.question, record.binding.reason, receipt.answer.choice, answer.choice));
      if (applied) {
        snapshots.push({answer, ...view, questionRevision: record.revision,
          existingReceipt: structuredClone(applied), alreadyApplied: true});
        answers.push(answer); continue;
      }
      if (record.question.issued_operation_id === operationId || !options?.publicationProof) {
        throw new QuestionAnswerError("QUESTION_NOT_PUBLISHED", "问题尚未在本轮之前的最终工具回执中发布，不能同轮自确认。",
          answer.source.channel === "click" ? "user" : "pi");
      }
      if (!await options.publicationProof(view.question)) {
        throw new QuestionAnswerError("QUESTION_NOT_PUBLISHED", "没有找到对应该 question_id/version 的正式工具回执。",
          answer.source.channel === "click" ? "user" : "pi");
      }
      if (!pointer || pointer.version !== answer.version || record.status !== "open") {
        throw new QuestionAnswerError("QUESTION_SUPERSEDED", "问题版本或状态已不可受理。",
          answer.source.channel === "click" ? "user" : "pi");
      }
      const input = answer.source.channel === "model"
        ? {question_id: answer.question_id, version: answer.version, choice: answer.choice, evidence: {excerpt: answer.source.excerpt}}
        : {question_id: answer.question_id, version: answer.version, choice: answer.choice};
      answer = normalizeAnswerForQuestion(input, view.question, answer.source, record.binding.reason);
      snapshots.push({answer, ...view, questionRevision: record.revision});
      answers.push(answer);
    }
    return {answers, answerSnapshots: snapshots,
      discardedAnswers: [...new Map(discarded.map(answer => [JSON.stringify(answer), answer])).values()]};
  }
  private queueQuestionRecord(writes: Map<string, QuestionVersionRecord>, record: QuestionVersionRecord) {
    writes.set(`${record.question.question_id}/${record.question.version}`, structuredClone(record));
  }
  private async queueQuestionRef(tx: SessionMutator, context: Context,
    updates: Map<string, {scope: "plan" | "task"; ownerRef: string; refs: QuestionRef[]}>,
    scope: "plan" | "task", ownerRef: string, ref: QuestionRef) {
    const key = `${scope}/${ownerRef}`;
    let update = updates.get(key);
    if (!update) {
      const address = scope === "plan" ? questionPlanIndexAddress(ownerRef) : questionTaskIndexAddress(ownerRef);
      update = {scope, ownerRef, refs: (await tx.getValue(address, context))?.value ?? []};
      updates.set(key, update);
    }
    update.refs = [...update.refs.filter(item => item.question_id !== ref.question_id), ref];
  }
  private async applyAnswerRecords(tx: SessionMutator, context: Context, records: Map<string, QuestionVersionRecord>,
    recordWrites: Map<string, QuestionVersionRecord>,
    refUpdates: Map<string, {scope: "plan" | "task"; ownerRef: string; refs: QuestionRef[]}>,
    applications: readonly SemanticAnswerApplication[], owner: string) {
    const receipts: AnswerReceipt[] = [];
    for (const application of applications) {
      let answer = application.snapshot.answer;
      let record = records.get(answer.question_id);
      if (!record || record.question.version !== answer.version) {
        record = structuredClone((await tx.getValue(questionAddress(answer.question_id, answer.version), context))?.value);
        if (record) records.set(answer.question_id, record);
      }
      if (!record || record.owner !== owner) throw new QuestionAnswerError("QUESTION_NOT_PUBLISHED", "问题不存在或当前身份不可读取。");
      const view = this.questionView(record);
      answer = normalizeAnswerChoiceForQuestion(answer, view.question, record.binding.reason);
      const operationReceipts = record.binding.receipts.filter(receipt => receipt.answer.source.operation_id === answer.source.operation_id);
      if (operationReceipts.some(receipt => !sameAnswerChoiceForQuestion(view.question, record.binding.reason, receipt.answer.choice, answer.choice))) {
        throw new QuestionAnswerError("ANSWER_OPERATION_CONFLICT", "同一 operation 已受理其他选择，不能覆盖。");
      }
      const sameOperation = operationReceipts.reverse().find(receipt => ["applied", "declined", "already_applied"].includes(receipt.outcome));
      if (sameOperation) {receipts.push(this.publicReceipt(sameOperation)); continue;}
      const priorApplied = record.binding.receipts.find(receipt => receipt.outcome === "applied"
        && sameAnswerChoiceForQuestion(view.question, record.binding.reason, receipt.answer.choice, answer.choice));
      const repeated = application.outcome === "already_applied" || application.snapshot.alreadyApplied || !!priorApplied;
      if (repeated && !priorApplied) throw new Error("SEMANTIC_STATE_CONFLICT");
      if (!repeated) {
        if (record.revision !== application.snapshot.questionRevision) throw new Error("SEMANTIC_QUESTION_CONFLICT");
        if (record.status !== "open") throw new QuestionAnswerError("QUESTION_SUPERSEDED", "问题已不可受理。");
        if (record.binding.item_ref !== application.snapshot.binding.item_ref) throw new Error("SEMANTIC_QUESTION_BINDING_CONFLICT");
        const boundTaskRef = application.snapshot.binding.taskRef;
        if (application.expectedTaskRevision !== undefined) {
          const task = (await tx.getValue(taskAddress(boundTaskRef), context))?.value;
          if (!task || task.revision !== application.expectedTaskRevision) throw new Error("SEMANTIC_TASK_REVISION_CONFLICT");
        }
        if (application.expectedOrganizationCodes) {
          const task = (await tx.getValue(taskAddress(boundTaskRef), context))?.value;
          const value = task?.target.fields[record.question.scope.field]?.resolvedValue as {codes?: string[]} | undefined;
          if (JSON.stringify([...(value?.codes ?? [])].sort()) !== JSON.stringify([...application.expectedOrganizationCodes].sort())) {
            throw new QuestionAnswerError("ANSWER_OPERATION_CONFLICT", "来源确认对应的完整机构集合已变化。");
          }
        }
      }
      const outcome = repeated ? "already_applied" as const : application.outcome;
      const selected = outcome === "applied" || outcome === "already_applied" ? this.selectedOptions(view.question, answer) : [];
      const code = repeated ? "ANSWER_ALREADY_APPLIED" : application.code;
      const receipt: AnswerAcceptanceRecord = {receipt_id: randomUUID(), answer: structuredClone(answer), outcome,
        planRef: application.planRef, targetRef: application.targetRef,
        ...(selected.length ? {selected_options: selected} : {}),
        notice: application.notice ?? this.receiptNotice(outcome, selected, code), ...(code ? {code} : {})};
      if (outcome === "applied") record.status = "answered";
      else if (outcome === "declined") record.status = "rejected";
      record.binding = {...record.binding, planRef: application.snapshot.binding.planRef, targetRef: application.snapshot.binding.targetRef,
        taskRef: application.snapshot.binding.taskRef, receipts: [...record.binding.receipts, receipt]};
      record.revision++;
      records.set(answer.question_id, record);
      this.queueQuestionRecord(recordWrites, record);
      const ref = {question_id: answer.question_id, version: answer.version};
      await this.queueQuestionRef(tx, context, refUpdates, "plan", application.planRef, ref);
      if (record.binding.planRef !== application.planRef) await this.queueQuestionRef(tx, context, refUpdates, "plan", record.binding.planRef, ref);
      await this.queueQuestionRef(tx, context, refUpdates, "task", record.binding.taskRef, ref);
      receipts.push(this.publicReceipt(receipt));
    }
    return receipts;
  }
  private async writeQuestions(tx: SessionMutator, context: Context, records: Map<string, QuestionVersionRecord>,
    recordWrites: Map<string, QuestionVersionRecord>, pointerWrites: QuestionPointer[],
    refUpdates: Map<string, {scope: "plan" | "task"; ownerRef: string; refs: QuestionRef[]}>,
    issues: readonly SemanticQuestionIssue[], reason: QuestionBinding["reason"], closeUnmatched: boolean) {
    const matched = new Set<string>();
    for (const issue of issues) {
      matched.add(issue.itemKey);
      const existing = [...records.values()].find(record => record.itemKey === issue.itemKey
        && record.binding.reason === reason && record.question.scope.field === issue.draft.scope.field);
      const sameBasis = existing && sameQuestionBusinessBasis(existing.binding.businessBasis, issue.draft.businessBasis);
      let current: QuestionVersionRecord;
      // 同一候选仍在未决槽位时，已拒绝的旧题不能作为最终状态：本轮只答了同组的一部分
      // 或“先不选”时，应签发新的 open 版本继续等待该组，而不是只留一句无题可答的 pending。
      if (existing && sameBasis && existing.status === "open") {
        const options = existing.status === "open" ? existing.binding.options.map(binding => ({...binding,
          candidate: structuredClone(issue.draft.options.find(option => option.key === binding.candidateKey)?.binding
            ?? binding.candidate) as QuestionBinding["options"][number]["candidate"]})) : existing.binding.options;
        // 已发布快照、原槽位和原解析依据不可被本轮回复覆盖；只推进合法来源链上的当前绑定。
        existing.binding = {...existing.binding, planRef: issue.binding.planRef, targetRef: issue.binding.targetRef, taskRef: issue.binding.taskRef,
          businessBasis: structuredClone(issue.draft.businessBasis), options, receipts: existing.binding.receipts};
        if (existing.binding.sourceConfirmation && existing.question.kind === "confirm") {
          existing.binding.sourceConfirmation.option_id = existing.question.confirmation_option_id;
        }
        existing.revision++;
        current = existing;
      } else {
        if (existing?.status === "open") {
          existing.status = "superseded"; existing.revision++;
          this.queueQuestionRecord(recordWrites, existing);
        }
        const itemRef = existing?.binding.item_ref ?? semanticRef();
        const draft = {...structuredClone(issue.draft), version: existing ? existing.question.version + 1 : issue.draft.version,
          scope: {...structuredClone(issue.draft.scope), item_ref: itemRef}} as QuestionSnapshotDraft;
        const published = publishQuestionSnapshot(draft);
        const questionId = existing?.question.question_id ?? published.question.question_id;
        published.question.question_id = questionId;
        const binding: QuestionBinding = {...structuredClone(issue.binding), question_id: questionId,
          version: published.question.version, item_ref: itemRef, businessBasis: structuredClone(issue.draft.businessBasis),
          options: published.optionBindings.map(option => ({option_id: option.option_id, candidateKey: option.key,
            candidate: structuredClone(option.binding) as QuestionBinding["options"][number]["candidate"]})), receipts: []};
        if (binding.sourceConfirmation && published.question.kind === "confirm") {
          binding.sourceConfirmation.option_id = published.question.confirmation_option_id;
        }
        current = {owner: issue.owner, itemKey: issue.itemKey, question: published.question, binding, status: "open", revision: 0};
        pointerWrites.push({question_id: questionId, version: published.question.version, itemKey: issue.itemKey});
      }
      records.set(current.question.question_id, current);
      this.queueQuestionRecord(recordWrites, current);
      const ref = {question_id: current.question.question_id, version: current.question.version};
      await this.queueQuestionRef(tx, context, refUpdates, "plan", current.binding.planRef, ref);
      await this.queueQuestionRef(tx, context, refUpdates, "task", current.binding.taskRef, ref);
    }
    if (closeUnmatched) for (const record of records.values()) {
      const retryable = record.binding.receipts.some(receipt => receipt.outcome === "not_applied");
      if (record.binding.reason === reason && record.status === "open" && !matched.has(record.itemKey) && !retryable) {
        record.status = "superseded"; record.revision++;
        this.queueQuestionRecord(recordWrites, record);
      }
    }
  }
  private flushQuestionWrites(writes: SessionWrites, records: Map<string, QuestionVersionRecord>, pointers: QuestionPointer[],
    refs: Map<string, {scope: "plan" | "task"; ownerRef: string; refs: QuestionRef[]}>) {
    for (const record of records.values()) writes.push(setValue(questionAddress(record.question.question_id, record.question.version), record));
    for (const pointer of pointers) writes.push(setValue(questionPointerAddress(pointer.question_id), pointer));
    for (const update of refs.values()) {
      const address = update.scope === "plan" ? questionPlanIndexAddress(update.ownerRef) : questionTaskIndexAddress(update.ownerRef);
      writes.push(setValue(address, update.refs));
    }
  }
  async save(task: SemanticTask, expectedVersion: number, turn?: SemanticTurn, focus = true, options: SemanticSaveOptions = {}) {
    return this.session.mutate(async (tx, context) => {
      const index = (await tx.getValue(indexAddress, context))?.value ?? {version: 0, order: []};
      if (index.version !== expectedVersion) throw new Error("SEMANTIC_STATE_CONFLICT");
      const previous = (await tx.getValue(taskAddress(task.ref), context))?.value;
      if (previous && task.owner !== previous.owner) throw new Error("SEMANTIC_OWNER_CONFLICT");
      const nextTask = structuredClone(task), writes: SessionWrites = [];
      const records = await this.questionRecords(tx, context, "task", task.ref);
      const sourceTaskRefs = new Set<string>();
      if (turn?.admittedTask && turn.admittedTask !== task.ref) sourceTaskRefs.add(turn.admittedTask);
      if (turn?.source?.kind === "reference" && turn.source.task_ref !== task.ref) sourceTaskRefs.add(turn.source.task_ref);
      for (const sourceRef of sourceTaskRefs) for (const [questionId, record] of await this.questionRecords(tx, context, "task", sourceRef)) {
        const needed = record.status === "answered" || options.questions?.some(issue => issue.itemKey === record.itemKey)
          || options.answers?.some(application => application.snapshot.answer.question_id === questionId);
        if (needed && !records.has(questionId)) records.set(questionId, record);
      }
      const recordWrites = new Map<string, QuestionVersionRecord>(), pointerWrites: QuestionPointer[] = [];
      const refUpdates = new Map<string, {scope: "plan" | "task"; ownerRef: string; refs: QuestionRef[]}>();
      if (options.answers) nextTask.answerReceipts = await this.applyAnswerRecords(tx, context, records, recordWrites, refUpdates, options.answers, task.owner);
      if (options.questions) await this.writeQuestions(tx, context, records, recordWrites, pointerWrites, refUpdates, options.questions, "candidate_choice", true);
      for (const record of records.values()) {
        if (record.binding.reason !== "candidate_choice" || record.status !== "answered") continue;
        const planRef = task.parentPlan ?? record.binding.planRef;
        if (record.binding.planRef === planRef && record.binding.targetRef === task.target.ref && record.binding.taskRef === task.ref) continue;
        record.binding = {...record.binding, planRef, targetRef: task.target.ref, taskRef: task.ref, receipts: record.binding.receipts};
        record.revision++;
        this.queueQuestionRecord(recordWrites, record);
        const ref = {question_id: record.question.question_id, version: record.question.version};
        await this.queueQuestionRef(tx, context, refUpdates, "plan", planRef, ref);
        await this.queueQuestionRef(tx, context, refUpdates, "task", task.ref, ref);
      }
      if (options.questions || options.answers) nextTask.questionSnapshots = [...records.values()].filter(record => record.status === "open"
        && record.binding.taskRef === task.ref).map(record => this.questionView(record).question);
      this.flushQuestionWrites(writes, recordWrites, pointerWrites, refUpdates);
      const next = {...index, version: index.version + 1, ...(focus ? {focus: task.ref} : {}),
        order: index.order.includes(task.ref) ? index.order : [...index.order, task.ref]};
      const runtime = turn ? (await tx.getValue(turnAddress(turn.operationId), context))?.value?.runtime : undefined;
      await tx.commit([...writes, setValue(indexAddress, next), setValue(taskAddress(task.ref), nextTask),
        setValue(referenceAddress(nextTask.target.ref), {task: nextTask.ref, target: structuredClone(nextTask.target)}),
        ...(turn ? [setValue(turnAddress(turn.operationId), {...turn, ...(runtime ? {runtime} : {})})] : [])], context);
      return structuredClone(nextTask);
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
  async savePlan(plan: SemanticPlan, expectedVersion: number, focus = true, options: SemanticSaveOptions = {}) {
    return this.session.mutate(async (tx, context) => {
      const address = value<PlanIndex>(NS, "plans/index");
      const index = (await tx.getValue(address, context))?.value ?? {version: 0, order: [], operations: {}};
      if (index.version !== expectedVersion) throw new Error("SEMANTIC_PLAN_CONFLICT");
      const previous = (await tx.getValue(value<SemanticPlan>(NS, `plans/${plan.ref}`), context))?.value;
      if (previous && previous.owner !== plan.owner) throw new Error("SEMANTIC_OWNER_CONFLICT");
      const writes: SessionWrites = [];
      const records = await this.questionRecords(tx, context, "plan", plan.ref);
      const sourcePlanRefs = new Set(plan.steps.flatMap(step => step.source.kind === "reference" && step.source.task_ref !== plan.ref ? [step.source.task_ref] : []));
      for (const application of options.answers ?? []) sourcePlanRefs.add(application.snapshot.binding.planRef);
      sourcePlanRefs.delete(plan.ref);
      for (const sourceRef of sourcePlanRefs) for (const [questionId, record] of await this.questionRecords(tx, context, "plan", sourceRef)) {
        const needed = options.questions?.some(issue => issue.itemKey === record.itemKey)
          || options.answers?.some(application => application.snapshot.answer.question_id === questionId);
        if (needed && !records.has(questionId)) records.set(questionId, record);
      }
      const recordWrites = new Map<string, QuestionVersionRecord>(), pointerWrites: QuestionPointer[] = [];
      const refUpdates = new Map<string, {scope: "plan" | "task"; ownerRef: string; refs: QuestionRef[]}>();
      if (options.answers) await this.applyAnswerRecords(tx, context, records, recordWrites, refUpdates, options.answers, plan.owner);
      if (options.questions) await this.writeQuestions(tx, context, records, recordWrites, pointerWrites, refUpdates, options.questions, "source_confirmation", false);
      if (options.abandonQuestions) for (const record of records.values()) if (record.status === "open") {
        record.status = "abandoned"; record.revision++;
        this.queueQuestionRecord(recordWrites, record);
      }
      this.flushQuestionWrites(writes, recordWrites, pointerWrites, refUpdates);
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
      await tx.commit([...writes, setValue(address, {...index, version: index.version + 1,
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
  async bindContextAction(operationId: string, action: "resume" | "defer" | "abandon") {
    await this.session.mutate(async (tx, context) => {
      const address = turnAddress(operationId), turn = (await tx.getValue(address, context))?.value;
      if (!turn) throw new Error("SEMANTIC_TURN_NOT_ADMITTED");
      await tx.commit([setValue(address, {...turn, contextAction: action})], context);
    }, BACKGROUND_CONTEXT);
  }
  async claimQueryRecovery(operationId: string, planRef: string,
    scopes: NonNullable<SemanticTurn["queryRecovery"]>["scopes"], limit: number) {
    return this.session.mutate(async (tx, context) => {
      const address = turnAddress(operationId), turn = (await tx.getValue(address, context))?.value;
      if (!turn) throw new Error("SEMANTIC_TURN_NOT_ADMITTED");
      const previous = turn.queryRecovery;
      if (previous && (previous.planRef !== planRef || previous.attempts >= limit)) return undefined;
      const recovery = {planRef, attempts: (previous?.attempts ?? 0) + 1,
        scopes: structuredClone(previous?.scopes ?? scopes)};
      await tx.commit([setValue(address, {...turn, queryRecovery: recovery})], context);
      return recovery;
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
    const turn = await this.turn(operationId), snapshot = turn?.context;
    if (!snapshot) return;
    const questionViews = new Map<string, SemanticQuestionView>();
    if (snapshot.plan) for (const view of await this.questionsForPlan(snapshot.plan.ref)) questionViews.set(view.question.question_id, view);
    for (const task of snapshot.tasks) for (const view of await this.questionsForTask(task.ref)) questionViews.set(view.question.question_id, view);
    const pendingQuestions = [...questionViews.values()].filter(view => view.question.status === "open").map(view => view.question);
    const trustedAnswers = (turn?.answers ?? []).filter(answer => answer.source.channel === "click")
      .map(answer => ({question_id: answer.question_id, version: answer.version, choice: structuredClone(answer.choice)}));
    return {task_ref: snapshot.plan?.ref, ...(snapshot.clarification ? {pending_clarification: snapshot.clarification} : {}),
      pending_questions: pendingQuestions, trusted_answers: trustedAnswers, targets: snapshot.tasks.map(task => {
      const targetRef = snapshot.plan?.steps.find(step => step.taskRef === task.ref)?.targetRef ?? task.target.ref;
      const unconfirmedSources = new Set([...questionViews.values()].filter(view => {
        if (view.binding.reason !== "source_confirmation" || !["open", "rejected"].includes(view.question.status)
          || !(view.binding.taskRef === task.ref || view.binding.targetRef === targetRef)) return false;
        const current = task.target.fields[view.question.scope.field];
        const replaced = view.question.status === "rejected" && current?.resolutionStatus === "resolved"
          && typeof current.metadata?.semanticTurn === "string"
          && current.metadata?.resolution_source !== "model_inferred"
          && (Array.isArray(current.metadata?.source_codes) || !!current.metadata?.fieldSource);
        return !replaced;
      }).map(view => view.question.scope.field));
      return {target_ref: targetRef, status: task.target.status, frame_id: task.target.frameId,
        conditions: Object.fromEntries(Object.entries(task.target.fields).map(([name, field]) => [name, {
          status: field.resolutionStatus, expression: semanticDisplay(field),
          ...(field.resolutionStatus === "resolved" && !unconfirmedSources.has(name as import("./questions.js").QuestionField)
            ? {confirmed: (field.resolvedValue as {names?: string[]} | undefined)?.names ?? field.resolvedValue} : {}),
        }])), pending: task.target.pending};
    })};
  }
  private async projectPlan(plan: SemanticPlan) {
    return {task_ref: plan.ref, status: plan.status, completion: plan.completion, issues: plan.issues, goal: plan.originalMessage, intent: plan.intent,
      pending_questions: (await this.questionsForPlan(plan.ref)).filter(view => view.question.status === "open").map(view => view.question),
      targets: await Promise.all(plan.steps.map(async step => {
        const task = step.taskRef ? await this.get(step.taskRef) : undefined;
        return {target_ref: step.targetRef, status: step.status, kind: step.kind, label: step.label, aliases: step.aliases, dependencies: step.dependencies,
          conditions: Object.fromEntries(Object.entries(task?.target.fields ?? {}).map(([field, value]) => [field, {status: value.resolutionStatus,
            expression: semanticDisplay(value), ...(value.candidates ? {candidates: candidateOptions(displayedCandidates(value.candidates)).map(option => ({no: option.no, name: option.candidate.value}))} : {})}])),
          pending: task?.target.pending ?? {}};
      }))};
  }
  /** 默认投影只呈现当前业务目标；历史仍由Pi自由调用context工具分页读取，不与当前状态平铺混用。 */
  async runtimeContext() {
    const index = await this.planIndex();
    const focus = (await this.session.getValue(value<ContextFocus>(NS, "context/focus"), BACKGROUND_CONTEXT))?.value;
    const current = focus?.business ?? index.focus;
    if (!current) {
      // 首轮错误草案只有历史地址，不能因尚无焦点而成为默认业务上下文。
      if (index.order.length) return {tasks: [], history_available: true};
      const legacyIndex = await this.index(), legacy = await this.context();
      return {current_task_ref: legacyIndex.focus, tasks: legacy.tasks.filter(task => task.task_ref === legacyIndex.focus),
        history_available: legacyIndex.order.some(ref => ref !== legacyIndex.focus)};
    }
    const plan = await this.plan(current);
    const topic = plan ? await this.topicFor(plan) : undefined, history = await this.historyCatalog();
    return {current_task_ref: current, focus, topic_ref: topic, tasks: plan ? [await this.projectPlan(plan)] : [], history_available: index.order.length > 1,
      related_history: history.filter(row => row.topic_ref === topic && row.task_ref !== current).filter((row, index, all) =>
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
        {status: value.resolutionStatus, expression: semanticDisplay(value), ...(value.candidates ? {candidates: candidateOptions(displayedCandidates(value.candidates)).map(option => ({no: option.no, name: option.candidate.value}))} : {})}])),
      pending: task.target.pending,
    }))};
  }
}
