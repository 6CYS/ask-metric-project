import {referencedQueryNumbers} from "./historyReference.js";
import {createHash} from "node:crypto";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {BackendApiError, type AnswerBlock} from "../backendClient.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import {isSemanticFeedback, type SemanticFeedback} from "./feedback.js";
import {semanticPlanDigest} from "./planService.js";
import type {SemanticTask, SemanticTurn} from "./store.js";
import {completeQuery, transitionValue, type TransitionField} from "./transition.js";
import {withoutContextResetInstruction} from "./sourceGuard.js";

export interface DirectAnswerSource {
  target_ref: string; frame_id: string; task_id: string; result_id: string; result_ref: string;
  row_count: number; truncated: false;
}
export interface DirectAnswerSnapshot {
  version: 1; renderer_version: "query_result_v1"; delivery_path: "direct_query";
  answer_id: string; operation_id: string; plan_ref: string; plan_revision: number;
  public_answer: string; answer_blocks: AnswerBlock[]; sources: DirectAnswerSource[];
}
export interface DirectDeliveryDecision {
  eligible: boolean; reason: string; snapshot?: DirectAnswerSnapshot;
  /** 复核失败必须删除事实，不能把已失权/未知的事实交给模型再说一遍。 */
  terminalFeedback?: SemanticFeedback;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const segments = (value: unknown): boolean => Array.isArray(value) && value.every(item => object(item) && typeof item.text === "string" && typeof item.bold === "boolean");
function answerBlock(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.type === "paragraph") return segments(value.segments);
  if (value.type === "list") return typeof value.ordered === "boolean" && Array.isArray(value.items) && value.items.every(segments);
  const header = value.header;
  return value.type === "table" && Array.isArray(header) && header.every(segments)
    && Array.isArray(value.rows) && value.rows.every(row => Array.isArray(row) && row.length === header.length && row.every(segments))
    && Array.isArray(value.aligns) && value.aligns.length === header.length && value.aligns.every(item => ["left", "center", "right"].includes(item as string));
}
const snapshotId = (value: Omit<DirectAnswerSnapshot, "answer_id">) => "direct-answer-" + createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 唯一恢复入口：只认真实工具回执内的版本化完整快照，校验失败不能变成成功答案。 */
export function readDirectAnswerSnapshot(details: unknown): DirectAnswerSnapshot | undefined {
  if (!isSemanticFeedback(details) || !["succeeded", "reused"].includes(details.status)
    || details.state.completion !== "full" || !Array.isArray(details.issues) || details.issues.length
    || !object(details.continuation) || details.continuation.action !== "deliver_saved_answer"
    || !Array.isArray(details.state.targets) || details.state.targets.some(target => !object(target) || !nonempty(target.target_ref)
      || target.status !== "succeeded" || !Array.isArray(target.pending) || target.pending.length)) return;
  const candidate = (details as SemanticFeedback & {direct_answer?: unknown}).direct_answer;
  if (!object(candidate) || candidate.version !== 1 || candidate.renderer_version !== "query_result_v1" || candidate.delivery_path !== "direct_query"
    || !nonempty(candidate.answer_id) || !nonempty(candidate.operation_id) || !nonempty(candidate.plan_ref)
    || !Number.isInteger(candidate.plan_revision) || Number(candidate.plan_revision) < 1 || !nonempty(candidate.public_answer)
    || !Array.isArray(candidate.answer_blocks) || !candidate.answer_blocks.length || !candidate.answer_blocks.every(answerBlock)
    || !Array.isArray(candidate.sources) || !candidate.sources.length || candidate.sources.some(source => !object(source)
      || ![source.target_ref, source.frame_id, source.task_id, source.result_id, source.result_ref].every(nonempty)
      || !Number.isInteger(source.row_count) || Number(source.row_count) < 0 || source.truncated !== false
      || source.result_ref !== `query:${encodeURIComponent(String(source.task_id))}:${encodeURIComponent(String(source.result_id))}`)) return;
  const snapshot = candidate as unknown as DirectAnswerSnapshot;
  if (new Set(snapshot.sources.map(source => source.target_ref)).size !== snapshot.sources.length
    || snapshot.plan_ref !== details.state.task_ref || snapshot.sources.length !== details.state.targets.length
    || details.state.targets.some(target => target.status !== "succeeded" || target.pending.length || !snapshot.sources.some(source => source.target_ref === target.target_ref))) return;
  const {answer_id, ...body} = snapshot;
  return snapshotId(body) === answer_id ? structuredClone(snapshot) : undefined;
}

