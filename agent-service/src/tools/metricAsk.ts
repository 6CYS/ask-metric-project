/**
 * metric_ask 工具：受治理问数的三种动作。
 *
 * - new：本轮原文提交新业务查询（提交→提槽→条件齐全则查询）；
 * - clarify：精确推进已有任务的澄清（同 task/version/clarification_id）；
 * - followup：引用一笔已完成查询，做单字段机构或日期替换并创建新任务。
 *
 * 幂等：命令键由（owner+session+request+业务负载）指纹派生，不用随机键；
 * 同一 operation 只接纳一个独立写意图，clarify 的受控版本刷新不改变命令键。
 */
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  BackendApiError,
  type QueryExecutionResult,
  type TaskCommandResult,
} from "../backendClient.js";
import { commandKey, phaseKey } from "../harnessHost.js";
import type { AskMetricRequestContext, WriteCommandRecord } from "../requestContext.js";
import { MAX_ROWS_FOR_MODEL } from "./shared.js";

const taskRef = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 128 }),
  version: Type.Integer({ minimum: 0 }),
});

const metricAskParameters = Type.Union([
  Type.Object({
    action: Type.Literal("new"),
  }, { description: "全新业务查询：本轮用户原文由宿主直接提交，模型无需复述" }),
  Type.Object({
    action: Type.Literal("clarify"),
    target: Type.Intersect([
      taskRef,
      Type.Object({ clarification_id: Type.String({ minLength: 1, maxLength: 128 }) }),
    ]),
  }, { description: "补充已有任务的澄清条件：用户本轮的补充文字由宿主提交到原任务" }),
  Type.Object({
    action: Type.Literal("followup"),
    source: taskRef,
    change_field: StringEnum(["orgs", "time"], {
      description: "orgs=只替换机构；time=只替换日期。其他修改不支持",
    }),
  }, { description: "引用一笔已完成查询，替换机构或日期后创建新查询" }),
]);

type Params = Static<typeof metricAskParameters>;

export interface MetricAskDetails {
  kind: "metric_ask";
  task_id?: string | undefined;
  version?: number | undefined;
  result_id?: string | undefined;
  status: string;
  columns?: string[] | undefined;
  row_count?: number | undefined;
  truncated?: boolean | undefined;
  clarification?: unknown;
}

type Receipt = AgentToolResult<MetricAskDetails>;

export function createMetricAskTool(): AgentHarnessTool<AskMetricRequestContext, typeof metricAskParameters, MetricAskDetails> {
  return {
    name: "metric_ask",
    label: "指标问数",
    description:
      "受治理的经营指标问数。action=new 提交新问题；action=clarify 把用户本轮补充提交到正在澄清的原任务（需要任务返回的 task_id/version/clarification_id）；" +
      "action=followup 引用一笔已完成查询只换机构或日期。条件不足时返回澄清提示，如实转告用户，不代填条件。",
    parameters: metricAskParameters,
    // 兼容层：部分模型会把嵌套对象序列化成 JSON 字符串，schema 校验前还原
    prepareArguments: (args: unknown) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) return args as never;
      const normalized = { ...(args as Record<string, unknown>) };
      for (const key of ["target", "source"]) {
        const raw = normalized[key];
        if (typeof raw === "string") {
          try {
            normalized[key] = JSON.parse(raw);
          } catch {
            // 解析失败留给 schema 校验报出明确错误
          }
        }
      }
      return normalized as never;
    },
    execute: async (_toolCallId, params: Params, _onUpdate, request, _invocation, context) => {
      try {
        if (params.action === "new") return await runNew(request, context.abortSignal);
        if (params.action === "clarify") return await runClarify(request, params.target, context.abortSignal);
        return await runFollowup(
          request,
          params.source,
          params.change_field as "orgs" | "time",
          context.abortSignal,
        );
      } catch (error) {
        const handled = backendErrorReceipt(error);
        if (handled) return handled;
        throw error;
      }
    },
  };
}

/* ---------------------------------- 公共 ---------------------------------- */

/** 命令键业务负载：clarify 不含版本（受控刷新不改变身份），followup 含来源版本 */
function businessPayload(request: AskMetricRequestContext, params: Params): Record<string, unknown> {
  if (params.action === "clarify") {
    return {
      action: "clarify",
      task_id: params.target.task_id,
      clarification_id: params.target.clarification_id,
      original_text: request.originalMessage,
      answers: clarifyAnswers(request),
    };
  }
  if (params.action === "followup") {
    return {
      action: "followup",
      source: { task_id: params.source.task_id, version: params.source.version },
      change_field: params.change_field,
      original_text: request.originalMessage,
      selected_answers: request.selectedAnswers,
    };
  }
  return {
    action: "new",
    original_text: request.originalMessage,
    selected_answers: request.selectedAnswers,
  };
}

