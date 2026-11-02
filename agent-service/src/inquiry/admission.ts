import type {
  BusinessFrame,
  FieldCandidate,
  FieldResolution,
  QueryOperation,
  ResolvedField,
  ResolvedOrganizations,
} from "../business-context/types.js";
import type { NativeFrameStore } from "../business-context/store.js";
import { clarificationOptions } from "../business-context/clarificationOptions.js";
import type { NativeSemanticTaskStore, SemanticQuestionView } from "../semantic-task/store.js";
import type {
  AnswerReceipt,
  ClickAnswerInput,
  PendingQuestion,
  QuestionField,
} from "../semantic-task/questions.js";
import {
  normalizeAnswerInput,
  normalizeAnswerChoiceForQuestion,
  validateAnswer,
  sameAnswerChoice,
  QuestionAnswerError,
} from "../semantic-task/questions.js";
import { isCalendarDate } from "../tools/shared.js";
import type { BackendClient } from "../backendClient.js";

export interface InquiryAcceptedTarget {
  targetRef: string;
  source:
    | { kind: "semantic"; taskRef: string }
    | { kind: "frame"; frameId: string }
    | { kind: "backend_task"; taskId: string };
  sourceQuestion: string;
  metrics?: { codes: string[]; names: string[] };
  organizations?: ResolvedOrganizations;
  comparisonOrganizations?: ResolvedOrganizations;
  operation?: QueryOperation;
  time?: {
    preset?: "latest";
    start?: string;
    end?: string;
    dates?: string[];
    record_selection?: string;
  };
  pending: Array<{
    field: QuestionField | "time" | "selection" | "operation";
    reason: "unresolved" | "declined";
    selectedBases?: Array<{ name: string; sourceMetricCode: string }>;
  }>;
}
export interface InquiryAdmission {
  targets: InquiryAcceptedTarget[];
  answerReceipts: AnswerReceipt[];
}
export interface InquiryAdmissionInput {
  answers?: ClickAnswerInput[];
  clarification_target?: { task_id: string; version: number; clarification_id: string };
  selected_answers?: Record<string, unknown>;
  clarification_selection?: { frame_id: string; option_ids: string[] };
}
export interface InquiryAdmissionDependencies {
  actorId: string;
  sessionId: string;
  operationId: string;
  /** 当前分支已受理的同目标选择；仍逐项通过现有发布、版本与候选校验。 */
  priorAnswers?: readonly ClickAnswerInput[];
  semanticTasks?: Pick<NativeSemanticTaskStore, "question" | "get" | "questionsForTask">;
  frames?: Pick<NativeFrameStore, "get" | "state">;
  questionPublicationProof?: (question: PendingQuestion) => Promise<boolean>;
  framePublicationProof?: (frame: BusinessFrame) => Promise<boolean>;
  resolveMetric?: (values: string[]) => Promise<FieldResolution>;
  resolveOrganization?: (values: string[]) => Promise<FieldResolution>;
  resolveDate?: (text: string) => Promise<FieldResolution>;
  getTask?: BackendClient["getTask"];
  taskPublicationProof?: (
    target: NonNullable<InquiryAdmissionInput["clarification_target"]>,
  ) => Promise<boolean>;
}

