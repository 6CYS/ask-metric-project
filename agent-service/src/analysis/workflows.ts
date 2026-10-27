import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {catalogBindingView} from "./bindings.js";
import {validateAnalysisPlanShape, type AnalysisPlan} from "./contracts.js";
import {organizationScopeInput} from "../business-context/organizationScope.js";
import type {SemanticOperation} from "../semantic-task/protocol.js";

export interface WorkflowRoute {
  status: "matched" | "fallback";
  reason?: string;
  workflow_id?: "profitability_ranking_v1";
  version?: string;
  name?: string;
  basis?: string;
  parameters?: {position: "top" | "bottom"; top_n: number; explain: boolean};
  plan?: AnalysisPlan;
  metrics?: unknown[];
  admission?: {organization_expression?: string; expected_org_count?: number; numbered_cohort?: boolean};
  retrieval?: {strategy: string; matched_document: {id: string; text: string};
    embedding_model?: string; reranker_model?: string;
    rerank_score: number; other_class_score: number; min_score: number; min_margin: number};
}

export interface WorkflowDebugTrace {
  schema_version: 1; workflow_id: string; name: string; version?: string; basis?: string;
  retrieval?: WorkflowRoute["retrieval"];
  phase: string; outcome?: string; run_ref?: string;
  date_policy?: {mode?: unknown; requested_start?: unknown; requested_end?: unknown; actual_dates?: unknown};
  coverage?: unknown; interpretation?: unknown;
  steps: Array<Record<string, unknown>>;
}

/** 调试视图只采用服务端注册计划与真实执行回执，不收集模型的自由规划文字。 */
export function workflowDebugTrace(route: WorkflowRoute, evidence: Record<string, unknown> | undefined,
  status: string): WorkflowDebugTrace | undefined {
  if (route.status !== "matched" || !route.plan || !route.workflow_id) return;
  const leaves = (value: Record<string, unknown> | undefined): Record<string, unknown>[] =>
    value?.kind === "semantic_results" && Array.isArray(value.results)
      ? value.results.flatMap(item => item && typeof item === "object" ? leaves(item as Record<string, unknown>) : [])
      : value ? [value] : [];
  const result = leaves(evidence).find(item => item.kind === "analysis_evidence"
    && (item.plan as AnalysisPlan | undefined)?.workflow_id === route.workflow_id);
  const execution = result?.workflow_execution as {steps?: Array<Record<string, unknown>>} | undefined;
  const brief = result?.workflow_brief as Record<string, unknown> | undefined;
  const metrics = (route.metrics ?? []) as Array<{binding_ref?: string; code?: string; name?: string}>;
  return {schema_version: 1, workflow_id: route.workflow_id, name: route.name ?? "机构盈利排名及原因分析",
    ...(route.version ? {version: route.version} : {}), ...(route.basis ? {basis: route.basis} : {}),
    ...(route.retrieval ? {retrieval: route.retrieval} : {}),
    phase: result ? "executed" : status === "needs_user" ? "awaiting_input"
      : ["failed", "denied", "invalid_input", "unsupported"].includes(status) ? "blocked" : "planned",
    ...(result ? {outcome: String(brief?.outcome ?? "unknown"), run_ref: String(result.run_ref),
      date_policy: {mode: result.date_selection, requested_start: result.requested_start,
        requested_end: result.requested_end, actual_dates: result.actual_dates},
      coverage: brief?.coverage, interpretation: brief?.interpretation} : {}),
    steps: route.plan.steps.map(step => ({id: step.id, method: step.method, rationale: step.rationale,
      depends_on: step.depends_on ?? [], organization_from_step: step.organization_from_step,
      position: step.position, top_n: step.top_n,
      metrics: step.metric_refs.flatMap(ref => {
        const metric = metrics.find(item => item.binding_ref === ref);
        return metric ? [{code: metric.code, name: metric.name ?? metric.code}] : [];
      }),
      status: result ? "not_recorded" : "not_started", ...execution?.steps?.find(item => item.id === step.id)})),
  };
}
const routes = new WeakMap<AskMetricRequestContext, Promise<WorkflowRoute>>();

