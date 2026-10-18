import {randomUUID} from "node:crypto";
import type {FieldCandidate} from "../business-context/types.js";

export type QuestionField = "organizations" | "comparison_organizations" | "metrics";
export type QuestionStatus = "open" | "answered" | "rejected" | "superseded" | "abandoned";
export interface QuestionOption {option_id: string; no: number; label: string; description?: string}
export interface QuestionScope {task_ref: string; target_ref: string; field: QuestionField; item_ref: string}
interface PendingQuestionBase {
  question_id: string;
  version: number;
  scope: QuestionScope;
  prompt: string;
  selection_mode: "single" | "multiple";
  options: QuestionOption[];
  status: QuestionStatus;
  issued_operation_id: string;
}
export type PendingQuestion = PendingQuestionBase & (
  | {kind: "choice"; confirmation_option_id?: never}
  | {kind: "confirm"; confirmation_option_id: string}
);

export type AnswerChoice =
  | {type: "select"; option_ids: [string, ...string[]]}
  | {type: "accept"}
  | {type: "reject"}
  | {type: "none_of_these"};
export interface ClickAnswerInput {question_id: string; version: number; choice: AnswerChoice}
export type ModelAnswerInput = ClickAnswerInput & {evidence: {excerpt: string}};
export type Answer = ClickAnswerInput & {source: {
  channel: "click" | "model";
  operation_id: string;
  excerpt?: string;
}};
export interface AnswerReceipt {
  question_id: string;
  version: number;
  outcome: "applied" | "declined" | "not_applied" | "already_applied";
  selected_options?: QuestionOption[];
  notice: string;
  code?: string;
}
export interface AnswerAcceptanceRecord {
  receipt_id: string;
  answer: Answer;
  outcome: AnswerReceipt["outcome"];
  planRef: string;
  targetRef: string;
  selected_options?: QuestionOption[];
  notice: string;
  code?: string;
}
export interface AnswerHostSource {channel: "click" | "model"; operation_id: string}

/** 以下绑定只持久化在服务端，不进入问题投影或 Answer DTO。 */
export interface PendingItemBinding {rawValueIndex?: number; semanticSpan?: string; rawValue?: unknown}
export interface QuestionOptionBinding {option_id: string; candidateKey: string; candidate: FieldCandidate}
export interface SourceConfirmationBinding {option_id: string; organizationCondition: unknown}
export interface QuestionBinding {
  question_id: string;
  version: number;
  reason: "candidate_choice" | "source_confirmation";
  planRef: string;
  targetRef: string;
  taskRef: string;
  item_ref: string;
  /** 签发时原准入片段；后续回答文本不能覆盖它。 */
  sourceQuestion?: string;
  pendingItem?: PendingItemBinding;
  options: QuestionOptionBinding[];
  sourceConfirmation?: SourceConfirmationBinding;
  resolutionBasis: unknown;
  businessBasis: QuestionBusinessBasis;
  receipts: AnswerAcceptanceRecord[];
}

export interface QuestionOptionBasis {key: string; label: string; description?: string}
interface QuestionBusinessBasisBase {
  field: QuestionField;
  prompt: string;
  selection_mode: "single" | "multiple";
  rawValue?: unknown;
  resolutionInput?: unknown;
  catalog?: unknown;
  permission?: unknown;
  options: readonly QuestionOptionBasis[];
}
/** 只放解析器实际业务依据；技术引用、签发状态和运行日志不属于版本依据。 */
export type QuestionBusinessBasis = QuestionBusinessBasisBase & (
  | {kind: "choice"; confirmation_key?: never}
  | {kind: "confirm"; confirmation_key: string}
);

export interface QuestionOptionDraft {key: string; no: number; label: string; description?: string; binding: unknown}
interface QuestionSnapshotDraftBase {
  version: number;
  scope: QuestionScope;
  prompt: string;
  selection_mode: "single" | "multiple";
  options: readonly QuestionOptionDraft[];
  issued_operation_id: string;
  businessBasis: QuestionBusinessBasis;
}
export type QuestionSnapshotDraft = QuestionSnapshotDraftBase & (
  | {kind: "choice"; confirmation_key?: never}
  | {kind: "confirm"; confirmation_key: string}
);
export interface PublishedOptionBinding {option_id: string; key: string; binding: unknown}
export interface PublishedQuestionSnapshot {
  question: PendingQuestion;
  optionBindings: PublishedOptionBinding[];
  businessBasis: QuestionBusinessBasis;
}

