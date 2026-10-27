import {createHash} from "node:crypto";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BusinessInputError} from "../business-context/inputError.js";
import {contextService, resolverContext} from "../tools/businessContext.js";
import type {ContextDelta} from "../business-context/types.js";
import type {EnhancedAnalysis, SemanticOperation} from "./protocol.js";
import type {SemanticTask, SemanticTurn} from "./store.js";
import {backendIssue} from "./backendIssue.js";
import {bindFieldOperations} from "./actionBinding.js";
import {inquiryProblem} from "../analysis/inquiry.js";
import {completeRankingSteps} from "../analysis/contracts.js";
import {completeRankingOperation} from "../business-context/rankingEvidence.js";
import {metricMentions} from "../business-context/metricMentions.js";
import {retainedQueryScope, assertRetainedQueryScope, assertRecoveryComparisonBasis, completeRecoveryMetricAlternatives} from "./queryRecovery.js";
import {bindWorkflowScopeOperations} from "../analysis/workflows.js";

/** 分析计划复用既有口径校验和受治理取数，但来源、状态及执行许可统一进入语义任务。 */
export async function resolveEnhancedAnalysis(request: AskMetricRequestContext, task: SemanticTask,
  turn: SemanticTurn, operations: SemanticOperation[], signal?: AbortSignal) {
  const store = request.semanticTasks!;
  try {
    const declared = operations.filter(op => op.field === "_analysis");
    if (declared.length !== 1 || declared[0]?.action !== "set") throw new BusinessInputError(
      "ANALYSIS_PLAN_REQUIRED", "plan", "请在当前target.analysis提交一份完整分析计划，来源和机构日期变化保留在同一target。");
    const input = JSON.parse(declared[0].value) as EnhancedAnalysis;
    let calendarBinding: import("../business-context/types.js").ResolverContext["boundAnalysisCalendar"];
    if (input.kind === "business_analysis") {
      // 分析统一复用原句的正式身份和日历；不要求模型重复抄写已经确定的范围。
      const binding = bindFieldOperations(operations, request.semanticStep?.facts,
        turn.baseline?.fields ?? {}, {analysis: true});
      operations = binding.operations;
      const time = operations.find(op => op.field === "time" && op.action === "set");
      if (binding.calendar && time && "value" in time) calendarBinding = {raw: time.value, value: binding.calendar};
      if (input.plan.workflow_id) operations = await bindWorkflowScopeOperations(operations, request, signal);
    }
    const previous = (await request.answerEvidence?.() ?? []).filter(item =>
      ["analysis_evidence", "business_overview"].includes(item.evidence.kind) && item.evidence.status === "succeeded");
    // 回读上轮报告不等于本轮已经执行过首批取数，避免把新追问误当成同轮补查。
    const executedThisTurn = previous.some(item => {
      const source = item.evidence as {execution_turn_id?: string; scope_id?: string};
      return (source.execution_turn_id ?? source.scope_id) === (request.semanticStep?.rootOperationId ?? request.operationId);
    });
    const inquiryError = inquiryProblem(input.plan.inquiry, previous, executedThisTurn);
    if (inquiryError) throw new BusinessInputError("ANALYSIS_INQUIRY_REQUIRED", "plan", inquiryError);
    // 原文已有正式身份时不再让模型suggestion阻止身份归一；未识别原文仍保留原提案供目录处理。
    const hasBoundOrganizations = request.semanticStep?.facts?.fragments.some(fragment => fragment.organizations.length);
    const organizationOperations = operations.filter(op => op.field === "organizations").map(op =>
      hasBoundOrganizations && op.action === "set" && !("organizationScope" in op && op.organizationScope) ? {action: op.action, field: op.field, value: op.value} : op);
    const boundOrganizations = organizationOperations.length ? bindFieldOperations(organizationOperations,
      request.semanticStep?.facts, turn.baseline?.fields ?? {}, {analysis: true}).operations
      .filter(op => op.field === "organizations") : [];
    // 兼容模型把明确指标重复写到范围operations：先核对本轮正式身份，再由计划完整性校验接管。
    // 不接受clear、猜测指标或借此覆盖原目标；普通查询的指标变更协议保持原样。
    const explicitMetrics = await metricMentions(request);
    const explicitCodes = new Set(explicitMetrics.mentions.flatMap(mention => mention.resolution.status === "resolved"
      ? (mention.resolution.value as {codes?: string[]} | undefined)?.codes ?? [] : []));
    const redundantMetrics = new Set<SemanticOperation>();
    for (const op of operations.filter(item => input.kind === "business_analysis" && item.field === "metrics" && item.action === "set")) {
      if (op.action !== "set") continue;
      const supplied = await metricMentions(request, op.value);
      const codes = supplied.mentions.flatMap(mention => mention.resolution.status === "resolved"
        ? (mention.resolution.value as {codes?: string[]} | undefined)?.codes ?? [] : []);
      if (codes.length && supplied.status !== "temporary_error" && codes.every(code => explicitCodes.has(code))) redundantMetrics.add(op);
    }
    const scopeOperations = [...operations.filter(op => op.field !== "organizations" && !redundantMetrics.has(op)), ...boundOrganizations];
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
      changes.push({fieldHint: op.field, operation: op.action as "set" | "clear", ...("value" in op ? {rawValue: op.field === "organizations" && "organizationScope" in op && op.organizationScope ? op.organizationScope : op.value} : {})});
    }
    const recoveryScope = await retainedQueryScope(request, task, changes, input.kind === "business_analysis" ? input.plan : undefined);
    if (recoveryScope && input.kind !== "business_analysis") throw new BusinessInputError(
      "QUERY_RECOVERY_PLAN_REQUIRED", "plan", "基础查询恢复请用同目标的business_analysis小范围计划，不升级为整套专项经营概览。");
    if (input.kind === "business_analysis") {
      if ((recoveryScope?.operation?.resolvedValue as {kind?: string} | undefined)?.kind !== "ranking")
        completeRecoveryMetricAlternatives(request, recoveryScope, input.plan);
      assertRecoveryComparisonBasis(request, recoveryScope, input.plan);
    }
    const baseId = turn.baseline?.frameId ?? turn.baseline?.baseFrameId;
    // 统一语义入口已从原文绑定出的机构不能因模型省略operations而退回账号默认机构。
    // 只采用后端inspect-goal的正式身份，仍由下游目录和权限复核；没有明确机构时保留原默认策略。
    const explicitOrgs = [...new Set(request.semanticStep?.facts?.fragments.flatMap(fragment => fragment.organizations) ?? [])];
    const inheritedOrgs = (turn.baseline?.fields.organizations?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? [];
    if (!changes.some(change => change.fieldHint === "organizations") && explicitOrgs.length
      && (explicitOrgs.length !== inheritedOrgs.length || explicitOrgs.some(code => !inheritedOrgs.includes(code))))
      throw new BusinessInputError("ANALYSIS_EXPLICIT_ORGANIZATION_REQUIRED", "organizations",
        "原文已明确机构，请在同一target.operations中set本轮原文机构名称。只写scope_notice不是范围条件，不能省略后改用账号默认机构；保留原分析计划修正，不向用户重复追问。");
    const resolutionContext: import("../business-context/types.js").ResolverContext = resolverContext(request, signal);
    if (calendarBinding) resolutionContext.boundAnalysisCalendar = calendarBinding;
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
    const frame = await contextService(request).resolve({capabilityHint: input.kind,
      baseReference: baseId ? {frameId: baseId} : null, executionMode: "execute", fieldChanges: changes},
    {sessionId: request.sessionId, requestId: request.requestId, turnId: request.operationId}, {
      ...resolutionContext, ...(explicitOrgs.length ? {boundOrganizationCodes: explicitOrgs} : {}),
    });
    assertRetainedQueryScope(recoveryScope, frame.fields);
    delete task.analysisDiagnostics;
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
    if (error instanceof BusinessInputError && error.analysisDiagnostics) task.analysisDiagnostics = error.analysisDiagnostics;
    else delete task.analysisDiagnostics;
    task.issues = [problem]; task.status = "active"; task.completion = "unmet"; delete task.permit;
    await store.save(task, (await store.index()).version, turn);
    return {task, status: problem.category === "permission" ? "denied" as const
      : problem.remediation === "stop" ? "failed" as const : "needs_interpretation" as const};
  }
}