/** 同一入场问题只召回一次；服务不可用仅放弃预设路线，权限拒绝继续抛出。 */
export function workflowRoute(request: AskMetricRequestContext, signal?: AbortSignal): Promise<WorkflowRoute> {
  let pending = routes.get(request);
  if (!pending) {
    pending = (async (): Promise<WorkflowRoute> => {
      if (!request.backend.analysisWorkflowRoute || request.trustedAnswers?.length
        || !/收益|盈利|利润|赚钱/u.test(request.originalMessage)) return {status: "fallback"};
      try {
        const raw = await request.backend.analysisWorkflowRoute(request.originalMessage, {signal});
        if (raw.status !== "matched" || raw.workflow_id !== "profitability_ranking_v1"
          || !validateAnalysisPlanShape(raw.plan) || raw.plan.workflow_id !== raw.workflow_id
          || !Array.isArray(raw.metrics)) return {status: "fallback", reason: String(raw.reason ?? "invalid_route")};
        catalogBindingView(request, raw.metrics);
        return raw as unknown as WorkflowRoute;
      } catch (error) {
        if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {status: "fallback", reason: "retrieval_unavailable"};
      }
    })();
    routes.set(request, pending);
  }
  return pending;
}

/** 给模型一个简单的注册路线入口；内部仍转成唯一语义协议，不另建任务状态。 */
export function workflowPublicParameters(parameters: unknown, route: WorkflowRoute): unknown {
  if (route.status !== "matched") return parameters;
  const schema = structuredClone(parameters) as {definitions: {target: {properties: {analysis: {oneOf: unknown[]}}}}};
  schema.definitions.target.properties.analysis.oneOf = [{type: "object", additionalProperties: false,
    required: ["kind", "workflow_id"], properties: {kind: {const: "registered_workflow"},
      workflow_id: {const: route.workflow_id}}}];
  return schema;
}

export async function materializeWorkflowProposal(raw: unknown, request: AskMetricRequestContext, signal?: AbortSignal): Promise<unknown> {
  if (!raw || typeof raw !== "object") return raw;
  const input = raw as {intent?: string; targets?: Array<{analysis?: Record<string, unknown>}>};
  if (input.intent !== "analyze" || input.targets?.length !== 1) return raw;
  const analysis = input.targets[0]?.analysis;
  if (!["registered_workflow", "business_analysis"].includes(String(analysis?.kind))) return raw;
  const route = await workflowRoute(request, signal);
  if (route.status !== "matched" || analysis?.kind === "registered_workflow"
    && (analysis.workflow_id !== route.workflow_id
      || Object.keys(analysis).some(key => !["kind", "workflow_id"].includes(key)))) return raw;
  const result = structuredClone(raw) as {targets: Array<{analysis: unknown; operations?: Array<Record<string, unknown>>}>};
  result.targets[0]!.analysis = {kind: "business_analysis", plan: structuredClone(route.plan)};
  const expression = route.admission?.organization_expression;
  const numbered = route.admission?.numbered_cohort === true && typeof expression === "string"
    && /^[1-9]\d{0,2}\s*家(?:机构|农商行|银行)$/u.test(expression);
  if (typeof expression === "string" && request.originalMessage.includes(expression)
    && (numbered || organizationScopeInput(expression)?.kind === "authorized_cohort")) {
    result.targets[0]!.operations = [...(result.targets[0]!.operations ?? []).filter(op => op.field !== "organizations"),
      {action: "set", field: "organizations", value: expression}];
  }
  // 从当前可信回执重新登记，防止恢复上下文投影时覆盖本轮目录短引用。
  catalogBindingView(request, route.metrics);
  return result;
}