export type AnswerErrorCode = "ANSWER_INPUT_SHAPE_INVALID" | "ANSWER_OPERATION_CONFLICT"
  | "QUESTION_SUPERSEDED" | "ANSWER_OPTION_INVALID" | "ANSWER_SELECTION_INVALID"
  | "QUESTION_NOT_PUBLISHED" | "ANSWER_EXCERPT_UNGROUNDED" | "ANSWER_TARGET_AMBIGUOUS" | "ANSWER_ALREADY_APPLIED";
export class QuestionAnswerError extends Error {
  constructor(readonly code: AnswerErrorCode, message: string, readonly remediation: "pi" | "user" | "stop" = "pi") {
    super(`${code}: ${message}`); this.name = "QuestionAnswerError";
  }
}

const fail = (code: AnswerErrorCode, message: string): never => {throw new QuestionAnswerError(code, message);};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : fail("ANSWER_INPUT_SHAPE_INVALID", "必须是对象。");
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("ANSWER_INPUT_SHAPE_INVALID", "包含未定义或越权字段。");
}
function id(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : fail("ANSWER_INPUT_SHAPE_INVALID", "ID 必须是非空字符串。");
}
function version(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value
    : fail("ANSWER_INPUT_SHAPE_INVALID", "version 必须是正整数。");
}
function choice(value: unknown): AnswerChoice {
  const input = record(value), type = input.type;
  if (type === "select") {
    keys(input, ["type", "option_ids"]);
    if (!Array.isArray(input.option_ids) || !input.option_ids.length || input.option_ids.length > 100) {
      return fail("ANSWER_INPUT_SHAPE_INVALID", "select 的 option_ids 必须包含 1 至 100 项。");
    }
    const optionIds = input.option_ids.map(id);
    if (new Set(optionIds).size !== optionIds.length) return fail("ANSWER_INPUT_SHAPE_INVALID", "option_ids 不得重复。");
    return {type: "select", option_ids: [...optionIds].sort() as [string, ...string[]]};
  }
  if (type === "accept" || type === "reject" || type === "none_of_these") {
    keys(input, ["type"]);
    return {type};
  }
  return fail("ANSWER_INPUT_SHAPE_INVALID", "未知回答选择类型。");
}

/** 只从宿主来源参数绑定 channel；输入中的 source/channel 会按未知字段拒绝。 */
export function normalizeAnswerInput(input: unknown, source: AnswerHostSource): Answer {
  if ((source.channel !== "click" && source.channel !== "model") || !source.operation_id) {
    return fail("ANSWER_INPUT_SHAPE_INVALID", "宿主回答来源无效。");
  }
  const value = record(input);
  keys(value, source.channel === "model" ? ["question_id", "version", "choice", "evidence"] : ["question_id", "version", "choice"]);
  const answer: Answer = {question_id: id(value.question_id), version: version(value.version), choice: choice(value.choice),
    source: {channel: source.channel, operation_id: source.operation_id}};
  if (source.channel === "model") {
    const evidence = record(value.evidence);
    keys(evidence, ["excerpt"]);
    if (typeof evidence.excerpt !== "string" || !evidence.excerpt.length || evidence.excerpt.length > 4000) {
      return fail("ANSWER_INPUT_SHAPE_INVALID", "模型 excerpt 必须非空且不超过 4000 字符。");
    }
    answer.source.excerpt = evidence.excerpt;
  }
  return answer;
}

