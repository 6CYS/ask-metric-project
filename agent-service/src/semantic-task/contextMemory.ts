import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {historySources, resolveHistoryOrganizationScopes} from "../historySources.js";
import type {HistoryTarget} from "./store.js";

/** 请求前保守估算只用于预算；验收仍使用 provider usage，不能把字符数当实测 token。 */
export function contextEstimate(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let units = 0;
  for (const character of text) units += character.codePointAt(0)! > 127 ? 1 : 0.3;
  return Math.ceil(units);
}

/** 以完整回合裁剪发送副本；本轮和工具调用配对不拆分，原生历史不修改。 */
export function workingMessages(messages: readonly AgentMessage[], budget = 4000): AgentMessage[] {
  const turns: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "compactionSummary" || message.role === "branchSummary") continue;
    if (message.role === "user") turns.push([]);
    turns.at(-1)?.push(message);
  }
  const current = turns.pop() ?? [], retained: AgentMessage[][] = [];
  let used = 0;
  for (const turn of turns.reverse()) {
    // 只计模型可见正文与调用关联；details 等原生元数据不发送，但仍保留供后续权限核验。
    const cost = contextEstimate(turn.map(message => message.role === "toolResult"
      ? {role: message.role, content: message.content, toolCallId: message.toolCallId, toolName: message.toolName}
      : message.role === "user" || message.role === "assistant" ? {role: message.role, content: message.content} : message));
    if (used + cost > budget || retained.length >= 3) break;
    retained.unshift(turn); used += cost;
  }
  return [...retained.flat(), ...current];
}

export async function scopeAvailable(request: AskMetricRequestContext, codes: string[]): Promise<boolean> {
  if (!codes.length) return true;
  const unique = [...new Set(codes)].sort(), key = JSON.stringify(unique);
  const cache = request.semanticScopeChecks ??= new Map();
  if (!cache.has(key)) cache.set(key, (async () => {
    try {
      const result = await request.backend.resolveBusinessField("organization", unique);
      if (result.status === "temporary_error") throw new BackendApiError(503, "机构权限复核服务暂不可用", "HISTORY_AUTHORIZATION_UNAVAILABLE");
      const actual = (result.value as {codes?: string[]} | undefined)?.codes;
      return result.status === "resolved" && !!actual && unique.length === new Set(actual).size && unique.every(code => actual.includes(code));
    } catch (error) {
      if (error instanceof BackendApiError && [403,404].includes(error.status)) return false;
      throw error;
    }
  })());
  return cache.get(key)!;
}

export async function availableReferences(request: AskMetricRequestContext, rows: HistoryTarget[]) {
  const decisions = await Promise.all(rows.map(row => scopeAvailable(request, row.scope ?? row.organizations)));
  return rows.filter((_, index) => decisions[index]);
}

/** 历史投影先查当前权限；未选用的失权旧结果只屏蔽该回合，不阻断无关新问题。 */
export async function safeWorkingHistory(request: AskMetricRequestContext, messages: AgentMessage[]) {
  const turns: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push([]);
    turns.at(-1)?.push(message);
  }
  const current = turns.pop() ?? [];
  const checked = await Promise.all(turns.map(async turn => {
    try {
      const sources = historySources(turn.flatMap(message => message.role === "toolResult" ? [message.details] : []), () => {throw new Error("HISTORY_SCOPE_UNAVAILABLE");});
      for (const [taskId, resultId] of sources.tasks) {
        const task = await request.backend.getTask(taskId);
        if (task.task_id !== taskId || !["SUCCEEDED","succeeded"].includes(task.status)
          || resultId && task.result?.result_id !== resultId) throw new Error("HISTORY_SCOPE_UNAVAILABLE");
      }
      const scopes = await resolveHistoryOrganizationScopes(sources, request.semanticTasks, () => {throw new Error("HISTORY_SCOPE_UNAVAILABLE");});
      for (const codes of scopes) if (!await scopeAvailable(request, codes)) throw new Error("HISTORY_SCOPE_UNAVAILABLE");
      return turn;
    } catch (error) {
      if (error instanceof BackendApiError && ![403,404,409,422].includes(error.status)) throw error;
      return turn.map(message => message.role === "assistant" ? {...message, content: [{type: "text" as const, text: "此轮历史证据当前不可访问，不能据此复述数值或继承条件。"}]}
        : message.role === "toolResult" ? {...message, details: undefined, content: [{type: "text" as const, text: "历史来源当前不可访问。"}]} : message);
    }
  }));
  return [...checked.flat(), ...current];
}