/** 不是意图分类器：仅对可穷尽解释的取值语法放行，其余语言保留 Pi。
 * 只消去目录给出的正式名称与已识别指标片段，绝不消去模型填的整句 rawValue。
 */
export function supportedResultOnlyQuestion(question: string, names: string[], mentions: string[], readOnly = false): boolean {
  let remaining = question;
  for (const name of [...new Set([...names, ...mentions])].filter(Boolean).sort((a, b) => b.length - a.length)) remaining = remaining.split(name).join(" ");
  if (readOnly && !/(?:读取|显示|展示|重显|再看|看看|看|列出|返回)/u.test(remaining.replaceAll("不要重新查询", " "))) return false;
  remaining = remaining
    .replace(/(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/gu, " ")
    .replace(/(?:(?:\d{4}|[二〇零一三四五六七八九十]{4})年)?(?:\d{1,2}|[一二三四五六七八九十]{1,3})月(?:(?:\d{1,2}|[一二三四五六七八九十廿三]{1,3})[日号]|[末底初])?/gu, " ")
    .replace(/(?:\d{4}年(?:年?[末底初])?|今年(?:年?[末底初])?|去年(?:年?[末底初])?|前年(?:年?[末底初])?|本月[末底初]?|上月[末底初]?|今日|今天|昨日|昨天|(?:\d{1,2})[日号])/gu, " ");
  if (!readOnly) remaining = withoutContextResetInstruction(remaining)
    .replace(/(?:机构|指标|日期|时间)(?:(?:和|与|、|及)(?:机构|指标|日期|时间))*(?:保持)?不变/gu, " ");
  // 纯回读仅允许展示/引用语法。全部日期、最新有值、取值口径及集合变化都是新义务，不能靠没有“改”字放行。
  const words = ["请问", "请", "帮我", "帮忙", "给我", "麻烦", "查看", "读取", "显示", "展示", "重显", "重新", "再看", "看看", "看", "列出", "返回", "的", "在", "截至", "截止", "到", "至", "为", "是", "有", "多少", "是多少", "呢", "吗", "数据", "结果", "数值", "值", "日期", "时间", "机构", "指标", "再", "原来", "之前", "刚才", "上次", "上一轮", "这份", "那份", "这个", "那个", "一份", "明细", "本对话", "本会话", "这次对话", "正式", "上述", "以上", "这些", "上面", "同一天"];
  if (readOnly) words.push("不要重新查询");
  else words.push("新问题", "那", "分别", "以及", "还有", "和", "与", "及", "查询", "查一下", "查下", "查", "取值", "取数", "改成", "改为", "换成", "换为", "改", "换", "继续", "追加", "增加", "加上", "补充", "去掉", "排除", "只看", "只要", "全部", "所有", "当日数", "当日", "期末", "余额", "最新", "有值", "取", "确认", "就选", "选择", "选", "其他条件不变", "其余条件不变", "其它条件不变", "其他条件保持不变", "其余条件保持不变", "其它条件保持不变");
  // 逐词前进，不用重复分组回溯；未识别的一个字符也会保留模型路径。
  const ordinalToken = readOnly ? "第[一二三四五六七八九十百\\d]+次查询" : "第[一二三四五六七八九十百\\d]+(?:次查询|[个次])";
  const token = new RegExp(`${words.sort((a, b) => b.length - a.length).join("|")}|${ordinalToken}|[一二两三四五六七八九十百\\d]+家|[\\s，,。；;、：:？?！!()（）“”"'/\\-]`, "uy");
  while (token.lastIndex < remaining.length) if (!token.exec(remaining)) return false;
  return true;
}

function leaves(value: unknown): Record<string, unknown>[] {
  if (!object(value)) return [];
  return value.kind === "semantic_results" && Array.isArray(value.results) ? value.results.flatMap(leaves) : [value];
}
function namedValues(task: SemanticTask): string[] {
  return ["metrics", "organizations", "comparison_organizations"].flatMap(name => {
    const value = task.target.fields[name]?.resolvedValue;
    return object(value) && Array.isArray(value.names) ? value.names.filter((item): item is string => nonempty(item)) : [];
  });
}
/** 别名只能来自当前后端目录的正式身份配对；不得信任模型rawValue或吞掉整句剩余文本。 */
export async function verifiedResultOnlyQuestion(request: Pick<AskMetricRequestContext, "backend">, question: string, tasks: SemanticTask[],
  goal: Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>, signal?: AbortSignal | undefined, readOnly = false): Promise<boolean> {
  const names = tasks.flatMap(namedValues), mentions = goal.fragments.flatMap(fragment => fragment.mentions.map(mention => mention.text));
  if (supportedResultOnlyQuestion(question, names, mentions, readOnly)) return true;
  const explicit = new Set(goal.fragments.flatMap(fragment => fragment.organizations));
  const checked = new Set<string>();
  for (const task of tasks) {
    const value = task.target.fields.organizations?.resolvedValue as {codes?: string[]; names?: string[]} | undefined;
    for (const [index, code] of (value?.codes ?? []).entries()) {
      const name = value?.names?.[index];
      if (!name || question.includes(name) || !explicit.has(code) || checked.has(code)) continue;
      checked.add(code);
      const catalog = await request.backend.searchOrganizations(code, 10, {signal});
      const hit = catalog.items.find(item => item.match_type === "exact" && item.org_code === code && item.org_name === name);
      if (hit?.aliases) names.push(...hit.aliases.filter(nonempty));
    }
  }
  return supportedResultOnlyQuestion(question, names, mentions, readOnly);
}

/** 辅助读取不能完成已明确的普通取值请求；说明/定义/目录检索等未知额外目的不据此强迫查询。 */
export async function ordinaryQueryNeedsResolution(request: AskMetricRequestContext,
  goal: Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>, signal?: AbortSignal | undefined): Promise<boolean> {
  const mentions = goal.fragments.flatMap(fragment => fragment.mentions.map(mention => mention.text));
  if (!mentions.length || goal.requires_calculation) return false;
  const turn = await request.semanticTasks?.turn(request.operationId), names = (turn?.context?.tasks ?? []).flatMap(namedValues);
  const confirmedQuery = () => {
    let purpose = request.originalMessage;
    for (const name of [...names, ...mentions].sort((a, b) => b.length - a.length)) if (name) purpose = purpose.split(name).join(" ");
    return /(?:查询|查|取值|取数|多少|数值)/u.test(purpose) && supportedResultOnlyQuestion(request.originalMessage, names, mentions);
  };
  if (confirmedQuery()) return true;
  if (typeof request.backend.searchOrganizations !== "function") return false;
  for (const code of new Set(goal.fragments.flatMap(fragment => fragment.organizations))) {
    const catalog = await request.backend.searchOrganizations(code, 10, {signal});
    const hit = catalog.items.find(item => item.match_type === "exact" && item.org_code === code);
    if (hit) names.push(hit.org_name, ...(hit.aliases ?? []).filter(nonempty));
  }
  return confirmedQuery();
}
function explicitReadFactsMatch(goal: Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>, tasks: SemanticTask[]): boolean {
  const sameCodes = (left: string[], right: string[]) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  const fragments = goal.fragments.filter(fragment => fragment.organizations.length || fragment.mentions.length || fragment.calendar.ranges.length);
  if (fragments.some(fragment => fragment.calendar.unresolved.length || fragment.mentions.some(mention => mention.resolution.status !== "resolved"))) return false;
  const matches = (fragment: typeof goal.fragments[number], task: SemanticTask) => {
    const spec = completeQuery(task.target); if (!spec) return false;
    const metrics = fragment.mentions.flatMap(mention => (mention.resolution.value as {codes?: string[]} | undefined)?.codes ?? []);
    return (!fragment.organizations.length || sameCodes(fragment.organizations, spec.org_codes ?? []))
      && (!fragment.mentions.length || metrics.length > 0 && sameCodes(metrics, spec.metric_codes))
      && (!fragment.calendar.ranges.length || fragment.calendar.ranges.length === 1
        && fragment.calendar.ranges[0]!.start === spec.time.start && fragment.calendar.ranges[0]!.end === spec.time.end
        && JSON.stringify(fragment.calendar.ranges[0]!.dates ?? []) === JSON.stringify(spec.time.dates ?? []));
  };
  // 明示条件须与正式来源完整对应；对子集的筛选也不能直接交付原来更大的结果。
  return fragments.every(fragment => tasks.some(task => matches(fragment, task)))
    && (!fragments.length || tasks.every(task => fragments.some(fragment => matches(fragment, task))));
}
function queryOrdinal(question: string): number | undefined {
  const values = referencedQueryNumbers(question);
  return values.length === 1 ? values[0] : undefined;
}
async function historicalQueryAt(request: AskMetricRequestContext, ordinal: number) {
  // 交付门禁与模型索引共用业务查询序号，失败查询占位，回读/分析不重编号。
  const reference = (await request.semanticTasks!.historyCatalog()).find(row => row.query_number === ordinal);
  return reference ? request.semanticTasks!.plan(reference.task_ref) : undefined;
}

function unchangedTransition(task: SemanticTask): boolean {
  const transition = task.target.transition;
  if (!transition || !completeQuery(task.target)) return false;
  const fields: TransitionField[] = ["metrics", "organizations", "comparison_organizations", "time", "selection", "operation"];
  return fields.every(field => {
    const before = field === "metrics" ? transition.before.metric_codes : field === "organizations" ? transition.before.org_codes ?? []
      : field === "comparison_organizations" ? transition.before.comparison_scope?.org_codes ?? [] : transition.before[field] ?? null;
    const changes = transition.changes.filter(change => change.field === field);
    let expected: unknown = before;
    for (const change of changes) {
      if (JSON.stringify(change.before) !== JSON.stringify(expected)) return false;
      expected = change.after;
    }
    return JSON.stringify(expected) === JSON.stringify(transitionValue(task.target, field));
  });
}
function terminal(feedback: SemanticFeedback, denied: boolean): SemanticFeedback {
  const {evidence: _evidence, ...state} = feedback.state;
  return {...feedback, status: denied ? "denied" : "failed", state,
    issues: [{code: denied ? "PERMISSION_DENIED" : "DIRECT_DELIVERY_SOURCE_UNVERIFIED", category: denied ? "permission" : "infrastructure",
      message: denied ? "当前权限已变化，结果不可读取。" : "正式结果的当前访问权限或身份尚未确认，暂不能交付，请稍后回读原任务。", remediation: "stop"}],
    continuation: {actor: "none", action: "stop"}};
}

/** 普通问数资格由宿主逐项验证；此函数不执行 SQL、不制造 assistant 消息。 */
export async function prepareDirectQueryDelivery(request: AskMetricRequestContext, feedback: SemanticFeedback,
  input: {toolName: string; toolCallId: string; messages: AgentMessage[]; signal?: AbortSignal | undefined}): Promise<DirectDeliveryDecision> {
  const reject = (reason: string): DirectDeliveryDecision => ({eligible: false, reason});
  if (feedback.continuation.action === "continue_analysis") return reject("analysis_continuation");
  if (!["succeeded", "reused"].includes(feedback.status) || feedback.state.completion !== "full" || feedback.issues.length) return reject("unfinished_task");
  const batch = [...input.messages].reverse().find(message => message.role === "assistant");
  const calls = batch?.role === "assistant" ? batch.content.filter(block => block.type === "toolCall") : [];
  if (calls.length !== 1 || calls[0]?.id !== input.toolCallId || calls[0]?.name !== input.toolName
    || !["resolve_business_turn", "execute_business_frame", "read_business_result"].includes(input.toolName)) return reject("mixed_native_batch");
  const turn = await request.semanticTasks?.turn(request.operationId);
  const plan = feedback.state.task_ref ? await request.semanticTasks?.plan(feedback.state.task_ref) : undefined;
  if (!turn || turn.originalMessage !== request.originalMessage || !plan || plan.owner !== request.actor.id
    || !["query", "reuse"].includes(plan.intent) || plan.status !== "completed" || plan.completion !== "full" || plan.issues.length
    || plan.admitted?.operationId !== plan.operationId || plan.admitted.revision !== plan.revision
    || plan.admitted.digest !== semanticPlanDigest(plan)) return reject("plan_not_current_or_admitted");
  const historyRead = plan.operationId !== request.operationId;
  const readOnlyDelivery = historyRead || plan.intent === "reuse";
  const ordinalReferences = [...request.originalMessage.matchAll(/第[一二三四五六七八九十百\d]+次(?:查询)?/gu)];
  if (readOnlyDelivery && (ordinalReferences.length > 1 || ordinalReferences.length === 1 && /(?:刚才|上次|上一轮|当前)/u.test(request.originalMessage))) return reject("multiple_read_sources_unverified");
  if (readOnlyDelivery && ordinalReferences.length === 1 && queryOrdinal(request.originalMessage) === undefined) return reject("read_query_ordinal_unparsed");
  let readBinding: NonNullable<SemanticTurn["readDelivery"]> | undefined;
  if (historyRead) {
    const args = calls[0]!.arguments as {task_ref?: unknown; target_ref?: unknown};
    if (input.toolName !== "read_business_result" || plan.steps.length !== 1 || args.task_ref !== plan.ref || args.target_ref !== plan.steps[0]?.targetRef) return reject("history_read_scope_unverified");
    const ordinal = queryOrdinal(request.originalMessage);
    let source: "query_ordinal" | "admitted_focus";
    if (ordinal !== undefined) {
      if ((await historicalQueryAt(request, ordinal))?.ref !== plan.ref) return reject("history_query_ordinal_mismatch");
      source = "query_ordinal";
    } else {
      if (!/(?:刚才|上次|上一轮|当前)/u.test(request.originalMessage) || turn.context?.plan?.ref !== plan.ref) return reject("history_read_source_ambiguous");
      source = "admitted_focus";
    }
    readBinding = {planRef: plan.ref, revision: plan.revision,
      digest: plan.admitted.digest, targetRefs: plan.steps.map(step => step.targetRef), source};
  } else if (plan.intent === "reuse") {
    const ordinal = queryOrdinal(request.originalMessage);
    const source = ordinal !== undefined ? await historicalQueryAt(request, ordinal)
      : /(?:刚才|上次|上一轮|当前)/u.test(request.originalMessage) ? turn.context?.plan : undefined;
    const issue = ordinal !== undefined ? "history_query_ordinal_mismatch" : "history_read_focus_mismatch";
    if (!source || source.owner !== request.actor.id || source.admitted?.operationId !== source.operationId
      || source.admitted.revision !== source.revision || source.admitted.digest !== semanticPlanDigest(source)
      || source.steps.length !== plan.steps.length || plan.steps.some(step => !source.steps.some(candidate => candidate.taskRef === step.taskRef
        && candidate.targetRef === step.targetRef && (step.source.kind === "reference" ? step.source.task_ref === source.ref && step.source.target_ref === candidate.targetRef
          : step.source.kind === "current" && source.ref === turn.context?.plan?.ref)))) return reject(issue);
    readBinding = {planRef: source.ref, revision: source.revision, digest: source.admitted.digest,
      targetRefs: source.steps.map(step => step.targetRef), source: ordinal !== undefined ? "query_ordinal" : "admitted_focus"};
  }
  if (!plan.steps.length || plan.steps.some(step => step.kind !== "query" || step.status !== "succeeded" || step.issues.length
    || step.dependencies.length || !step.taskRef || !step.evidence?.resultRef || step.evidence.truncated)) return reject("non_value_or_incomplete_steps");
  if (feedback.state.targets.length !== plan.steps.length || feedback.state.targets.some(target => target.status !== "succeeded" || target.pending.length
    || !plan.steps.some(step => step.targetRef === target.target_ref))) return reject("target_coverage_mismatch");
  const tasks = await Promise.all(plan.steps.map(step => request.semanticTasks!.get(step.taskRef!)));
  if (tasks.some(task => !task || task.owner !== request.actor.id || task.target.status !== "succeeded" || task.completion !== "full"
    || task.issues.length || Object.keys(task.target.pending).length || task.capability !== "metric_query"
    || ["metrics", "organizations", "time", "selection", "operation"].some(name => task.target.fields[name]?.resolutionStatus !== "resolved")
    || !object(task.target.fields.operation?.resolvedValue) || task.target.fields.operation.resolvedValue.kind !== "value"
    || !nonempty(task.target.fields.metrics?.metadata?.semanticSelectionReceipt))) return reject("unverified_value_contract");
  const presentTasks = tasks as SemanticTask[];
  if (/(?:其他|其余|其它)条件(?:保持)?不变/u.test(request.originalMessage) && presentTasks.some(task => !unchangedTransition(task))) return reject("unchanged_conditions_unverified");
  if (/(?:不要|无需|不必)重新查询/u.test(request.originalMessage) && !historyRead && plan.intent !== "reuse") return reject("read_only_delivery_required");
  const questions = [request.originalMessage, ...(turn.contextAction === "resume" && turn.context?.clarification ? [turn.context.clarification.originalMessage] : [])];
  try {
    for (const question of questions) {
      const goal = await request.backend.inspectBusinessGoal(question, turn.businessDate, {signal: input.signal}, plan.referenceYear);
      if (readOnlyDelivery && !explicitReadFactsMatch(goal, presentTasks)) return reject("read_source_conditions_mismatch");
      if (goal.requires_calculation || goal.fragments.some(fragment => fragment.calendar.unresolved.length)
        || !await verifiedResultOnlyQuestion(request, question, presentTasks, goal, input.signal, readOnlyDelivery)) return reject(readOnlyDelivery ? "read_only_obligation_unverified" : "additional_or_unknown_answer_obligation");
    }
  } catch {return reject("delivery_obligation_unverified");}
  const evidence = leaves(feedback.state.evidence);
  if (evidence.length !== plan.steps.length || evidence.some(item => !["metric_query_structured", "metric_read"].includes(String(item.kind)) || item.status !== "succeeded"
    || !nonempty(item.task_id) || !nonempty(item.result_id) || !nonempty(item.public_answer) || !Number.isInteger(item.row_count) || Number(item.row_count) < 0
    || item.truncated === true || item.result_truncated === true)) return reject("formal_evidence_incomplete");
  if (evidence.some(item => {
    if (item.kind === "metric_query_structured") return !Array.isArray(item.rows) || item.rows.length !== item.row_count;
    const pages = Array.isArray(item.payloads) ? item.payloads.filter(payload => object(payload) && Array.isArray(payload.rows)) as Record<string, unknown>[] : [];
    return !pages.length || pages.some(page => page.has_more === true || Number(page.offset ?? 0) !== 0
      || page.next_offset !== undefined && page.next_offset !== null || (page.rows as unknown[]).length !== item.row_count);
  })) return reject("formal_result_page_incomplete");
  const sources: DirectAnswerSource[] = [], answers: string[] = [], blocks: AnswerBlock[] = [];
  const frameState = await request.frames?.state();
  for (const [index, step] of plan.steps.entries()) {
    const task = presentTasks[index]!;
    const frame = await request.frames?.get(step.evidence!.frameId);
    if (!frame || frame.sessionId !== request.sessionId || frame.status !== "success" || frame.resultRef !== step.evidence!.resultRef
      || frameState?.operations[frame.operationFrameId] !== frame.frameId || frame.resultSummary?.truncated
      || ["metrics", "organizations", "time", "selection", "operation", "comparison_organizations"].some(name =>
        frame.fields[name]?.resolutionStatus !== task.target.fields[name]?.resolutionStatus
        || JSON.stringify(frame.fields[name]?.resolvedValue) !== JSON.stringify(task.target.fields[name]?.resolvedValue))) return reject("frame_result_binding_mismatch");
    const match = /^query:([^:]+):([^:]+)$/u.exec(frame.resultRef!);
    if (!match) return reject("unsupported_result_reference");
    let taskId: string, resultId: string;
    try {taskId = decodeURIComponent(match[1]!); resultId = decodeURIComponent(match[2]!);} catch {return reject("invalid_result_reference");}
    const item = evidence.find(candidate => candidate.task_id === taskId && candidate.result_id === resultId);
    if (!item) return reject("source_evidence_mismatch");
    if (frame.resultSummary?.rowCount !== item.row_count) return reject("frame_result_count_mismatch");
    try {
      // 当前 Bearer 复核每个正式来源；结果分页仅查任务持久结果，不重新运行指标 SQL。
      const page = await request.backend.getTaskResult(taskId, 0, 1, {signal: input.signal});
      if (page.task_id !== taskId || page.result_id !== resultId || page.status !== "succeeded" || page.truncated !== false || page.row_count !== item.row_count) {
        return {eligible: false, reason: "source_identity_or_completeness_changed", terminalFeedback: terminal(feedback, false)};
      }
    } catch (error) {
      const denied = error instanceof BackendApiError && [401, 403, 404].includes(error.status);
      return {eligible: false, reason: denied ? "source_permission_denied" : "source_recheck_unavailable", terminalFeedback: terminal(feedback, denied)};
    }
    sources.push({target_ref: step.targetRef, frame_id: frame.frameId, task_id: taskId, result_id: resultId,
      result_ref: frame.resultRef!, row_count: Number(item.row_count), truncated: false});
    const answer = String(item.public_answer);
    answers.push(plan.steps.length > 1 ? `${step.label ?? `目标 ${index + 1}`}\n${answer}` : answer);
    const savedBlocks = item.public_answer_blocks;
    if (savedBlocks !== undefined && (!Array.isArray(savedBlocks) || !savedBlocks.every(answerBlock))) return reject("renderer_invalid_blocks");
    if (plan.steps.length > 1) blocks.push({type: "paragraph", segments: [{text: step.label ?? `目标 ${index + 1}`, bold: true}]});
    blocks.push(...(Array.isArray(savedBlocks) && savedBlocks.length ? structuredClone(savedBlocks) as AnswerBlock[]
      : [{type: "paragraph" as const, segments: [{text: answer, bold: false}]}]));
  }
  const body: Omit<DirectAnswerSnapshot, "answer_id"> = {version: 1, renderer_version: "query_result_v1", delivery_path: "direct_query",
    operation_id: request.operationId, plan_ref: plan.ref, plan_revision: plan.revision,
    public_answer: answers.join("\n\n"), answer_blocks: blocks, sources};
  const snapshot = {answer_id: snapshotId(body), ...body};
  const delivered = {...feedback, continuation: {actor: "none", action: "deliver_saved_answer"}, direct_answer: snapshot};
  if (!readDirectAnswerSnapshot(delivered)) return reject("renderer_snapshot_invalid");
  if (readBinding) await request.semanticTasks!.bindReadDelivery(request.operationId, readBinding);
  return {eligible: true, reason: "complete_verified_result_only", snapshot};
}