/** 已知题目后的纯等价归一不读取 open 状态，供终结回执比较和新受理校验共用。 */
export function normalizeAnswerChoiceForQuestion<T extends ClickAnswerInput>(answer: T, question: PendingQuestion,
  reason?: QuestionBinding["reason"]): T {
  let choice: AnswerChoice = answer.choice;
  if (reason === "source_confirmation" && question.kind === "confirm" && choice.type === "select"
    && choice.option_ids.length === 1 && choice.option_ids[0] === question.confirmation_option_id) choice = {type: "accept"};
  if (choice.type !== "select") return choice === answer.choice ? answer : {...answer, choice} as T;
  const order = new Map(question.options.map((option, index) => [option.option_id, index]));
  const optionIds = [...choice.option_ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  return {...answer, choice: {type: "select", option_ids: optionIds as [string, ...string[]]}} as T;
}

/** 按冻结问题校验，并把多选恢复为发布清单顺序；不得用模型输入改变题目模式。 */
export function normalizeAnswerForQuestion(input: unknown, question: PendingQuestion, source: AnswerHostSource,
  reason?: QuestionBinding["reason"]): Answer {
  const answer = normalizeAnswerChoiceForQuestion(normalizeAnswerInput(input, source), question, reason);
  validateAnswer(question, answer);
  return answer;
}

export function validateAnswer(question: PendingQuestion, answer: ClickAnswerInput): void {
  version(answer.version);
  if (answer.version !== question.version || question.status !== "open") {
    return fail("QUESTION_SUPERSEDED", "问题版本或状态已不可受理。");
  }
  if (answer.choice.type === "accept") {
    if (question.kind !== "confirm") return fail("ANSWER_SELECTION_INVALID", "accept 只适用于 confirm 问题。");
    if (!question.options.some(option => option.option_id === question.confirmation_option_id)) {
      return fail("ANSWER_OPTION_INVALID", "确认对象不在已发布清单中。");
    }
    return;
  }
  if (answer.choice.type === "reject") {
    if (question.kind !== "confirm") return fail("ANSWER_SELECTION_INVALID", "reject 只适用于 confirm 问题。");
    return;
  }
  if (answer.choice.type !== "select") return;
  const selected = answer.choice.option_ids;
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) {
    return fail("ANSWER_OPTION_INVALID", "选择清单为空或包含重复选项。");
  }
  if (question.scope.field === "metrics" && selected.length !== 1
    || question.selection_mode === "single" && selected.length !== 1
    || question.selection_mode === "multiple" && selected.length > 100) {
    return fail("ANSWER_SELECTION_INVALID", "选择数量不符合问题的字段和 selection_mode。");
  }
  const published = new Set(question.options.map(option => option.option_id));
  if (selected.some(optionId => !published.has(optionId))) return fail("ANSWER_OPTION_INVALID", "包含清单外选项。");
}

const choiceKey = (value: AnswerChoice): string => value.type === "select"
  ? `select:${JSON.stringify([...value.option_ids].sort())}` : value.type;
export const sameAnswerChoice = (left: AnswerChoice, right: AnswerChoice): boolean => choiceKey(left) === choiceKey(right);
export function sameAnswerChoiceForQuestion(question: PendingQuestion, reason: QuestionBinding["reason"],
  left: AnswerChoice, right: AnswerChoice): boolean {
  const normalize = (choice: AnswerChoice) => normalizeAnswerChoiceForQuestion({question_id: question.question_id, version: question.version, choice}, question, reason).choice;
  return sameAnswerChoice(normalize(left), normalize(right));
}

/** 同题同版本同选择归并；其余同题回答必须显式修正，不能后答覆盖先答。 */
export function mergeAnswers(answers: readonly Answer[]): Answer[] {
  if (answers.length > 20) return fail("ANSWER_INPUT_SHAPE_INVALID", "一轮最多提交 20 条回答。");
  const byQuestion = new Map<string, Answer>();
  for (const answer of answers) {
    const previous = byQuestion.get(answer.question_id);
    if (!previous) byQuestion.set(answer.question_id, answer);
    else if (previous.version !== answer.version || !sameAnswerChoice(previous.choice, answer.choice)) {
      return fail("ANSWER_OPERATION_CONFLICT", "同一问题存在版本或选择冲突。");
    }
  }
  return [...byQuestion.values()].sort((a, b) => a.question_id.localeCompare(b.question_id));
}