function keyOf(request: AskMetricRequestContext, params: Params): string {
  return commandKey({
    owner: request.actor.id,
    session_id: request.sessionId,
    request_id: request.requestId,
    fingerprint: request.promptFingerprint,
    ...businessPayload(request, params),
  });
}

/** 澄清答案：显式选择与本轮原文合并提交；纯文本补充直接作为自由文本 */
function clarifyAnswers(request: AskMetricRequestContext): unknown {
  if (request.selectedAnswers && Object.keys(request.selectedAnswers).length > 0) {
    return { ...request.selectedAnswers, text: request.originalMessage };
  }
  return request.originalMessage;
}

function receipt(payload: Record<string, unknown>, details: MetricAskDetails): Receipt {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details,
  };
}

function errorReceipt(code: string, message: string, taskId?: string): Receipt {
  return receipt(
    { status: "error", error: { code, message }, ...(taskId ? { task_id: taskId } : {}) },
    { kind: "metric_ask", status: "error", ...(taskId ? { task_id: taskId } : {}) },
  );
}

function limitReceipt(): Receipt {
  return errorReceipt(
    "TURN_QUERY_LIMIT",
    "一轮提问只支持一个业务查询或修改；其余部分请分开发送。",
  );
}

function backendErrorReceipt(error: unknown): Receipt | undefined {
  if (!(error instanceof BackendApiError)) return undefined;
  if (error.status === 401 || error.status === 403) {
    return errorReceipt("AUTH_EXPIRED", "当前登录状态已失效，请提示用户刷新页面重新登录后再提问。");
  }
  return errorReceipt(error.code ?? "BACKEND_ERROR", `后端请求失败：${error.message}`);
}

/**
 * 写意图门禁：同一 operation 只接纳一个独立业务写命令。
 * 相同命令键=幂等重放（已完成则只读回读）；不同命令=TURN_QUERY_LIMIT。
 * clarify 版本冲突后的受控刷新不改变命令键，允许且不占用新名额。
 */
async function gateWriteCommand(
  request: AskMetricRequestContext,
  key: string,
  action: WriteCommandRecord["action"],
): Promise<{ proceed: true; record: WriteCommandRecord } | { proceed: false; receipt: Receipt }> {
  const existing = await request.commands.getWriteCommand();
  if (!existing) {
    const record: WriteCommandRecord = { commandKey: key, action, status: "pending" };
    await request.commands.setWriteCommand(record);
    return { proceed: true, record };
  }
  if (existing.commandKey !== key) return { proceed: false, receipt: limitReceipt() };
  if (existing.status === "completed" && existing.taskId) {
    return { proceed: false, receipt: await replayTaskReceipt(request, existing.taskId) };
  }
  // pending（上次中断）或 conflict（待受控刷新）：继续原命令
  return { proceed: true, record: existing };
}

/** 相同命令已完成时只读回读当前任务状态，不重复提交 */
async function replayTaskReceipt(request: AskMetricRequestContext, taskId: string): Promise<Receipt> {
  const task = await request.backend.getTask(taskId);
  return taskReceipt(task, true);
}

function taskReceipt(task: TaskCommandResult, replayed: boolean): Receipt {
  const base = {
    task_id: task.task_id,
    version: task.version,
    result_id: task.result?.result_id ?? undefined,
    idempotent_replay: replayed || undefined,
  };
  if (task.status === "WAITING_USER" || task.clarification) {
    const clarification = task.clarification ?? {};
    return receipt(
      {
        status: "clarification_required",
        ...base,
        clarification: {
          id: clarification.id,
          prompt: clarification.prompt ?? "该问题缺少必要条件，请用户补充后重试。",
          missing: clarification.missing ?? task.missing ?? [],
          fields: clarification.fields ?? [],
        },
        query_description: task.resolved_question ?? undefined,
      },
      {
        kind: "metric_ask",
        status: "clarification_required",
        task_id: task.task_id,
        version: task.version,
        clarification: task.clarification ?? null,
      },
    );
  }
  if (task.status === "FAILED" || task.error_code) {
    return errorReceipt(
      task.error_code ?? "TASK_FAILED",
      task.error_message ?? "任务处理失败。",
      task.task_id,
    );
  }
  return receipt(
    {
      status: task.status === "SUCCEEDED" ? "succeeded" : "pending",
      ...base,
      task_status: task.status,
      query_description: task.resolved_question ?? undefined,
    },
    {
      kind: "metric_ask",
      status: task.status,
      task_id: task.task_id,
      version: task.version,
      ...(task.result?.result_id ? { result_id: task.result.result_id } : {}),
    },
  );
}

