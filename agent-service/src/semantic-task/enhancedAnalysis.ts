import {createHash} from "node:crypto";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BusinessInputError} from "../business-context/inputError.js";
import {contextService, resolverContext} from "../tools/businessContext.js";
import type {ContextDelta, FieldResolution, OrganizationScopeInput, ResolvedOrganizations} from "../business-context/types.js";
import {hasInputEvidence, normalizeInputEvidence, organizationInputMembers} from "../business-context/inputEvidence.js";
import type {EnhancedAnalysis, SemanticOperation} from "./protocol.js";
import type {SemanticTask, SemanticTurn} from "./store.js";
import {backendIssue} from "./backendIssue.js";
import {bindFieldOperations} from "./actionBinding.js";
import {inquiryProblem, type AnalysisInquiry} from "../analysis/inquiry.js";
import type {EvidenceReference} from "../answerEvidence.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import {analysisEvidenceAliases, expandFindingRefs} from "../analysis/verifiedFindings.js";
import {completeRankingSteps} from "../analysis/contracts.js";
import {completeRankingOperation} from "../business-context/rankingEvidence.js";
import {metricMentions} from "../business-context/metricMentions.js";
import {retainedQueryScope, assertRetainedQueryScope, assertRecoveryComparisonBasis, completeRecoveryMetricAlternatives} from "./queryRecovery.js";

