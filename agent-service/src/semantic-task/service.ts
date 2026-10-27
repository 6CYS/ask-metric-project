import {organizationScopeInput} from "../business-context/organizationScope.js";
import {candidateOptions, candidateOptionGroups, displayedCandidates, preferredOption} from "./candidateOptions.js";
import {createHash} from "node:crypto";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {metricMentions} from "../business-context/metricMentions.js";
import {orgCatalog, organizationValues} from "../business-context/orgCatalog.js";
import {hasInputEvidence, normalizeInputEvidence} from "../business-context/inputEvidence.js";
import {type TurnFacts, bindFieldOperations, hasCollectionIntent, entityIsGrounded, inspectTurn, resolveTurnField, updateCollection} from "./actionBinding.js";
import {isCalendarDate} from "../tools/shared.js";
import {validateFrame} from "../business-context/core.js";
import {completeRankingOperation, normalizeQueryOperation} from "../business-context/rankingEvidence.js";
import {createCapabilities} from "../business-context/capabilities.js";
import type {BusinessFrame, FieldCandidate, FieldResolution, ResolvedField} from "../business-context/types.js";
import type {ModelCalendar, SemanticOperation, SemanticRequest, SemanticSource} from "./protocol.js";
import {bindAnswerInputs} from "./questions.js";
import {backendIssue} from "./backendIssue.js";
import {resolveEnhancedAnalysis} from "./enhancedAnalysis.js";
import {BusinessInputError} from "../business-context/inputError.js";
import {assertRecoveredQueryConditions, frozenQueryScope} from "./queryRecovery.js";
import {operationLabel} from "./structuredQuery.js";
import {applyMetricDefaultContext} from "../business-context/metricDefaults.js";
import {analysisCandidates} from "../analysis/bindings.js";
import {semanticRef, type SemanticAnswerApplication, type SemanticAnswerSnapshot, type SemanticIssue,
  type SemanticQuestionIssue, type SemanticTarget, type SemanticTask, type SemanticTurn} from "./store.js";