export class InquiryAdmissionError extends Error {
  constructor(
    readonly code: "LEGACY_CLARIFICATION_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "InquiryAdmissionError";
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? (value as string[])
    : [];
type Entity = { codes: string[]; names: string[] };
type Field = InquiryAcceptedTarget["pending"][number]["field"];
const fields: Field[] = [
  "metrics",
  "organizations",
  "comparison_organizations",
  "time",
  "selection",
  "operation",
];
const keyOf = (field: QuestionField) =>
  field === "comparison_organizations" ? "comparisonOrganizations" : field;
const unsupported = (): never => {
  throw new InquiryAdmissionError(
    "LEGACY_CLARIFICATION_UNSUPPORTED",
    "旧澄清缺少可核对的发布记录或条件，请按原问题继续说明查询目标。",
  );
};
const invalid = (message: string): never => {
  throw new QuestionAnswerError("ANSWER_SELECTION_INVALID", message, "user");
};
const unpublished = (): never => {
  throw new QuestionAnswerError(
    "QUESTION_NOT_PUBLISHED",
    "待确认项不属于当前会话已发布的业务目标。",
    "user",
  );
};
function entity(value: unknown): Entity | undefined {
  const item = object(value),
    codes = strings(item.codes),
    names = strings(item.names);
  return codes.length && codes.length === names.length && new Set(codes).size === codes.length
    ? { codes: [...codes], names: [...names] }
    : undefined;
}
function organizationScope(value: unknown): ResolvedOrganizations["scope"] {
  const scope = object(object(value).scope);
  if (scope.kind === "authorized_cohort" && scope.cohort === "rural_commercial_banks")
    return { kind: "authorized_cohort", cohort: "rural_commercial_banks" };
  if (scope.kind === "children_of" && typeof scope.parent_code === "string" && scope.parent_code)
    return { kind: "children_of", parent_code: scope.parent_code };
  return undefined;
}
function time(value: unknown): InquiryAcceptedTarget["time"] {
  const item = object(value);
  if (item.preset === "latest") return { preset: "latest" };
  if (
    typeof item.start !== "string" ||
    typeof item.end !== "string" ||
    !isCalendarDate(item.start) ||
    !isCalendarDate(item.end) ||
    item.start > item.end
  )
    return;
  const dates = strings(item.dates);
  if (
    item.dates !== undefined &&
    (!dates.length ||
      dates.some((day) => !isCalendarDate(day) || day < item.start! || day > item.end!))
  )
    return;
  return {
    start: item.start,
    end: item.end,
    ...(dates.length ? { dates: [...dates] } : {}),
    ...(typeof item.record_selection === "string"
      ? { record_selection: item.record_selection }
      : {}),
  };
}
function queryOperation(value: unknown): QueryOperation | undefined {
  const item = object(value);
  if (
    (item.kind === "value" || item.kind === "rank_position") &&
    Object.keys(item).every((key) => key === "kind")
  )
    return { kind: item.kind };
  if (
    item.kind === "ranking" &&
    (item.position === "top" || item.position === "bottom") &&
    typeof item.top_n === "number" &&
    Number.isInteger(item.top_n) &&
    item.top_n >= 1 &&
    item.top_n <= 100 &&
    Object.keys(item).every((key) => ["kind", "position", "top_n"].includes(key))
  )
    return { kind: "ranking", position: item.position, top_n: item.top_n };
  return undefined;
}
function pending(
  target: InquiryAcceptedTarget,
  field: Field,
  reason: "unresolved" | "declined",
  selectedBases?: Array<{ name: string; sourceMetricCode: string }>,
) {
  const previous = target.pending.find((item) => item.field === field);
  target.pending = target.pending.filter((item) => item.field !== field);
  target.pending.push({
    field,
    reason: previous?.reason === "declined" ? "declined" : reason,
    ...(selectedBases?.length
      ? { selectedBases: [...(previous?.selectedBases ?? []), ...selectedBases] }
      : previous?.selectedBases
        ? { selectedBases: previous.selectedBases }
        : {}),
  });
}
function merge(target: InquiryAcceptedTarget, field: QuestionField, value: Entity) {
  const key = keyOf(field),
    prior = target[key];
  const values = new Map((prior?.codes ?? []).map((code, index) => [code, prior!.names[index]!]));
  value.codes.forEach((code, index) => values.set(code, value.names[index]!));
  target[key] = { codes: [...values.keys()], names: [...values.values()] };
}
function fromFields(
  targetRef: string,
  source: InquiryAcceptedTarget["source"],
  sourceQuestion: string,
  values: Record<string, ResolvedField>,
): InquiryAcceptedTarget {
  const target: InquiryAcceptedTarget = { targetRef, source, sourceQuestion, pending: [] };
  for (const field of fields) {
    const current = values[field];
    if (!current) continue;
    if (field === "time") {
      const resolved =
        current.resolutionStatus === "resolved" ? time(current.resolvedValue) : undefined;
      if (resolved) target.time = resolved;
      else pending(target, field, "unresolved");
      continue;
    }
    if (field === "selection") {
      const selection = current.resolvedValue;
      if (
        current.resolutionStatus === "resolved" &&
        typeof selection === "string" &&
        ["exact", "latest", "latest_in_range", "all_in_range"].includes(selection) &&
        (selection === "latest") === (target.time?.preset === "latest")
      ) {
        // 旧查询把日期和取数方式分开保存；迁移时不能把已确认的范围策略降为默认值。
        target.time = {
          ...target.time,
          record_selection: selection === "latest" ? "latest_snapshot" : selection,
        };
      } else pending(target, field, "unresolved");
      continue;
    }
    if (field === "operation") {
      const resolved =
        current.resolutionStatus === "resolved" ? queryOperation(current.resolvedValue) : undefined;
      if (resolved) target.operation = resolved;
      else pending(target, field, "unresolved");
      continue;
    }
    const resolved = entity(
      current.resolutionStatus === "resolved"
        ? current.resolvedValue
        : current.metadata?.partialMembers,
    );
    if (resolved) {
      merge(target, field, resolved);
      const scope = field !== "metrics" ? organizationScope(current.resolvedValue) : undefined;
      if (scope) (target[keyOf(field)] as ResolvedOrganizations).scope = scope;
    }
    if (field === "metrics" && Array.isArray(current.metadata?.mentionResolutions)) {
      for (const raw of current.metadata.mentionResolutions) {
        const mention = object(raw),
          known = mention.status === "resolved" ? entity(mention.value) : undefined;
        if (known) merge(target, field, known);
      }
    }
    if (current.resolutionStatus !== "resolved") pending(target, field, "unresolved");
  }
  return target;
}
async function applyCandidate(
  target: InquiryAcceptedTarget,
  field: QuestionField,
  candidate: FieldCandidate,
  deps: InquiryAdmissionDependencies,
  previous?: ResolvedField,
): Promise<boolean> {
  if (field === "metrics" && candidate.metadata?.kind === "base_only") {
    const name = candidate.value,
      sourceMetricCode = candidate.metadata.source_metric_code;
    if (
      typeof name !== "string" ||
      !name ||
      typeof sourceMetricCode !== "string" ||
      !sourceMetricCode
    )
      return invalid("基础指标候选缺少正式目录身份。");
    const resolved = await deps.resolveMetric?.([name]);
    const value = resolved?.status === "resolved" ? entity(resolved.value) : undefined;
    if (value?.codes.length === 1) {
      merge(target, field, value);
      return true;
    }
    pending(target, field, "unresolved", [{ name, sourceMetricCode }]);
    return false;
  }
  const value =
    typeof candidate.code === "string" && candidate.code && typeof candidate.value === "string"
      ? { codes: [candidate.code], names: [candidate.value] }
      : entity(candidate.value);
  if (!value) return invalid("所选候选缺少可执行的正式目录身份。");
  merge(target, field, value);
  if (
    field === "metrics" &&
    candidate.metadata?.kind === "base" &&
    Array.isArray(previous?.metadata?.mentionResolutions)
  ) {
    const mentions = previous.metadata.mentionResolutions.map(object);
    const index = candidate.metadata.rawValueIndex,
      source = candidate.metadata.source_metric_code;
    const group = typeof index === "number" ? object(mentions[index]?.group).id : undefined;
    if (typeof group === "string" && typeof source === "string")
      for (const mention of mentions) {
        if (object(mention.group).id !== group || mention.status === "resolved") continue;
        const match = Array.isArray(mention.candidates)
          ? mention.candidates
              .map(object)
              .find((item) => object(item.metadata).source_metric_code === source)
          : undefined;
        if (!match || typeof match.code !== "string" || typeof match.value !== "string")
          return invalid("基础指标的原口径组缺少完整目录映射。");
        merge(target, field, { codes: [match.code], names: [match.value] });
      }
  }
  return true;
}

/** 只读取已发布的选择及原条件；结果由宿主写入现有请求关联，旧任务和执行状态保持只读。 */
export async function admitInquiryInput(
  input: InquiryAdmissionInput,
  deps: InquiryAdmissionDependencies,
): Promise<InquiryAdmission | undefined> {
  const legacy = input.clarification_target !== undefined || input.selected_answers !== undefined;
  if (
    Number(!!input.answers?.length) + Number(!!input.clarification_selection) + Number(legacy) >
    1
  )
    throw new QuestionAnswerError(
      "ANSWER_INPUT_SHAPE_INVALID",
      "同一请求只能使用一种结构化澄清格式。",
    );
  if (legacy) return admitBackendTask(input, deps);
  if (input.clarification_selection) return admitFrame(input.clarification_selection, deps);
  if (!input.answers?.length) return;
  if (input.answers.length > 20)
    throw new QuestionAnswerError("ANSWER_INPUT_SHAPE_INVALID", "一轮最多提交20条回答。");
  const store = deps.semanticTasks;
  if (!store) return unpublished();
  const output: InquiryAdmission = { targets: [], answerReceipts: [] };
  const groups = new Map<
    string,
    {
      target: InquiryAcceptedTarget;
      questions: SemanticQuestionView[];
      answered: Set<string>;
      resolved: Set<QuestionField>;
    }
  >();
  const answers = new Map<string, ClickAnswerInput>();
  for (const raw of [...(deps.priorAnswers ?? []), ...input.answers]) {
    let answer = normalizeAnswerInput(raw, { channel: "click", operation_id: deps.operationId });
    const view: SemanticQuestionView | undefined = await store.question(answer.question_id);
    if (!view) return unpublished();
    const task = await store.get(view.binding.taskRef);
    if (!task || task.owner !== deps.actorId || task.target.ref !== view.binding.targetRef)
      return unpublished();
    answer = normalizeAnswerChoiceForQuestion(answer, view.question, view.binding.reason);
    const previous = answers.get(answer.question_id);
    if (previous) {
      if (previous.version !== answer.version || !sameAnswerChoice(previous.choice, answer.choice))
        throw new QuestionAnswerError(
          "ANSWER_OPERATION_CONFLICT",
          "同一请求不能对同一道题提交不同选择。",
        );
      continue;
    }
    answers.set(answer.question_id, answer);
    validateAnswer(view.question, answer);
    if (
      view.question.issued_operation_id === deps.operationId ||
      !(await deps.questionPublicationProof?.(view.question))
    )
      return unpublished();
    const key = `${task.ref}/${task.target.ref}`;
    let group = groups.get(key);
    if (!group) {
      const target = fromFields(
        task.target.ref,
        { kind: "semantic", taskRef: task.ref },
        view.binding.sourceQuestion ?? task.originalMessage,
        task.target.fields,
      );
      group = {
        target,
        questions: await store.questionsForTask(task.ref),
        answered: new Set(),
        resolved: new Set(),
      };
      for (const field of fields)
        if (field in task.target.pending) pending(target, field, "unresolved");
      for (const related of group.questions)
        if (
          related.binding.targetRef === target.targetRef &&
          ["open", "rejected"].includes(related.question.status)
        )
          pending(target, related.question.scope.field, "unresolved");
      groups.set(key, group);
      output.targets.push(target);
    }
    const { target } = group,
      field = view.question.scope.field;
    group.answered.add(answer.question_id);
    if (answer.choice.type === "reject" || answer.choice.type === "none_of_these") {
      delete target[keyOf(field)];
      pending(target, field, "declined");
      output.answerReceipts.push({
        question_id: answer.question_id,
        version: answer.version,
        outcome: "declined",
        notice: "已拒绝该候选，尚未确定新的查询对象。",
      });
      continue;
    }
    const ids =
      answer.choice.type === "select"
        ? answer.choice.option_ids
        : view.question.kind === "confirm"
          ? [view.question.confirmation_option_id]
          : [];
    let resolved = true;
    if (view.binding.reason === "source_confirmation") {
      const value = entity(view.binding.sourceConfirmation?.organizationCondition);
      if (!value || field === "metrics") return invalid("来源确认缺少完整机构条件。");
      const current = entity(task.target.fields[field]?.resolvedValue);
      if (
        !current ||
        JSON.stringify([...current.codes].sort()) !== JSON.stringify([...value.codes].sort())
      )
        throw new QuestionAnswerError("QUESTION_SUPERSEDED", "来源确认对应的机构集合已变化。");
      delete target[keyOf(field)];
      merge(target, field, value);
      const scope = organizationScope(view.binding.sourceConfirmation?.organizationCondition);
      if (scope) (target[keyOf(field)] as ResolvedOrganizations).scope = scope;
    } else
      for (const id of ids) {
        const selected = view.binding.options.find((option) => option.option_id === id);
        if (!selected) return invalid("所选项没有服务端候选绑定。");
        if (
          !(await applyCandidate(
            target,
            field,
            selected.candidate,
            deps,
            task.target.fields[field],
          ))
        )
          resolved = false;
      }
    if (resolved) group.resolved.add(field);
    output.answerReceipts.push({
      question_id: answer.question_id,
      version: answer.version,
      outcome: "applied",
      selected_options: structuredClone(
        view.question.options.filter((option) => ids.includes(option.option_id)),
      ),
      notice: resolved ? "已按所选项确认查询条件。" : "已确认基础指标，具体口径仍需确定。",
    });
  }
  for (const group of groups.values())
    for (const field of group.resolved) {
      const unresolved = group.questions.some(
        (view) =>
          view.question.scope.field === field &&
          view.binding.targetRef === group.target.targetRef &&
          ["open", "rejected"].includes(view.question.status) &&
          !group.answered.has(view.question.question_id),
      );
      if (!unresolved)
        group.target.pending = group.target.pending.filter(
          (item) =>
            item.field !== field || item.reason === "declined" || item.selectedBases?.length,
        );
    }
  return structuredClone(output);
}

async function admitFrame(
  selection: NonNullable<InquiryAdmissionInput["clarification_selection"]>,
  deps: InquiryAdmissionDependencies,
): Promise<InquiryAdmission> {
  const frame = await deps.frames?.get(selection.frame_id),
    state = await deps.frames?.state();
  if (!frame || frame.sessionId !== deps.sessionId || !state || state.sessionId !== deps.sessionId)
    return unpublished();
  if (state.operations[frame.operationFrameId] !== frame.frameId || frame.status !== "clarifying")
    throw new QuestionAnswerError("QUESTION_SUPERSEDED", "旧澄清已不是该目标的当前快照。");
  if (frame.turnId === deps.operationId || !(await deps.framePublicationProof?.(frame)))
    return unpublished();
  const groups = clarificationOptions(frame, {
    metrics: "指标",
    organizations: "机构",
    comparison_organizations: "对比机构",
  });
  if (
    !selection.option_ids.length ||
    new Set(selection.option_ids).size !== selection.option_ids.length
  )
    return invalid("选择清单不能为空或重复。");
  const options = groups.flatMap((group) => group.options),
    selected = selection.option_ids.map((id) => options.find((option) => option.id === id));
  if (selected.some((option) => !option)) return invalid("选择包含未发布的选项。");
  const target = fromFields(
    frame.frameId,
    { kind: "frame", frameId: frame.frameId },
    "",
    frame.fields,
  );
  for (const field of fields)
    if (frame.issues.some((issue) => issue.field === field)) pending(target, field, "unresolved");
  const unresolved = new Set<QuestionField>();
  for (const group of groups) {
    const matches = selected.filter(
      (option) => option!.field === group.field && option!.item === group.item,
    );
    if (matches.length > 1) return invalid("同一待确认项只能选择一个候选。");
    const field = group.field as QuestionField;
    if (
      !matches.length ||
      !(await applyCandidate(target, field, matches[0]!.candidate, deps, frame.fields[field]))
    )
      unresolved.add(field);
  }
  const candidateFields = new Set(groups.map((group) => group.field));
  target.pending = target.pending.filter(
    (item) =>
      !candidateFields.has(item.field) || [...unresolved].some((field) => field === item.field),
  );
  return { targets: [target], answerReceipts: [] };
}

async function admitBackendTask(
  input: InquiryAdmissionInput,
  deps: InquiryAdmissionDependencies,
): Promise<InquiryAdmission> {
  const ref = input.clarification_target;
  if (!ref || !deps.getTask || !(await deps.taskPublicationProof?.(ref))) return unsupported();
  const task = await deps.getTask(ref.task_id);
  if (task.task_id !== ref.task_id) return unpublished();
  if (
    task.version !== ref.version ||
    task.status !== "WAITING_USER" ||
    task.clarification?.id !== ref.clarification_id
  )
    throw new QuestionAnswerError("QUESTION_SUPERSEDED", "旧澄清的任务版本或问题已变化。");
  const patch = object(input.selected_answers),
    set = object(patch.set);
  if (
    Object.keys(patch).some(
      (key) => !["set", "add_ops", "remove_ops", "text", "catalog_selection_mode"].includes(key),
    ) ||
    Object.keys(set).some((key) => !["metrics", "orgs"].includes(key)) ||
    [patch.add_ops, patch.remove_ops].some(
      (value) => value !== undefined && (!Array.isArray(value) || value.length),
    ) ||
    (patch.text !== undefined && patch.text !== "") ||
    (patch.catalog_selection_mode !== undefined && patch.catalog_selection_mode !== "append")
  )
    return unsupported();
  const clarification = task.clarification,
    understood = clarification.understood ?? {};
  const allowed = new Set(
    (Array.isArray(clarification.fields) ? clarification.fields : []).map(
      (field) => object(field).type,
    ),
  );
  if (clarification.missing?.includes("metrics")) allowed.add("metric");
  if (clarification.missing?.includes("orgs")) allowed.add("organization");
  const selectedMetrics = Array.isArray(set.metrics)
    ? set.metrics.map((item) => object(item).code)
    : [];
  const metrics =
    selectedMetrics.length &&
    selectedMetrics.every((code) => typeof code === "string" && code.trim())
      ? (selectedMetrics as string[])
      : [];
  const orgs = strings(set.orgs);
  if (
    (set.metrics !== undefined && (!metrics.length || !allowed.has("metric"))) ||
    (set.orgs !== undefined && (!orgs.length || !allowed.has("organization")))
  )
    return unsupported();
  const target: InquiryAcceptedTarget = {
    targetRef: task.task_id,
    source: { kind: "backend_task", taskId: task.task_id },
    sourceQuestion: task.resolved_question ?? "",
    pending: [],
  };
  for (const [field, values, resolve] of [
    ["metrics", metrics.length ? metrics : (understood.metrics ?? []), deps.resolveMetric],
    ["organizations", orgs.length ? orgs : (understood.orgs ?? []), deps.resolveOrganization],
  ] as const) {
    if (!values.length) {
      if (allowed.has(field === "metrics" ? "metric" : "organization"))
        pending(target, field, "unresolved");
      continue;
    }
    if (!resolve) return unsupported();
    const resolution = await resolve([...values]),
      value = resolution.status === "resolved" ? entity(resolution.value) : undefined;
    if (value) {
      if (
        field === "metrics" &&
        metrics.length &&
        (value.codes.length !== new Set(metrics).size ||
          metrics.some((code) => !value.codes.includes(code)))
      )
        return invalid("目录解析结果与明确选择的指标编码不一致。");
      merge(target, field, value);
    } else pending(target, field, "unresolved");
  }
  if (understood.time) {
    if (!deps.resolveDate) return unsupported();
    const resolution = await deps.resolveDate(understood.time),
      resolved = resolution.status === "resolved" ? time(resolution.value) : undefined;
    if (resolved) target.time = resolved;
    else pending(target, "time", "unresolved");
  }
  return { targets: [target], answerReceipts: [] };
}