function resultReceipt(taskId: string, version: number | undefined, executed: QueryExecutionResult, resultId?: string): Receipt {
  const sampleRows = executed.rows.slice(0, MAX_ROWS_FOR_MODEL);
  return receipt(
    {
      status: executed.status,
      task_id: taskId,
      // 追问引用需要来源版本：回执必须携带
      ...(version !== undefined ? { version } : {}),
      ...(resultId ? { result_id: resultId } : {}),
      query_shape: executed.query_shape,
      columns: executed.columns,
      // 仅样例行供模型核对口径；完整明细经 metric_read 分页读取
      sample_rows: sampleRows,
      row_count: executed.row_count,
      model_preview_truncated: executed.rows.length > MAX_ROWS_FOR_MODEL || executed.row_count > sampleRows.length,
      result_truncated: Boolean(executed.truncated),
      message: executed.message ?? null,
      error_message: executed.error_message ?? null,
      display_hint: "明细数据已在用户界面以结果表展示，回答正文不要逐条罗列数值，简洁概括即可。",
    },
    {
      kind: "metric_ask",
      status: executed.status,
      task_id: taskId,
      ...(version !== undefined ? { version } : {}),
      columns: executed.columns,
      row_count: executed.row_count,
      truncated: executed.truncated,
      ...(resultId ? { result_id: resultId } : {}),
    },
  );
}

/** 分析结果可执行时执行并返回事实回执；澄清/失败/等待中直接返回任务回执 */
async function analyzeAndMaybeExecute(
  request: AskMetricRequestContext,
  key: string,
  task: TaskCommandResult,
  signal: AbortSignal | undefined,
): Promise<Receipt> {
  const analyzed = await request.backend.analyzeTask(task.task_id, task.version, {
    signal,
    requestId: phaseKey(key, "analyze"),
  });
  if (analyzed.status === "WAITING_USER" || analyzed.clarification) return taskReceipt(analyzed, false);
  if (analyzed.status === "FAILED" || analyzed.error_code) return taskReceipt(analyzed, false);
  return executeTask(request, key, analyzed.task_id, analyzed.version, signal);
}

async function executeTask(
  request: AskMetricRequestContext,
  key: string,
  taskId: string,
  version: number,
  signal: AbortSignal | undefined,
): Promise<Receipt> {
  const executed = await request.backend.executeTask(taskId, version, phaseKey(key, "execute"), { signal });
  if (executed.status !== "succeeded") return resultReceipt(taskId, version, executed);
  // 成功后取一次任务状态拿到稳定 result_id 引用与当前版本（只读）
  const task = await request.backend.getTask(taskId, { signal });
  return resultReceipt(taskId, task.version, executed, task.result?.result_id ?? undefined);
}

/* ---------------------------------- new ---------------------------------- */

async function runNew(request: AskMetricRequestContext, signal: AbortSignal | undefined): Promise<Receipt> {
  const key = keyOf(request, { action: "new" });
  const gate = await gateWriteCommand(request, key, "new");
  if (!gate.proceed) return gate.receipt;

  let conversationId = await request.commands.getConversationId();
  let submitted: TaskCommandResult;
  try {
    submitted = await request.backend.submitQuestion(request.originalMessage, conversationId, key, undefined, {
      signal,
      requestId: key,
    });
  } catch (error) {
    if (error instanceof BackendApiError) throw error;
    // 提交超时/丢响应：同键找回或同键重试，不换键新建
    const recovered = conversationId
      ? await tryLookup(request, conversationId, key, signal)
      : undefined;
    if (recovered) {
      submitted = recovered;
    } else if (!conversationId) {
      // 尚无会话映射时同键重试一次：服务端按幂等键去重
      submitted = await request.backend.submitQuestion(request.originalMessage, null, key, undefined, {
        signal,
        requestId: key,
      });
    } else {
      // 提交结果未知：不假报失败也不重跑，交回模型说明
      return receipt(
        { status: "pending", message: "提交结果未知，请稍后查询任务状态，不要重复提交。" },
        { kind: "metric_ask", status: "pending" },
      );
    }
  }
  if (!conversationId) {
    conversationId = submitted.conversation_id;
    await request.commands.setConversationId(submitted.conversation_id);
  }
  await request.commands.setWriteCommand({ ...gate.record, status: "pending", taskId: submitted.task_id });
  const result = await analyzeAndMaybeExecute(request, key, submitted, signal);
  await request.commands.setWriteCommand({
    ...gate.record,
    status: "completed",
    taskId: submitted.task_id,
    ...(result.details?.result_id ? { resultId: result.details.result_id } : {}),
  });
  return result;
}

/* -------------------------------- clarify --------------------------------- */