/** 模型与可信点击分别归一化；同题冲突时点击优先，被丢弃的模型提案仍留作本轮审计。 */
export function bindAnswerInputs(modelInputs: readonly unknown[], clickInputs: readonly unknown[], operationId: string, originalMessage: string) {
  const models = modelInputs.map(input => normalizeAnswerInput(input, {channel: "model", operation_id: operationId}));
  const clicks = clickInputs.map(input => normalizeAnswerInput(input, {channel: "click", operation_id: operationId}));
  const answers: Answer[] = [], discarded: Answer[] = [];
  const ids = [...new Set([...models, ...clicks].map(answer => answer.question_id))].sort();
  for (const questionId of ids) {
    const click = mergeAnswers(clicks.filter(answer => answer.question_id === questionId));
    const proposed = models.filter(answer => answer.question_id === questionId);
    if (click.length) {
      // 可信点击是本题唯一输入；模型复述不再作为另一份用户证据进行校验。
      answers.push(click[0]!);
      discarded.push(...proposed.filter(answer => answer.version !== click[0]!.version || !sameAnswerChoice(answer.choice, click[0]!.choice)
        || !answer.source.excerpt || !originalMessage.includes(answer.source.excerpt)));
    } else {
      const model = mergeAnswers(proposed);
      for (const answer of model) if (!answer.source.excerpt || !originalMessage.includes(answer.source.excerpt)) {
        return fail("ANSWER_EXCERPT_UNGROUNDED", "模型 excerpt 必须是本轮真实用户原文的原样片段。");
      }
      answers.push(model[0]!);
    }
  }
  return {answers: mergeAnswers(answers), discarded};
}

export function newOpaquePublicId(kind: "question" | "option"): string {
  return `${kind === "question" ? "q" : "opt"}_${randomUUID()}`;
}

/** 发布不可变内容快照；公共 ID 独立签发，不复用含编码的内部 candidateKey/optionId。 */
export function publishQuestionSnapshot(draft: QuestionSnapshotDraft,
  issueId: (kind: "question" | "option") => string = newOpaquePublicId): PublishedQuestionSnapshot {
  version(draft.version);
  if (!draft.options.length) return fail("ANSWER_OPTION_INVALID", "问题至少需要一个选项。");
  if (draft.scope.field === "metrics" && draft.selection_mode !== "single") {
    return fail("ANSWER_SELECTION_INVALID", "指标问题只能 single。");
  }
  if (draft.options.some((option, index) => option.no !== index + 1 || !option.key || !option.label)) {
    return fail("ANSWER_OPTION_INVALID", "选项编号必须从 1 连续递增，内部键和标签不能为空。");
  }
  if (new Set(draft.options.map(option => option.key)).size !== draft.options.length) {
    return fail("ANSWER_OPTION_INVALID", "同一问题内候选身份重复。");
  }
  const saved = structuredClone([...draft.options]);
  const optionIds = saved.map(() => id(issueId("option")));
  if (new Set(optionIds).size !== optionIds.length) return fail("ANSWER_OPTION_INVALID", "公共选项 ID 签发重复。");
  const options: QuestionOption[] = saved.map((option, index) => ({option_id: optionIds[index]!, no: option.no, label: option.label,
    ...(option.description !== undefined ? {description: option.description} : {})}));
  const base: PendingQuestionBase = {question_id: id(issueId("question")), version: draft.version, scope: structuredClone(draft.scope),
    prompt: draft.prompt, selection_mode: draft.selection_mode, options, status: "open", issued_operation_id: draft.issued_operation_id};
  let question: PendingQuestion;
  if (draft.kind === "confirm") {
    const index = saved.findIndex(option => option.key === draft.confirmation_key);
    if (index < 0) return fail("ANSWER_OPTION_INVALID", "confirmation_key 未对应当前选项。");
    question = {...base, kind: "confirm", confirmation_option_id: optionIds[index]!};
  } else question = {...base, kind: "choice"};
  return {question, businessBasis: structuredClone(draft.businessBasis),
    optionBindings: saved.map((option, index) => ({option_id: optionIds[index]!, key: option.key, binding: option.binding}))};
}

function businessJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(businessJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${businessJson(item)}`).join(",")}}`;
}

function comparableBusinessBasis(value: QuestionBusinessBasis): QuestionBusinessBasis {
  const result = structuredClone(value);
  const input = result.resolutionInput;
  if (input && typeof input === "object" && !Array.isArray(input)
    && ("pendingRawValues" in input || "semanticOperations" in input)) delete result.resolutionInput;
  const catalog = result.catalog;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog) && "candidate_count" in catalog) {
    const retained = Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== "candidate_count"));
    if (Object.keys(retained).length) result.catalog = retained; else delete result.catalog;
  }
  return result;
}

/** 数组顺序代表候选发布顺序；旧式整字段布局和技术操作不参与逐题版本比较。 */
export function sameQuestionBusinessBasis(a: QuestionBusinessBasis, b: QuestionBusinessBasis): boolean {
  return businessJson(comparableBusinessBasis(a)) === businessJson(comparableBusinessBasis(b));
}
