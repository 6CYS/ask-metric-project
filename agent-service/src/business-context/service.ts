import {settleLatestQueryFields} from "./queryDates.js";
import {settleAnalysisScopeFields, type AnalysisExecutionScope} from "./analysisScope.js";
import { createHash, randomUUID } from "node:crypto";
import {Type, validateToolArguments} from "@earendil-works/pi-ai";
import { CapabilityRegistry, FieldResolverRegistry, mergeFields, resolveFrame, validateFrame, inheritableFrame, validateFieldIntents, applyFieldIntentConstraints, preflightFieldRecovery, fieldLabels } from "./core.js";
import type { BusinessFrame, ContextDelta, FieldInputCorrection, FrameStore, ResolverContext } from "./types.js";
import { BusinessInputError } from "./inputError.js";
import {withFieldClarification} from "./fieldClarification.js";
import {clarificationOptions, selectOptions} from "./clarificationOptions.js";
import {hasInputEvidence} from "./inputEvidence.js";
import {assertOverviewMonthSource, comparisonPeriodsOnly, multipleOverviewTopics, overviewContinuesCurrent, overviewTimeExpression, overviewTopicExpression, recentOverviewExpression} from "./overviewPolicy.js";

/** 旧排名契约用 asc/desc 表达数值方向，名次类指标会取反；这类 Frame 须在新回合按新契约重建。 */
function legacyRankingOrder(operation: unknown): boolean {
  return !!operation && typeof operation === "object" && "order" in operation;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const businessKey = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const isAnalysisCapability = (capability?: string) => capability === "business_overview" || capability === "business_analysis";
export interface TurnIdentity { sessionId: string; turnId: string; requestId: string }
export class BusinessContextService {
  constructor(readonly store: FrameStore, readonly capabilities: CapabilityRegistry, readonly resolvers: FieldResolverRegistry) {}

  /** 最近的可继承祖先：沿 parentFrameId 回溯，跳过失败/执行中/自身即坏引用的帧。
   *  只作为澄清候选暴露，调用方需用 baseReference 显式指认，不做自动回退。 */
  private async inheritableAncestors(from: BusinessFrame | undefined): Promise<string[]> {
    let current = from?.parentFrameId ? await this.store.get(from.parentFrameId) : undefined;
    while (current) {
      if (inheritableFrame(current) && current.status !== "executing" && !current.issues.some(issue => issue.field === "$base")) {
        return [current.frameId];
      }
      current = current.parentFrameId ? await this.store.get(current.parentFrameId) : undefined;
    }
    return [];
  }

  async resolve(delta: ContextDelta, identity: TurnIdentity, context: ResolverContext): Promise<BusinessFrame> {
    try {
      return await this.resolveAtomic(delta, identity, context);
    } catch (error) {
      if (!(error instanceof BusinessInputError) || error.recovery) throw error;
      // 已核验的选择不能因无关字段参数失败而丢失；只保存确认，不执行失败提案。
      const preserved = await this.preserveBoundConfirmation(delta, identity, context, error.field.split(","));
      if (!preserved) throw error;
      throw new BusinessInputError(error.code, error.field, error.correction,
        {frameId: preserved.frameId}, error.recovery, error.corrections);
    }
  }

  private async resolveAtomic(delta: ContextDelta, identity: TurnIdentity, context: ResolverContext): Promise<BusinessFrame> {
    // 模型入口的目标声明先于幂等读取，旧准备快照不能绕过新入口契约。
    const declaredSchema = this.capabilities.list().find(schema => schema.capability === delta.capabilityHint);
    await this.preflightRecovery(delta, identity, context);
    if (declaredSchema) validateFieldIntents(declaredSchema, delta, context);
    const misplacedMode = delta.fieldChanges.filter(change => change.fieldHint === "executionMode");
    if (misplacedMode.length) {
      // 只消除与顶层完全一致的冗余控制字段；冲突不能猜测优先级或改变执行意图。
      if (misplacedMode.some(change => change.operation !== "set" || change.rawValue !== delta.executionMode))
        throw new BusinessInputError("EXECUTION_MODE_CONFLICT", "executionMode", "executionMode只在顶层提交；fieldChanges中的值与顶层冲突或操作无效，请明确修正执行方式，原焦点未改变。");
      delta = {...delta, fieldChanges: delta.fieldChanges.filter(change => change.fieldHint !== "executionMode")};
    }
    if (isAnalysisCapability(delta.capabilityHint)) {
      const planningOnly = /(?:只|仅|先|暂时)(?:做|看|给|说明)?(?:分析)?(?:计划|规划|方案|思路|方法)|(?:不要|不用|不需要|无需|暂不|先不|别)(?:再|重新)?(?:查询|取数|执行)/u.test(context.originalMessage);
      // 日期方式由概览适配器确定；普通查数的控制枚举不影响概览条件。
      // 可选字段在独立问题中 retain 等价于未提供，采用已声明的机构/日期默认值。
      delta = {...delta,
        // 概览默认交付结果；不能因模型误选“仅保存条件”而停在计划或复述旧聊天。
        ...(delta.executionMode === "resolve_more" && !planningOnly ? {executionMode: "execute" as const} : {}),
        fieldChanges: delta.fieldChanges.filter(change =>
        !["selection", "operation"].includes(change.fieldHint)
        && !(delta.baseReference === null && change.operation === "retain"
          && ["time", "organizations"].includes(change.fieldHint)))};
    }
    // 先收敛上一轮遗留的执行中 Frame（会写入新快照并推进版本），再读取本轮解析所用的状态。
    await this.settleStaleExecution(delta, identity, context);
    let key = businessKey({phase: "resolve", ...identity, delta: {...delta, fieldChanges: [...delta.fieldChanges].sort((a, b) => a.fieldHint.localeCompare(b.fieldHint))}});
    // 相同Delta通常幂等复用；但已因范围失效失败的准备快照必须换代，不能永远返回旧指纹；
    // 目录服务临时失败的草稿同样换代重新解析，否则同轮重试永远拿到同一个临时错误。
    for (;;) {
      const existing = await this.store.command(key);
      if (!existing) break;
      const savedState = await this.store.state();
      const completed = await this.store.get(savedState.operations[existing.operationFrameId] ?? existing.frameId);
      if (completed?.errorCode !== "SCOPE_CHANGED" && completed?.errorCode !== "TEMPORARY_ERROR") return existing;
      key = businessKey({phase: "scope-refresh", previousKey: key, failedFrameId: completed.frameId});
    }
    const state = await this.store.state();
    if (isAnalysisCapability(delta.capabilityHint) && delta.baseReference === null
      && state.focusFrameId && overviewContinuesCurrent(context.originalMessage)) {
      throw new BusinessInputError("OVERVIEW_CONTINUATION_REQUIRES_BASE", "baseReference",
        "用户使用明确延续问法，请改用 baseReference=current，继承未变化的机构与日期并按新主题重新规划；不要用账户默认机构替代上一轮机构，原焦点未改变。");
    }
    if (delta.baseReference === "current" && !state.focusFrameId) {
      throw new BusinessInputError("CURRENT_FOCUS_MISSING", "baseReference", "当前没有可继承焦点；独立新问题用 null，明确历史引用用选择对象，不要编造来源。");
    }
    if (delta.fieldChanges.some(change => change.operation === "retain")
      && (delta.baseReference === null || !delta.baseReference && !state.focusFrameId)) {
      throw new BusinessInputError("NO_BASE_FOR_RETAIN", "$base",
        delta.baseReference === null && state.focusFrameId
          ? "baseReference=null 声明独立新问题，不能同时 retain 历史字段。请先从历史索引选择用户所指的继承来源；继续当前讨论时用 current。引用字段中的 sources 只组合该字段，不会替其他字段选择继承来源；不要重填历史名称和日期。原焦点未改变。"
          : "当前没有可继承的业务条件。请从本轮用户原文重新提交完整字段，不能把 retain 当作已确认条件，也不要让用户重复确认原文已给出的条件。原焦点未改变。");
    }
    let base: BusinessFrame | undefined;
    let referenceIssue: "ambiguous" | "not_found" | "invalid" | undefined;
    let candidates: string[] | undefined;
    let pendingExecution = false;
    if (delta.baseReference && delta.baseReference !== "current") {
      const resolution = resolveFrame(delta.baseReference, state, await this.store.list(), identity.turnId);
      if (resolution.status === "resolved") base = await this.store.get(resolution.frameId!);
      else {
        const focus = state.focusFrameId ? await this.store.get(state.focusFrameId) : undefined;
        if (resolution.status === "not_found" && isAnalysisCapability(delta.capabilityHint)
          && focus?.turnId === identity.turnId && focus.capability === delta.capabilityHint
          && focus.status === "success" && focus.resultRef
          && delta.fieldChanges.every(change => change.fieldHint === "plan" || change.operation === "retain")) {
          // 本轮补查的内部引用错误不能制造用户澄清、冲掉已成功焦点；由调用方显式使用准确引用重试。
          throw new BusinessInputError("ANALYSIS_REFINEMENT_REFERENCE_INVALID", "baseReference",
            "同轮补查不能用历史相对位置指向本轮结果；历史序号仅计算本轮之前的业务。请保留retry_reference的frameId重新提交补查计划，机构日期不变，无需向用户澄清。", {frameId: focus.frameId});
        }
        referenceIssue = resolution.status; candidates = resolution.candidates;
      }
    } else if (delta.baseReference !== null && state.focusFrameId) {
      const focus = await this.store.get(state.focusFrameId);
      const latest = focus ? await this.store.get(state.operations[focus.operationFrameId] ?? focus.frameId) : undefined;
      if ((latest && !inheritableFrame(latest)) || latest?.status === "executing" || latest?.issues.some(issue => issue.field === "$base")) {
        referenceIssue = "invalid";
        pendingExecution = latest?.status === "executing";
        base = latest; // 仅保留失败来源及能力用于澄清，下面门禁禁止合并其字段。
        // 拒绝自动继承不等于是死路：附上最近的可继承祖先作为候选，让调用方能用 baseReference 显式指认。
        // 不静默回退（回退必须由用户显式发起），只是让澄清可回答。
        candidates = await this.inheritableAncestors(latest ?? focus);
      }
      else base = latest?.status === "failed" && inheritableFrame(latest) ? latest : focus;
    }
    if (delta.executionMode === "reuse_result" && delta.fieldChanges.length) {
      throw new BusinessInputError("RESULT_REUSE_HAS_CHANGES", "$result",
        "reuse_result 只回读历史结果，fieldChanges 必须为空数组，不清除或改写历史条件；用 baseReference 明确用户所指历史 Frame，原焦点未改变。");
    }
    // READY 是操作的解析快照；复用结果需定位同一操作的最终快照，不重查或修改旧 Frame。
    if (delta.executionMode === "reuse_result" && base && !base.resultRef) {
      const completed = await this.store.get(state.operations[base.operationFrameId] ?? base.frameId);
      if (completed?.status === "success" && completed.resultRef) base = completed;
    }
    if ((base && !inheritableFrame(base)) || base?.status === "executing") referenceIssue = "invalid";
    const recovering = state.focusFrameId ? await this.store.get(state.focusFrameId) : undefined;
    if (delta.baseReference !== null && recovering?.recovery && base?.frameId !== recovering.frameId) {
      throw new BusinessInputError("TURN_RECOVERY_REFERENCE_REQUIRED", "$base",
        "已保存的候选确认仍有本轮变更待修正，请使用 retry_reference 指向恢复草稿并完成 pending_fields；不能回到旧快照忽略这些变更。明确独立的新目标使用 null。",
        {frameId: recovering.frameId});
    }
    if (context.confirmationSelection) {
      const selection = context.confirmationSelection;
      const source = await this.store.get(selection.frameId);
      const sourceSchema = source ? this.capabilities.list().find(item => item.capability === source.capability) : undefined;
      const options = source && sourceSchema ? clarificationOptions(source, fieldLabels(sourceSchema)).flatMap(group => group.options) : [];
      const recovered = base?.recovery?.selectionFrameId === selection.frameId
        && businessKey([...base.recovery.optionIds].sort()) === businessKey([...selection.optionIds].sort());
      if (!source || source.sessionId !== identity.sessionId || source.turnId === identity.turnId || !inheritableFrame(source)
        || !selection.optionIds.length || new Set(selection.optionIds).size !== selection.optionIds.length
        || selection.optionIds.some(id => !options.some(option => option.id === id))
        || base?.frameId !== selection.frameId && !recovered) {
        throw new BusinessInputError("CLARIFICATION_SELECTION_INVALID", "$confirmation",
          "点选来源或选项已失效，不能将其应用到其它业务条件；请读取原待确认状态重新选择，未执行查询。");
      }
    }
    const capability = delta.capabilityHint ?? base?.capability ?? "";
    if (capability === "metric_query" && recentOverviewExpression(context.originalMessage)
      && recentOverviewExpression(overviewTimeExpression(context.originalMessage) ?? "")) {
      throw new BusinessInputError("ANALYSIS_LATEST_PLAN_REQUIRED", "time", "用户表达的是按最新可用数据了解现状，不是日期缺失。请analysis_catalog发现正式指标，用business_analysis规划并把最近按原文提交；服务端回查实际日期，无需请用户选择月份或内部比较口径。明确单日仍使用基础查询。");
    }
    let schema;
    try { schema = this.capabilities.get(capability); } catch {
      throw new BusinessInputError("CAPABILITY_REQUIRED", "$capability", "无可继承能力时必须提供 capabilityHint，使用 business_context_read 中的能力名称；不要向用户询问内部能力名称。原焦点未改变。");
    }
    if (!declaredSchema) validateFieldIntents(schema, delta, context);
    if (base?.recovery) {
      const pending = base.recovery.pendingFields.filter(name => {
        const change = delta.fieldChanges.find(item => item.fieldHint === name);
        const saved = base.recovery!.pendingChanges?.find(item => item.field === name);
        if (change) return change.operation === "retain" && saved?.mayRetain === false;
        // 只把已校验的显式 inherit 作为撤销无依据提案；不能凭省略抹掉本轮真实变化。
        return !(saved?.mayRetain === true && delta.fieldIntents?.[name]?.mode === "inherit");
      });
      if (pending.length) throw new BusinessInputError("TURN_CHANGES_PENDING", pending.join(","),
        "已核验的选择已保存。按 pending_changes 处理剩余提案：有本轮依据的新值须修正并落实；允许保留旧值的项可显式 inherit 或 retain，不能仅省略所有待修字段。完成校验前不会执行查询。",
        {frameId: base.frameId});
    }
    // 旧排名把父机构与实际目标混用，不能静默继承为新契约的普通取值。
    if (delta.executionMode !== "reuse_result" && base?.capability === "metric_query"
      && (base.fields.selection?.resolvedValue === "ranking" || ["order", "top_n"].some(name => base!.fields[name]?.resolvedValue !== undefined)
        || legacyRankingOrder(base.fields.operation?.resolvedValue))) {
      throw new Error("LEGACY_QUERY_REQUIRES_NEW_TURN");
    }
    const id = randomUUID();
    // 同轮同一笔已准备条件转为执行，只推进操作快照；内部准备步骤不能占用用户历史序号。
    // 已完成后的新分支、跨轮操作、能力变化或实际字段修改仍保留独立操作身份。
    const promotesPrepared = !referenceIssue && base?.turnId === identity.turnId && base.status === "ready"
      && base.capability === capability && delta.executionMode === "execute"
      && delta.fieldChanges.every(change => change.operation === "retain");
    const frame: BusinessFrame = {frameId: id, ...identity, capability, operationFrameId: promotesPrepared ? base!.operationFrameId : id,
      ...(base ? {parentFrameId: base.frameId} : {}), fields: {}, delta: structuredClone(delta), issues: [],
      status: "clarifying", createdAt: new Date().toISOString()};
    if (referenceIssue) frame.issues.push({field: "$base", reason: referenceIssue,
      ...(candidates || pendingExecution ? {message: JSON.stringify({...(candidates ? {candidates} : {}),
        ...(pendingExecution ? {pending_execution: true,
          hint: "上一次查询仍在执行，结果确认前不能在其基础上追问；请如实告知用户稍后再问，或按用户新给出的完整条件发起查询。"} : {})})} : {})});
    if (!schema) frame.issues.push({field: "$capability", reason: "not_found"});
    if (delta.executionMode === "reuse_result") {
      if (!base?.resultRef || base.status !== "success" || capability !== base.capability) frame.issues.push({field: "$result", reason: "invalid"});
      if (!frame.issues.length) {
        frame.fields = structuredClone(base!.fields);
        if (isAnalysisCapability(capability)) assertOverviewMonthSource(context.originalMessage, frame.fields);
        frame.status = "success";
        frame.resultRef = base!.resultRef!;
        if (base!.resultSummary) frame.resultSummary = structuredClone(base!.resultSummary);
      }
    } else if (schema && !referenceIssue) {
      try {
        if (capability === "business_overview") {
          const topic = overviewTopicExpression(context.originalMessage);
          const planChange = delta.fieldChanges.find(change => change.fieldHint === "plan" && change.operation === "set");
          const inherited = base?.fields.plan?.resolvedValue as import("../tools/businessOverview.js").OverviewPlan | undefined;
          if (multipleOverviewTopics(context.originalMessage) || !topic && (!base || base.capability !== "business_overview")) {
            throw new BusinessInputError("ANALYSIS_SCOPE_UNSUPPORTED", "plan",
              "本轮没有限定为单一存款或贷款主题，不能默认缩成loan。请并行analysis_catalog跨方面发现正式指标与business_skill_read(name=general-analysis)读取分析方法，再用business_analysis规划原始目标；整体经营还需探索收益等方面，不能只查存贷款。沿用已有机构日期，不要求用户选主题。领域概览只适用于原文明示或可信历史继承的单一主题。");
          }
          if (planChange && planChange.rawValue && typeof planChange.rawValue === "object") {
            const plan = planChange.rawValue as import("../tools/businessOverview.js").OverviewPlan;
            if (topic && plan.topic && plan.topic !== topic) throw new BusinessInputError("ANALYSIS_TOPIC_INVALID", "plan", "计划主题与用户本轮明确主题不同，请读取正确主题并重新规划，不向用户重复询问。");
            planChange.rawValue = {...plan, topic: plan.topic ?? topic ?? inherited?.topic ?? "loan"};
          } else if (topic && inherited && topic !== (inherited.topic ?? "loan")) {
            throw new BusinessInputError("ANALYSIS_TOPIC_CHANGED", "plan", "用户已切换主题，请读取新主题并提交完整plan；机构日期可以继承，不能沿用旧主题指标。");
          }
        }
        const requestedTime = isAnalysisCapability(capability) ? overviewTimeExpression(context.originalMessage) : undefined;
        const comparisonOnly = isAnalysisCapability(capability) && comparisonPeriodsOnly(context.originalMessage);
        const organizations = isAnalysisCapability(capability) && context.organizationMentions
          && !delta.fieldChanges.some(change => change.fieldHint === "organizations" && change.operation === "set")
          ? await context.organizationMentions() : [];
        // 已明确的日期无需模型逐字再抄一次；缺省与追问继承仍沿用 Frame 语义。
        const mergeDelta = {...delta, fieldChanges: [
          ...delta.fieldChanges.filter(change => !((requestedTime || comparisonOnly) && change.fieldHint === "time")
            && !(organizations.length && change.fieldHint === "organizations")),
          ...(requestedTime ? [{fieldHint: "time", operation: "set" as const, rawValue: requestedTime}] : []),
          ...(organizations.length ? [{fieldHint: "organizations", operation: "set" as const, rawValue: organizations}] : []),
        ]};
        frame.delta = structuredClone(mergeDelta);
        const mergeBase = isAnalysisCapability(capability) && !requestedTime
          && base?.fields.time?.resolutionStatus === "invalid"
          && typeof base.fields.time.rawValue === "string" && overviewTimeExpression(base.fields.time.rawValue)
          ? {...base, fields: {...base.fields, time: {...base.fields.time,
            metadata: {...base.fields.time.metadata, refreshOnInherit: true}}}} : base;
        const merged = await mergeFields(schema, mergeBase, mergeDelta, this.resolvers, context);
        if (merged.issues.length) {
          const invalidFields = [...new Set(merged.issues.map(issue => issue.field))];
          throw new BusinessInputError("FIELD_CHANGES_INVALID", invalidFields.join(","),
            `${capability} 的 fieldChanges 含未声明或重复字段：${invalidFields.join("、")}。允许的字段仅为：${Object.keys(schema.fields).join("、")}。移除未声明项或重复项，保留其他有效字段及用户条件后重试；不要切换业务目标来绕过错误，原焦点未改变。`);
        }
        frame.fields = merged.fields;
        let constrained = delta;
        for (const saved of base?.recovery?.pendingChanges ?? []) {
          if (saved.mayRetain || saved.expectedCount === undefined) continue;
          const intent = delta.fieldIntents?.[saved.field];
          if (intent?.expectedCount !== undefined && intent.expectedCount !== null && intent.expectedCount !== saved.expectedCount) {
            throw new BusinessInputError("FIELD_INTENT_COUNT_CONFLICT", saved.field,
              "恢复同一本轮变化须保留 pending_changes 中已核验的目标数量；不能用新数量或null删除约束。原条件及确认已保留。");
          }
          // 只补已保存约束供集合校验，模型原始 Delta 与其来源声明保持不变。
          constrained = {...constrained, fieldIntents: {...constrained.fieldIntents, [saved.field]: {
            mode: intent?.mode ?? "inherit", sourceText: intent?.sourceText ?? null, expectedCount: saved.expectedCount}}};
        }
        applyFieldIntentConstraints(schema, merged.fields, constrained, base);
        if (capability === "metric_query" && context.analysisFallbackAvailable
          && ["not_found", "ambiguous", "needs_confirmation"].includes(merged.fields.metrics?.resolutionStatus ?? "")
          && delta.fieldChanges.some(change => change.fieldHint === "metrics" && change.operation === "set"
            && change.rawValue && typeof change.rawValue === "object" && "fromQuestion" in change.rawValue)) {
          throw new BusinessInputError("ANALYSIS_METRIC_DISCOVERY_REQUIRED", "metrics", "基础精确匹配未能唯一确定指标，这不证明正式目录不存在。先analysis_catalog按完整业务名发现指标，再用business_analysis选择与目标相符的正式指标并披露范围；现状选当日数，明确日期原样保留。不向用户罗列内部比较口径，也不虚构其他会计口径。确有不可替代的业务歧义才说明限制。");
        }
        if (isAnalysisCapability(capability)) assertOverviewMonthSource(context.originalMessage, merged.fields);
        const validation = validateFrame(schema, merged.fields, merged.issues);
        const businessMissing = validation.issues.some(issue => issue.reason === "missing"
          && schema.fields[issue.field]?.required && !schema.fields[issue.field]?.missingIsArgumentError);
        // 字段经会话历史指代兑现，说明用户在继续已有讨论；此时声明独立问题（null）且必填条件缺项
        // 或指标在本轮原文无提及（not_found），不把缺项抛给用户，指导模型改用 current 继承重新解析。
        const referencedHistory = Object.values(merged.fields).some(field => field.metadata?.referenceSource === "session_history");
        const metricsAbsent = typeof schema.fields.metrics === "object" && merged.fields.metrics?.resolutionStatus === "not_found";
        if ((businessMissing || metricsAbsent) && delta.baseReference === null && referencedHistory && state.focusFrameId) {
          throw new BusinessInputError("REFERENCE_IMPLIES_CONTINUATION", "$base",
            "机构/条件已按会话历史指代解析，说明用户在继续已有讨论。请改用 baseReference=current 重新解析：未变化字段省略继承；若用户明确表示另起话题，先向用户确认，不要按独立问题丢弃已确定条件。");
        }
        // 先保存真实业务缺项及已知条件；内部枚举待条件补齐后由模型修正，不交给用户填写。
        const visibleIssues = validation.issues.filter(issue => !(businessMissing && issue.reason === "missing"
          && schema.fields[issue.field]?.missingIsArgumentError));
        // 能力组合诊断可补充已有字段问题；同一字段/原因只交付一项，优先保留结构化合法边界。
        const invalid = [...new Map(visibleIssues.filter(issue => (issue.reason === "missing" && schema.fields[issue.field]?.missingIsArgumentError)
          || (issue.reason === "invalid" && (issue.message !== undefined || merged.fields[issue.field]?.metadata?.userInputIssue !== true)))
          .map(issue => [`${issue.field}:${issue.reason}`, issue] as const)).values()];
        if (invalid.length) {
          const corrections: FieldInputCorrection[] = invalid.map(issue => {
            if (issue.correction) return issue.correction;
            const definition = schema.fields[issue.field];
            const message = issue.message ?? `${issue.field} 是模型需提供的内部控制字段，按Schema修正参数并保留用户目标；${definition?.description ?? ""}`;
            const inputSchema = definition?.inputSchema ?? (definition?.validation?.enum ? {enum: definition.validation.enum} : undefined);
            return {field: issue.field, reason: issue.reason === "missing" ? "missing" : "invalid", message,
              ...(definition?.validation?.enum ? {allowedValues: definition.validation.enum} : {}), ...(inputSchema ? {inputSchema} : {})};
          });
          throw new BusinessInputError("FIELD_COMBINATION_INVALID", invalid.map(issue => issue.field).join(","),
            corrections.map(issue => issue.message).join("；"), undefined, undefined, corrections);
        }
        const temporary = validation.issues.some(issue => issue.reason === "temporary_error");
        frame.issues.push(...visibleIssues);
        frame.status = temporary ? "draft" : validation.status === "READY" ? "ready" : "clarifying";
        if (temporary) frame.errorCode = "TEMPORARY_ERROR";
      } catch (error) {
        // 字段解析、结构与组合校验共用纠错边界，不能丢失已经选定的历史来源。
        if (error instanceof BusinessInputError) {
          // Resolver 提前拒绝输入时，只有字段 Schema 已知；未完成解析不能推断跨字段组合。
          const rawCorrections = error.corrections?.length ? error.corrections : (error.recovery ? undefined : error.field.split(",").flatMap(name => {
            const definition = schema.fields[name];
            if (!definition?.inputSchema && !definition?.validation?.enum) return [];
            return [{field: name, reason: "invalid" as const, message: error.correction,
              ...(definition.validation?.enum ? {allowedValues: definition.validation.enum} : {}),
              inputSchema: definition.inputSchema ?? {enum: definition.validation!.enum!}}];
          }));
          const corrections = rawCorrections?.map(correction => schema.fields[correction.field]
            ? withFieldClarification(schema.fields[correction.field]!, correction) : correction);
          throw new BusinessInputError(error.code, error.field, error.correction,
            base && delta.baseReference ? {frameId: base.frameId} : error.baseReference, error.recovery, corrections);
        }
        throw error;
      }
    }
    // 初次失败保留原文以便重试；已有确定焦点时失败草稿不抢占它，回执给显式重试引用。
    const saved = await this.store.save(frame, state.version, key, frame.status !== "draft" || !state.focusFrameId);
    this.trace(saved);
    return saved;
  }
  /** 选择只绑定同会话、同来源的旧候选，编码仍经原 Resolver 复核；草稿闸门覆盖其余失败字段。 */
  private async preserveBoundConfirmation(delta: ContextDelta, identity: TurnIdentity, context: ResolverContext,
    invalidFields: string[]): Promise<BusinessFrame | undefined> {
    if (!context.replyEvidence || delta.baseReference === null) return undefined;
    const state = await this.store.state();
    let base: BusinessFrame | undefined;
    if (delta.baseReference && delta.baseReference !== "current") {
      const resolution = resolveFrame(delta.baseReference, state, await this.store.list(), identity.turnId);
      if (resolution.status === "resolved") base = await this.store.get(resolution.frameId!);
    } else if (state.focusFrameId) base = await this.store.get(state.focusFrameId);
    if (!base || base.sessionId !== identity.sessionId || !inheritableFrame(base) || base.status === "executing"
      || base.issues.some(issue => issue.field === "$base") || delta.capabilityHint && delta.capabilityHint !== base.capability) return undefined;
    const selection = context.confirmationSelection;
    if (selection && selection.frameId !== base.frameId && selection.frameId !== base.recovery?.selectionFrameId) return undefined;
    const latest = await this.store.get(state.operations[base.operationFrameId] ?? base.frameId);
    if (latest?.recovery) return latest;
    if (latest && (!inheritableFrame(latest) || latest.status === "executing")) return undefined;
    if (base.recovery) return base;
    const schema = this.capabilities.get(base.capability);
    const pending = clarificationOptions(base, fieldLabels(schema)).filter(group =>
      (base!.fields[group.field]?.metadata?.candidateTurnId ?? base!.turnId) !== context.turnId);
    if (!pending.length) return undefined;
    const evidence = await context.replyEvidence(base.frameId);
    const boundIds = [...(evidence.optionIds ?? [])];
    if (boundIds.some(id => !pending.some(group => group.options.some(option => option.id === id)))) return undefined;
    // 自然文本也只从规范清单唯一对应；不使用失败提案中模型填写的 affirmation。
    const selected = selectOptions(pending, boundIds.length ? {reply: "", optionIds: boundIds} : evidence);
    const ids = selected.map(option => option.id);
    if (!ids.length || boundIds.some(id => !ids.includes(id))) return undefined;
    const selectedFields = new Set(selected.map(option => option.field));
    // 选择之外的参数失败可以单独保存选择；数量等本字段校验失败不能另存一个绕过失败的确认。
    if (invalidFields.some(name => selectedFields.has(name))) return undefined;
    const confirmation: ContextDelta = {capabilityHint: base.capability, baseReference: {frameId: base.frameId},
      executionMode: "resolve_more", fieldChanges: [...selectedFields].map(fieldHint => ({fieldHint, operation: "set", rawValue: {confirm: true}}))};
    const merged = await mergeFields(schema, base, confirmation, this.resolvers, context);
    applyFieldIntentConstraints(schema, merged.fields, confirmation, base);
    if ([...selectedFields].some(name => merged.fields[name]?.metadata?.confirmationTurnId !== context.turnId
      || ["invalid", "temporary_error"].includes(merged.fields[name]!.resolutionStatus)
      || merged.fields[name]?.metadata?.confirmationUnclear === true)) return undefined;
    const pendingFields = [...new Set([
      ...delta.fieldChanges.filter(change => change.operation !== "retain").map(change => change.fieldHint),
      ...Object.entries(delta.fieldIntents ?? {}).filter(([, intent]) => intent.mode !== "inherit").map(([name]) => name),
    ])].filter(name => !selectedFields.has(name) && Object.hasOwn(schema.fields, name));
    const pendingChanges = pendingFields.map(name => {
      const change = delta.fieldChanges.find(item => item.fieldHint === name);
      const intent = delta.fieldIntents?.[name];
      const raw = change?.rawValue;
      const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
      const evidence = object?.evidence as {sourceText?: unknown} | undefined;
      const sources = [intent?.sourceText, object?.sourceText, evidence?.sourceText,
        // 枚举是程序控制值，缺少原文锚定不能据此判断用户没有改变业务选择。
        ...(typeof raw === "string" && !schema.fields[name]!.validation?.enum?.includes(raw) ? [raw] : []),
        ...(Array.isArray(raw) ? raw : [])].filter((value): value is string => typeof value === "string" && !!value.trim());
      const sourceText = sources.find(value => hasInputEvidence(context.originalMessage, value));
      let expectedCount: number | undefined;
      if (sourceText && intent && typeof intent.expectedCount === "number") {
        try {
          const definition = schema.fields[name]!;
          validateFieldIntents({...schema, fields: {[name]: definition}}, {...delta,
            fieldChanges: change ? [change] : [], fieldIntents: {[name]: intent}}, context);
          if (definition.inputSchema) validateToolArguments({name: "recovery_field", description: "恢复字段结构",
            parameters: Type.Object({raw: Type.Unsafe(definition.inputSchema)}, {additionalProperties: false})},
          {type: "toolCall", name: "recovery_field", id: "recovery", arguments: {raw}});
          expectedCount = intent.expectedCount;
        } catch { /* 非法声明或字段形状不成为新的恢复数量约束。 */ }
      }
      return {field: name, operation: change?.operation === "retain" ? "inherit" as const : change?.operation ?? intent!.mode,
        ...(sourceText ? {sourceText} : {}), ...(expectedCount !== undefined ? {expectedCount} : {}),
        mayRetain: sources.length > 0 && sourceText === undefined};
    });
    const id = randomUUID();
    const frame: BusinessFrame = {frameId: id, ...identity, capability: base.capability,
      operationFrameId: base.operationFrameId, parentFrameId: base.frameId, fields: merged.fields,
      delta: confirmation, status: "draft", errorCode: "TURN_ARGUMENTS_PENDING",
      recovery: {turnId: identity.turnId, pendingFields, pendingChanges, selectionFrameId: base.frameId, optionIds: [...new Set(ids)].sort()},
      issues: validateFrame(schema, merged.fields, merged.issues).issues,
      createdAt: new Date().toISOString()};
    const saved = await this.store.save(frame, state.version,
      businessKey({phase: "verified-confirmation", ...identity, source: base.frameId, ids: [...new Set(ids)].sort(), pendingFields}), true);
    this.trace(saved);
    return saved;
  }
  /** 恢复只读定位与正常来源门禁一致；无法唯一绑定时仍走原参数/来源纠错，不猜焦点或来源。 */
  private async preflightRecovery(delta: ContextDelta, identity: TurnIdentity, context: ResolverContext): Promise<void> {
    if (!delta.fieldChanges.some(change => change.operation === "set") || delta.baseReference === null) return;
    const state = await this.store.state();
    let base: BusinessFrame | undefined;
    if (delta.baseReference && delta.baseReference !== "current") {
      const resolution = resolveFrame(delta.baseReference, state, await this.store.list(), identity.turnId);
      if (resolution.status === "resolved") base = await this.store.get(resolution.frameId!);
    } else if (state.focusFrameId) {
      const focus = await this.store.get(state.focusFrameId);
      const latest = focus ? await this.store.get(state.operations[focus.operationFrameId] ?? focus.frameId) : undefined;
      if (latest && (!inheritableFrame(latest) || latest.status === "executing" || latest.issues.some(issue => issue.field === "$base"))) return;
      base = latest?.status === "failed" ? latest : focus;
    }
    if (!base || base.sessionId !== identity.sessionId || !inheritableFrame(base) || base.status === "executing"
      || base.issues.some(issue => issue.field === "$base")) return;
    const schema = this.capabilities.list().find(item => item.capability === (delta.capabilityHint ?? base.capability));
    if (schema) preflightFieldRecovery(schema, base, delta, this.resolvers, context);
  }
  /** 焦点或所引用操作停在上一轮的 executing：回查后端真实终态并补写，不重发查询。 */
  private async settleStaleExecution(delta: ContextDelta, identity: TurnIdentity, context: ResolverContext): Promise<void> {
    if (!context.reconcileExecution) return;
    const state = await this.store.state();
    let target: BusinessFrame | undefined;
    if (delta.baseReference && delta.baseReference !== "current") {
      const resolution = resolveFrame(delta.baseReference, state, await this.store.list(), identity.turnId);
      if (resolution.status === "resolved") target = await this.store.get(resolution.frameId!);
    } else if (delta.baseReference !== null && state.focusFrameId) {
      target = await this.store.get(state.focusFrameId);
    }
    if (!target) return;
    const latest = await this.store.get(state.operations[target.operationFrameId] ?? target.frameId);
    if (latest?.status !== "executing" || latest.turnId === identity.turnId) return;
    const settled = await context.reconcileExecution(latest);
    if (settled) await this.finishExecution(latest, settled);
  }
  async beginExecution(frameId: string, identity: TurnIdentity): Promise<BusinessFrame> {
    const frame = await this.store.get(frameId);
    if (!frame || frame.sessionId !== identity.sessionId) throw new Error("FRAME_NOT_CURRENT_TURN");
    if (frame.turnId !== identity.turnId) throw new BusinessInputError("FRAME_NOT_CURRENT_TURN", "$frame",
      "不能直接执行上轮 Frame。用户确认继续已有查询时，调用 resolve_business_turn，沿用焦点或明确 baseReference，未变化字段省略（fieldChanges=[]），executionMode=execute，再执行返回的本轮 READY frameId。不要把确认话语当成新指标解析。原焦点未改变。");
    const focusId = (await this.store.state()).focusFrameId;
    const focus = focusId ? await this.store.get(focusId) : undefined;
    if (frame.recovery || focus?.recovery?.turnId === identity.turnId) {
      throw new BusinessInputError("TURN_CHANGES_PENDING", "$frame", "本轮仍有未完成的参数修正，已核验的确认已保存；请完成本轮全部变化校验后执行新 READY Frame。",
        {frameId: (focus?.recovery ? focus : frame).frameId});
    }
    if (frame.capability === "metric_query" && (frame.fields.selection?.resolvedValue === "ranking"
      || ["order", "top_n"].some(name => frame.fields[name]?.resolvedValue !== undefined)
      || legacyRankingOrder(frame.fields.operation?.resolvedValue))) throw new Error("LEGACY_QUERY_REQUIRES_NEW_TURN");
    if (frame.status !== "ready" || frame.delta.executionMode !== "execute") throw new Error("FRAME_NOT_EXECUTABLE");
    if (validateFrame(this.capabilities.get(frame.capability), frame.fields, frame.issues).status !== "READY") throw new Error("FRAME_NOT_READY");
    const key = businessKey({phase: "execute", frameId});
    const previous = await this.store.command(key);
    if (previous) return previous;
    const state = await this.store.state();
    const executing: BusinessFrame = {...structuredClone(frame), frameId: randomUUID(), parentFrameId: frame.frameId,
      status: "executing", createdAt: new Date().toISOString()};
    const saved = await this.store.save(executing, state.version, key);
    this.trace(saved);
    return saved;
  }
  async finishExecution(executing: BusinessFrame, result: Pick<BusinessFrame, "status" | "resultRef" | "resultSummary" | "errorCode">): Promise<BusinessFrame> {
    const key = businessKey({phase: "finish", frameId: executing.frameId});
    const prior = await this.store.command(key);
    if (prior) return prior;
    const state = await this.store.state();
    const next: BusinessFrame = {...structuredClone(executing), ...result,
      ...(result.status === "success" ? {fields: settleAnalysisScopeFields({...executing,
        fields: settleLatestQueryFields(executing, result.resultSummary?.fields?.query_dates,
          result.resultSummary?.rowCount ?? 0, result.resultSummary?.truncated ?? false)},
      result.resultSummary?.fields?.analysis_scope as AnalysisExecutionScope | undefined)} : {}), frameId: randomUUID(),
      parentFrameId: executing.frameId, createdAt: new Date().toISOString()};
    // 网络执行期间若焦点已改变，只追加审计快照，旧请求不能夺回焦点。
    const saved = await this.store.save(next, state.version, key, state.focusFrameId === executing.frameId);
    this.trace(saved);
    return saved;
  }
  /** 任意执行阶段的引用均可定位同一操作的已完成结果；不跨操作猜测。 */
  async resultFrame(frameId: string): Promise<BusinessFrame | undefined> {
    const frame = await this.store.get(frameId);
    if (!frame || frame.resultRef) return frame;
    const state = await this.store.state();
    const completed = await this.store.get(state.operations[frame.operationFrameId] ?? frameId);
    return completed?.status === "success" && completed.resultRef ? completed : frame;
  }
  completed(executing: BusinessFrame) { return this.store.command(businessKey({phase: "finish", frameId: executing.frameId})); }
  private trace(frame: BusinessFrame): void {
    const declared = new Set(this.capabilities.list().flatMap(schema => Object.keys(schema.fields)));
    console.info(JSON.stringify({event: "business_frame", session_id: frame.sessionId, turn_id: frame.turnId,
      frame_id: frame.frameId, parent_frame_id: frame.parentFrameId, capability: frame.capability,
      status: frame.status, result_ref: frame.resultRef, issues: frame.issues.map(({field, reason}) => ({field: declared.has(field) || ["$base", "$capability", "$result"].includes(field) ? field : "$unknown", reason})),
      fields: Object.fromEntries(Object.entries(frame.fields).map(([name, field]) => [name,
        {source: field.source, source_frame_id: field.sourceFrameId, resolver: field.resolver, status: field.resolutionStatus}]))}));
  }
}