async function runClarify(
  request: AskMetricRequestContext,
  target: { task_id: string; version: number; clarification_id: string },
  signal: AbortSignal | undefined,
): Promise<Receipt> {
  if (request.sendAs === "new_question") {
    return errorReceipt(
      "CLARIFICATION_FORBIDDEN",
      "用户已明确作为新问题发送，不能消费旧澄清；请改用 action=new。",
    );
  }
  const card = request.clarificationTarget;
  if (card && (card.task_id !== target.task_id || card.clarification_id !== target.clarification_id)) {
    return errorReceipt(
      "CLARIFICATION_TARGET_MISMATCH",
      "澄清目标与用户选择的卡片不一致，请向用户确认要补充哪一条。",
      target.task_id,
    );
  }
  const key = keyOf(request, { action: "clarify", target });
  const gate = await gateWriteCommand(request, key, "clarify");
  if (!gate.proceed) return gate.receipt;
  // 本地跟踪最新登记状态，避免后续写回覆盖刷新标记
  let record = gate.record;
  const save = async (next: WriteCommandRecord) => {
    record = next;
    await request.commands.setWriteCommand(next);
  };

  const answers = clarifyAnswers(request);
  const submit = (version: number) =>
    request.backend.submitClarification(
      target.task_id,
      { expected_version: version, clarification_id: target.clarification_id, answers },
      phaseKey(key, "clarify"),
      { signal },
    );

  let clarified: TaskCommandResult;
  try {
    clarified = await submit(target.version);
  } catch (error) {
    if (!(error instanceof BackendApiError) || error.code !== "TASK_VERSION_CONFLICT") throw error;
    // 受控版本刷新：同一澄清最多一次；条件校验后仍未变才允许
    if (gate.record.refreshed) {
      return errorReceipt(
        "STALE_CLARIFICATION",
        "该澄清已被其他操作更新，请向用户确认当前要补充的内容后再试。",
        target.task_id,
      );
    }
    const current = await request.backend.getTask(target.task_id, { signal });
    const activeId = (current.clarification as { id?: string } | null | undefined)?.id;
    if (
      current.status !== "WAITING_USER"
      || activeId !== target.clarification_id
    ) {
      return errorReceipt(
        "CLARIFICATION_MISMATCH",
        "澄清问题已变化或任务不再等待补充，请向用户确认。",
        target.task_id,
      );
    }
    await save({ ...record, refreshed: true });
    try {
      clarified = await submit(current.version);
    } catch (second) {
      if (second instanceof BackendApiError && second.code === "TASK_VERSION_CONFLICT") {
        return errorReceipt(
          "STALE_CLARIFICATION",
          "该澄清正被并行修改，请向用户确认当前内容后再试。",
          target.task_id,
        );
      }
      throw second;
    }
  }
  await save({ ...record, status: "completed", taskId: target.task_id });
  // 条件已补齐（RUNNING）时继续执行；仍缺条件则返回新的澄清
  if (clarified.status === "RUNNING" && !clarified.clarification) {
    return executeTask(request, key, clarified.task_id, clarified.version, signal);
  }
  return taskReceipt(clarified, false);
}

/* -------------------------------- followup -------------------------------- */

async function runFollowup(
  request: AskMetricRequestContext,
  source: { task_id: string; version: number },
  changeField: "orgs" | "time",
  signal: AbortSignal | undefined,
): Promise<Receipt> {
  if (request.sendAs === "new_question") {
    return errorReceipt(
      "FOLLOWUP_FORBIDDEN",
      "用户已明确作为新问题发送，不能引用旧查询；请改用 action=new。",
    );
  }
  const params: Params = { action: "followup", source, change_field: changeField };
  const key = keyOf(request, params);
  const gate = await gateWriteCommand(request, key, "followup");
  if (!gate.proceed) return gate.receipt;

  const conversationId = await request.commands.getConversationId();
  const submitted = await request.backend.submitQuestion(
    request.originalMessage,
    conversationId,
    key,
    { task_id: source.task_id, version: source.version, change_field: changeField },
    { signal, requestId: key },
  );
  await request.commands.setWriteCommand({ ...gate.record, status: "pending", taskId: submitted.task_id });
  const result = await analyzeAndMaybeExecute(request, key, submitted, signal);
  await request.commands.setWriteCommand({
    ...gate.record,
    status: "completed",
    taskId: submitted.task_id,
    ...(result.details?.result_id ? { resultId: result.details.result_id } : {}),
  });
  return result;
}

/* --------------------------------- 工具函数 --------------------------------- */

async function tryLookup(
  request: AskMetricRequestContext,
  conversationId: string,
  key: string,
  signal: AbortSignal | undefined,
): Promise<TaskCommandResult | undefined> {
  try {
    return await request.backend.lookupTask(conversationId, key, { signal });
  } catch (error) {
    if (error instanceof BackendApiError && error.status === 404) return undefined;
    throw error;
  }
}