/** 先通过唯一公开协议校验，再附加服务端已核验的范围标记，不能把内部标记塞进模型参数。 */
export async function bindWorkflowScopeOperations(operations: SemanticOperation[], request: AskMetricRequestContext, signal?: AbortSignal) {
  const route = await workflowRoute(request, signal), expression = route.admission?.organization_expression;
  if (route.status !== "matched" || route.admission?.numbered_cohort !== true || typeof expression !== "string"
    || !/^[1-9]\d{0,2}\s*家(?:机构|农商行|银行)$/u.test(expression) || !request.originalMessage.includes(expression)) return operations;
  return operations.map(op => op.action === "set" && op.field === "organizations" && op.value === expression
    ? {...op, organizationScope: {kind: "authorized_cohort" as const, cohort: "rural_commercial_banks" as const, sourceText: expression}} : op);
}

export function workflowTurnView(route: WorkflowRoute): Record<string, unknown> | undefined {
  return route.status === "matched" ? {workflow_id: route.workflow_id, version: route.version,
    name: route.name, basis: route.basis, parameters: route.parameters,
    instruction: "已召回并准备服务端注册路线。调用resolve_business_turn，intent=analyze，只提交一个target：source按真实新问或继承选择，operations只提交当前机构及日期变化，analysis={kind:registered_workflow,workflow_id:profitability_ranking_v1}。不编写plan、不先检索目录；程序自动排名并从排名结果选机构补查。日期无数据也是有效覆盖结果，收到workflow_brief后直接组织报告，不改日期或另换机构重试。"} : undefined;
}

/** 只缩减模型视图，完整证据、排名参与集和校验依据仍保存在回执。 */
export function compactWorkflowEvidence(result: Record<string, unknown>, aliases: Map<string, string>): Record<string, unknown> {
  const brief = result.workflow_brief as {focus_refs?: string[]; selected_org_codes?: string[]; [key: string]: unknown} | undefined;
  if (!brief) return {};
  const reverse = new Map([...aliases].map(([alias, ref]) => [ref, alias]));
  const focus = new Set(brief.focus_refs);
  const selected = new Set(brief.selected_org_codes);
  const atoms = (result.evidence_items as Array<Record<string, unknown>>).filter(atom => focus.has(String(atom.ref))
    || atom.judgment_kind === "ranking" || selected.has(String(atom.org_code)) && atom.type !== "observation");
  const translate = (value: unknown): unknown => {
    if (typeof value === "string") return reverse.get(value) ?? value;
    if (Array.isArray(value)) return value.map(translate);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item)]));
    return value;
  };
  // 完整参与事实链只供服务端校验；模型引用排名判断即可，不必读完整同行引用列表。
  const modelBrief = {...brief, focus_refs: undefined,
    ranking: Array.isArray(brief.ranking) ? brief.ranking.map((item: Record<string, unknown>) => ({...item,
      fact_refs: undefined, comparison_fact_refs: undefined})) : brief.ranking};
  return {workflow_brief: translate(modelBrief), evidence_items: atoms.map(atom => ({...atom,
    ref: reverse.get(String(atom.ref)) ?? atom.ref, input_refs: undefined,
    fact_id: undefined, metadata_version: undefined, input_fact_refs: undefined, calculation_id: undefined})),
    org_codes: undefined, org_names: undefined, observations: undefined, plan: undefined,
    workflow_execution: undefined,
    verified_findings: undefined,
    next_action: "预设路线已执行。立即调用analysis_report_present，evidence_refs使用当前e编号，body只写一句交付说明，不再撰写数值或原因结论。服务端根据本次真实回执编译排名、正式比较、收入成本事实及原因证据边界，可通过presentation选择简洁或详细展示。outcome=no_data是正常覆盖结果，保留用户日期，不补零、不换日期；unavailable才是服务问题。关键结论由注册路线负责，不自行改成盈利效率排名或重写因果分析。"};
}
