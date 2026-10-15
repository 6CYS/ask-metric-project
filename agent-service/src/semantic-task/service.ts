import {createHash} from "node:crypto";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {metricMentions} from "../business-context/metricMentions.js";
import {hasInputEvidence, normalizeInputEvidence} from "../business-context/inputEvidence.js";
import {metricCoverageSource} from "../business-context/adapters.js";
import {completeQuery, isTransitionField, transitionValue, transitionBasis, type SemanticChange} from "./transition.js";
import {isCalendarDate} from "../tools/shared.js";
import {validateFrame} from "../business-context/core.js";
import {normalizeQueryOperation} from "../business-context/rankingEvidence.js";
import {createCapabilities} from "../business-context/capabilities.js";
import type {BusinessFrame, FieldCandidate, FieldResolution, MentionResolution, ResolvedField} from "../business-context/types.js";
import type {SemanticOperation, SemanticRequest, SemanticSource} from "./protocol.js";
import {semanticRef, type SemanticIssue, type SemanticTarget, type SemanticTask, type SemanticTurn} from "./store.js";

type EntityValue = {codes: string[]; names: string[]};
const entityValue = (field?: ResolvedField): EntityValue => field?.resolvedValue as EntityValue ?? {codes: [], names: []};
const resolved = (rawValue: string, resolvedValue: unknown, resolver: string): ResolvedField => ({rawValue, resolvedValue, resolver, resolutionStatus: "resolved", source: "explicit"});
const sourceKey = (source: SemanticSource) => JSON.stringify(source);
export const snapshotDigest = (target: SemanticTarget) => createHash("sha256").update(JSON.stringify(target.fields)).digest("hex");
const issue = (code: string, field: string, message: string, remediation: SemanticIssue["remediation"] = "pi", category = "semantic"): SemanticIssue => ({code, field, message, remediation, category});
export class SemanticConflict extends Error {constructor(readonly issue: SemanticIssue) {super(issue.code);}}
function conflict(code: string, message: string): never {throw new SemanticConflict(issue(code, "objective", message, "pi", "reference"));}
const emptyTarget = (): SemanticTarget => ({ref: semanticRef(), fields: {}, pending: {}, status: "draft"});
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
function candidateOrdinal(clause: string): {field?: string; index: number} | undefined {
  const matched = /^(?:(指标|机构|日期)(?:选|用|就用)?|选|用|就用)?第?([一二两三四五六七八九十\d]+)(?:个|项|号)(?:候选)?[！!。\s]*$/u.exec(clause.trim());
  if (!matched) return;
  const digits: Record<string, number> = {一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10};
  const index = /^\d+$/u.test(matched[2]!) ? Number(matched[2]) : digits[matched[2]!];
  return index ? {index: index - 1, ...(matched[1] ? {field: matched[1] === "指标" ? "metrics" : matched[1] === "机构" ? "organizations" : "time"} : {})} : undefined;
}
function selectSavedCandidates(target: SemanticTarget, field: string, turn: SemanticTurn): FieldCandidate[] {
  const previous = target.fields[field], candidates = previous?.candidates ?? [];
  if (!previous || previous.resolutionStatus === "resolved" || !candidates.length) throw new SemanticConflict(issue("CONFIRMATION_NOT_AVAILABLE", field,
    "该字段没有待选择的候选，不能confirm。已确认条件继续查询时使用query并沿用source，不重写未变化字段；只有真实未决候选才需要用户选择。"));
  const clauses = turn.originalMessage.split(/[，,。；;]|但是|不过|但/u);
  // 只用真实用户原句选择已保存候选，模型填写的确认文本不能建立选择事实。
  const acceptable = candidates.filter(candidate => {
    if (typeof candidate.value !== "string") return false;
    // 日历候选的名称与括号内范围是同一已保存身份；用户按唯一名称选择时无需复述展示附注。
    const calendar = field === "time" && candidate.metadata?.calendar;
    const label = calendar ? candidate.value.split(/[（(]/u)[0]!.trim() : undefined;
    const uniqueLabel = label && candidates.filter(item => typeof item.value === "string" && item.value.split(/[（(]/u)[0]!.trim() === label).length === 1;
    return clauses.some(clause => (hasInputEvidence(clause, candidate.value as string) || uniqueLabel && hasInputEvidence(clause, label!))
      && !(field === "time" && /^\s*(?:指标|机构)(?:选|用|就用|改|为|是)/u.test(clause))
      && !/(?:不(?:要|用|选|是|需要)|别(?:用|选)|取消)/u.test(clause));
  });
  const pending = Object.entries(target.fields).filter(([, value]) => value.resolutionStatus !== "resolved" && value.candidates?.length).map(([name]) => name);
  const ordinal = clauses.map(candidateOrdinal).find(choice => choice && (choice.field === field || !choice.field && pending.length === 1));
  const accepts = pending.length === 1 && clauses.some(clause => /^(?:好(?:的)?|是(?:的)?|可以|确认|同意|就按你说的)[！!。\s]*$/u.test(clause.trim()));
  // 首推确认的“是”：恰有一个首选候选（后端或模型建议通道标记）时视为确认首选，与确认式话术一致。
  const preferred = candidates.filter(candidate => candidate.preferred === true);
  const selected = ordinal && candidates[ordinal.index] ? [candidates[ordinal.index]!] : acceptable.length ? acceptable
    : accepts && (candidates.length === 1 || preferred.length === 1) ? (candidates.length === 1 ? candidates : preferred) : [];
  if (!previous || !["needs_confirmation", "ambiguous", "not_found"].includes(previous.resolutionStatus) || !selected.length
    || previous.metadata?.proposalTurn === turn.operationId) throw new SemanticConflict(issue("CONFIRMATION_NOT_ESTABLISHED", field,
    "请明确选择已保存候选；其它字段中的数字和否定表述不能确认此项。", "user", "catalog"));
  return selected;
}
export function explicitOrganizationCount(question: string): number | undefined {
  const raw = /(?:以上|上述|这|共)?([一二两三四五六七八九十\d]+)家/u.exec(question)?.[1];
  if (!raw) return;
  if (/^\d+$/u.test(raw)) return Number(raw);
  const digits: Record<string, number> = {一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
  if (raw === "十") return 10;
  if (raw.includes("十")) {const [a, b] = raw.split("十"); return (a ? digits[a]! : 1) * 10 + (b ? digits[b]! : 0);}
  return digits[raw];
}

/** Pi 提议语义，宿主绑定目录及原始义务；这里不调用另一个模型理解原句。 */
export class SemanticTaskService {
  constructor(private readonly request: AskMetricRequestContext, private readonly signal?: AbortSignal) {}
  private get store() {if (!this.request.semanticTasks) throw new Error("SEMANTIC_STORE_NOT_BOUND"); return this.request.semanticTasks;}
  async resolve(input: SemanticRequest): Promise<{task?: SemanticTask; status: string; issues?: SemanticIssue[]}> {
    const turn = await this.store.admit(this.request.operationId, this.request.originalMessage);
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
    if (input.intent === "reuse") return {task, status: task.target.status === "succeeded" ? "reused" : "needs_user"};
    if (task.permit?.consumed && task.permit.operationId === turn.operationId) return {task, status: task.target.status === "succeeded" ? "succeeded" : task.target.status === "failed" ? "failed" : "unknown"};
    if (["executing", "unknown"].includes(task.target.status)) return {task, status: "unknown"};
    // 纠错只替换本字段提案；其它有效值和未决新值均不能因省略而丢失。
    for (const field of new Set(proposal.operations.map(operation => operation.field))) {
      turn.operations[field] = proposal.operations.filter(operation => operation.field === field);
    }
    const target = structuredClone(turn.baseline!);
    const priorMetricSource = turn.baseline?.metricSource ?? turn.baseline?.coverage?.question;
    if (turn.operations.metrics) target.metricSource = priorMetricSource ? priorMetricSource + "\n" + turn.originalMessage : turn.originalMessage;
    for (const field of Object.values(target.fields)) field.source = "inherited";
    if (target.fields.metrics?.metadata) delete target.fields.metrics.metadata.semanticSelectionReceipt;
    target.ref = semanticRef();
    target.status = "draft";
    const baseFrameId = turn.baseline?.frameId ?? turn.baseline?.baseFrameId;
    if (baseFrameId) target.baseFrameId = baseFrameId; else delete target.baseFrameId;
    delete target.frameId;
    task.issues = [];
    const removed = new Set<string>();
    const derivedChanges: SemanticChange[] = [];
    const appliedChanges: SemanticChange[] = [];
    for (const operations of Object.values(turn.operations)) {
      const field = operations[0]!.field;
      const cached = task.target.fields[field];
      if (cached?.resolutionStatus === "resolved" && !task.target.pending[field]
        && cached.metadata?.semanticTurn === turn.operationId && cached.metadata?.semanticOperations === JSON.stringify(operations)) {
        target.fields[field] = structuredClone(cached);
        appliedChanges.push(...structuredClone(cached.metadata?.transitionChanges as SemanticChange[] ?? []));
        if (field === "availability") {
          // 一个语义字段编译出多个执行字段；修复其它字段时须复用整份规范结果，不能只保留入口字段。
          for (const derived of ["dimension", "match", "page", "page_size"]) {
            const value = task.target.fields[derived];
            if (value) target.fields[derived] = structuredClone(value);
          }
        }
        delete target.pending[field];
        if (field === "metrics") entityValue(turn.baseline?.fields.metrics).codes.filter(code => !entityValue(cached).codes.includes(code)).forEach(code => removed.add(code));
        continue;
      }
      if (operations.filter(operation => operation.action === "set" || operation.action === "clear").length > 1) {
        target.pending[field] = `同一目标的${field}只能有一次set或clear。多个成员请用一次set，value写完整业务清单；修正本字段operations后重提，不能重复冲突动作。`;
        task.issues.push(issue("CONFLICTING_OPERATIONS", field, target.pending[field]!));
        continue;
      }
      const fieldChanges: SemanticChange[] = [];
      for (const operation of operations) {
        try {
          const before = isTransitionField(field) ? transitionValue(target, field) : undefined;
          await this.apply(target, operation, turn, removed);
          if (isTransitionField(field)) {const change: SemanticChange = {field, action: ["copy", "select", "rank_all"].includes(operation.action) ? "set" : operation.action as SemanticChange["action"], before, after: transitionValue(target, field)}; fieldChanges.push(change); appliedChanges.push(change);}
          const normalized = target.fields[field];
          if (normalized) normalized.metadata = {...normalized.metadata,
            semanticTurn: turn.operationId, semanticOperations: JSON.stringify(operations), transitionChanges: structuredClone(fieldChanges)};
          if (!target.pending[field]) delete target.pendingChanges?.[field];
        }
        catch (error) {
          const diagnostic = error instanceof BackendApiError && [401, 403].includes(error.status)
            ? issue("PERMISSION_DENIED", field, "当前身份无权继续此范围，已保留有效条件和待修提案。", "stop", "permission") : error instanceof SemanticConflict ? error.issue
            : issue("FIELD_SOURCE_UNAVAILABLE", field, "字段事实服务暂不可用，已保留本轮提案。", "retry", "infrastructure");
          target.pending[field] = "value" in operation ? operation.value : "subject" in operation ? operation.subject : "待清除";
          if (operation.action !== "confirm" || !target.pendingChanges?.[field]) {
            (target.pendingChanges ??= {})[field] = {operations: structuredClone(operations),
              ...(turn.baseline?.fields[field] ? {baseline: structuredClone(turn.baseline.fields[field])} : {}), sourceMessage: turn.originalMessage};
          }
          // 无来源的模型复述没有获准成为用户变更；Pi按回执省略该字段即可恢复冻结基线。
          if (diagnostic.code === "CONFIRMATION_NOT_AVAILABLE" || diagnostic.code === "ENTITY_SOURCE_NOT_ESTABLISHED" && "value" in operation && !hasInputEvidence(turn.originalMessage, operation.value)) {
            delete turn.operations[field];
            if (turn.baseline?.fields[field]) target.fields[field] = structuredClone(turn.baseline.fields[field]!);
            else delete target.fields[field];
            delete target.pendingChanges?.[field]; delete target.pending[field];
          }
          task.issues.push(diagnostic);
        }
      }
    }
    if (task.issues.some(item => item.category === "permission")) {
      task = {...task, revision: task.revision + 1, target: {...target, status: "blocked"}, status: "stopped", completion: "unmet"};
      delete task.permit;
      await this.store.save(task, (await this.store.index()).version, turn);
      return {task, status: "denied"};
    }
    if (this.request.semanticStep?.kind === "query" && (turn.operations.operation || turn.baseline?.fields.operation?.resolutionStatus !== "resolved")) {
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
        const beforeOperation = transitionValue(target, "operation");
        target.fields.operation = {...resolved(typeof description?.value === "string" ? description.value : "查询操作", ranking.value, "query_operation"), source: "resolved", ...(target.fields.operation?.metadata ? {metadata: target.fields.operation.metadata} : {})};
        delete target.pending.operation;
        if (JSON.stringify(beforeOperation) !== JSON.stringify(ranking.value)) derivedChanges.push({field: "operation", action: "set", before: beforeOperation, after: ranking.value});
        // 原句事实已独立规范化此字段，不能同时保留早先动作不兼容的过期错误，制造已解决但仍待修的状态。
        task.issues = task.issues.filter(item => item.field !== "operation" || !["FIELD_ACTION_INCOMPATIBLE", "RANKING_NOT_DETERMINED"].includes(item.code));
        delete target.pendingChanges?.operation;
      }
      else {target.pending.operation = "请明确榜单的前后方向和条数，或关注对象位次"; task.issues.push(issue("RANKING_NOT_DETERMINED", "operation", target.pending.operation, "user"));}
    }
    const operationKind = (target.fields.operation?.resolvedValue as {kind?: string} | undefined)?.kind;
    if (target.fields.organizations?.metadata?.resultSelection && !turn.operations.operation) {
      target.pending.operation = "选择原结果成员后，请显式说明本轮是普通取值还是重新排序；普通取值用operation:set的value=普通取值。";
      task.issues.push(issue("RESULT_SELECTION_OPERATION_REQUIRED", "operation", target.pending.operation, "pi"));
    }
    if (this.request.semanticStep?.kind === "query" && target.fields.operation?.resolutionStatus === "resolved" && operationKind !== "rank_position") {
      const organizations = target.fields.organizations, metadata = organizations?.metadata;
      const anchored = metadata?.source_codes;
      if (Array.isArray(anchored) && anchored.length && anchored.every(code => typeof code === "string")
        && turn.operations.comparison_organizations && turn.operations.organizations?.every(operation => operation.action === "set")
        && (metadata?.semanticTurn === turn.operationId || metadata?.proposalTurn === turn.operationId)) {
        const exact = await this.request.backend.resolveBusinessField("organization", anchored as string[], {signal: this.signal});
        if (exact.status === "resolved" && checkedEntity(exact.value) && exact.value.codes.length === anchored.length) {
          target.fields.organizations = {...resolved(exact.value.names.join("、"), exact.value, "organization"), source: "resolved", metadata: {...metadata, source_codes: anchored}};
          delete target.pending.organizations; task.issues = task.issues.filter(item => item.field !== "organizations");
        }
      }
      // 比较总体只属于对象位次。原值/榜单的完整机构已由原句事实绑定，口径误放到此字段不能变成用户缺项。
      if (target.fields.organizations?.resolutionStatus === "resolved") {
        const beforeComparison = transitionValue(target, "comparison_organizations") as string[];
        if (beforeComparison.length) derivedChanges.push({field: "comparison_organizations", action: "clear", before: beforeComparison, after: []});
        delete target.fields.comparison_organizations; delete target.pending.comparison_organizations;
        task.issues = task.issues.filter(item => item.field !== "comparison_organizations");
      }
    }
    const quantity = this.request.semanticStep && (operationKind === "ranking" || this.request.semanticStep.jointCoverage && operationKind !== "rank_position")
      ? undefined : explicitOrganizationCount(turn.originalMessage);
    const quantityField = operationKind === "rank_position" && this.request.semanticStep ? "comparison_organizations" : "organizations";
    if (this.request.semanticStep && quantity !== undefined && entityValue(target.fields[quantityField]).codes.length !== quantity) {
      const anchored = target.fields[quantityField]?.metadata?.source_codes ?? target.fields.organizations?.metadata?.source_codes;
      if (Array.isArray(anchored) && anchored.length === quantity && anchored.every(code => typeof code === "string")
        && (quantityField !== "comparison_organizations" || entityValue(target.fields.organizations).codes.every(code => anchored.includes(code)))) {
        const exact = await this.request.backend.resolveBusinessField("organization", anchored as string[], {signal: this.signal});
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
    let missingFacts: Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>> | undefined;
    for (const field of required) {
      if (!target.fields[field] || target.fields[field]!.resolutionStatus !== "resolved"
        || ["organizations", "comparison_organizations", "metrics"].includes(field) && !entityValue(target.fields[field]).codes.length) {
        target.pending[field] ??= typeof target.fields[field]?.rawValue === "string" ? target.fields[field]!.rawValue as string : "尚未确定";
        if (this.request.semanticStep) missingFacts ??= await this.request.backend.inspectBusinessGoal(turn.originalMessage, turn.businessDate, {signal: this.signal}, this.request.semanticStep.referenceYear);
        const supplied = missingFacts?.fragments.some(fragment => field === "organizations" ? fragment.organizations.length > 0
          : field === "metrics" ? fragment.mentions.some(mention => mention.resolution.status === "resolved")
          : field === "time" ? fragment.calendar.ranges.length > 0 && !fragment.calendar.unresolved.length
          : field === "comparison_organizations" ? fragment.organizations.length > 1 : false);
        const name = ({organizations: "机构", metrics: "指标", time: "日期范围", comparison_organizations: "位次比较总体", availability: "要发现指标还是日期"} as Record<string,string>)[field];
        // 占位机构来自模型而非用户；真实原句有实体时由Pi修提案，否则只询问真正缺少的业务条件。
        const proposed = turn.operations[field]?.find(operation => operation.action === "set");
        const raw = target.fields[field]?.rawValue ?? (proposed && "value" in proposed ? proposed.value : undefined);
        const inventedEntity = field === "organizations" && missingFacts && typeof raw === "string" && !hasInputEvidence(turn.originalMessage, raw)
          && turn.baseline?.fields[field]?.resolutionStatus !== "resolved" && task.issues.some(item => item.field === field
            && (item.code === "ENTITY_NOT_DETERMINED" || !supplied && item.code === "ENTITY_SOURCE_NOT_ESTABLISHED"));
        if (inventedEntity) {
          task.issues = task.issues.filter(item => item.field !== field || !["ENTITY_NOT_DETERMINED", "ENTITY_SOURCE_NOT_ESTABLISHED"].includes(item.code));
          target.fields[field] = {resolutionStatus: "missing", source: "explicit", resolver: "organization"};
          target.pending[field] = "尚未确定";
        }
        if (!task.issues.some(item => item.field === field)) {
          task.issues.push(issue(supplied ? "PROPOSAL_FIELD_OMITTED" : "FIELD_REQUIRED", field,
            supplied ? `原始目标已提供${name}，请按原始绑定补齐或重组提案，不能把内部遗漏转成用户缺项。` : `请补充或确定${name}。`, supplied ? "pi" : "user"));
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
    if (!availability && target.fields.time?.resolutionStatus === "resolved" && (time?.start === time?.end && !time?.dates || time?.dates && (!target.fields.selection || target.pending.selection))) {
      target.fields.selection = {...resolved("指定日期", "exact", "enum"), source: "resolved"};
      delete target.pending.selection;
      delete target.pendingChanges?.selection;
      task.issues = task.issues.filter(item => item.field !== "selection");
    }
    const selection = target.fields.selection?.resolvedValue;
    if (!availability && target.fields.time?.resolutionStatus === "resolved" && (!selection || selection === "exact" && time?.start !== time?.end && !time?.dates)) {
      target.pending.selection ??= "需要确定在区间内取最新一期，还是全部已有数据点";
      if (!task.issues.some(item => item.field === "selection")) task.issues.push(issue("TIME_SELECTION_REQUIRED", "selection", target.pending.selection, "user"));
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
    if (target.fields.metrics?.metadata) delete target.fields.metrics.metadata.semanticSelectionReceipt;
    if (!availability && target.fields.metrics?.resolutionStatus === "resolved" && !task.issues.some(item => item.category === "permission")) {
      const before = completeQuery(turn.baseline!);
      if (this.request.semanticStep?.kind === "query" && before) {
        const prior = turn.baseline!, receipt = prior.fields.metrics?.metadata?.semanticSelectionReceipt;
        const coverage = prior.coverage ? metricCoverageSource(prior.coverage.question, prior.coverage.mentions, prior.coverage.removed) : undefined;
        const normalized = appliedChanges;
        target.transition = {before, changes: structuredClone([...normalized, ...derivedChanges]), ...(typeof receipt === "string" ? {source_semantic_receipt: receipt} : {}),
          ...(coverage ? {source_question: coverage.source_question, bindings: coverage.source_metric_bindings, exclusions: coverage.source_metric_exclusions} : {}),
          field_sources: appliedChanges.flatMap(change => {
            const metadata = target.fields[change.field]?.metadata;
            return metadata?.semanticTurn === turn.operationId && metadata.fieldSource ? [metadata.fieldSource as NonNullable<import("./transition.js").SemanticTransition["field_sources"]>[number]] : [];
          })};
      } else delete target.transition;
      if (target.transition && task.issues.length && !task.issues.some(item => item.field === "metrics")) {
        const identities = entityValue(target.fields.metrics);
        const supplied = originalMetrics.mentions.flatMap(mention => (mention.resolution.value as EntityValue | undefined)?.codes ?? []);
        if (identities.codes.every(code => target.transition!.before.metric_codes.includes(code) || supplied.includes(code))) {
          // 部分条件未完成时，只保存已核验指标子状态；没有整批签票，仍不能执行。
          const question = identities.names.join("、"), basisRequest = {...this.request, originalMessage: question}; delete basisRequest.metricMentions;
          const basis = await metricMentions(basisRequest);
          const known = basis.mentions.flatMap(mention => (mention.resolution.value as EntityValue | undefined)?.codes ?? []);
          if (identities.codes.every(code => known.includes(code)) && known.every(code => identities.codes.includes(code))) {
            target.coverage = {question, mentions: basis.mentions.map(mention => ({text: mention.text, start: mention.start, end: mention.end, status: "resolved", value: mention.resolution.value as EntityValue})), removed: []};
            target.metricSource = question;
          }
        } else task.issues.push(issue("ENTITY_SOURCE_NOT_ESTABLISHED", "metrics", "未完成目标中的新增指标仍需有本轮目录身份依据，不能借待补日期接纳额外指标。"));
      }
      const permit = this.request.semanticStep?.analysisSelection;
      if (permit && JSON.stringify([...permit.codes].sort()) === JSON.stringify([...entityValue(target.fields.metrics).codes].sort())
        && JSON.stringify([...permit.orgs].sort()) === JSON.stringify([...entityValue(target.fields.organizations).codes].sort())
        && JSON.stringify(permit.time) === JSON.stringify(target.fields.time?.resolvedValue)) {
        target.fields.metrics.metadata = {...target.fields.metrics.metadata, semanticSelectionReceipt: permit.receipt, origin: this.request.semanticStep?.analysis ? "analysis_selected" : "user_explicit"};
        // 同轮签发后的重放必须沿用已核验的替换/排除快照；共享目标的单步骤则由整批签发回执证明其范围。
        const checked = task.target.coverage, selected = entityValue(target.fields.metrics).codes;
        const covered = checked?.mentions.flatMap(mention => mention.value?.codes ?? []) ?? [];
        if (checked && checked.question === target.metricSource && selected.every(code => covered.includes(code))
          && covered.every(code => selected.includes(code))) target.coverage = structuredClone(checked);
        else delete target.coverage;
        if (target.transition) {
          // 已签发范围的指标身份形成下一轮可继承覆盖基准；原句、排除动作及完整前后状态仍保存在任务/Frame来源链。
          // 这也支持后续清空日期等未完成状态，不把更早被替换的指标重新扫描成新义务。
          const identities = entityValue(target.fields.metrics), question = identities.names.join("、");
          const basisRequest = {...this.request, originalMessage: question}; delete basisRequest.metricMentions;
          const basis = await metricMentions(basisRequest);
          const covered = basis.mentions.flatMap(mention => (mention.resolution.value as EntityValue | undefined)?.codes ?? []);
          if (basis.mentions.length && identities.codes.every(code => covered.includes(code)) && covered.every(code => identities.codes.includes(code))) {
            target.coverage = {question, mentions: basis.mentions.map(mention => ({text: mention.text, start: mention.start, end: mention.end, status: "resolved", value: mention.resolution.value as EntityValue})), removed: []};
            target.metricSource = question;
          }
        }
      } else {
      const coverage = target.transition ? {issues: task.issues.length ? [] : [issue("TRANSITION_ADMISSION_REQUIRED", "metrics", "跨轮变更已保存，等待整批准入对账；准入未通过的真实原因见同一回执的其他 issue，请按其指引修正或等待用户回复，不要原样重提相同提案。")]} : await this.coverage(target, turn, removed);
      if (this.request.semanticStep?.analysis && coverage.issues.length && !coverage.issues.some(item => item.category === "permission")) {
        coverage.issues = [issue("ANALYSIS_SELECTION_REQUIRED", "metrics", "分析选指标需绑定本次实际目录回执及执行范围；先查阅目录，再沿用目标重提。")];
      }
      task.issues.push(...coverage.issues);
      if (coverage.snapshot) target.coverage = coverage.snapshot;
      }
    }
    if (!availability && (operationKind === "ranking" || operationKind === "rank_position") && (selection === "all_in_range" || time?.dates)) {
      target.pending.selection = "当前后端尚不支持逐日或离散日期排名";
      task.issues.push(issue("QUERY_COMBINATION_UNSUPPORTED", "selection", target.pending.selection, "stop", "capability"));
    }
    if (this.request.semanticStep) {
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
    if (task.issues.length || Object.keys(target.pending).length) target.status = "blocked";
    task = {...task, revision: task.revision + 1, target, status: task.issues.some(item => item.category === "permission") ? "stopped"
      : task.issues.some(item => item.remediation === "user") ? "waiting_input" : "active", completion: "unmet"};
    delete task.permit;
    const index = await this.store.index();
    if (target.status !== "blocked" && input.intent === "query") {
      const frame = await this.compile(task);
      target.frameId = frame.frameId;
      target.status = "ready";
      task.permit = {operationId: this.request.operationId, revision: task.revision, frameId: frame.frameId,
        digest: snapshotDigest(target), actor: this.request.actor.id, consumed: false};
    }
    await this.store.save(task, index.version, turn);
    return {task, status: task.issues.some(item => item.category === "permission") ? "denied"
      : task.issues.some(item => item.remediation === "stop" && item.category === "capability") ? "unsupported"
      : target.status === "blocked" ? task.issues.some(item => item.remediation !== "user") ? "needs_interpretation" : "needs_user"
      : input.intent === "prepare" ? "prepared" : "ready"};
  }
  private async bind(turn: SemanticTurn, source: SemanticSource): Promise<SemanticTask> {
    if (source.kind === "references") conflict("GROUP_SOURCE_NOT_EXPANDED", "多个来源须经过整笔计划展开与准入，不能直接执行单个子任务。");
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
    turn.boundTask = task.ref;
    turn.source = structuredClone(source);
    turn.baseline = structuredClone(task.target);
    await this.store.save(task, (await this.store.index()).version, turn);
    return task;
  }
  private async apply(target: SemanticTarget, operation: SemanticOperation, turn: SemanticTurn, removed: Set<string>) {
    const field = operation.field;
    if (operation.action === "rank_all") {
      target.fields.operation = {rawValue: "排序全部已选机构", resolutionStatus: "ambiguous", source: "explicit", metadata: {allMembersRanking: operation.direction}};
      delete target.pending.operation; return;
    }
    if (operation.action === "copy") {
      if (!isTransitionField(field)) throw new SemanticConflict(issue("FIELD_COPY_UNSUPPORTED", field, "只能复制完整业务条件字段，不能复制目标说明或计算公式。"));
      const reference = operation.reference;
      const parent = await this.store.plan(reference.task_ref), step = parent?.steps.find(item => item.targetRef === reference.target_ref);
      const source = step?.taskRef ? await this.store.get(step.taskRef) : undefined;
      const basis = source ? transitionBasis(source.target) : undefined, value = source?.target.fields[field];
      if (!parent || parent.owner !== this.request.actor.id || !basis || value?.resolutionStatus !== "resolved") throw new SemanticConflict(issue("FIELD_COPY_SOURCE_INVALID", field, "字段来源尚未完整确认，请定向读取历史后选择有效引用。", "pi", "reference"));
      const {changes: _changes, ...fieldSource} = basis;
      target.fields[field] = {...structuredClone(value), source: "inherited", metadata: {...value.metadata, fieldSource: {field, ...fieldSource}}};
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
      const resolution = await this.request.backend.resolveBusinessField("organization", codes, {signal: this.signal});
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
    if (operation.action === "set" && previous?.resolutionStatus !== "resolved" && previous?.candidates?.length) {
      try {
        selectSavedCandidates(target, field, turn);
        // 用户已选择保存候选时，set和confirm都绑定同一选择；不能由模型措辞改变所选身份。
        operation = {...operation, action: "confirm"};
      } catch (error) {
        if (!(error instanceof SemanticConflict) || error.issue.code !== "CONFIRMATION_NOT_ESTABLISHED") throw error;
      }
    }
    if (field === "operation") {
      if (operation.action !== "set") throw new SemanticConflict(issue("FIELD_ACTION_INCOMPATIBLE", field, "操作类型使用set明确表达本轮目的。"));
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
      let response: FieldResolution;
      let usedOrgSuggestion = false;
      let pendingAction: SemanticOperation | undefined;
      let pendingBaseline: ResolvedField | undefined;
      let pendingSource = turn.originalMessage;
      let confirmedBindings = {...previous?.metadata?.confirmedBindings as Record<string, string[]> | undefined};
      if (operation.action === "confirm") {
        const selected = selectSavedCandidates(target, field, turn);
        response = await this.request.backend.resolveBusinessField(entity, selected.map(candidate => candidate.code ?? String(candidate.value)), {signal: this.signal});
        raw = selected.map(candidate => String(candidate.value)).join("、");
        const partial = previous?.metadata?.partialMembers;
        if (response.status === "resolved" && checkedEntity(response.value)) {
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
        } else if (response.candidates && selected.length === 1) {
          response = {...response, candidates: response.candidates.map(candidate => ({...candidate, metadata: {...candidate.metadata,
            semanticSpan: selected[0]!.metadata?.semanticSpan}})), metadata: {...response.metadata, ...(checkedEntity(partial) ? {partialMembers: partial} : {}), confirmedBindings}};
        }
        const pending = target.pendingChanges?.[field];
        if (pending) {
          if (pending.operations.length !== 1) throw new SemanticConflict(issue("CONFIRMATION_CHANGE_AMBIGUOUS", field, "该候选关联多个尚未确定的集合修改，需要先明确完整变更。", "user"));
          pendingAction = pending.operations[0]; pendingBaseline = pending.baseline; pendingSource = pending.sourceMessage;
        }
      } else {
        // 模型按有权机构清单自主判断的结论：豁免原文子串与锚定校验，成员校验与编码来源由后端裁定。
        const suggestion = entity === "organization" && (operation.action === "set" || operation.action === "replace")
          && "suggestion" in operation ? operation.suggestion : undefined;
        if (suggestion) {
          const code = typeof suggestion.code === "string" && suggestion.code.trim() ? suggestion.code.trim() : undefined;
          const name = typeof suggestion.name === "string" && suggestion.name.trim() ? suggestion.name.trim() : undefined;
          const excerpt = typeof suggestion.excerpt === "string" && suggestion.excerpt.trim() ? suggestion.excerpt.trim() : undefined;
          if (!code && !name) throw new SemanticConflict(issue("ORG_SUGGESTION_INVALID", field,
            "suggestion 至少提交有权机构清单中的编码或名称之一，excerpt 为用户原文片段；无法判断时按业务表达提交 value 或澄清。", "pi", "catalog"));
          usedOrgSuggestion = true;
          response = await this.request.backend.resolveBusinessFieldSuggestion(entity,
            [{...(code ? {code} : {}), ...(name ? {name} : {}), ...(excerpt ? {excerpt} : {})}], {signal: this.signal}, turn.originalMessage);
          // 建议未唯一命中但其值在候选中时标记首推，澄清话术改为确认式。
          if (response.candidates?.length) response = {...response, candidates: response.candidates.map(candidate =>
            candidate.preferred === true || !!(code && candidate.code === code) || !!(name && candidate.value === name)
              ? {...candidate, preferred: true} : candidate)};
          response = {...response, metadata: {...response.metadata, ...(excerpt ? {rawExcerpt: excerpt} : {})}};
        } else if (entity === "organization" && /全部|所有|各家|全省|下辖|下属/u.test(raw)) {
          const cohort = /农商|农村商业银行/u.test(raw) && !/下辖|下属/u.test(raw);
          const parentName = raw.split(/(?:的)?(?:下辖|下属)/u)[0]?.replace(/^(?:查询|查看|分析|查)/u, "").trim();
          if (!cohort && (!parentName || !hasInputEvidence(turn.originalMessage, parentName))) throw new SemanticConflict(issue("ORGANIZATION_SCOPE_NOT_DETERMINED", field, "下辖范围需要明确上级机构，不能按词语扩大范围。", "user"));
          response = await this.request.backend.resolveOrganizationScope(cohort ? {kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: turn.originalMessage}
            : {kind: "children_of", parentName: parentName!, sourceText: turn.originalMessage}, {signal: this.signal});
          if (response.status === "resolved" && checkedEntity(response.value)) response.metadata = {...response.metadata, source_codes: response.value.codes};
        } else {
        response = await this.request.backend.resolveBusinessField(entity, entity === "organization" ? splitNames(raw) : [raw], {signal: this.signal}, undefined, source);
        }
        if (entity === "metric" && operation.action !== "exclude") {
          const original = await metricMentions(this.request);
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
              response=await this.request.backend.resolveBusinessField(entity,aligned.flatMap(mention=>(mention.resolution.value as EntityValue).codes),{signal:this.signal});
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
                const joined = await this.request.backend.resolveBusinessField("metric", [raw + hint], {signal: this.signal});
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
            response = await this.request.backend.resolveBusinessField(entity, matching[0]!.resolution.value.codes, {signal: this.signal});
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
        const inherited = entityValue(previous).codes;
        const exact = Array.isArray(anchored) && anchored.length === 1 ? anchored
          : Array.isArray(anchored) && !anchored.length && previous?.resolutionStatus === "resolved" && inherited.length === 1 ? inherited : [];
        if (exact.length === 1 && response.candidates?.some(candidate => candidate.code === exact[0])) {
          // 确定身份来自完整原句或可信继承；模型缩写不是一次新的用户候选确认。
          const identity = await this.request.backend.resolveBusinessField("organization", exact as string[], {signal: this.signal});
          if (identity.status === "resolved" && checkedEntity(identity.value)) response = {...identity, metadata: {...response.metadata, source_codes: exact}};
        }
      }
      const value = response.value;
      if (response.status !== "resolved" || !checkedEntity(value)) {
        target.fields[field] = {rawValue: raw, resolutionStatus: response.status === "resolved" ? "temporary_error" : response.status,
          source: "explicit", resolver: entity, ...(response.candidates ? {candidates: response.candidates} : {}), metadata: {...response.metadata, proposalTurn: turn.operationId}};
        target.pending[field] = raw;
        const original = field === "metrics" ? await metricMentions(this.request) : undefined;
        const modelMismatch = original?.mentions.length && original.mentions.every(mention => mention.resolution.status === "resolved")
          && (!hasInputEvidence(turn.originalMessage, raw) || splitNames(raw).every(member=>original.mentions.some(mention => hasInputEvidence(mention.text, member))))
          && ["ambiguous", "needs_confirmation", "not_found"].includes(response.status);
        if (modelMismatch) throw new SemanticConflict(issue("MODEL_FIELD_NOT_ALIGNED", field,
          `用户原句已明确指标：${original!.mentions.map(mention => mention.text).join("、")}。当前提议未保留本阶段完整口径，请根据原始目标修正，不向用户重复确认。`));
        if (field === "metrics" && operation.action !== "confirm" && !this.request.semanticStep?.analysis && !hasInputEvidence(turn.originalMessage, raw)
          && !(original?.mentions.length)) throw new SemanticConflict(issue("ENTITY_SOURCE_NOT_ESTABLISHED", field,
          "本轮没有此指标新值依据。若沿用已确认指标，请保留已绑定source并省略未变化字段；不要把模型复述产生的歧义交给用户。"));
        const analysisSelection = field === "metrics" && this.request.semanticStep?.analysis && !(await metricMentions(this.request)).mentions.length;
        // 零候选的 not_found 是死胡同澄清：必须引导用户改写，不能原样复读模型给出的错名。
        const noHit = entity === "organization" && response.status === "not_found" && !response.candidates?.length;
        throw new SemanticConflict(analysisSelection ? issue("ANALYSIS_CATALOG_EVIDENCE_REQUIRED", field, "此分析选指标提案尚无正式目录身份，请先catalog检索相关业务类别，核对确定性命中后继续规划；不用让用户填写内部指标。", "pi", "catalog")
          : issue("ENTITY_NOT_DETERMINED", field, noHit
            ? `未找到名为「${raw}」的机构，请换个说法或回复机构全称。`
            : `请确定${field === "metrics" ? "指标口径" : "机构名称"}：${raw}。`, "user", "catalog"));
      }
      if (field === "metrics" && operation.action !== "confirm" && operation.action !== "exclude" && !this.request.semanticStep?.analysis) {
        const mentions = await metricMentions(this.request);
        const supported = new Set([...entityValue(previous).codes, ...mentions.mentions.flatMap(mention =>
          (mention.resolution.value as EntityValue | undefined)?.codes ?? [])]);
        if (value.codes.some(code => !supported.has(code))) throw new SemanticConflict(issue("ENTITY_SOURCE_NOT_ESTABLISHED", field,
          "提议指标没有本轮目录身份或已绑定来源。若指标来自历史，不能使用new重新填写；请复制admitted_context或business_context_read签发的reference，省略未变化字段并完整重提。未获准错误草案可由正确来源替换，不能向用户重复确认已知指标。"));
      }
      if (operation.action !== "confirm" && operation.action !== "exclude" && entity === "organization" && !usedOrgSuggestion) {
        let anchored = response.metadata?.source_codes;
        if (Array.isArray(anchored) && !anchored.length && operation.action === "set" && previous?.resolutionStatus === "resolved"
          && JSON.stringify([...value.codes].sort()) === JSON.stringify([...entityValue(previous).codes].sort())) {
          anchored = entityValue(previous).codes;
          response.metadata = {...response.metadata, source_codes: anchored};
        }
        if (!Array.isArray(anchored) || value.codes.some(code => !anchored.includes(code))) throw new SemanticConflict(issue("ENTITY_SOURCE_NOT_ESTABLISHED", field, "提议机构尚未与原始问题中的目录实体对应，请保留用户机构重新解释。"));
        if (operation.action === "set" && !turn.operations.comparison_organizations && field !== "comparison_organizations"
          && !this.request.semanticStep?.jointCoverage && anchored.some(code => !value.codes.includes(String(code)))) throw new SemanticConflict(issue("GOAL_OBLIGATION_UNCOVERED", field, "原句还有机构没有进入提案，不能执行半份查询。普通取值或计算来源可以拆成多个明确绑定目标，并在同一提案提交完整范围；同一榜单须保留完整比较总体。"));
      }
      let next = value;
      const actual = pendingAction ?? operation;
      const baseField = pendingAction ? pendingBaseline : previous;
      const before = entityValue(baseField);
      if (["add", "replace", "exclude"].includes(actual.action) && baseField?.resolutionStatus !== "resolved") throw new SemanticConflict(issue("COLLECTION_SOURCE_UNRESOLVED", field,
        !baseField || baseField.resolutionStatus === "missing" ? "当前字段尚无原集合；新建完整条件应使用set，请根据用户原句修正操作。" : "原集合尚未确定，请先完成原有条件，不丢弃未决成员。",
        !baseField || baseField.resolutionStatus === "missing" ? "pi" : "user"));
      if (actual.action === "add") next = joinValues(before, value);
      if (actual.action === "replace" || actual.action === "exclude") {
        const subject = actual.subject;
        const subjectResolution = actual.action === "exclude" ? response : await this.request.backend.resolveBusinessField(entity, [subject], {signal: this.signal});
        let found = subjectResolution.status === "resolved" && checkedEntity(subjectResolution.value) ? subjectResolution.value : undefined;
        // subject 证据放宽到被修改对象的已知身份：被引用/继承目标字段的正式名称、编码或原值。
        // 只有目录未命中且不在对象身份中的 subject 才判失败；value 的校验不因此放宽。
        if (!found || found.codes.some(code => !before.codes.includes(code))) {
          const normalized = normalizeInputEvidence(subject);
          const baseRaw = typeof baseField?.rawValue === "string" ? normalizeInputEvidence(baseField.rawValue) : undefined;
          const identity = before.codes.flatMap((code, index) => {
            const name = before.names[index]!;
            return normalizeInputEvidence(code) === normalized || normalizeInputEvidence(name) === normalized
              || baseRaw !== undefined && baseRaw === normalized ? [{code, name}] : [];
          });
          if (identity.length) found = {codes: identity.map(item => item.code), names: identity.map(item => item.name)};
        }
        if (!found || found.codes.some(code => !before.codes.includes(code))) throw new SemanticConflict(issue("SUBJECT_NOT_IN_TARGET", field, "被操作成员未唯一落在已选目标中，原集合保持不变。"));
        // 被操作身份已经由绑定集合与目录唯一确定；省略、序数和历史指代的语言含义由Pi负责，不要求用户复述旧名称。
        if (field === "metrics") found.codes.forEach(code => removed.add(code));
        const keep = before.codes.flatMap((code, i) => found.codes.includes(code) ? [] : [{code, name: before.names[i]!}]);
        next = {codes: keep.map(item => item.code), names: keep.map(item => item.name)};
        if (actual.action === "replace") next = joinValues(next, value);
      }
      if (field === "metrics" && actual.action === "set") before.codes.filter(code => !next.codes.includes(code)).forEach(code => removed.add(code));
      target.fields[field] = {...resolved(raw, next, entity), metadata: {...response.metadata, confirmed: operation.action === "confirm", confirmedBindings}};
      if (!next.codes.length) target.pending[field] = "集合为空，不能扩大成全部范围"; else delete target.pending[field];
      return;
    }
    if (field === "time") {
      if (operation.action === "confirm") {
        const selected = selectSavedCandidates(target, field, turn);
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
        const subject = await this.request.backend.resolveBusinessField("date", [operation.subject], {signal: this.signal}, year,
          {business_date: turn.businessDate, source_question: operation.subject});
        const calendar = subject.value as {start?: string; end?: string; dates?: string[]} | undefined;
        if (previous?.resolutionStatus !== "resolved" || subject.status !== "resolved" || !calendar?.start || !calendar.end
          || calendar.start !== old?.start || calendar.end !== old?.end
          || JSON.stringify(calendar.dates ?? []) !== JSON.stringify((old as {dates?: string[]} | undefined)?.dates ?? [])) {
          throw new SemanticConflict(issue("FIELD_MEMBER_NOT_FOUND", field, "替换的时间与已选目标不一致，请核对引用；替换完整范围可使用set，不得忽略错误来源。"));
        }
        operation = {action: "set", field, value: operation.value};
      }
      if (operation.action !== "set") throw new SemanticConflict(issue("FIELD_ACTION_INCOMPATIBLE", field, "时间支持set、clear、confirm及明确匹配已选范围的replace。"));
      const response = await this.request.backend.resolveBusinessField("date", [operation.value], {signal: this.signal}, year,
        {business_date: turn.businessDate, source_question: turn.originalMessage});
      const calendarSource = (this.request.semanticStep?.calendar ?? response.metadata?.source_calendar) as {ranges?: unknown[]; unresolved?: unknown[]} | undefined;
      if (previous?.resolutionStatus !== "resolved" && calendarSource?.ranges?.length === 0 && calendarSource.unresolved?.length === 0) {
        const metrics = await metricMentions(this.request);
        const dateText = Array.from(turn.originalMessage).map((character, index) => metrics.mentions.some(mention => index >= mention.start && index < mention.end) ? " " : character).join("");
        if (!hasInputEvidence(dateText, operation.value)) {
          // 指标名称内的口径和模型补造日期都不能变成日历来源；无日期时直接保存已知条件并澄清。
          target.fields.time = {resolutionStatus: "missing", source: "explicit", resolver: "date"};
          target.pending.time = "尚未确定日期范围";
          throw new SemanticConflict(issue("FIELD_REQUIRED", field, "请补充查询日期范围。", "user", "calendar"));
        }
      }
      const value = response.value as {start?: string; end?: string; dates?: string[]} | undefined;
      if (response.status !== "resolved" || !value?.start || !value.end || !isCalendarDate(value.start) || !isCalendarDate(value.end) || value.start > value.end) {
        target.fields.time = {rawValue: operation.value, resolutionStatus: response.status === "resolved" ? "temporary_error" : response.status,
          source: "explicit", resolver: "date", ...(response.candidates ? {candidates: response.candidates} : {}), metadata: {...response.metadata, proposalTurn: turn.operationId}};
        const unsupported = response.metadata?.reason === "unsupported_expression";
        throw new SemanticConflict(issue(unsupported ? "TIME_EXPRESSION_UNSUPPORTED" : "TIME_NOT_DETERMINED", field,
          unsupported ? "此时间表达尚未支持，请在同一Pi中解释为等价日历含义；不能改变原时间范围。"
            : response.status === "ambiguous" ? "请确定日期范围的口径。" : "日期尚未确定或日历无效，请核对日期含义。", unsupported ? "pi" : "user", "calendar"));
      }
      if (value.dates !== undefined && (!Array.isArray(value.dates) || value.dates.length < 2 || !value.dates.every(isCalendarDate)
        || value.dates.some((date, i) => i > 0 && date <= value.dates![i - 1]!) || value.dates[0] !== value.start || value.dates.at(-1) !== value.end)) {
        throw new SemanticConflict(issue("DATE_SOURCE_RESPONSE_INVALID", field, "日期事实服务返回的离散时点不符合日历契约。", "retry", "infrastructure"));
      }
      const source = (this.request.semanticStep?.calendar ?? response.metadata?.source_calendar) as {ranges?: Array<{start: string; end: string; dates?: string[]}>; unresolved?: string[]} | undefined;
      if (!source || !Array.isArray(source.ranges) || !Array.isArray(source.unresolved)) throw new SemanticConflict(issue("DATE_SOURCE_RESPONSE_INVALID", field, "日期事实服务尚未提供原始范围对账，请核对配套后端版本。", "retry", "infrastructure"));
      const ranges = source.ranges;
      const same = ranges.length === 1 && ranges[0]!.start === value.start && ranges[0]!.end === value.end
        && JSON.stringify(ranges[0]!.dates ?? []) === JSON.stringify(value.dates ?? []);
      const dates = [...new Set(ranges.flatMap(range => range.start === range.end ? [range.start] : range.dates ?? []))].sort();
      const discrete = ranges.length > 1 && ranges.every(range => range.start === range.end || range.dates)
        && JSON.stringify(dates) === JSON.stringify(value.dates ?? []);
      const explicitPoints = ranges.flatMap(range => range.start === range.end ? [range.start] : range.dates ?? []);
      // 同一原句的离散日期可拆为多个步骤；最终完整性由整批准入独立核验，子步骤不能单独执行。
      const splitPoint = this.request.semanticStep?.partialCalendar && value.start === value.end && !value.dates
        && explicitPoints.includes(value.start) && (ranges.length > 1 || ranges.some(range => range.dates));
      const changedRange = this.request.semanticStep && completeQuery(turn.baseline!) && ranges.some(range => range.start === value.start && range.end === value.end
        && JSON.stringify(range.dates ?? []) === JSON.stringify(value.dates ?? []));
      const retained = !ranges.length && !source.unresolved.length && turn.baseline?.fields.time?.resolutionStatus === "resolved"
        && JSON.stringify(transitionValue(turn.baseline, "time")) === JSON.stringify(value);
      if (retained) {
        target.fields.time = {...structuredClone(turn.baseline!.fields.time!), source: "inherited"};
        delete target.pending.time; return;
      }
      if (source.unresolved.length || !(same || discrete || splitPoint || changedRange || !ranges.length && hasInputEvidence(turn.originalMessage, operation.value))) {
        throw new SemanticConflict(issue("TIME_SCOPE_CONFLICT", field, "提议时间与原始日历范围尚未对齐，不能截短区间或漏掉离散日期。"));
      }
      target.fields.time = {...resolved(operation.value, value, "date"), metadata: {...response.metadata, ...(response.alternative ? {timeAlternative: response.alternative} : {})}};
    } else if (field === "selection") {
      if (operation.action !== "set") throw new SemanticConflict(issue("FIELD_ACTION_INCOMPATIBLE", field, "取数方式使用set或clear。"));
      const text = normalizeInputEvidence(operation.value);
      const meaning = /最新|最后|latest_in_range/u.test(text) ? "latest_in_range"
        : /全部|所有|完整|逐|各期|all_in_range/u.test(text) ? "all_in_range" : /指定|精确|exact/u.test(text) ? "exact" : undefined;
      if (!meaning) throw new SemanticConflict(issue("SELECTION_NOT_INTERPRETED", field, "请明确提议指定时点、区间最新或完整时间序列的业务含义。"));
      const source = normalizeInputEvidence(turn.originalMessage);
      const anchor = meaning === "latest_in_range" ? /最新|最后|最近一期|末次/u.test(source)
        : meaning === "all_in_range" ? /所有|全部|完整|逐日|每日|各期|序列|趋势|变化/u.test(source) : true;
      if (!anchor && !this.request.semanticStep?.analysis) throw new SemanticConflict(issue("SELECTION_SOURCE_NOT_ESTABLISHED", field, "原始问题尚未明确此区间取数方式，不能默认最新一期或完整序列。", "user"));
      target.fields.selection = resolved(operation.value, meaning, "enum");
    } else if (field === "objective") {
      if (operation.action !== "set") throw new SemanticConflict(issue("FIELD_ACTION_INCOMPATIBLE", field, "步骤说明使用set。"));
      target.fields.objective = resolved(operation.value, operation.value, "objective");
    } else if (field === "availability") {
      if (operation.action !== "set") throw new SemanticConflict(issue("FIELD_ACTION_INCOMPATIBLE", field, "覆盖要求使用set。"));
      const dimension = /日期|时点|哪天/u.test(operation.value) ? "dates" : /指标/u.test(operation.value) ? "metrics" : undefined;
      if (!dimension) throw new SemanticConflict(issue("AVAILABILITY_NOT_DETERMINED", field, "请说明要发现有记录的指标，还是有记录的日期。", "user"));
      target.fields.availability = resolved(operation.value, dimension, "availability");
      target.fields.dimension = resolved(operation.value, dimension, "enum");
      target.fields.match = resolved(/共同|全部都有/u.test(operation.value) ? "共同记录" : "任意记录", /共同|全部都有/u.test(operation.value) ? "all" : "any", "enum");
      const page = /第\s*(\d+)\s*页/u.exec(operation.value)?.[1];
      target.fields.page = resolved(page ?? "第一页", page ? Number(page) : 1, "integer");
      target.fields.page_size = resolved("每页50项", 50, "integer");
    } else {
      if (operation.action !== "set") throw new SemanticConflict(issue("FIELD_ACTION_INCOMPATIBLE", field, "操作类型使用set或clear。"));
      // query意图在当前阶段只有原值取数；操作范围由完整原句和目录片段对账，不校验模型描述是否命中固定说法。
      target.fields.operation = resolved(operation.value, {kind: "value"}, "query_operation");
    }
    delete target.pending[field];
  }
  private async coverage(target: SemanticTarget, turn: SemanticTurn, removed: Set<string>): Promise<{issues: SemanticIssue[]; snapshot?: NonNullable<SemanticTarget["coverage"]>}> {
    const previous = turn.baseline?.coverage;
    const previousQuestion = turn.baseline?.metricSource ?? previous?.question;
    const changed = !!turn.operations.metrics;
    const question = previousQuestion ? changed ? previousQuestion + "\n" + turn.originalMessage : previousQuestion : turn.originalMessage;
    let matched: Awaited<ReturnType<typeof metricMentions>>;
    try {matched = await metricMentions(this.request, question);} catch (error) {
      if (!(error instanceof BackendApiError) || ![401, 403].includes(error.status)) throw error;
      return {issues: [issue("PERMISSION_DENIED", "metrics", "当前身份无权复核原始指标范围，未执行查询。", "stop", "permission")]};
    }
    const codes = entityValue(target.fields.metrics).codes;
    const confirmed = target.fields.metrics?.metadata?.confirmedBindings as Record<string, string[]> | undefined;
    const mentions: MentionResolution[] = [], excluded: MentionResolution[] = [], issues: SemanticIssue[] = [];
    if (matched.status || !matched.mentions.length) issues.push(issue("GOAL_SOURCE_NOT_RESOLVED", "metrics", "原始问题的指标依据尚未完整确定，保留目标继续解释。"));
    for (const item of matched.mentions) {
      const snapshot: MentionResolution = {text: item.text, start: item.start, end: item.end, status: item.resolution.status,
        ...(item.resolution.candidates ? {candidates: item.resolution.candidates} : {})};
      const inherited = previous?.mentions.find(mention => mention.start === item.start && mention.end === item.end && mention.text === item.text);
      const resolvedCodes = inherited?.value?.codes ?? (item.resolution.status === "resolved" && checkedEntity(item.resolution.value) ? item.resolution.value.codes : []);
      const chosen = resolvedCodes.length ? resolvedCodes : confirmed?.[spanKey(item)] ?? [];
      const oldFragment = !!previousQuestion && changed && item.end <= Array.from(previousQuestion).length;
      if (chosen.length && chosen.every(code => codes.includes(code))) {
        snapshot.status = "resolved";
        snapshot.value = {codes: chosen, names: chosen.map(code => entityValue(target.fields.metrics).names[codes.indexOf(code)]!)};
        mentions.push(snapshot);
      } else if (previous?.removed.some(mention => mention.start === item.start && mention.end === item.end && mention.text === item.text)
        || resolvedCodes.length && resolvedCodes.every(code => removed.has(code)) && (oldFragment || turn.operations.metrics?.some(op => "subject" in op && hasInputEvidence(item.text, op.subject)))) {
        excluded.push({...snapshot, status: "removed"});
      } else issues.push(issue("GOAL_OBLIGATION_UNCOVERED", "metrics", `原始义务“${item.text}”尚未正确进入目标或有依据的替换排除，不能只执行已完整部分。`, item.resolution.status === "resolved" ? "pi" : "user", "coverage"));
    }
    return {issues, ...(issues.length ? {} : {snapshot: {question, mentions, removed: excluded}})};
  }
  async compile(task: SemanticTask) {
    const capability = task.capability ?? "metric_query";
    if (!this.request.frames || capability === "metric_query" && !task.target.coverage && !task.target.fields.metrics?.metadata?.semanticSelectionReceipt) throw new Error("SEMANTIC_COMPILE_NOT_READY");
    const schema = createCapabilities().get(capability);
    const fields = Object.fromEntries(Object.entries(structuredClone(task.target.fields)).filter(([name]) => name in schema.fields));
    if (task.target.coverage && fields.metrics) fields.metrics.metadata = {...fields.metrics.metadata, questionText: task.target.coverage.question,
      mentionResolutions: task.target.coverage.mentions, removedMentions: task.target.coverage.removed};
    const inherited = new Set(Object.values(fields).flatMap(field => Array.isArray(field.metadata?.inheritedFrameIds) ? field.metadata.inheritedFrameIds as string[] : []));
    const baseId = task.target.baseFrameId ?? (inherited.size === 1 ? [...inherited][0] : undefined);
    const base = baseId ? await this.request.frames.get(baseId) : undefined;
    if (baseId && (!base || base.sessionId !== this.request.sessionId)) throw new Error("SEMANTIC_FRAME_SOURCE_INVALID");
    const frame: BusinessFrame = {frameId: semanticRef(), sessionId: this.request.sessionId, turnId: this.request.operationId,
      requestId: this.request.requestId, capability, operationFrameId: semanticRef(), fields,
      ...(base ? {parentFrameId: base.frameId} : {}),
      delta: {capabilityHint: capability, baseReference: base ? {frameId: base.frameId} : null, fieldChanges: [...new Set(task.target.transition?.changes.map(change => change.field) ?? [])].map(name => ({fieldHint: name,
        operation: !task.target.fields[name] || task.target.fields[name]?.resolutionStatus === "missing" ? "clear" as const : "set" as const,
        ...(task.target.fields[name]?.rawValue !== undefined ? {rawValue: task.target.fields[name]!.rawValue} : {})})), executionMode: "execute"},
      issues: [], status: "ready", createdAt: new Date().toISOString()};
    return this.request.frames.save(frame, (await this.request.frames.state()).version, `semantic:${task.ref}:${task.revision}`);
  }
  async consume(taskRef: string, targetRef: string) {
    const task = await this.store.get(taskRef);
    if (!task || task.owner !== this.request.actor.id || task.target.ref !== targetRef) conflict("REFERENCE_INVALID", "当前执行引用不可用。");
    const permit = task.permit;
    if (task.parentPlan) {
      const bound = this.request.semanticStep, plan = await this.store.plan(task.parentPlan);
      if (!bound || bound.planRef !== task.parentPlan || !plan?.admitted || plan.owner !== this.request.actor.id
        || plan.admitted.operationId !== bound.rootOperationId || plan.admitted.revision !== bound.revision
        || !plan.steps.some(step => step.taskRef === task.ref && step.targetRef === targetRef)) conflict("PLAN_NOT_ADMITTED", "完整任务尚未获准，不能执行其中一项。");
    }
    if (!permit || permit.consumed || task.target.status !== "ready" || permit.operationId !== this.request.operationId || permit.revision !== task.revision
      || permit.actor !== this.request.actor.id || permit.digest !== snapshotDigest(task.target) || Object.keys(task.target.pending).length || task.issues.length) {
      conflict("EXECUTION_PERMIT_INVALID", "执行许可缺失或已失效，不能直接执行Frame。");
    }
    for (const field of ["organizations", "metrics"] as const) {
      if (!task.target.fields[field]) continue;
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
    if (frame?.status === "success" && frame.resultSummary?.truncated) {latest.status = "active"; latest.completion = "partial";}
    await this.store.save(latest, (await this.store.index()).version, undefined, false);
    return latest;
  }
}