type EntityValue = {codes: string[]; names: string[]};
const entityValue = (field?: ResolvedField): EntityValue => field?.resolvedValue as EntityValue ?? {codes: [], names: []};
const resolved = (rawValue: string, resolvedValue: unknown, resolver: string): ResolvedField => ({rawValue, resolvedValue, resolver, resolutionStatus: "resolved", source: "explicit"});
const sourceKey = (source: SemanticSource) => JSON.stringify(source);
export const snapshotDigest = (target: SemanticTarget) => createHash("sha256").update(JSON.stringify(target.fields)).digest("hex");
const issue = (code: string, field: string, message: string, remediation: SemanticIssue["remediation"] = "pi", category = "semantic"): SemanticIssue => ({code, field, message, remediation, category});
export class SemanticConflict extends Error {constructor(readonly issue: SemanticIssue) {super(issue.code);}}
function conflict(code: string, message: string): never {throw new SemanticConflict(issue(code, "objective", message, "pi", "reference"));}
const emptyTarget = (): SemanticTarget => ({ref: semanticRef(), fields: {}, pending: {}, status: "draft"});
/** 区间取数方式待补时的统一追问：只问全部已有记录还是最新一期，不默认最新，也不擅自改月末采样。 */
export const SELECTION_PENDING_QUESTION = "需要确定取数方式：区间内全部已有记录，还是最新一期？";
const joinValues = (a: EntityValue, b: EntityValue): EntityValue => {
  const entries = new Map(a.codes.map((code, i) => [code, a.names[i]!]));
  b.codes.forEach((code, i) => entries.set(code, b.names[i]!));
  return {codes: [...entries.keys()], names: [...entries.values()]};
};
function checkedEntity(value: unknown): value is EntityValue {
  const result = value as EntityValue | undefined;
  return !!result && Array.isArray(result.codes) && result.codes.length > 0 && result.codes.every(code => typeof code === "string" && code)
    && Array.isArray(result.names) && result.names.length === result.codes.length && result.names.every(name => typeof name === "string" && name);
}
const splitNames = (text: string) => text.split(/\s*(?:、|，|,|以及|和|与|及)\s*/u).filter(Boolean);
const spanKey = (span: {text: string; start: number; end: number}) => JSON.stringify([span.start, span.end, span.text]);
export function candidateOrdinal(clause: string): {field?: string; index: number} | undefined {
  const matched = /^(?:(指标|机构|日期)(?:选|用|就用)?|选|用|就用|是)?第?([一二两三四五六七八九十\d]+)(?:个|项|号)(?:候选)?[！!。\s]*$/u.exec(clause.trim());
  if (!matched) return;
  // 日期语境里的数字不是选择序号（如“日期改成2026年4月30日”“是10月3号”）；完整日期表达本来也不匹配
  // 上面的序数句型，这里只排除带年/月的语境。“日期用第二项”这类指题序号不含年/月，不受影响。
  if (/[年月]/u.test(clause)) return;
  const digits: Record<string, number> = {一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10};
  const index = /^\d+$/u.test(matched[2]!) ? Number(matched[2]) : digits[matched[2]!];
  return index ? {index: index - 1, ...(matched[1] ? {field: matched[1] === "指标" ? "metrics" : matched[1] === "机构" ? "organizations" : "time"} : {})} : undefined;
}
export async function selectSavedCandidates(target: SemanticTarget, field: string, turn: SemanticTurn, request: AskMetricRequestContext): Promise<FieldCandidate[]> {
  const previous = target.fields[field], candidates = previous?.candidates ?? [];
  if (!previous || previous.resolutionStatus === "resolved" || !candidates.length) throw new SemanticConflict(issue("CONFIRMATION_NOT_AVAILABLE", field,
    "该字段没有待选择的候选，不能confirm。已确认条件继续查询时使用query并沿用source，不重写未变化字段；只有真实未决候选才需要用户选择。"));
  const clauses = turn.originalMessage.split(/[，,。；;]|但是|不过|而是|但/u);
  const catalog = field === "organizations" || field === "comparison_organizations"
    ? typeof request.backend.orgCatalog === "function" ? await orgCatalog(request) : undefined : undefined;
  // 只用真实用户原句选择已保存候选，模型填写的确认文本不能建立选择事实。
  const acceptable = candidates.filter((candidate, candidateIndex) => {
    if (typeof candidate.value !== "string") return false;
    const calendar = field === "time" && candidate.metadata?.calendar;
    const label = calendar ? candidate.value.split(/[（(]/u)[0]!.trim() : undefined;
    const uniqueLabel = label && candidates.filter(item => typeof item.value === "string" && item.value.split(/[（(]/u)[0]!.trim() === label).length === 1;
    return clauses.some(clause => {
      if (/(?:不(?:要|用|选|是|需要)|别(?:用|选)|取消)/u.test(clause)
        || field === "time" && /^\s*(?:指标|机构)(?:选|用|就用|改|为|是)/u.test(clause)) return false;
      if (uniqueLabel && hasInputEvidence(clause, label!)) return true;
      const reply = normalizeInputEvidence(clause);
      const hits = candidates.flatMap((option, index) => {
        const member = catalog?.items.find(item => item.code === option.code);
        const terms = [typeof option.value === "string" ? option.value : "", ...(member ? [member.name, ...member.aliases] : [])];
        return [...new Set(terms.map(normalizeInputEvidence).filter(Boolean))].flatMap(term => {
          const positions: Array<{index: number; group: unknown; start: number; end: number}> = [];
          for (let start = reply.indexOf(term); start >= 0; start = reply.indexOf(term, start + 1)) {
            positions.push({index, group: option.metadata?.rawValueIndex ?? 0, start, end: start + term.length});
          }
          return positions;
        });
      });
      // 同槽位的重叠名称取最长且唯一的身份；显式提及的互不重叠多家仍全部保留。
      return hits.some(hit => hit.index === candidateIndex && !hits.some(other => other.index !== hit.index && other.group === hit.group
        && other.start <= hit.start && other.end >= hit.end));
    });
  });
  const pending = Object.entries(target.fields).filter(([, value]) => value.resolutionStatus !== "resolved" && value.candidates?.length).map(([name]) => name);
  const ordinal = clauses.map(candidateOrdinal).find(choice => choice && (choice.field === field || !choice.field && pending.length === 1));
  const accepts = pending.length === 1 && clauses.some(clause => /^(?:好(?:的)?|是(?:的)?|可以|确认|同意|就按你说的)[！!。\s]*$/u.test(clause.trim()));
  // 首推确认的“是”：恰有一个首选候选（后端或模型建议通道标记）时视为确认首选，与确认式话术一致。
  const preferred = candidates.filter(candidate => candidate.preferred === true);
  // 序号按本轮实际展示的收敛清单解释（最多 DISPLAYED_CANDIDATE_LIMIT 项）；未展示项不能借序号选中，
  // 但完整合法名称走上面的名称命中，与是否展示无关。
  const numbered = ordinal ? candidateOptions(displayedCandidates(candidates), field).find(option => option.no === ordinal.index + 1)?.candidate : undefined;
  // “当日数”等裸口径短语限定在本题已保存候选（同一基础指标范围）内唯一命中时才成立。
  const basis = !numbered && !acceptable.length ? clauses.flatMap(clause => {
    if (/(?:不(?:要|用|选|是|需要)|别(?:用|选)|取消)/u.test(clause)) return [];
    const phrase = clause.trim().replace(/^(?:口径)?(?:改成|改为|换成|就用|用|选|是)/u, "").replace(/[！!。\s]+$/u, "");
    if (!phrase || phrase.length > 8) return [];
    return candidates.filter(candidate => candidate.metadata?.value_basis === phrase
      || typeof candidate.value === "string" && phrase.length >= 2 && candidate.value !== phrase && candidate.value.endsWith(phrase));
  }) : [];
  const basisSelected = [...new Set(basis)].length === 1 ? [basis[0]!] : [];
  const selected = numbered ? [numbered] : acceptable.length ? acceptable
    : basisSelected.length ? basisSelected
    : accepts && (candidates.length === 1 || preferred.length === 1) ? (candidates.length === 1 ? candidates : preferred) : [];
  if (!previous || !["needs_confirmation", "ambiguous", "not_found"].includes(previous.resolutionStatus) || !selected.length
    || previous.metadata?.proposalTurn === turn.operationId) throw new SemanticConflict(issue("CONFIRMATION_NOT_ESTABLISHED", field,
    "请明确选择已保存候选；其它字段中的数字和否定表述不能确认此项。", "user", "catalog"));
  return selected;
}
export function explicitOrganizationCount(question: string): number | undefined {
  const matched = [...question.matchAll(/(?:以上|上述|这|共)?([一二两三四五六七八九十\d]+)家/gu)]
    .find(item => !/[第前后]$/u.test(question.slice(0, item.index)));
  const raw = matched?.[1];
  if (!raw) return;
  if (/^\d+$/u.test(raw)) return Number(raw);
  const digits: Record<string, number> = {一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
  if (raw === "十") return 10;
  if (raw.includes("十")) {const [a, b] = raw.split("十"); return (a ? digits[a]! : 1) * 10 + (b ? digits[b]! : 0);}
  return digits[raw];
}

/** Pi 提议语义，宿主绑定目录及原始义务；这里不调用另一个模型理解原句。 */
export class SemanticTaskService {
  private boundFacts: TurnFacts | undefined;
  private boundCalendar: ModelCalendar | undefined;
  constructor(private readonly request: AskMetricRequestContext, private readonly signal?: AbortSignal) {}
  private get store() {if (!this.request.semanticTasks) throw new Error("SEMANTIC_STORE_NOT_BOUND"); return this.request.semanticTasks;}
  async resolve(input: SemanticRequest): Promise<{task?: SemanticTask; status: string; issues?: SemanticIssue[]}> {
    const boundAnswers = this.request.semanticStep ? {answers: [], discarded: []}
      : bindAnswerInputs(input.answers ?? [], this.request.trustedAnswers ?? [], this.request.operationId, this.request.originalMessage);
    const turn = await this.store.admit(this.request.operationId, this.request.originalMessage, undefined, undefined,
      this.request.semanticStep ? undefined : {actorId: this.request.actor.id, answers: boundAnswers.answers,
        discardedAnswers: boundAnswers.discarded, ...(this.request.questionPublicationProof
          ? {publicationProof: this.request.questionPublicationProof} : {})});
    if (input.targets.length !== 1 || !["query", "prepare", "reuse"].includes(input.intent)) {
      return {status: "unsupported", issues: [issue("SEMANTIC_CAPABILITY_NOT_ENABLED", "objective",
        "当前候选入口已实现精确查询、条件准备和结果重显；复合目标及分析计算仍待下一阶段接入。原始目标已保存，未执行部分查询。", "stop", "capability")]};
    }
    const proposal = input.targets[0]!;
    if (input.intent === "reuse" && proposal.operations.length) return {status: "needs_interpretation", issues: [issue("REUSE_WITH_CHANGES", "objective", "重显结果不能同时更改条件；按原目标修正本次提案。") ]};
    let task: SemanticTask;
    try {task = await this.bind(turn, proposal.source);} catch (error) {
      if (error instanceof SemanticConflict) return {status: "conflict", issues: [error.issue]};
      throw error;
    }
    if (this.request.semanticStep) {task.parentPlan = this.request.semanticStep.planRef;
      task.capability = this.request.semanticStep.kind === "availability" ? "data_availability" : "metric_query";}
    const answerSnapshots = (this.request.semanticAnswers ?? turn.answerSnapshots ?? []).map(snapshot => this.request.semanticStep
      ? {...snapshot, binding: {...snapshot.binding, planRef: this.request.semanticStep!.planRef, targetRef: task.target.ref, taskRef: task.ref}}
      : snapshot);
    if (answerSnapshots.some(snapshot => snapshot.binding.reason !== "candidate_choice"
      || !this.request.semanticStep && snapshot.binding.taskRef !== task.ref)) {
      throw new SemanticConflict(issue("ANSWER_TARGET_AMBIGUOUS", "objective", "回答不能唯一绑定当前任务。", "pi", "reference"));
    }
    if (input.intent === "reuse") return {task, status: task.target.status === "succeeded" ? "reused" : "needs_user"};
    if (proposal.operations.some(op => op.field === "_analysis")) {
      return resolveEnhancedAnalysis(this.request, task, turn, proposal.operations, this.signal);
    }
    if (task.permit?.consumed && task.permit.operationId === turn.operationId) return {task, status: task.target.status === "succeeded" ? "succeeded" : task.target.status === "failed" ? "failed" : "unknown"};
    if (["executing", "unknown"].includes(task.target.status)) return {task, status: "unknown"};
    const facts = this.request.semanticStep?.facts ?? (typeof this.request.backend.inspectBusinessGoal === "function"
      ? await inspectTurn(this.request, turn.originalMessage, turn.businessDate, this.request.semanticStep?.referenceYear, this.signal) : undefined);
    this.boundFacts = facts;
    const binding = bindFieldOperations(proposal.operations, facts, turn.baseline!.fields, {joint: this.request.semanticStep?.multipleTargets, analysis: this.request.semanticStep?.analysis, ...(this.request.timeOverride ? {calendar: this.request.timeOverride} : {}),
      answered: new Set(answerSnapshots.map(snapshot => snapshot.question.scope.field))});
    proposal.operations = binding.operations; this.boundCalendar = binding.calendar;
    // 只有“选择/接受”会改写字段；reject/none_of_these 由 applyDeclinedAnswers 处理。
    // 非选择回答不能进入字段集合，否则同一轮后续重复受理（如工具重放）会用空
    // operations 覆盖已记录的字段操作，导致已解析的机构被误判为遗漏。
    const answerFields = new Set(answerSnapshots.filter(snapshot => ["select", "accept"].includes(snapshot.answer.choice.type))
      .map(snapshot => snapshot.question.scope.field));
    // 纠错只替换本字段提案；其它有效值和未决新值均不能因省略而丢失。
    for (const field of new Set([...proposal.operations.map(operation => operation.field), ...answerFields])) {
      const operations = proposal.operations.filter(operation => operation.field === field);
      if (operations.length) turn.operations[field] = operations; else delete turn.operations[field];
    }
    await this.groundExplicitMetricBasis(turn);
    const answerCandidates = new Map<SemanticOperation, FieldCandidate[]>();
    const answerOperations = new Map<SemanticOperation, SemanticAnswerSnapshot[]>();
    for (const field of answerFields) {
      const snapshots = answerSnapshots.filter(snapshot => snapshot.question.scope.field === field);
      const operations = turn.operations[field] ?? [];
      if (snapshots.length && operations.some(operation => operation.action === "confirm")) {
        throw new SemanticConflict(issue("ANSWER_OPERATION_CONFLICT", field, "已提供结构化 Answer，请删除同字段冗余 confirm。", "pi", "input_shape"));
      }
      const fresh = snapshots.filter(snapshot => !snapshot.existingReceipt && ["select", "accept"].includes(snapshot.answer.choice.type));
      if (fresh.length && operations.length) {
        throw new SemanticConflict(issue("ANSWER_OPERATION_CONFLICT", field, "选择候选与同字段修改不能在同一提案中隐式覆盖。", "pi", "input_shape"));
      }
      if (!fresh.length) continue;
      const selected = fresh.flatMap(snapshot => {
        const ids = snapshot.answer.choice.type === "select" ? snapshot.answer.choice.option_ids
          : snapshot.question.kind === "confirm" ? [snapshot.question.confirmation_option_id] : [];
        return ids.map(id => {
          const option = snapshot.binding.options.find(binding => binding.option_id === id);
          if (!option) throw new SemanticConflict(issue("ANSWER_OPTION_INVALID", field, "回答选项不在冻结绑定中。", "pi", "input_shape"));
          return structuredClone(option.candidate);
        });
      });
      const operation: SemanticOperation = {action: "confirm", field, value: "已发布问题选择"};
      turn.operations[field] = [operation];
      answerCandidates.set(operation, selected);
      answerOperations.set(operation, fresh);
    }
    const publishedFields = new Set<string>();
    if (this.request.questionPublicationProof) {
      const published = task.questionSnapshots?.length ? task.questionSnapshots.map(question => ({question})) : await this.store.questionsForTask(task.ref);
      for (const view of published) {
        if (view.question.status === "open" && await this.request.questionPublicationProof(view.question)) publishedFields.add(view.question.scope.field);
      }
    }
    const target = structuredClone(turn.baseline!);
    const priorMetricSource = turn.baseline?.metricSource;
    if (turn.operations.metrics) target.metricSource = priorMetricSource ? priorMetricSource + "\n" + turn.originalMessage : turn.originalMessage;
    for (const field of Object.values(target.fields)) field.source = "inherited";
    target.ref = semanticRef();
    target.status = "draft";
    const baseFrameId = turn.baseline?.frameId ?? turn.baseline?.baseFrameId;
    if (baseFrameId) target.baseFrameId = baseFrameId; else delete target.baseFrameId;
    delete target.frameId;
    task.issues = [];
    const appliedAnswers = new Set<string>();
    for (const operations of Object.values(turn.operations)) {
      const field = operations[0]!.field;
      const cached = task.target.fields[field];
      if (cached?.resolutionStatus === "resolved" && !task.target.pending[field]
        && cached.metadata?.semanticTurn === turn.operationId && cached.metadata?.semanticOperations === JSON.stringify(operations)) {
        target.fields[field] = structuredClone(cached);
        if (field === "availability") {
          // 一个语义字段编译出多个执行字段；修复其它字段时须复用整份规范结果，不能只保留入口字段。
          for (const derived of ["dimension", "match", "page", "page_size"]) {
            const value = task.target.fields[derived];
            if (value) target.fields[derived] = structuredClone(value);
          }
        }
        delete target.pending[field];
        continue;
      }
      if (operations.filter(operation => operation.action === "set" || operation.action === "clear").length > 1) {
        target.pending[field] = `同一目标的${field}只能有一次set或clear。多个成员请用一次set，value写完整业务清单；修正本字段operations后重提，不能重复冲突动作。`;
        task.issues.push(issue("CONFLICTING_OPERATIONS", field, target.pending[field]!));
        continue;
      }
      for (const [operationIndex, operation] of operations.entries()) {
        const operationBaseline = target.fields[field] ? structuredClone(target.fields[field]) : undefined;
        try {
          await this.apply(target, operation, turn, answerCandidates.get(operation), publishedFields);
          for (const snapshot of answerOperations.get(operation) ?? []) appliedAnswers.add(snapshot.answer.question_id);
          const normalized = target.fields[field];
          if (normalized) normalized.metadata = {...normalized.metadata,
            semanticTurn: turn.operationId, semanticOperations: JSON.stringify(operations)};
          if (!target.pending[field]) delete target.pendingChanges?.[field];
        }
        catch (error) {
          const diagnostic = error instanceof SemanticConflict ? error.issue : backendIssue(error, field);
          const attempted = target.fields[field];
          if (diagnostic.code === "ENTITY_NOT_DETERMINED" && attempted?.candidates?.length) {
            // 所选基础身份已被正式解析器接纳，但产生下一层口径候选；本题记为已应用，新题继续待答。
            for (const snapshot of answerOperations.get(operation) ?? []) appliedAnswers.add(snapshot.answer.question_id);
          }
          target.pending[field] = attempted?.metadata?.proposalTurn === turn.operationId && typeof attempted.rawValue === "string"
            ? attempted.rawValue : "value" in operation ? operation.value : "subject" in operation ? operation.subject : "待清除";
          if (operation.action !== "confirm" || !target.pendingChanges?.[field]) {
            (target.pendingChanges ??= {})[field] = {operations: structuredClone(operations.slice(operationIndex)),
              ...(operationBaseline ? {baseline: operationBaseline} : {}), sourceMessage: turn.originalMessage};
          }
          // 无来源的模型复述没有获准成为用户变更；Pi按回执省略该字段即可恢复冻结基线。
          // 重置以冻结基线为唯一依据：基线存在时连同待答槽位、已确认待恢复变更一并回到基线；
          // 无基线时只丢弃本轮失败提案本身，不能清空已保存字段、候选或其他待答题。
          if (diagnostic.code === "CONFIRMATION_NOT_AVAILABLE") {
            delete turn.operations[field];
            if (turn.baseline?.fields[field]) {
              target.fields[field] = structuredClone(turn.baseline.fields[field]!);
              if (turn.baseline.pending[field] === undefined) delete target.pending[field]; else target.pending[field] = turn.baseline.pending[field];
              if (turn.baseline.pendingChanges?.[field]) (target.pendingChanges ??= {})[field] = structuredClone(turn.baseline.pendingChanges[field]);
              else delete target.pendingChanges?.[field];
            } else if (!turn.baseline?.pendingChanges?.[field]) {
              delete target.pendingChanges?.[field];
            }
          }
          task.issues.push(diagnostic);
          // 本字段后续变更等当前未决项确认后顺序恢复，不能覆盖失败槽位或遗失已完成修改。
          break;
        }
      }
    }
    if (task.issues.some(item => item.category === "permission")) {
      task = {...task, revision: task.revision + 1, target: {...target, status: "blocked"}, status: "stopped", completion: "unmet"};
      delete task.permit;
      await this.store.save(task, (await this.store.index()).version, turn);
      return {task, status: "denied"};
    }
    const structuredOperation = target.fields.operation?.metadata?.modelOperation as import("./protocol.js").StructuredOperation | undefined;
    if (structuredOperation?.kind === "sort" && target.fields.organizations?.resolutionStatus === "resolved") {
      const count = entityValue(target.fields.organizations).codes.length;
      if (count >= 1 && count <= 100) {
        target.fields.operation!.resolvedValue = {kind: "ranking", position: structuredOperation.direction === "descending" ? "top" : "bottom", top_n: count};
        target.fields.operation!.resolutionStatus = "resolved";
      } else {
        task.issues.push(issue("RANKING_SCOPE_TOO_LARGE", "operation", "当前排序最多支持100家机构，请缩小排序范围。", "stop", "capability"));
      }
    } else if (structuredOperation?.kind === "ranking" && (structuredOperation.position === null || structuredOperation.top_n === null)) {
      const missing = [structuredOperation.position === null ? "查看前几名还是后几名" : "", structuredOperation.top_n === null ? "需要几名" : ""].filter(Boolean);
      target.pending.operation = `请补充${missing.join("，以及")}。`;
      task.issues.push(issue("RANKING_NOT_DETERMINED", "operation", target.pending.operation, "user"));
    }
    if (this.request.semanticStep?.kind === "query" && !target.fields.operation?.metadata?.structuredQuery
      && (turn.operations.operation || turn.baseline?.fields.operation?.resolutionStatus !== "resolved")) {
      const description = turn.operations.operation?.find(op => "value" in op);
      let ranking = await normalizeQueryOperation({originalMessage: description && "value" in description
        ? description.value : turn.originalMessage, currentDate: turn.businessDate, turnId: turn.operationId,
        resolveCatalog: async () => ({status: "invalid"}), resolveMetricMentions: question => metricMentions(this.request, question)},
        target.fields.operation?.metadata?.allMembersRanking ? {count: entityValue(target.fields.organizations).codes.length, direction: target.fields.operation.metadata.allMembersRanking as "ascending" | "descending"} : undefined);
      if (ranking.status !== "resolved" && description && "value" in description) {
        // 无TopN的明确排序覆盖完整已选集合；原句与提案必须独立得到同一方向，不能只信模型措辞。
        const count = entityValue(target.fields.organizations).codes.length;
        const context = {currentDate: turn.businessDate, turnId: turn.operationId, resolveCatalog: async () => ({status: "invalid" as const}), resolveMetricMentions: (question?: string) => metricMentions(this.request, question)};
        const actual = await normalizeQueryOperation({...context, originalMessage: turn.originalMessage}, {count});
        const proposed = await normalizeQueryOperation({...context, originalMessage: description.value}, {count});
        if (actual.status === "resolved" && proposed.status === "resolved" && (actual.value as {kind?: string})?.kind === "ranking"
          && JSON.stringify(actual.value) === JSON.stringify(proposed.value)) ranking = actual;
      }
      if (ranking.status === "resolved") {
        target.fields.operation = {...resolved(typeof description?.value === "string" ? description.value : "查询操作", ranking.value, "query_operation"), source: "resolved", ...(target.fields.operation?.metadata ? {metadata: target.fields.operation.metadata} : {})};
        delete target.pending.operation;
        // 原句事实已独立规范化此字段，不能同时保留早先动作不兼容的过期错误，制造已解决但仍待修的状态。
        task.issues = task.issues.filter(item => item.field !== "operation" || !["RANKING_NOT_DETERMINED"].includes(item.code));
        delete target.pendingChanges?.operation;
      }
      else {target.pending.operation = "请明确榜单的前后方向和条数，或关注对象位次"; task.issues.push(issue("RANKING_NOT_DETERMINED", "operation", target.pending.operation, "user"));}
    }
    const operationKind = (target.fields.operation?.resolvedValue as {kind?: string} | undefined)?.kind;
    if (target.fields.organizations?.metadata?.resultSelection && !turn.operations.operation) {
      target.pending.operation = "选择原结果成员后，请显式说明本轮是普通取值还是重新排序；普通取值用operation:set的value=普通取值。";
      task.issues.push(issue("RESULT_SELECTION_OPERATION_REQUIRED", "operation", target.pending.operation, "pi"));
    }
    // 同一榜单拆成逐机构目标会破坏排名总体：多步骤并列时排名范围仍须覆盖原句锚定的完整机构集合。
    if (this.request.semanticStep?.multipleTargets && (operationKind === "ranking" || operationKind === "rank_position")) {
      const scopeField = operationKind === "rank_position" ? "comparison_organizations" : "organizations";
      const anchored = target.fields[scopeField]?.metadata?.source_codes;
      if (Array.isArray(anchored) && anchored.length && anchored.every(code => typeof code === "string")
        && anchored.some(code => !entityValue(target.fields[scopeField]).codes.includes(code))) {
        target.pending[scopeField] = "同一榜单须保留完整比较总体，不能拆成逐机构目标";
        task.issues.push(issue("GOAL_OBLIGATION_UNCOVERED", scopeField,
          "同一榜单须保留完整比较总体：请把完整机构集合放在同一排名目标内，不能拆成逐机构目标。"));
      }
    }
    if (this.request.semanticStep?.kind === "query" && target.fields.operation?.resolutionStatus === "resolved" && operationKind !== "rank_position") {
      const organizations = target.fields.organizations, metadata = organizations?.metadata;
      const anchored = metadata?.source_codes;
      if (Array.isArray(anchored) && anchored.length && anchored.every(code => typeof code === "string")
        && turn.operations.comparison_organizations && turn.operations.organizations?.every(operation => operation.action === "set")
        && (metadata?.semanticTurn === turn.operationId || metadata?.proposalTurn === turn.operationId)) {
        const exact = await resolveTurnField(this.request, "organization", anchored as string[], {signal: this.signal});
        if (exact.status === "resolved" && checkedEntity(exact.value) && exact.value.codes.length === anchored.length) {
          target.fields.organizations = {...resolved(exact.value.names.join("、"), exact.value, "organization"), source: "resolved", metadata: {...metadata, source_codes: anchored}};
          delete target.pending.organizations; task.issues = task.issues.filter(item => item.field !== "organizations");
        }
      }
      // 比较总体只属于对象位次。原值/榜单的完整机构已由原句事实绑定，口径误放到此字段不能变成用户缺项。
      if (target.fields.organizations?.resolutionStatus === "resolved") {
        delete target.fields.comparison_organizations; delete target.pending.comparison_organizations;
        task.issues = task.issues.filter(item => item.field !== "comparison_organizations");
      }
    }
    const quantity = this.request.semanticStep && (operationKind === "ranking" || this.request.semanticStep.multipleTargets && operationKind !== "rank_position")
      ? undefined : explicitOrganizationCount(turn.originalMessage);
    const quantityField = operationKind === "rank_position" && this.request.semanticStep ? "comparison_organizations" : "organizations";
    if (this.request.semanticStep && quantity !== undefined && entityValue(target.fields[quantityField]).codes.length !== quantity) {
      const anchored = target.fields[quantityField]?.metadata?.source_codes ?? target.fields.organizations?.metadata?.source_codes;
      if (Array.isArray(anchored) && anchored.length === quantity && anchored.every(code => typeof code === "string")
        && (quantityField !== "comparison_organizations" || entityValue(target.fields.organizations).codes.every(code => anchored.includes(code)))) {
        const exact = await resolveTurnField(this.request, "organization", anchored as string[], {signal: this.signal});
        if (exact.status === "resolved" && checkedEntity(exact.value) && exact.value.codes.length === quantity) {
          target.fields[quantityField] = {...resolved(exact.value.names.join("、"), exact.value, "organization"), source: "resolved", metadata: {source_codes: anchored}};
          delete target.pending[quantityField]; task.issues = task.issues.filter(item => item.field !== quantityField);
        }
      }
    }
    if (quantity !== undefined && target.fields[quantityField]?.resolutionStatus === "resolved"
      && entityValue(target.fields[quantityField]).codes.length !== quantity) {
      target.pending[quantityField] = `本轮明确要求${quantity}家，已绑定集合数量不符`;
      task.issues.push(issue("ORGANIZATION_COUNT_CONFLICT", quantityField, target.pending[quantityField], "user", "coverage"));
    }
    const availability = this.request.semanticStep?.kind === "availability";
    const required = availability ? ["organizations", "availability"] : ["organizations", "metrics", "time"];
    if (operationKind === "rank_position") required.push("comparison_organizations");
    for (const field of required) {
      if (!target.fields[field] || target.fields[field]!.resolutionStatus !== "resolved"
        || ["organizations", "comparison_organizations", "metrics"].includes(field) && !entityValue(target.fields[field]).codes.length) {
        target.pending[field] ??= typeof target.fields[field]?.rawValue === "string" ? target.fields[field]!.rawValue as string : "尚未确定";
        if (!task.issues.some(item => item.field === field)) {
          const name = ({organizations: "机构", metrics: "指标", time: "日期范围", comparison_organizations: "位次比较总体", availability: "要发现的指标或日期"} as Record<string,string>)[field];
          task.issues.push(issue("FIELD_REQUIRED", field, `请补充或确定${name}。`, "user"));
        }
      }
    }
    if (!availability && target.fields.time?.resolutionStatus !== "resolved"
      && task.issues.some(item => item.field === "time" && item.remediation === "user")) {
      // 取数方式依赖已确定日历。真实日期缺失时先澄清日期，不能让模型误填的指标口径驱动无意义修复。
      const deferred = new Set(["SELECTION_NOT_INTERPRETED", "SELECTION_SOURCE_NOT_ESTABLISHED"]);
      if (task.issues.some(item => item.field === "selection" && deferred.has(item.code))) {
        task.issues = task.issues.filter(item => item.field !== "selection" || !deferred.has(item.code));
        delete target.pending.selection;
      }
    }
    const time = target.fields.time?.resolvedValue as {start?: string; end?: string; dates?: string[]} | undefined;
    const completeCalendar = !!time && typeof time.start === "string" && typeof time.end === "string"
      && isCalendarDate(time.start) && isCalendarDate(time.end) && time.start <= time.end;
    if (!availability && target.fields.time?.resolutionStatus === "resolved" && !completeCalendar) {
      target.pending.time = "已保存时间策略尚未编译为当前查询所需的完整日历";
      task.issues.push(issue("TASK_TIME_MATERIALIZATION_REQUIRED", "time",
        "日期策略与当前执行能力不兼容；保留机构、指标和原时间口径，以analysis.actions重新编译本轮目标，不让用户重填日期。", "pi", "input_shape"));
    }
    if (!availability && completeCalendar && target.fields.time?.resolutionStatus === "resolved" && (time?.start === time?.end && !time?.dates || time?.dates && (!target.fields.selection || target.pending.selection))) {
      target.fields.selection = {...resolved("指定日期", "exact", "enum"), source: "resolved"};
      delete target.pending.selection;
      delete target.pendingChanges?.selection;
      task.issues = task.issues.filter(item => item.field !== "selection");
    }
    const selection = target.fields.selection?.resolvedValue;
    if (!availability && target.fields.time?.resolutionStatus === "resolved" && (!selection || selection === "exact" && time?.start !== time?.end && !time?.dates)) {
      target.pending.selection = SELECTION_PENDING_QUESTION;
      if (!task.issues.some(item => item.field === "selection")) task.issues.push(issue("TIME_SELECTION_REQUIRED", "selection", SELECTION_PENDING_QUESTION, "user"));
    }
    target.fields.operation ??= {...resolved("查询指标值", {kind: "value"}, "query_operation"), source: "resolved"};
    let originalMetrics: Awaited<ReturnType<typeof metricMentions>> = {mentions: []};
    try {originalMetrics = await metricMentions(this.request);} catch (error) {
      if (!(error instanceof BackendApiError) || ![401, 403].includes(error.status)) throw error;
      task.issues.push(issue("PERMISSION_DENIED", "metrics", "当前身份无权核验指标来源，未执行查询。", "stop", "permission"));
    }
    const chars = Array.from(turn.originalMessage);
    const operationText = chars.map((character, index) => originalMetrics.mentions.some(mention => index >= mention.start && index < mention.end) ? " " : character).join("");
    if (!this.request.semanticStep && /排名|位次|(?:前|后)[一二三四五六七八九十\d]+(?:名|家)|对比|比较|求和|合计|平均|均值|差多少|差值|相加|计算|归因|预测|分析/u.test(operationText)) {
      target.pending.operation = "比较、排名、计算或分析目标尚未接入当前候选执行器";
      task.issues.push(issue("OPERATION_NOT_ENABLED", "operation", "原始问题包含当前阶段未接入的操作，不能降级成普通取值。", "stop", "capability"));
    }
    if (!availability && (operationKind === "ranking" || operationKind === "rank_position") && (selection === "all_in_range" || time?.dates)) {
      target.pending.selection = "保留原日期及排名操作，转通用分析逐期排名";
      task.issues.push(issue("QUERY_RANGE_ANALYSIS_REQUIRED", "selection", target.pending.selection,
        operationKind === "ranking" ? "pi" : "stop", "capability"));
    }
    if (this.request.semanticStep && !task.issues.some(item => item.code === "QUERY_RANGE_ANALYSIS_REQUIRED")) {
      const schema = createCapabilities().get(task.capability ?? "metric_query");
      for (const validation of validateFrame(schema, target.fields).issues) {
        // 取数方式依赖日历；日期尚未确定时不制造“缺少selection”的模型错误或重复追问。
        if (validation.field === "selection" && target.fields.time?.resolutionStatus !== "resolved") continue;
        if (task.issues.some(item => item.field === validation.field)) continue;
        const definition = schema.fields[validation.field];
        const bounds = definition?.validation;
        task.issues.push(issue("QUERY_COMBINATION_UNSUPPORTED", validation.field, validation.message
          ?? `${definition?.label ?? validation.field}尚未通过执行契约校验${bounds?.min !== undefined ? `，下限${bounds.min}` : ""}${bounds?.max !== undefined ? `，上限${bounds.max}` : ""}。`, "pi", "capability"));
      }
    }
    this.applyDeclinedAnswers(target, task, answerSnapshots, turn);
    if (!task.issues.length && !Object.keys(target.pending).length) {
      try {assertRecoveredQueryConditions(await frozenQueryScope(this.request, task), target.fields);} catch (error) {
        if (!(error instanceof BusinessInputError)) throw error;
        task.issues.push(issue(error.code, error.field, error.correction, "pi", "input_shape"));
      }
    }
    if (task.issues.length || Object.keys(target.pending).length) target.status = "blocked";
    task = {...task, revision: task.revision + 1, target, status: task.issues.some(item => item.category === "permission") ? "stopped"
      : task.issues.some(item => item.remediation === "user") ? "waiting_input" : "active", completion: "unmet"};
    delete task.permit;
    const index = await this.store.index();
    const conditionValues = (fields: Record<string, ResolvedField>) => Object.fromEntries(Object.entries(fields)
      .filter(([name]) => name !== "objective").map(([name, value]) => [name, value.resolvedValue]));
    const unchanged = target.status !== "blocked" && turn.baseline?.status === "succeeded" && turn.baseline.frameId
      && Object.keys(turn.operations).length > 0 && !/(?:重新|重查|刷新|更新|再查|查一次)/u.test(turn.originalMessage)
      && JSON.stringify(conditionValues(target.fields)) === JSON.stringify(conditionValues(turn.baseline.fields));
    if (unchanged && input.intent === "query") {
      target.frameId = turn.baseline!.frameId!; target.status = "succeeded";
      task.status = "completed"; task.completion = "full";
    } else if (target.status !== "blocked" && input.intent === "query") {
      const frame = await this.compile(task);
      target.frameId = frame.frameId;
      target.status = "ready";
      task.permit = {operationId: this.request.operationId, revision: task.revision, frameId: frame.frameId,
        digest: snapshotDigest(target), actor: this.request.actor.id, consumed: false};
    }
    const questions = await this.candidateQuestionIssues(task, target, turn);
    const answers = answerSnapshots.length ? this.answerApplications(task, answerSnapshots, appliedAnswers) : undefined;
    task = await this.store.save(task, index.version, turn, true, {questions, ...(answers ? {answers} : {})});
    return {task, status: task.issues.some(item => item.category === "permission") ? "denied"
      : task.issues.some(item => item.remediation === "stop" && item.category === "capability") ? "unsupported"
      : target.status === "blocked" ? task.issues.some(item => item.remediation !== "user") ? "needs_interpretation" : "needs_user"
      : unchanged && input.intent === "query" ? "reused" : input.intent === "prepare" ? "prepared" : "ready"};
  }
  /**
   * 明确口径优先：用户用“较上月/当日数”等口径词要求换口径、模型却把它写进 time 时，
   * 若该词恰好补全当前基础指标的唯一目录成员名，则按指标口径处理并保留原日期。
   * 只复用目录检索与解析、要求精确同名和同一基础名，不拼造指标；检索不可用时不改提案。
   */
  private async groundExplicitMetricBasis(turn: SemanticTurn): Promise<void> {
    if (turn.operations.metrics?.length) return;
    const timeOperations = turn.operations.time ?? [];
    for (const [index, operation] of timeOperations.entries()) {
      if (operation.action !== "set" || !("value" in operation) || typeof operation.value !== "string") continue;
      const phrase = operation.value.trim();
      if (!/^[\u4e00-\u9fff]{2,8}$/u.test(phrase)) continue;
      const metric = turn.baseline?.fields.metrics;
      if (metric?.resolutionStatus !== "resolved") continue;
      const bases = [...new Set(((metric.metadata?.metrics as Array<{base_name?: string}> | undefined) ?? [])
        .map(item => item.base_name).filter((name): name is string => !!name))];
      if (!bases.length) continue;
      // 先让确定性日历解析核验：能被日历规则解释的（“上月末”“九月末”）仍是日期，
      // 只有日历不认识的短词才可能是指标口径。
      try {
        const asDate = await resolveTurnField(this.request, "date", [phrase], {signal: this.signal});
        if (asDate.status === "resolved" && asDate.metadata?.resolution_source !== "model") continue;
      } catch {
        // 日期事实服务不可用时保持原时间提案，由原路径处理。
        continue;
      }
      for (const base of bases) {
        const name = `${base}${phrase}`;
        try {
          const search = await this.request.backend.searchMetrics(name, 20, {signal: this.signal});
          if ((search.items ?? []).filter(item => normalizeInputEvidence(item.metric_name) === normalizeInputEvidence(name)).length !== 1) continue;
          const resolved = await resolveTurnField(this.request, "metric", [name], {signal: this.signal});
          const value = resolved.value;
          if (resolved.status !== "resolved" || !checkedEntity(value) || value.codes.length !== 1) continue;
          const code = value.codes[0]!;
          const basis = (resolved.metadata?.metrics as Array<{code?: string; base_name?: string; value_basis?: string}> | undefined)
            ?.find(item => item.code === code);
          if (!basis || basis.base_name !== base || basis.value_basis !== phrase) continue;
          turn.operations.metrics = [{action: "set", field: "metrics", value: name}];
          turn.operations.time = timeOperations.filter((_, position) => position !== index);
          if (!turn.operations.time.length) delete turn.operations.time;
          return;
        } catch {
          // 目录检索不可用时保持原时间提案，由日期解析按原路径澄清。
        }
      }
    }
  }
  private applyDeclinedAnswers(target: SemanticTarget, task: SemanticTask, snapshots: readonly SemanticAnswerSnapshot[], turn: SemanticTurn) {
    for (const snapshot of snapshots) {
      const choice = snapshot.answer.choice.type;
      if (snapshot.existingReceipt || choice !== "reject" && choice !== "none_of_these") continue;
      const field = snapshot.question.scope.field;
      if (turn.operations[field]?.length) continue;
      const current = target.fields[field];
      const rejected = choice === "none_of_these" ? snapshot.binding.options
        : snapshot.binding.options.filter(option => option.option_id === (snapshot.question.kind === "confirm" ? snapshot.question.confirmation_option_id : ""));
      const identities = new Set(rejected.map(option => JSON.stringify(option.candidate)));
      if (current?.candidates) current.candidates = current.candidates.filter(candidate => !identities.has(JSON.stringify(candidate)));
      target.pending[field] = "请从剩余候选中选择，或补充新的业务表达。";
      if (!task.issues.some(item => item.field === field)) task.issues.push(issue("ENTITY_NOT_DETERMINED", field, target.pending[field]!, "user", "catalog"));
    }
  }
  private answerApplications(task: SemanticTask, snapshots: readonly SemanticAnswerSnapshot[], applied: ReadonlySet<string>): SemanticAnswerApplication[] {
    return snapshots.map(snapshot => {
      const choice = snapshot.answer.choice.type;
      const outcome = snapshot.alreadyApplied ? "already_applied" : snapshot.existingReceipt?.outcome
        ?? (choice === "reject" || choice === "none_of_these" ? "declined" : applied.has(snapshot.answer.question_id) ? "applied" : "not_applied");
      return {snapshot, outcome, planRef: this.request.semanticStep?.planRef ?? task.parentPlan ?? task.ref,
        targetRef: task.target.ref, expectedTaskRevision: task.revision - 1,
        ...(outcome === "not_applied" ? {code: task.issues.find(item => item.field === snapshot.question.scope.field)?.code ?? "ANSWER_NOT_APPLIED"} : {})};
    });
  }
  private async candidateQuestionIssues(task: SemanticTask, target: SemanticTarget, turn?: SemanticTurn): Promise<SemanticQuestionIssue[]> {
    const result: SemanticQuestionIssue[] = [];
    const sourceTaskRefs = new Set<string>();
    if (turn?.admittedTask && turn.admittedTask !== task.ref) sourceTaskRefs.add(turn.admittedTask);
    if (turn?.source?.kind === "reference" && turn.source.task_ref !== task.ref) sourceTaskRefs.add(turn.source.task_ref);
    const sourceQuestions = (await Promise.all([...sourceTaskRefs].map(ref => this.store.questionsForTask(ref)))).flat();
    for (const field of ["organizations", "comparison_organizations", "metrics"] as const) {
      const current = target.fields[field];
      if (!current || current.resolutionStatus === "resolved" || !current.candidates?.length
        || !["needs_confirmation", "ambiguous", "not_found"].includes(current.resolutionStatus)) continue;
      const pendingValues = current.metadata?.pendingRawValues;
      const rawValues = field === "metrics" ? [] : Array.isArray(pendingValues)
        ? pendingValues.flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [])
        : typeof current.rawValue === "string" ? await organizationValues(this.request, current.rawValue) : [];
      for (const group of candidateOptionGroups(current.candidates, field)) {
        const pending = Array.isArray(pendingValues) ? pendingValues[group.rawValueIndex] : undefined;
        const spanText = group.semanticSpan ? (() => {try {const value = JSON.parse(group.semanticSpan!) as unknown;
          return Array.isArray(value) && typeof value[2] === "string" ? value[2] : undefined;} catch {return undefined;}})() : undefined;
        const groupRaw = Array.isArray(pending) ? pending.join("、") : typeof pending === "string" ? pending : spanText ?? String(current.rawValue ?? "当前表达");
        const preferred = preferredOption(group.options);
        const confirmation = group.options.length === 1 ? group.options[0] : preferred;
        const selectionMode = field === "metrics" ? "single" as const : "multiple" as const;
        const truncated = typeof current.metadata?.candidate_count === "number" && current.metadata.candidate_count > current.candidates.length;
        const prompt = confirmation ? `您是指「${confirmation.label}」吗？`
          : `请确定${field === "metrics" ? "指标口径" : "机构名称"}：${groupRaw}${truncated ? "。当前候选清单不完整，请补充范围" : ""}`;
        const options = group.options.map(option => {
          const metadata = option.candidate.metadata ?? {};
          // 名称已含口径时不再重复附加口径。
          const description = ["description", "value_basis", "unit", "frequency", "parent_name", "parentName"]
            .flatMap(key => {
              const value = metadata[key];
              return typeof value === "string" && value && !(key === "value_basis" && option.label.includes(value)) ? [value] : [];
            }).join("；") || undefined;
          return {key: option.optionId, no: option.no, label: option.label, ...(description ? {description} : {}), binding: structuredClone(option.candidate)};
        });
        const kind = confirmation ? {kind: "confirm" as const, confirmation_key: confirmation.optionId} : {kind: "choice" as const};
        const businessBasis = {field, prompt, selection_mode: selectionMode, rawValue: groupRaw,
          permission: {codes: [...new Set(group.options.map(option => option.candidate.code).filter((code): code is string => !!code))].sort()},
          options: options.map(({key, label, description}) => ({key, label, ...(description ? {description} : {})})), ...kind};
        const generatedKey = field === "metrics" ? `${field}:${spanText ?? groupRaw}:${group.semanticSpan ?? `raw:${group.rawValueIndex}`}`
          : `${field}:${group.rawValueIndex}:${groupRaw}`;
        const prior = sourceQuestions.find(view => view.itemKey === generatedKey && view.binding.reason === "candidate_choice")
          ?? sourceQuestions.filter(view => view.binding.reason === "candidate_choice" && view.question.scope.field === field
            && (group.semanticSpan ? view.binding.pendingItem?.semanticSpan === group.semanticSpan
              : view.binding.pendingItem?.rawValueIndex === group.rawValueIndex && view.binding.pendingItem?.rawValue === groupRaw)).at(-1);
        const itemKey = prior?.itemKey ?? generatedKey;
        const sourceQuestion = prior?.binding.sourceQuestion
          ?? (typeof current.metadata?.resumedSourceMessage === "string" ? current.metadata.resumedSourceMessage : undefined)
          ?? target.pendingChanges?.[field]?.sourceMessage ?? turn?.baseline?.pendingChanges?.[field]?.sourceMessage ?? this.request.originalMessage;
        const planRef = this.request.semanticStep?.planRef ?? task.parentPlan ?? task.ref;
        result.push({itemKey, owner: task.owner,
          draft: {version: 1, scope: {task_ref: planRef, target_ref: target.ref, field, item_ref: prior?.binding.item_ref ?? itemKey}, prompt,
            selection_mode: selectionMode, options, issued_operation_id: this.request.semanticStep?.rootOperationId ?? this.request.operationId,
            businessBasis, ...kind},
          binding: {reason: "candidate_choice", planRef, targetRef: target.ref, taskRef: task.ref, sourceQuestion,
            pendingItem: {rawValueIndex: group.rawValueIndex, ...(group.semanticSpan ? {semanticSpan: group.semanticSpan} : {}), rawValue: groupRaw},
            resolutionBasis: {rawValue: structuredClone(current.rawValue), rawValues, pendingRawValues: structuredClone(pendingValues),
              suggested: structuredClone(current.metadata?.suggested), sourceQuestion, ...(target.metricSource ? {metricSource: target.metricSource} : {})}}});
      }
    }
    return result;
  }
  private async bind(turn: SemanticTurn, source: SemanticSource): Promise<SemanticTask> {
    if (source.kind === "references") conflict("GROUP_SOURCE_NOT_EXPANDED", "多个来源须由任务编排展开，不能直接执行单个子任务。");
    if (turn.boundTask) {
      if (sourceKey(source) !== sourceKey(turn.source!)) conflict("TURN_SOURCE_CONFLICT", "本轮已绑定目标，参数纠错不能换来源或重新新建。请沿用原source。");
      const bound = await this.store.get(turn.boundTask);
      if (!bound || bound.owner !== this.request.actor.id) conflict("REFERENCE_INVALID", "当前任务不可读取。");
      return bound;
    }
    let base: SemanticTask | undefined;
    if (source.kind === "current") {
      base = turn.admittedTask ? await this.store.get(turn.admittedTask) : undefined;
      if (!base) conflict("REFERENCE_UNAVAILABLE", "当前没有可续接任务；明确新问题请使用new。");
    } else if (source.kind === "reference") {
      base = await this.store.get(source.task_ref);
      const reference = await this.store.reference(source.target_ref);
      if (!base || !reference || reference.task !== base.ref || base.owner !== this.request.actor.id) conflict("REFERENCE_INVALID", "引用未签发、配对不符或不属于当前会话。");
      if (base.ref === turn.admittedTask && source.target_ref !== base.target.ref) conflict("REFERENCE_REVISION_CONFLICT", "当前目标已修订，请重新读取上下文。");
      if (base.ref !== turn.admittedTask) base = {...base, target: reference.target};
    }
    if (base && base.owner !== this.request.actor.id) conflict("REFERENCE_INVALID", "任务不属于当前身份。");
    if (base?.target.frameId && this.request.frames) {
      const frame = await this.request.frames.get(base.target.frameId);
      const state = await this.request.frames.state();
      const latest = frame ? await this.request.frames.get(state.operations[frame.operationFrameId] ?? frame.frameId) : undefined;
      if (latest?.status === "executing") conflict("EXECUTION_RESULT_UNKNOWN", "来源操作仍在途或结果未知，应先按原关联回查，不能换新命令重复查询。");
    }
    const continued = !!base && base.ref === turn.admittedTask && !base.target.frameId;
    const task: SemanticTask = continued ? base! : {ref: semanticRef(), owner: this.request.actor.id, revision: 0,
      target: base ? {...structuredClone(base.target), ref: semanticRef()} : emptyTarget(), originalMessage: turn.originalMessage,
      status: "active", completion: "unmet", issues: []};
    if (!continued && base?.questionSnapshots?.length) task.questionSnapshots = structuredClone(base.questionSnapshots);
    turn.boundTask = task.ref;
    turn.source = structuredClone(source);
    turn.baseline = structuredClone(task.target);
    await this.store.save(task, (await this.store.index()).version, turn);
    return task;
  }
  private async requireRecoveryAnalysis() {
    if (!analysisCandidates(this.request).length) return;
    const recovery = (await this.store.turn(this.request.semanticStep?.rootOperationId ?? this.request.operationId))?.queryRecovery;
    if (recovery) throw new SemanticConflict(issue("QUERY_RECOVERY_ANALYSIS_REQUIRED", "metrics",
      "目录已发现候选，但候选全名不等于用户原始指标含义。请继续同一source，改用target.analysis.kind=business_analysis并引用已签发的k引用完成原目标；不要继续把候选全名塞回query或清空指标后询问用户补指标。净增等比较基期不明时，清楚区分正式比较或只确认缺少的基期，不能擅自默认。", "pi", "catalog"));
  }
  private async apply(target: SemanticTarget, operation: SemanticOperation, turn: SemanticTurn,
    answerCandidates?: FieldCandidate[], publishedFields?: Set<string>) {
    const field = operation.field;
    if (operation.action === "rank_all") {
      target.fields.operation = {rawValue: "排序全部已选机构", resolutionStatus: "ambiguous", source: "explicit",
        metadata: {structuredQuery: true, modelOperation: {kind: "sort", direction: operation.direction}}};
      delete target.pending.operation; return;
    }
    if (operation.action === "copy") {
      const reference = operation.reference;
      const parent = await this.store.plan(reference.task_ref), step = parent?.steps.find(item => item.targetRef === reference.target_ref);
      const source = step?.taskRef ? await this.store.get(step.taskRef) : undefined;
      const value = source?.target.fields[field];
      if (!parent || parent.owner !== this.request.actor.id || value?.resolutionStatus !== "resolved") throw new SemanticConflict(issue("FIELD_COPY_SOURCE_INVALID", field, "字段来源尚未完整确认，请定向读取历史后选择有效引用。", "pi", "reference"));
      target.fields[field] = {...structuredClone(value), source: "inherited", metadata: {...value.metadata, fieldSource: {field, task_ref: reference.task_ref, target_ref: reference.target_ref}}};
      delete target.pending[field]; return;
    }
    if (operation.action === "select") {
      const frameState = await this.request.frames!.state(), base = turn.baseline?.frameId ? await this.request.frames!.get(turn.baseline.frameId) : undefined;
      const frame = base ? await this.request.frames!.get(frameState.operations[base.operationFrameId] ?? base.frameId) : undefined;
      const ref = frame?.resultRef && /^query:([^:]+):([^:]+)$/u.exec(frame.resultRef);
      if (!ref || frame?.status !== "success") throw new SemanticConflict(issue("RESULT_SELECTION_SOURCE_REQUIRED", field, "结果成员筛选需要已有成功查询来源。", "pi", "reference"));
      const page = await this.request.backend.getTaskResult(decodeURIComponent(ref[1]!), operation.offset, operation.limit, {signal: this.signal});
      if (page.status !== "succeeded" || page.result_id !== decodeURIComponent(ref[2]!) || page.row_count !== frame.resultSummary?.rowCount
        || page.truncated || page.rows.length !== operation.limit) throw new SemanticConflict(issue("RESULT_SELECTION_INCOMPLETE", field, "正式结果不足以确定所选成员，请读取完整结果并核对范围。", "user", "coverage"));
      const codes = [...new Set(page.rows.map(row => row.org_code).filter((code): code is string => typeof code === "string" && !!code))];
      const scope = entityValue(turn.baseline?.fields.organizations).codes;
      if (codes.length !== operation.limit || codes.some(code => !scope.includes(code))) throw new SemanticConflict(issue("RESULT_SELECTION_BINDING_INVALID", field, "结果成员与原查询范围不一致，不能继续筛选。"));
      const resolution = await resolveTurnField(this.request, "organization", codes, {signal: this.signal});
      if (resolution.status !== "resolved" || !checkedEntity(resolution.value) || resolution.value.codes.length !== codes.length) throw new SemanticConflict(issue("PERMISSION_DENIED", field, "所选结果成员当前不可访问。", "stop", "permission"));
      target.fields[field] = {...resolved("正式结果成员", resolution.value, "organization"), source: "inherited", metadata: {resultSelection: {task: page.task_id, result: page.result_id, offset: operation.offset, limit: operation.limit}}};
      delete target.pending[field]; return;
    }
    if (!["organizations", "comparison_organizations", "metrics", "time", "selection", "operation", "objective", "availability"].includes(field)) throw new SemanticConflict(issue("FIELD_CAPABILITY_NOT_ENABLED", field, "此字段尚未接入当前步骤，不能降级或忽略。", "stop", "capability"));
    if (operation.action === "clear") {
      target.fields[field] = {resolutionStatus: "missing", source: "explicit", metadata: {semanticAction: "clear"}};
      // clear只清除字段；是否必须补充由当前能力的必需条件统一判断，可选字段不能留下永久待决。
      delete target.pending[field]; return;
    }
    const previous = target.fields[field];
    if (operation.action === "confirm" && publishedFields?.has(field) && !answerCandidates) {
      throw new SemanticConflict(issue("ANSWER_REQUIRED", field, "该字段已有已发布问题，请使用 answers 引用问题版本和选项，不再回退旧口语选择器。", "pi", "input_shape"));
    }
    if (operation.action === "set" && previous?.resolutionStatus !== "resolved" && previous?.candidates?.length && !publishedFields?.has(field)) {
      try {
        await selectSavedCandidates(target, field, turn, this.request);
        // 用户已选择保存候选时，set和confirm都绑定同一选择；不能由模型措辞改变所选身份。
        operation = {...operation, action: "confirm"};
      } catch (error) {
        if (!(error instanceof SemanticConflict) || error.issue.code !== "CONFIRMATION_NOT_ESTABLISHED") throw error;
      }
    }
    if (field === "operation" && "value" in operation) {
      if ("queryOperation" in operation && operation.queryOperation) {
        const submitted = operation.queryOperation;
        const value = submitted.kind === "ranking" && (submitted.position === null || submitted.top_n === null)
          ? await completeRankingOperation(submitted, {originalMessage: turn.originalMessage, currentDate: turn.businessDate,
            turnId: turn.operationId, resolveCatalog: async () => ({status: "invalid"}),
            resolveMetricMentions: question => metricMentions(this.request, question)}) : submitted;
        target.fields.operation = {...resolved(operationLabel(value), value, "query_operation"),
          metadata: {structuredQuery: true, modelOperation: structuredClone(value),
            ...(value !== submitted ? {submittedOperation: structuredClone(submitted), sourceEvidence: "original_question"} : {})}};
        if (value.kind === "sort" || value.kind === "ranking" && (value.position === null || value.top_n === null)) {
          target.fields.operation.resolutionStatus = "ambiguous";
        }
        delete target.pending.operation; return;
      }
      const result = await normalizeQueryOperation({originalMessage: operation.value, currentDate: turn.businessDate, turnId: turn.operationId,
        resolveCatalog: async () => ({status: "invalid"}), resolveMetricMentions: question => metricMentions(this.request, question)});
      if (result.status !== "resolved") {
        // 集合可能在后续operation才解析；保留表达交给整目标校验，避免要求模型重复特殊动作。
        target.fields.operation = {rawValue: operation.value, resolutionStatus: "ambiguous", source: "explicit"};
        return;
      }
      target.fields.operation = resolved(operation.value, result.value, "query_operation"); delete target.pending.operation; return;
    }
    if (field === "metrics" || field === "organizations" || field === "comparison_organizations") {
      const entity = field === "metrics" ? "metric" : "organization";
      const source = {business_date: turn.businessDate, source_question: turn.originalMessage};
      let raw = "value" in operation ? operation.value : operation.subject;
      const facts = this.request.semanticStep?.facts;
      if (operation.action === "set" && !hasInputEvidence(turn.originalMessage, raw) && facts
        && !(entity === "metric" && this.request.semanticStep?.analysis)
        && !facts.fragments.some(fragment => entity === "organization" ? fragment.organizations.length : fragment.mentions.length)
        && previous?.resolutionStatus !== "resolved") {
        if (field === "metrics") await this.requireRecoveryAnalysis();
        delete target.fields[field]; delete target.pending[field]; return;
      }
      let response: FieldResolution;
      let pendingAction: SemanticOperation | undefined;
      let pendingTail: SemanticOperation[] = [];
      let pendingBaseline: ResolvedField | undefined;
      let pendingSource = turn.originalMessage;
      let confirmedBindings = {...previous?.metadata?.confirmedBindings as Record<string, string[]> | undefined};
      if (operation.action === "confirm") {
        const selected = answerCandidates ?? await selectSavedCandidates(target, field, turn, this.request);
        const partial = previous?.metadata?.partialMembers;
        const pendingValues = previous?.metadata?.pendingRawValues;
        const completeOrganization = entity === "organization" && Array.isArray(pendingValues)
          && pendingValues.length > 0 && pendingValues.every(value => typeof value === "string"
            || Array.isArray(value) && value.length > 0 && value.every(member => typeof member === "string"));
        if (completeOrganization) {
          // 按原槽位替换确认项后整表复核；已确定项、未选择项和零候选项均不能丢失。
          const values = structuredClone(pendingValues) as Array<string | string[]>;
          const choices = new Map<number, string[]>();
          for (const candidate of selected) {
            const index = Number(candidate.metadata?.rawValueIndex);
            if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new SemanticConflict(issue("INVALID_CANDIDATE_REFERENCE", field, "候选未绑定原始机构项，请保留完整原值重新确认。", "user"));
            choices.set(index, [...(choices.get(index) ?? []), candidate.code ?? String(candidate.value)]);
          }
          for (const [index, members] of choices) values[index] = members.length === 1 ? members[0]! : members;
          const indexes = values.flatMap((value, index) => (Array.isArray(value) ? value : [value]).map(() => index));
          response = await resolveTurnField(this.request, entity, values.flat(), {signal: this.signal});
          const frozen = response.metadata?.pendingRawValues;
          if (Array.isArray(frozen) && frozen.length === indexes.length) {
            for (let index = 0; index < values.length; index++) {
              const members = frozen.flatMap((value, position) => indexes[position] === index ? Array.isArray(value) ? value : [value] : []);
              if (members.length) values[index] = members.length === 1 ? members[0] as string : members as string[];
            }
          }
          const sourceIssues = response.metadata?.issues;
          response = {...response, ...(response.candidates ? {candidates: response.candidates.map(candidate => ({...candidate,
            metadata: {...candidate.metadata, rawValueIndex: indexes[Number(candidate.metadata?.rawValueIndex)]}}))} : {}),
            metadata: {...response.metadata, pendingRawValues: values,
              ...(Array.isArray(sourceIssues) ? {issues: sourceIssues.map(entry => ({...entry, rawValueIndex: indexes[Number(entry.rawValueIndex)]}))} : {})}};
          raw = typeof previous?.rawValue === "string" ? previous.rawValue : values.join("、");
        } else {
          response = await resolveTurnField(this.request, entity,
            [...(checkedEntity(partial) ? partial.codes : []), ...selected.map(candidate => candidate.code ?? String(candidate.value))], {signal: this.signal});
          raw = selected.map(candidate => String(candidate.value)).join("、");
        }
        if (!completeOrganization && response.status === "resolved" && checkedEntity(response.value)) {
          const selectedValue = response.value;
          for (const candidate of selected) {
            const span = candidate.metadata?.semanticSpan;
            if (typeof span === "string") confirmedBindings[span] = candidate.code ? [candidate.code] : selectedValue.codes;
          }
          const groups = new Set(selected.map(candidate => candidate.metadata?.rawValueIndex ?? 0));
          const remaining = (previous?.candidates ?? []).filter(candidate => !groups.has(candidate.metadata?.rawValueIndex ?? 0));
          const combined = checkedEntity(partial) ? joinValues(partial, selectedValue) : selectedValue;
          response = remaining.length ? {status: "needs_confirmation", candidates: remaining,
            metadata: {partialMembers: combined, confirmedBindings}} : {...response, value: combined};
        } else if (!completeOrganization && response.candidates && selected.length === 1) {
          response = {...response, candidates: response.candidates.map(candidate => ({...candidate, metadata: {...candidate.metadata,
            semanticSpan: selected[0]!.metadata?.semanticSpan}})), metadata: {...response.metadata, ...(checkedEntity(partial) ? {partialMembers: partial} : {}), confirmedBindings}};
        }
        const pending = target.pendingChanges?.[field];
        if (pending) {
          pendingAction = pending.operations[0]; pendingTail = pending.operations.slice(1);
          pendingBaseline = pending.baseline; pendingSource = pending.sourceMessage;
        }
      } else {
        // 建议辅助目录识别；完整原值、来源和权限与无建议路径使用同一约束。
        const suggestion = entity === "organization" && (operation.action === "set" || operation.action === "replace")
          && "suggestion" in operation ? operation.suggestion : undefined;
        const scope = entity === "organization" ? organizationScopeInput("organizationScope" in operation && operation.organizationScope || raw) : undefined;
        if (scope) {
          if (!hasInputEvidence(turn.originalMessage, scope.sourceText) || scope.kind === "children_of"
            && (!scope.parentName || !hasInputEvidence(turn.originalMessage, scope.parentName)
              || !hasInputEvidence(scope.sourceText, scope.parentName)))
            throw new SemanticConflict(issue("ORGANIZATION_SCOPE_SOURCE_INVALID", field,
              "机构集合和上级机构必须来自当前原文；未知范围不能扩大为全部机构。", "pi", "input_shape"));
          response = await this.request.backend.resolveOrganizationScope(scope, {signal: this.signal});
          if (response.status === "resolved" && checkedEntity(response.value)) response.metadata = {...response.metadata, source_codes: response.value.codes};
        } else if (suggestion) {
          const code = typeof suggestion.code === "string" && suggestion.code.trim() ? suggestion.code.trim() : undefined;
          const name = typeof suggestion.name === "string" && suggestion.name.trim() ? suggestion.name.trim() : undefined;
          const excerpt = typeof suggestion.excerpt === "string" && suggestion.excerpt.trim() ? suggestion.excerpt.trim() : undefined;
          if (!code && !name) throw new SemanticConflict(issue("ORG_SUGGESTION_INVALID", field,
            "suggestion 至少提交有权机构清单中的编码或名称之一，excerpt 为用户原文片段；无法判断时按业务表达提交 value 或澄清。", "pi", "catalog"));
          // suggestion 只辅助未决成员，完整value决定成员集合。
          response = await this.request.backend.resolveBusinessFieldSuggestion(entity,
            [{...(code ? {code} : {}), ...(name ? {name} : {}), ...(excerpt ? {excerpt} : {})}], {signal: this.signal}, turn.originalMessage, await organizationValues(this.request, raw));
          // 首推归属由后端按原值槽位判定，不能把另一个已定成员的建议覆盖到未决候选。
          response = {...response, metadata: {...response.metadata, ...(excerpt ? {rawExcerpt: excerpt} : {}),
            suggested: [{...(code ? {code} : {}), ...(name ? {name} : {}), ...(excerpt ? {excerpt} : {})}]}};
        } else {
        response = await resolveTurnField(this.request, entity, "values" in operation && operation.values
          ? operation.values : entity === "organization" ? await organizationValues(this.request, raw) : [raw], {signal: this.signal}, undefined, source);
        }
        const metricContext = entity === "metric" && previous?.resolutionStatus === "resolved"
          && checkedEntity(previous.resolvedValue) ? previous.resolvedValue : undefined;
        if (entity === "metric") response = applyMetricDefaultContext(response, metricContext);
        // 模型把用户原文的错字/缩写预纠成规范名时，按后端回记的原文槽位重新解析：
        // 字段解析和纠正留痕使用同一份原文依据，不要求用户重述。建议与无建议路径共用。
        if (entity === "organization" && response.metadata?.hint_source_bound === true) {
          const sourceValues = response.metadata.extractedRawValues;
          if (Array.isArray(sourceValues) && sourceValues.length && sourceValues.every(value => typeof value === "string")
            && sourceValues.join("、") !== raw) {
            const rebound = await resolveTurnField(this.request, "organization", sourceValues,
              {signal: this.signal}, undefined, {business_date: turn.businessDate, source_question: turn.originalMessage});
            if (rebound.status === "resolved" && checkedEntity(rebound.value)
              && JSON.stringify([...rebound.value.codes].sort()) === JSON.stringify([...((response.value as {codes?: string[]} | undefined)?.codes ?? [])].sort())) {
              // 保留建议通道已标注的来源类型（model_inferred 等），来源确认题由计划层据此首发；
              // 纠正痕迹与原文槽位以重新解析结果为准。
              response = {...rebound, metadata: {...rebound.metadata, ...response.metadata,
                ...(rebound.metadata?.corrections ? {corrections: rebound.metadata.corrections} : {}),
                ...(Array.isArray(rebound.metadata?.extractedRawValues) ? {extractedRawValues: rebound.metadata.extractedRawValues} : {extractedRawValues: sourceValues})}};
              raw = sourceValues.join("、");
            }
          }
        }
        if (entity === "metric" && operation.action !== "exclude") {
          const foundMentions = await metricMentions(this.request);
          const allMentions = {...foundMentions, mentions: foundMentions.mentions.map(mention => ({...mention,
            resolution: applyMetricDefaultContext(mention.resolution, metricContext)}))};
          const original = operation.action === "set" && hasCollectionIntent(turn.originalMessage)
            ? {...allMentions, mentions: allMentions.mentions.filter(mention => hasInputEvidence(raw, mention.text)
              || hasInputEvidence(mention.text, raw) || (mention.resolution.value as EntityValue | undefined)?.codes?.some(code =>
                (response.value as EntityValue | undefined)?.codes?.includes(code)))} : allMentions;
          const members = splitNames(raw);
          const explicit = original.mentions.filter(mention => mention.resolution.status === "resolved" && checkedEntity(mention.resolution.value));
          if (operation.action === "set" && members.length > 1) {
            // 整个清单不能用一次子串匹配。用原句已确定身份逐成员对齐，只有唯一配对才补全口径。
            const choices = members.map(member => {
              const exact = explicit.filter(mention => [mention.text, ...(mention.resolution.value as EntityValue).names].some(name=>normalizeInputEvidence(name)===normalizeInputEvidence(member)));
              return exact.length ? exact : explicit.filter(mention => hasInputEvidence(mention.text, member));
            });
            const assigned = new Map<number, (typeof explicit)[number]>();
            const used = new Set<string>();
            for (let count=0;count<members.length;count++) {
              let progress=false;
              choices.forEach((options,i)=>{
                if(assigned.has(i))return;
                const remaining=options.filter(mention=>!used.has(JSON.stringify((mention.resolution.value as EntityValue).codes)));
                if(remaining.length===1){assigned.set(i,remaining[0]!);used.add(JSON.stringify((remaining[0]!.resolution.value as EntityValue).codes));progress=true;}
              });
              if(!progress)break;
            }
            if(assigned.size===members.length){
              const aligned=members.map((_,i)=>assigned.get(i)!);
              raw=aligned.map(mention=>mention.text).join("、");
              response=await resolveTurnField(this.request, entity,aligned.flatMap(mention=>(mention.resolution.value as EntityValue).codes),{signal:this.signal});
            }
          }
          let matching = original.mentions.filter(mention => mention.resolution.status === "resolved" && checkedEntity(mention.resolution.value)
            && (hasInputEvidence(mention.text, raw) || mention.resolution.value.names.some(name => hasInputEvidence(name, raw)))
            && !(operation.action === "replace" && hasInputEvidence(mention.text, operation.subject)));
          if (matching.length > 1) {
            const labels = matching.map(mention => normalizeInputEvidence(mention.text));
            let stem = labels[0] ?? "";
            while (stem && !labels.every(label => label.startsWith(stem))) stem = stem.slice(0, -1);
            const operationHints = Object.values(turn.operations).flatMap(ops => ops.flatMap(op => ["selection", "operation"].includes(op.field) && "value" in op ? [normalizeInputEvidence(op.value)] : []));
            const pointed = matching.filter((_, index) => labels[index]!.slice(stem.length).length > 0
              && operationHints.some(hint => hint.includes(labels[index]!.slice(stem.length))));
            if (pointed.length === 1) matching = pointed;
            else {
              // 口径误放到操作/取数描述时，仍用同一目录解析器核验完整业务概念，不能靠字符串补后缀选指标。
              for (const hint of operationHints) {
                const joined = await resolveTurnField(this.request, "metric", [raw + hint], {signal: this.signal});
                const choices = joined.status === "resolved" && checkedEntity(joined.value) ? joined.value.codes
                  : (joined.candidates ?? []).flatMap(candidate => candidate.code ? [candidate.code] : []);
                if (!choices.length) continue;
                const selected = matching.filter(mention => checkedEntity(mention.resolution.value)
                  && mention.resolution.value.codes.every(code => choices.includes(code)));
                // 候选不能单独建立确认；这里只接受与原句已经精确确定的身份唯一相交的口径。
                if (selected.length === 1 && checkedEntity(selected[0]!.resolution.value)
                  && choices.every(code => (selected[0]!.resolution.value as EntityValue).codes.includes(code))) {matching = selected; break;}
              }
            }
          }
          // 模型省略目录名称中的口径时，以原句唯一正式片段补全身份；不向用户追问已给出的口径。
          if (matching.length === 1 && checkedEntity(matching[0]!.resolution.value)) {
            raw = matching[0]!.text;
            response = await resolveTurnField(this.request, entity, matching[0]!.resolution.value.codes, {signal: this.signal});
          }
          const unresolved = original.mentions.filter(mention => mention.resolution.status !== "resolved"
            && !(operation.action === "replace" && hasInputEvidence(mention.text, operation.subject)));
          if (unresolved.length) {
            raw = unresolved.map(mention => mention.text).join("、");
            const offset = Array.from(target.metricSource ?? turn.originalMessage).length - Array.from(turn.originalMessage).length;
            const known = original.mentions.filter(mention => mention.resolution.status === "resolved" && checkedEntity(mention.resolution.value)
              && !(operation.action === "replace" && hasInputEvidence(mention.text, operation.subject)))
              .reduce((value, mention) => joinValues(value, mention.resolution.value as EntityValue), {codes: [], names: []} as EntityValue);
            response = {status: "needs_confirmation", candidates: unresolved.flatMap((mention, index) =>
              (mention.resolution.candidates ?? []).map(candidate => ({...candidate, metadata: {...candidate.metadata, rawValueIndex: index,
                semanticSpan: spanKey({...mention, start: mention.start + offset, end: mention.end + offset})}}))),
              metadata: {...(known.codes.length ? {partialMembers: known} : {}), confirmedBindings: {}}};
          }
        }
      }
      if (entity === "organization" && ["ambiguous", "needs_confirmation"].includes(response.status) && operation.action === "set") {
        const anchored = response.metadata?.source_codes;
        const exact = Array.isArray(anchored) && anchored.length === 1 ? anchored : [];
        const catalog = typeof this.request.backend.orgCatalog === "function" ? await orgCatalog(this.request) : undefined;
        const member = catalog?.items.find(item => item.code === exact[0]);
        const original = normalizeInputEvidence(turn.originalMessage), excerpt = normalizeInputEvidence(raw);
        const position = original.indexOf(excerpt);
        const uniqueMention = position >= 0 && original.indexOf(excerpt, position + 1) < 0;
        const groundedAbbreviation = uniqueMention && member && [member.name, ...member.aliases].some(name => {
          const term = normalizeInputEvidence(name), start = original.indexOf(term);
          return start >= 0 && start <= position && start + term.length >= position + excerpt.length;
        });
        if (exact.length === 1 && groundedAbbreviation && response.metadata?.hint_source_bound !== true
          && (await organizationValues(this.request, raw)).length === 1 && !checkedEntity(response.metadata?.partialMembers)
          && response.candidates?.some(candidate => candidate.code === exact[0])) {
          // 确定身份来自完整原句或可信继承；模型缩写不是一次新的用户候选确认。
          const identity = await resolveTurnField(this.request, "organization", exact as string[], {signal: this.signal});
          if (identity.status === "resolved" && checkedEntity(identity.value)) response = {...identity, metadata: {...response.metadata, source_codes: exact}};
        }
      }
      const value = response.value;
      if (response.status !== "resolved" || !checkedEntity(value)) {
        if (previous?.resolutionStatus === "resolved" && operation.action === "set" && !hasInputEvidence(turn.originalMessage, raw)
          && !this.request.semanticStep?.analysis) {target.fields[field] = structuredClone(previous); return;}
        target.fields[field] = {rawValue: raw, resolutionStatus: response.status === "resolved" ? "temporary_error" : response.status,
          source: "explicit", resolver: entity, ...(response.candidates ? {candidates: response.candidates} : {}), metadata: {...response.metadata, proposalTurn: turn.operationId}};
        target.pending[field] = raw;
        const analysisPick = field === "metrics" && this.request.semanticStep?.analysis && !(await metricMentions(this.request)).mentions.length;
        // 零候选的 not_found 是死胡同澄清：必须引导用户改写，不能原样复读模型给出的错名。
        const noHit = entity === "organization" && response.status === "not_found" && !response.candidates?.length;
        if (entity === "organization" && response.metadata?.reason === "account_organization_unavailable")
          throw new SemanticConflict(issue("ACCOUNT_ORGANIZATION_UNAVAILABLE", field,
            "当前账号没有可用的所属机构，请说明‘我行’具体指哪家机构。", "user", "catalog"));
        throw new SemanticConflict(analysisPick ? issue("ANALYSIS_CATALOG_EVIDENCE_REQUIRED", field, "此分析选指标提案尚无正式目录身份，请先catalog检索相关业务类别，核对确定性命中后继续规划；不用让用户填写内部指标。", "pi", "catalog")
          : issue("ENTITY_NOT_DETERMINED", field, noHit
            ? `未找到名为「${raw}」的机构，请换个说法或回复机构全称。`
            : `请确定${field === "metrics" ? "指标口径" : "机构名称"}：${raw}。`, "user", "catalog"));
      }
      if (field === "metrics" && operation.action !== "confirm" && operation.action !== "exclude" && !this.request.semanticStep?.analysis) {
        const mentions = await metricMentions(this.request);
        const supported = new Set([...entityValue(previous).codes, ...mentions.mentions.flatMap(mention =>
          (mention.resolution.value as EntityValue | undefined)?.codes ?? [])]);
        const unsupported = value.codes.filter(code => !supported.has(code));
        // “明确口径优先”：同一基础指标换口径（“改成较上月”）可在本轮原文明确写出该口径时采用，
        // 不需要完整指标名再次出现在原句；基础名必须与已绑定指标一致，口径词必须来自本轮原文。
        type MetricBasis = {code?: string; base_name?: string; value_basis?: string};
        const previousBases = new Set(((previous?.metadata?.metrics as MetricBasis[] | undefined) ?? [])
          .map(item => item.base_name).filter((name): name is string => !!name));
        const proposedMetrics = (response.metadata?.metrics as MetricBasis[] | undefined) ?? [];
        const basisGrounded = !!unsupported.length && previousBases.size > 0 && unsupported.every(code => {
          const metric = proposedMetrics.find(item => item.code === code);
          return !!metric?.base_name && previousBases.has(metric.base_name) && !!metric.value_basis
            && normalizeInputEvidence(turn.originalMessage).includes(normalizeInputEvidence(metric.value_basis));
        });
        if (unsupported.length && !basisGrounded && !hasInputEvidence(turn.originalMessage, raw)) {
          await this.requireRecoveryAnalysis();
          if (previous) target.fields[field] = structuredClone(previous); else delete target.fields[field];
          return;
        }
      }
      if (entity === "organization" && operation.action !== "confirm" && operation.action !== "exclude"
        && !entityIsGrounded(value, previous, response.metadata?.source_codes, turn.originalMessage, raw)) {
        // 无依据的模型补值不成为用户条件；已有状态保留，真实缺项由统一出口询问。
        if (previous) target.fields[field] = structuredClone(previous); else delete target.fields[field];
        return;
      }
      let next = value;
      const actual = pendingAction ?? operation;
      const baseField = pendingAction ? pendingBaseline : previous;
      const before = entityValue(baseField);
      if (["replace", "exclude"].includes(actual.action) && baseField?.resolutionStatus !== "resolved") throw new SemanticConflict(issue("COLLECTION_SOURCE_UNRESOLVED", field,
        !baseField || baseField.resolutionStatus === "missing" ? "当前字段尚无原集合；新建完整条件应使用set，请根据用户原句修正操作。" : "原集合尚未确定，请先完成原有条件，不丢弃未决成员。",
        !baseField || baseField.resolutionStatus === "missing" ? "pi" : "user"));

      if (actual.action === "replace" || actual.action === "exclude") {
        const subject = actual.subject;
        const subjectResolution = actual.action === "exclude" ? response : await resolveTurnField(this.request, entity, entity === "organization" ? await organizationValues(this.request, subject) : [subject], {signal: this.signal});
        let found = subjectResolution.status === "resolved" && checkedEntity(subjectResolution.value) ? subjectResolution.value : undefined;
        // subject 证据放宽到被修改对象的已知身份：被引用/继承目标字段的正式名称、编码或原值。
        // 只有目录未命中且不在对象身份中的 subject 才判失败；value 的校验不因此放宽。
        if (!found) {
          const normalized = normalizeInputEvidence(subject);
          const identity = before.codes.flatMap((code, index) => {
            const name = before.names[index]!;
            return normalizeInputEvidence(code) === normalized || normalizeInputEvidence(name) === normalized ? [{code, name}] : [];
          });
          if (identity.length) found = {codes: identity.map(item => item.code), names: identity.map(item => item.name)};
        }
        if (!found || actual.action === "replace" && found.codes.some(code => !before.codes.includes(code))) throw new SemanticConflict(issue("SUBJECT_NOT_IN_TARGET", field, "请明确被替换的原成员。", "user"));
        next = updateCollection(before, actual.action, value, found)!;
      } else next = updateCollection(before, actual.action as "set" | "add" | "confirm", value)!;
      target.fields[field] = {...resolved(["add", "replace", "exclude"].includes(actual.action) ? next.names.join("、") : raw, next, entity), metadata: {...response.metadata, confirmed: operation.action === "confirm", confirmedBindings}};
      if (!next.codes.length) target.pending[field] = "集合为空，不能扩大成全部范围"; else delete target.pending[field];
      for (const [index, following] of pendingTail.entries()) {
        const baseline = structuredClone(target.fields[field]!);
        try {
          await this.apply(target, following, {...turn, originalMessage: pendingSource});
        }
        catch (error) {
          (target.pendingChanges ??= {})[field] = {operations: structuredClone(pendingTail.slice(index)), baseline, sourceMessage: pendingSource};
          throw error;
        }
      }
      if (pendingAction) target.fields[field]!.metadata = {...target.fields[field]!.metadata, resumedSourceMessage: pendingSource};
      return;
    }
    // 非集合字段的业务值由工具 Schema 约束；内部方法仅取值，不再产生重复形状错误。
    if (!("value" in operation)) return;
    if (field === "time") {
      // 宿主绑定的口径切换（前端 time_override）等同用户明确指定：跳过日历解析与模型换算。
      // 重建字段对象而不是合并旧 metadata，旧解析残留的 timeAlternative 备选口径不随新条件透传。
      if (this.request.timeOverride) {
        const {start, end} = this.request.timeOverride;
        target.fields.time = {rawValue: operation.value,
          resolvedValue: {start, end}, resolutionStatus: "resolved", source: "explicit", resolver: "date",
          metadata: {timeSource: "user_override"}};
        delete target.pending.time;
        return;
      }
      if (operation.action === "confirm") {
        const selected = await selectSavedCandidates(target, field, turn, this.request);
        const value = selected[0]?.metadata?.calendar as {start?: string; end?: string} | undefined;
        if (selected.length !== 1 || !value?.start || !value.end || !isCalendarDate(value.start) || !isCalendarDate(value.end) || value.start > value.end) {
          throw new SemanticConflict(issue("DATE_CANDIDATE_INVALID", field, "已保存日历候选不可用，请重新明确时间范围。", "user", "calendar"));
        }
        target.fields.time = {...resolved(String(selected[0]!.value), value, "date"), metadata: {...previous?.metadata, confirmed: true}};
        delete target.pending.time;
        return;
      }
      const old = previous?.resolvedValue as {start?: string; end?: string} | undefined;
      const year = this.request.semanticStep?.referenceYear ?? (old?.start?.slice(0, 4) === old?.end?.slice(0, 4) ? Number(old?.start?.slice(0, 4)) || undefined : undefined);
      if (operation.action === "replace") {
        const subject = await resolveTurnField(this.request, "date", [operation.subject], {signal: this.signal}, year,
          {business_date: turn.businessDate, source_question: operation.subject});
        const calendar = subject.value as {start?: string; end?: string; dates?: string[]} | undefined;
        if (previous?.resolutionStatus !== "resolved" || subject.status !== "resolved" || !calendar?.start || !calendar.end
          || calendar.start !== old?.start || calendar.end !== old?.end
          || JSON.stringify(calendar.dates ?? []) !== JSON.stringify((old as {dates?: string[]} | undefined)?.dates ?? [])) {
          throw new SemanticConflict(issue("FIELD_MEMBER_NOT_FOUND", field, "替换的时间与已选目标不一致，请核对引用；替换完整范围可使用set，不得忽略错误来源。"));
        }
        operation = {action: "set", field, value: operation.value, ...(operation.modelCalendar ? {modelCalendar: operation.modelCalendar} : {})};
      }
      // “较上月/较年初”等是指标价值口径：模型把它误当日期时，若同轮已提交含该口径的正式指标名，
      // 保留原日期条件不变，要求模型只改指标口径，不能把时间改成上月日期。
      const proposedMetric = turn.operations.metrics?.find(candidate => candidate.action === "set" && "value" in candidate);
      if (proposedMetric && "value" in proposedMetric) {
        const metricText = normalizeInputEvidence(proposedMetric.value), timeText = normalizeInputEvidence(operation.value);
        const previousMetric = turn.baseline?.fields.metrics;
        // 仅在“本轮切换了口径”且时间值恰为新指标名的口径后缀时判定；初始指标名中的
        // 口径不触发本规则，仍按真实缺日期澄清。
        const basisChange = previousMetric?.resolutionStatus === "resolved"
          && normalizeInputEvidence(String(previousMetric.rawValue ?? "")) !== metricText;
        if (basisChange && timeText.length >= 2 && timeText.length < metricText.length && metricText.endsWith(timeText)) {
          throw new SemanticConflict(issue("TIME_EXPRESSION_IS_METRIC_BASIS", field,
            "该表达是指标价值口径而非日期；请切换指标口径（metrics）并保持原日期条件，不提交 time 变更。", "pi", "calendar"));
        }
      }
      // 模型随原文提交的日历换算经 model_value 通道上送；形状由协议 Schema 约束，严格日历校验在服务端。
      const response = await resolveTurnField(this.request, "date", [operation.value], {signal: this.signal}, year,
        {business_date: turn.businessDate, source_question: turn.originalMessage}, operation.modelCalendar);
      let value = response.value as {start?: string; end?: string; dates?: string[]} | undefined;
      if (operation.action === "set" && this.boundCalendar && this.boundFacts?.question === turn.originalMessage
        && response.metadata?.resolution_source !== "model") {
        // 绑定阶段的完整日历是执行值；原表达仍用于口径说明，不把区间的一个端点当成整个范围。
        value = structuredClone(this.boundCalendar);
      }
      if (response.status !== "resolved" || !value?.start || !value.end || !isCalendarDate(value.start) || !isCalendarDate(value.end) || value.start > value.end) {
        target.fields.time = {rawValue: operation.value, resolutionStatus: response.status === "resolved" ? "temporary_error" : response.status,
          source: "explicit", resolver: "date", ...(response.candidates ? {candidates: response.candidates} : {}), metadata: {...response.metadata, proposalTurn: turn.operationId}};
        const reason = response.metadata?.reason;
        const unsupported = reason === "unsupported_expression";
        // 只给出一端的区间是用户缺项，不是模型能“换算”的歧义：保留已保存条件并追问缺失端。
        const incomplete = reason === "incomplete_range";
        throw new SemanticConflict(issue(unsupported ? "TIME_EXPRESSION_UNSUPPORTED" : incomplete ? "TIME_RANGE_INCOMPLETE" : "TIME_NOT_DETERMINED", field,
          unsupported ? "此时间表达尚未支持，请在同一Pi中解释为等价日历含义；不能改变原时间范围。"
            : incomplete ? "日期范围只明确了一端，请补充完整的起止日期。"
              : response.status === "ambiguous" ? "请确定日期范围的口径。" : "日期尚未确定或日历无效，请核对日期含义。", unsupported ? "pi" : "user", "calendar"));
      }
      if (value.dates !== undefined && (!Array.isArray(value.dates) || value.dates.length < 2 || !value.dates.every(isCalendarDate)
        || value.dates.some((date, i) => i > 0 && date <= value.dates![i - 1]!) || value.dates[0] !== value.start || value.dates.at(-1) !== value.end)) {
        throw new SemanticConflict(issue("DATE_SOURCE_RESPONSE_INVALID", field, "日期事实服务返回的离散时点不符合日历契约。", "retry", "infrastructure"));
      }
      target.fields.time = {...resolved(operation.value, value, "date"), metadata: {...response.metadata, ...(response.alternative ? {timeAlternative: response.alternative} : {})}};
    } else if (field === "selection") {
      const text = normalizeInputEvidence(operation.value);
      const meaning = ("selectionValue" in operation ? operation.selectionValue : undefined) ?? (/最新|最后|latest_in_range/u.test(text) ? "latest_in_range"
        : /全部|所有|完整|逐|各期|all_in_range/u.test(text) ? "all_in_range" : /指定|精确|exact/u.test(text) ? "exact" : undefined);
      // 模型提案无法解读（如只写“记录”）不是协议错误：转成可向用户回答的待补问题，保留范围和其他字段。
      if (!meaning) throw new SemanticConflict(issue("SELECTION_NOT_INTERPRETED", field, SELECTION_PENDING_QUESTION, "user"));
      const source = normalizeInputEvidence(turn.originalMessage);
      const anchor = meaning === "latest_in_range" ? /最新|最后|最近一期|末次/u.test(source)
        : meaning === "all_in_range" ? /所有|全部|完整|整个(?:月|月份|季度|期间|年份)|整(?:月|季|年)|逐日|每日|各期|序列|趋势|变化/u.test(source) : true;
      // 原句没有对应锚词（“记录”不等于全量）时不默认任何取数方式，只向用户追问。
      if (!anchor && !("structured" in operation && operation.structured) && !this.request.semanticStep?.analysis) throw new SemanticConflict(issue("SELECTION_SOURCE_NOT_ESTABLISHED", field,
        `原始问题尚未明确区间取数方式，不能默认最新一期或完整序列。${SELECTION_PENDING_QUESTION}`, "user"));
      target.fields.selection = resolved(operation.value, meaning, "enum");
    } else if (field === "objective") {
      target.fields.objective = resolved(operation.value, operation.value, "objective");
    } else if (field === "availability") {
      const dimension = /日期|时点|哪天/u.test(operation.value) ? "dates" : /指标/u.test(operation.value) ? "metrics" : undefined;
      if (!dimension) throw new SemanticConflict(issue("AVAILABILITY_NOT_DETERMINED", field, "请说明要发现有记录的指标，还是有记录的日期。", "user"));
      target.fields.availability = resolved(operation.value, dimension, "availability");
      target.fields.dimension = resolved(operation.value, dimension, "enum");
      target.fields.match = resolved(/共同|全部都有/u.test(operation.value) ? "共同记录" : "任意记录", /共同|全部都有/u.test(operation.value) ? "all" : "any", "enum");
      const page = /第\s*(\d+)\s*页/u.exec(operation.value)?.[1];
      target.fields.page = resolved(page ?? "第一页", page ? Number(page) : 1, "integer");
      target.fields.page_size = resolved("每页50项", 50, "integer");
    } else {
      // query意图在当前阶段只有原值取数；操作范围由完整原句和目录片段对账，不校验模型描述是否命中固定说法。
      target.fields.operation = resolved(operation.value, {kind: "value"}, "query_operation");
    }
    delete target.pending[field];
  }
  async compile(task: SemanticTask) {
    const capability = task.capability ?? "metric_query";
    if (!this.request.frames) throw new Error("SEMANTIC_FRAME_STORE_NOT_BOUND");
    const schema = createCapabilities().get(capability);
    // Frame 直接由工作状态字段投影生成；必需条件完整性由 resolve 的 blocked/ready 裁决保证。
    const fields = Object.fromEntries(Object.entries(structuredClone(task.target.fields)).filter(([name]) => name in schema.fields));
    const inherited = new Set(Object.values(fields).flatMap(field => Array.isArray(field.metadata?.inheritedFrameIds) ? field.metadata.inheritedFrameIds as string[] : []));
    const baseId = task.target.baseFrameId ?? (inherited.size === 1 ? [...inherited][0] : undefined);
    const base = baseId ? await this.request.frames.get(baseId) : undefined;
    if (baseId && (!base || base.sessionId !== this.request.sessionId)) throw new Error("SEMANTIC_FRAME_SOURCE_INVALID");
    const frame: BusinessFrame = {frameId: semanticRef(), sessionId: this.request.sessionId, turnId: this.request.operationId,
      requestId: this.request.requestId, capability, operationFrameId: semanticRef(), fields,
      ...(base ? {parentFrameId: base.frameId} : {}),
      // 执行帧只保留执行方式与基线关联；字段条件以 fields 投影为唯一依据，不再附变更清单。
      delta: {capabilityHint: capability, baseReference: base ? {frameId: base.frameId} : null, fieldChanges: [], executionMode: "execute"},
      issues: [], status: "ready", createdAt: new Date().toISOString()};
    return this.request.frames.save(frame, (await this.request.frames.state()).version, `semantic:${task.ref}:${task.revision}`);
  }
  async consume(taskRef: string, targetRef: string) {
    const task = await this.store.get(taskRef);
    if (!task || task.owner !== this.request.actor.id || task.target.ref !== targetRef) conflict("REFERENCE_INVALID", "当前执行引用不可用。");
    const permit = task.permit;
    if (task.parentPlan) {
      // 子步骤执行授权即 task.permit；这里只核对步骤仍绑定宿主定位到的计划及本轮版本。
      // 派生计划（reuse/续接）继承来源计划的 taskRef，task.parentPlan 指向源计划属合法绑定。
      const bound = this.request.semanticStep, plan = await this.store.plan(bound?.planRef ?? task.parentPlan);
      if (!bound || !plan || plan.owner !== this.request.actor.id
        || bound.revision !== plan.revision
        || !plan.steps.some(step => step.taskRef === task.ref && step.targetRef === targetRef)) conflict("PLAN_STEP_BINDING_INVALID", "当前步骤与完整任务的绑定已失效，请重新读取回执后执行。");
    }
    if (!permit || permit.consumed || task.target.status !== "ready" || permit.operationId !== this.request.operationId || permit.revision !== task.revision
      || permit.actor !== this.request.actor.id || permit.digest !== snapshotDigest(task.target) || Object.keys(task.target.pending).length || task.issues.length) {
      conflict("EXECUTION_PERMIT_INVALID", "执行许可缺失或已失效，不能直接执行Frame。");
    }
    for (const field of ["organizations", "metrics"] as const) {
      if (!task.target.fields[field]) continue;
      // 经营分析允许省略机构，由后端按认证账户取默认机构并重新鉴权；不能把缺省占位当空机构清单解析。
      // 显式机构、解析失败或其他能力的必填字段仍走原许可复核。
      if (field === "organizations" && ["business_overview", "business_analysis"].includes(task.capability ?? "")
        && task.target.fields[field].resolutionStatus === "missing") continue;
      const value = entityValue(task.target.fields[field]);
      const checked = await this.request.backend.resolveBusinessField(field === "metrics" ? "metric" : "organization", value.codes, {signal: this.signal});
      if (checked.status !== "resolved" || !checkedEntity(checked.value) || checked.value.codes.length !== value.codes.length
        || checked.value.codes.some(code => !value.codes.includes(code))) throw new SemanticConflict(issue("PERMISSION_DENIED", field,
        "目录身份或权限已变化，不能消费旧许可。", "stop", "permission"));
    }
    const index = await this.store.index();
    const latest = await this.store.get(task.ref);
    if (latest?.revision !== task.revision || latest.target.ref !== task.target.ref) conflict("REFERENCE_REVISION_CONFLICT", "许可复核期间目标已改变。");
    task.permit = {...permit, consumed: true};
    task.target.status = "executing"; task.status = "waiting_dependency";
    await this.store.save(task, index.version);
    return {task, frameId: permit.frameId};
  }
  async settle(task: SemanticTask, frame?: BusinessFrame) {
    const latest = await this.store.get(task.ref);
    if (!latest || latest.revision !== task.revision) return latest;
    latest.target.status = frame?.status === "success" ? "succeeded" : frame?.status === "failed" ? "failed" : "unknown";
    latest.status = frame?.status === "success" ? "completed" : frame?.status === "failed" ? "stopped" : "waiting_dependency";
    latest.completion = frame?.status === "success" && !frame.resultSummary?.truncated ? "full" : "unmet";
    if (frame?.status === "success" && (frame.resultSummary?.truncated || frame.resultSummary?.fields?.analysis_complete === false)) {
      latest.status = "active"; latest.completion = "partial";
    }
    await this.store.save(latest, (await this.store.index()).version, undefined, false);
    return latest;
  }
}