export async function permissionFilteredContext(request: AskMetricRequestContext, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const catalog = await request.semanticTasks!.historyCatalog();
  const allowed = await availableReferences(request, catalog.filter(row => {
    const refs = (context.references ?? context.related_history ?? []) as HistoryTarget[];
    const tasks = (context.tasks ?? []) as Array<{task_ref: string}>;
    return refs.some(ref => ref.task_ref === row.task_ref && ref.target_ref === row.target_ref) || tasks.some(task => task.task_ref === row.task_ref);
  }));
  const has = (task: string, target: string) => allowed.some(row => row.task_ref === task && row.target_ref === target);
  const filterTasks = (tasks: unknown) => Array.isArray(tasks) ? tasks.map(task => ({...task,
    targets: Array.isArray(task.targets) ? task.targets.filter((target: {target_ref: string}) => has(task.task_ref, target.target_ref)) : []})).filter(task => task.targets.length) : [];
  return {...context, tasks: filterTasks(context.tasks),
    ...(context.references ? {references: (context.references as HistoryTarget[]).filter(row => has(row.task_ref,row.target_ref))} : {}),
    ...(context.related_history ? {related_history: (context.related_history as HistoryTarget[]).filter(row => has(row.task_ref,row.target_ref))} : {}),
    ...(context.pending_tasks ? {pending_tasks: await availableReferences(request, context.pending_tasks as HistoryTarget[])} : {})};
}

/** 入场快照用于冻结来源，发送副本仍需按本轮权限过滤；不能直接注入旧确认条件。 */
export async function permissionFilteredAdmission(request: AskMetricRequestContext) {
  const store = request.semanticTasks!, projected = await store.admissionContext(request.operationId);
  if (!projected) return;
  const snapshot = (await store.turn(request.operationId))?.context;
  const allowed = new Set<string>();
  for (const task of snapshot?.tasks ?? []) {
    const codes = ["organizations", "comparison_organizations"].flatMap(field =>
      (task.target.fields[field]?.resolvedValue as {codes?: string[]} | undefined)?.codes ?? []);
    if (await scopeAvailable(request, codes)) allowed.add(snapshot?.plan?.steps.find(step => step.taskRef === task.ref)?.targetRef ?? task.target.ref);
  }
  const alternatives = [];
  for (const alternative of projected.pending_clarification?.alternatives ?? []) {
    const reference = (await store.historyCatalog()).find(row => row.task_ref === alternative.task_ref && row.target_ref === alternative.target_ref);
    if (reference && await scopeAvailable(request, reference.scope ?? reference.organizations)) alternatives.push(alternative);
  }
  const pendingQuestions = [];
  for (const question of projected.pending_questions ?? []) {
    if (!allowed.has(question.scope.target_ref) || !request.questionPublicationProof
      || !await request.questionPublicationProof(question)) continue;
    const stored = await store.question(question.question_id, question.version);
    const organizationQuestion = question.scope.field === "organizations" || question.scope.field === "comparison_organizations";
    const condition = stored?.binding.sourceConfirmation?.organizationCondition as {codes?: unknown} | undefined;
    const candidateCodes = organizationQuestion ? [...new Set([...(stored?.binding.options.map(option => option.candidate.code) ?? []),
      ...(Array.isArray(condition?.codes) ? condition.codes : [])])].filter((code): code is string => typeof code === "string" && !!code) : [];
    if (candidateCodes.length && !await scopeAvailable(request, candidateCodes)) continue;
    pendingQuestions.push(question);
  }
  const visibleQuestions = new Set(pendingQuestions.map(question => question.question_id));
  return {...projected, targets: projected.targets.filter(target => allowed.has(target.target_ref)),
    pending_questions: pendingQuestions,
    trusted_answers: (projected.trusted_answers ?? []).filter(answer => visibleQuestions.has(answer.question_id)),
    ...(projected.pending_clarification ? {pending_clarification: {...projected.pending_clarification, alternatives}} : {})};
}