/** 分析计划复用既有口径校验和受治理取数，但来源、状态及执行许可统一进入语义任务。 */
export async function resolveEnhancedAnalysis(request: AskMetricRequestContext, task: SemanticTask,
  turn: SemanticTurn, operations: SemanticOperation[], signal?: AbortSignal) {
  const store = request.semanticTasks!;
  try {
    const declared = operations.filter(op => op.field === "_analysis");
    if (declared.length !== 1 || declared[0]?.action !== "set") throw new BusinessInputError(
      "ANALYSIS_PLAN_REQUIRED", "plan", "请在当前target.analysis提交一份完整分析计划，来源和机构日期变化保留在同一target。");
    const input = JSON.parse(declared[0].value) as EnhancedAnalysis;
    const previous = (await request.answerEvidence?.() ?? []).filter(item =>
      ["analysis_evidence", "business_overview"].includes(item.evidence.kind) && item.evidence.status === "succeeded");
    // 回读上轮报告不等于本轮已经执行过首批取数，避免把新追问误当成同轮补查。
    const executedThisTurn = previous.some(item => {
      const source = item.evidence as {execution_turn_id?: string; scope_id?: string};
      return (source.execution_turn_id ?? source.scope_id) === (request.semanticStep?.rootOperationId ?? request.operationId);
    });
    const inquiryError = inquiryProblem(input.plan.inquiry, previous, executedThisTurn);
    if (inquiryError) throw new BusinessInputError("ANALYSIS_INQUIRY_REQUIRED", "plan", inquiryError);
    const frameService = contextService(request);
    let baseId = turn.baseline?.frameId ?? turn.baseline?.baseFrameId;
    if (baseId && turn.baseline?.status === "succeeded") {
      // 任务保留签发许可时的READY引用；续问须继承同一操作成功后回填的实际范围。
      const completed = await frameService.resultFrame(baseId);
      if (completed?.status === "success") baseId = completed.frameId;
    }
    const inquirySources = await analysisInquirySources(request, task, turn, input.plan.inquiry, previous, baseId);
    const evidenceOrganizations = analysisInquiryOrganizations(turn, operations, input.plan.inquiry, inquirySources);
    if (input.kind === "business_analysis" && !operations.some(op => op.field === "time")
      && (evidenceOrganizations || !operations.some(op => op.field === "organizations"))) {
      const answered = new Set(input.plan.steps.flatMap(step => step.answers));
      // 原始问题及成功回执仍留在首批来源；本批只执行新增取证，不能把已有步骤重查一遍。
      input.plan.requirements = input.plan.requirements.filter(requirement => answered.has(requirement.id)
        || requirement.gap_reason || requirement.deferred_reason || !inquirySources.some(source => {
          const evidence = source.evidence as AnalysisEvidence;
          const prior = evidence.plan.requirements.find(item => item.question === requirement.question);
          if (!prior || !evidence.requirement_dispositions?.some(item => item.id === prior.id
            && item.question === prior.question && item.status === "completed")) return false;
          const steps = evidence.plan.steps.filter(step => step.answers.includes(prior.id));
          return steps.length > 0 && steps.every(step => evidence.evidence_items?.some(atom =>
            atom.step_ids?.includes(step.id) && ["fact", "calculation"].includes(atom.type ?? "") && atom.value != null));
        }));
    }
    // 原文已有正式身份时不再让模型suggestion阻止身份归一；未识别原文仍保留原提案供目录处理。
    const hasBoundOrganizations = request.semanticStep?.facts?.fragments.some(fragment => fragment.organizations.length);
    const organizationOperations = operations.filter(op => op.field === "organizations").map(op =>
      hasBoundOrganizations && op.action === "set" && !op.organizationScope ? {action: op.action, field: op.field, value: op.value} : op);
    const boundOrganizations: SemanticOperation[] = evidenceOrganizations
      ? [{action: "set", field: "organizations", value: evidenceOrganizations.join("、")}]
      : organizationOperations.length ? bindFieldOperations(organizationOperations,
      request.semanticStep?.facts, turn.baseline?.fields ?? {}, {analysis: true}).operations
      .filter(op => op.field === "organizations") : [];
    const scopeOperations = [...operations.filter(op => op.field !== "organizations"), ...boundOrganizations];
    const resolutionContext = resolverContext(request, signal);
    let organizationScope: {raw: string[]; resolution: FieldResolution} | undefined;
    const changes: ContextDelta["fieldChanges"] = [{fieldHint: "plan", operation: "set", rawValue: input.plan}];
    for (const op of scopeOperations.filter(item => item.field !== "_analysis" && item.field !== "objective")) {
      if (op.field === "operation" && op.action === "set" && op.queryOperation?.kind === "ranking"
        && input.kind === "business_analysis" && scopeOperations.filter(item => item.field === "operation").length === 1) {
        const proposed = op.queryOperation.position !== null && op.queryOperation.top_n !== null ? op.queryOperation
          : await completeRankingOperation(op.queryOperation, {
          originalMessage: turn.originalMessage, currentDate: turn.businessDate, turnId: turn.operationId,
          resolveCatalog: async () => ({status: "invalid"}),
          resolveMetricMentions: question => metricMentions(request, question),
        });
        if (!completeRankingSteps(input.plan, proposed)) throw new BusinessInputError(
          "ANALYSIS_RANKING_OPERATION_CONFLICT", "operation",
          "重复声明的排名操作与analysis.plan不一致或未完整。请保留本轮用户要求，在ranking步骤明确相同方向和条数；不要选择冲突的一方执行。范围operations可省略这条重复声明。");
        // 排名参数属于计划，不另存为范围字段；真正变化仍保留在新计划与原生调用记录。
        continue;
      }
      if (!["organizations", "time"].includes(op.field) || !["set", "clear"].includes(op.action)) throw new BusinessInputError(
        "ANALYSIS_SCOPE_OPERATION_UNSUPPORTED", op.field, "分析范围使用机构或日期的set/clear；选择可信source后只提交变化字段，指标和方法写入analysis.plan。");
      if (op.field === "organizations" && op.action === "set" && op.organizationScope) {
        const scope = analysisOrganizationScope(request, task, turn, op.organizationScope);
        const resolution = await resolutionContext.resolveOrganizationScope(scope.input);
        const value = resolution.status === "resolved" ? resolution.value as ResolvedOrganizations : undefined;
        if (scope.parentCode && value?.scope?.kind === "children_of" && value.scope.parent_code !== scope.parentCode)
          throw new BusinessInputError("ANALYSIS_ORGANIZATION_PARENT_CHANGED", "organizations",
            "正式机构范围与已确认来源中的父机构不一致，请保留原来源并重新核验机构范围，不能改查其他机构。");
        organizationScope = {raw: value?.codes ?? [scope.input.sourceText], resolution};
        changes.push({fieldHint: "organizations", operation: "set", rawValue: organizationScope.raw});
        continue;
      }
      changes.push({fieldHint: op.field, operation: op.action as "set" | "clear", ...("value" in op ? {rawValue: op.value} : {})});
    }
    const recoveryScope = await retainedQueryScope(request, task, changes, input.kind === "business_analysis" ? input.plan : undefined);
    if (recoveryScope && input.kind !== "business_analysis") throw new BusinessInputError(
      "QUERY_RECOVERY_PLAN_REQUIRED", "plan", "基础查询恢复请用同目标的business_analysis小范围计划，不升级为整套专项经营概览。");
    if (input.kind === "business_analysis") {
      if ((recoveryScope?.operation?.resolvedValue as {kind?: string} | undefined)?.kind !== "ranking")
        completeRecoveryMetricAlternatives(request, recoveryScope, input.plan);
      assertRecoveryComparisonBasis(request, recoveryScope, input.plan);
    }
    // 统一语义入口已从原文绑定出的机构不能因模型省略operations而退回账号默认机构。
    // 只采用后端inspect-goal的正式身份，仍由下游目录和权限复核；没有明确机构时保留原默认策略。
    const explicitOrgs = [...new Set(request.semanticStep?.facts?.fragments.flatMap(fragment => fragment.organizations) ?? [])];
    const inheritedOrgs = (turn.baseline?.fields.organizations?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? [];
    if (!changes.some(change => change.fieldHint === "organizations") && explicitOrgs.length
      && (explicitOrgs.length !== inheritedOrgs.length || explicitOrgs.some(code => !inheritedOrgs.includes(code))))
      throw new BusinessInputError("ANALYSIS_EXPLICIT_ORGANIZATION_REQUIRED", "organizations",
        "原文已明确机构，请在同一target.operations中set本轮原文机构名称。只写scope_notice不是范围条件，不能省略后改用账号默认机构；保留原分析计划修正，不向用户重复追问。");
    const frozenTime = recoveryScope?.time;
    const frozenOrganizations = recoveryScope?.organizations;
    if (recoveryScope) {
      // 跨轮回复只有“全部记录”时，范围依据仍是已冻结账本；仅供字段来源核验，
      // 不改写用户消息、不传给模型。下方仍核对冻结范围，执行时再次鉴权。
      resolutionContext.originalMessage = [resolutionContext.originalMessage,
        ...[frozenOrganizations, frozenTime].flatMap(field => field?.resolutionStatus === "resolved"
          ? Array.isArray(field.rawValue) ? field.rawValue.map(String) : [String(field.rawValue)] : [])].join("\n");
    }
    // 基础查询已经核验的日历直接复用，避免“上月末”升级后被重新解析为整个月或最近记录。
    if (frozenTime?.resolutionStatus === "resolved" || frozenOrganizations?.resolutionStatus === "resolved") {
      const resolveCatalog = resolutionContext.resolveCatalog;
      resolutionContext.resolveCatalog = (entity, raw, referenceYear) => {
        const frozen = entity === "date" ? frozenTime : entity === "organization" ? frozenOrganizations : undefined;
        // 集合编码及指纹来自已授权解析；执行入口仍按当前权限和目录重新核对指纹。
        const sameRaw = (Array.isArray(frozen?.rawValue) ? frozen.rawValue.join("、") : String(frozen?.rawValue)) === raw.join("、");
        return frozen?.resolutionStatus === "resolved" && sameRaw
          ? Promise.resolve({status: "resolved", value: structuredClone(frozen.resolvedValue), metadata: structuredClone(frozen.metadata ?? {})})
          : resolveCatalog(entity, raw, referenceYear);
      };
    }
    if (organizationScope) {
      const verifiedScope = organizationScope, resolveCatalog = resolutionContext.resolveCatalog;
      // 仅把本次正式解析结果交给同一组编码，保留集合指纹；不放宽通用字段的原文约束。
      resolutionContext.resolveCatalog = (entity, raw, referenceYear) => entity === "organization"
        && raw.length === verifiedScope.raw.length && raw.every((value, index) => value === verifiedScope.raw[index])
        ? Promise.resolve(structuredClone(verifiedScope.resolution)) : resolveCatalog(entity, raw, referenceYear);
    }
    const boundOrganizationCodes = organizationScope?.resolution.status === "resolved" ? organizationScope.raw : evidenceOrganizations ?? explicitOrgs;
    const frame = await frameService.resolve({capabilityHint: input.kind,
      baseReference: baseId ? {frameId: baseId} : null, executionMode: "execute", fieldChanges: changes},
    {sessionId: request.sessionId, requestId: request.requestId, turnId: request.operationId}, {
      ...resolutionContext, ...(boundOrganizationCodes.length ? {boundOrganizationCodes} : {}),
    });
    assertRetainedQueryScope(recoveryScope, frame.fields);
    task.capability = input.kind;
    task.target = {...task.target, fields: structuredClone(frame.fields), pending: {}, frameId: frame.frameId,
      status: frame.status === "ready" ? "ready" : "blocked"};
    task.revision++;
    task.issues = frame.issues.map(item => ({code: "ANALYSIS_FIELD_UNRESOLVED", field: item.field,
      category: "semantic", message: item.message ?? `${item.field}尚未确定`, remediation: "pi" as const}));
    task.status = "active"; task.completion = "unmet";
    delete task.permit;
    if (frame.status === "ready") task.permit = {operationId: request.operationId, revision: task.revision,
      frameId: frame.frameId, digest: createHash("sha256").update(JSON.stringify(task.target.fields)).digest("hex"),
      actor: request.actor.id, consumed: false};
    await store.save(task, (await store.index()).version, turn, true,
      recoveryScope && frame.status === "ready" ? {questions: []} : {});
    return {task, status: frame.status === "ready" ? "ready" as const : "needs_interpretation" as const};
  } catch (error) {
    if (signal?.aborted) throw error;
    const problem = error instanceof BusinessInputError ? {code: error.code, field: error.field,
      category: error.code === "QUERY_RECOVERY_ALTERNATIVES_REQUIRED" ? "catalog" : "input_shape",
      message: error.correction, remediation: "pi" as const} : backendIssue(error);
    task.issues = [problem]; task.status = "active"; task.completion = "unmet";
    task.target.status = "blocked"; delete task.permit;
    await store.save(task, (await store.index()).version, turn);
    return {task, status: problem.category === "permission" ? "denied" as const
      : problem.remediation === "stop" ? "failed" as const : "needs_interpretation" as const};
  }
}

function analysisOrganizationScope(request: AskMetricRequestContext, task: SemanticTask,
  turn: SemanticTurn, scope: OrganizationScopeInput): {input: OrganizationScopeInput; parentCode?: string} {
  if (!hasInputEvidence(turn.originalMessage, scope.sourceText)) throw new BusinessInputError(
    "ANALYSIS_ORGANIZATION_SOURCE_INVALID", "organizations", "机构范围source_text必须引用本轮原文，不能从历史补造当前用户未要求的范围。");
  if (scope.kind !== "children_of" || hasInputEvidence(scope.sourceText, scope.parentName)) return {input: scope};
  const previous = turn.baseline?.fields.organizations;
  const value = previous?.resolvedValue as ResolvedOrganizations | undefined;
  const parentCode = value?.codes?.[0];
  const inherited = task.owner === request.actor.id && (turn.source?.kind === "current" || turn.source?.kind === "reference")
    && previous?.resolutionStatus === "resolved" && value?.codes?.length === 1 && value.names?.length === 1
    && [...value.codes, ...value.names].some(name => normalizeInputEvidence(name) === normalizeInputEvidence(scope.parentName));
  if (!inherited || !parentCode) throw new BusinessInputError("ANALYSIS_ORGANIZATION_PARENT_UNBOUND", "organizations",
    "本轮未明示父机构时，只能沿用已选current/reference来源中唯一、已确认的机构，不能补造或扩大父机构范围。");
  return {input: {...scope, parentName: parentCode}, parentCode};
}

/** 调查对象可来自本轮已引用事实；只接受所选来源内的真实成员，仍交目录复核权限。 */
async function analysisInquirySources(request: AskMetricRequestContext, task: SemanticTask, turn: SemanticTurn,
  inquiry: AnalysisInquiry | undefined, previous: EvidenceReference[], baseId: string | undefined): Promise<EvidenceReference[]> {
  const baseline = turn.baseline?.fields.organizations;
  const organizations = baseline?.resolvedValue as ResolvedOrganizations | undefined;
  if (!inquiry || task.owner !== request.actor.id || !["current", "reference"].includes(turn.source?.kind ?? "")
    || turn.baseline?.status !== "succeeded" || baseline?.resolutionStatus !== "resolved"
    || !organizations?.codes.length || organizations.codes.length !== organizations.names.length || !baseId) return [];
  const frame = await request.frames?.get(baseId);
  if (frame?.sessionId !== request.sessionId || frame.status !== "success") return [];
  const rootTurn = request.semanticStep?.rootOperationId ?? request.operationId;
  return previous.filter(source => {
    const evidence = source.evidence as AnalysisEvidence;
    if (evidence.kind !== "analysis_evidence" || evidence.status !== "succeeded"
      || (evidence.execution_turn_id ?? evidence.scope_id) !== rootTurn || evidence.frame_id !== baseId
      || evidence.org_codes.some(code => !organizations.codes.includes(code))) return false;
    const atoms = new Map((evidence.evidence_items ?? []).map(atom => [atom.ref, atom]));
    const aliases = analysisEvidenceAliases(source.ref, [...atoms.values()]);
    const cited = inquiry.basis_refs.map(ref => aliases.get(ref) ?? ref).filter(ref => atoms.has(ref));
    return expandFindingRefs(cited, atoms).some(ref => {
      const atom = atoms.get(ref)!;
      return ["fact", "calculation"].includes(atom.type ?? "") && atom.value != null;
    });
  });
}

function analysisInquiryOrganizations(turn: SemanticTurn, operations: SemanticOperation[],
  inquiry: AnalysisInquiry | undefined, sources: EvidenceReference[]): string[] | undefined {
  const changes = operations.filter(operation => operation.field === "organizations"), change = changes[0];
  if (!inquiry || !sources.length || changes.length !== 1 || change?.action !== "set" || change.organizationScope) return;
  const organizations = turn.baseline!.fields.organizations!.resolvedValue as ResolvedOrganizations;
  const names = change.values ?? organizationInputMembers(change.value);
  if (!names.length || names.every(name => hasInputEvidence(turn.originalMessage, name))) return;
  const eligible = new Set<string>();
  for (const source of sources) {
    const evidence = source.evidence as AnalysisEvidence;
    const atoms = new Map((evidence.evidence_items ?? []).map(atom => [atom.ref, atom]));
    const aliases = analysisEvidenceAliases(source.ref, [...atoms.values()]);
    const cited = inquiry.basis_refs.map(ref => aliases.get(ref) ?? ref).filter(ref => atoms.has(ref));
    for (const ref of expandFindingRefs(cited, atoms)) {
      const atom = atoms.get(ref)!;
      if (["fact", "calculation"].includes(atom.type ?? "") && atom.value != null && atom.org_code
        && evidence.org_codes.includes(atom.org_code)) eligible.add(atom.org_code);
    }
  }
  const selected: string[] = [];
  for (const name of names) {
    const matches = organizations.codes.filter((code, index) => eligible.has(code)
      && [code, organizations.names[index]!].some(value => normalizeInputEvidence(value) === normalizeInputEvidence(name)));
    if (matches.length !== 1) return;
    selected.push(matches[0]!);
  }
  return [...new Set(selected)];
}
