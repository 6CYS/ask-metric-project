import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { createCapabilities } from "../business-context/capabilities.js";
import { createFieldResolvers } from "../business-context/resolvers.js";
import { BusinessContextService, businessKey } from "../business-context/service.js";
import type { BusinessFrame, ExecutionSettlement } from "../business-context/types.js";
import { createBusinessTools } from "../business-context/adapters.js";
import { createMetricReadTool } from "./readTools.js";
import { BusinessInputError } from "../business-context/inputError.js";
import { frameClarificationOptions, modelFields, modelRecovery } from "../business-context/modelView.js";
import { renderClarificationOptions } from "../business-context/clarificationOptions.js";
import { getResolutionFailureDisposition } from "../business-context/resolutionFailure.js";
import {withOrgResolutionNotices} from "../business-context/resolutionNotice.js";

/** 前端据此展示可点选的规范清单；与正文追加的清单同源同编号。 */
function clarificationDetails(frame: BusinessFrame) {
  const groups = frameClarificationOptions(frame);
  if (!groups.length) return {};
  const unclear = Object.values(frame.fields).some(field => field.metadata?.confirmationUnclear === true);
  return {options: groups.map(group => ({title: group.title,
    options: group.options.map(option => ({no: option.no, id: option.id, label: option.label}))})),
    // 与正文末尾追加的清单逐字一致，前端可据此改为可点选的展示。
    listing: renderClarificationOptions(groups, unclear), ...(unclear ? {confirmation_unclear: true} : {})};
}

export function contextService(request: AskMetricRequestContext): BusinessContextService {
  if (!request.frames) throw new Error("BUSINESS_CONTEXT_NOT_BOUND");
  return new BusinessContextService(request.frames, createCapabilities(), createFieldResolvers());
}
const identity = (request: AskMetricRequestContext) => ({sessionId: request.sessionId, requestId: request.requestId, turnId: request.operationId});
function json(payload: unknown, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return {content: [{type: "text", text: JSON.stringify(payload)}], details};
}
function errorReceipt(error: unknown, originalMessage?: string, preservedFrame?: BusinessFrame) {
  if (error instanceof BusinessInputError && error.recovery?.action === "ask_user") {
    // 原字段没有可确认对象时，参数重试不能补足用户证据。回到原 Frame 澄清，不创建新操作或改焦点。
    return json({status: "NEEDS_CLARIFICATION", error_code: error.code,
      ...(preservedFrame ? {frameId: preservedFrame.frameId, fields: modelFields(preservedFrame.fields), issues: preservedFrame.issues} : {}),
      field: error.field, message: error.recovery.message, next_action: "ask_user", retryable: false, focus_preserved: true},
      {kind: "business_context", status: "NEEDS_CLARIFICATION", error_code: error.code, retryable: false, focus_preserved: true,
        message: error.recovery.message, ...(preservedFrame ? {frame_id: preservedFrame.frameId,
          issues: preservedFrame.issues, ...clarificationDetails(preservedFrame)} : {})});
  }
  if (error instanceof BusinessInputError) return json({status: "ARGUMENT_ERROR", error_code: error.code,
    field: error.field, message: error.correction, current_user_input: originalMessage, focus_preserved: true,
    next_action: "correct_arguments", scope: "argument_validation", query_executed: false, preserve_user_conditions: true,
    ...(error.corrections?.length ? {corrections: error.corrections} : {}),
    ...(preservedFrame ? modelRecovery(preservedFrame) : {}),
    ...(error.baseReference ? {retry_reference: error.baseReference,
      reference_hint: preservedFrame?.recovery
        ? "沿用 retry_reference，按 pending_changes 完成剩余项；inherit_allowed=true 才能用 inherit，may_retain=true 可显式 retain。已确认字段省略继承。"
        : "修正字段参数时保留此 baseReference；未改变的历史字段省略或 retain，不得改用当前焦点。"}
      : {reference_hint: "原焦点未改变不代表它就是用户所指来源。若字段来自历史引用，先用 FrameSelector 定位对应业务状态，再合并本轮变化；不要仅删除报错字段而默认继承焦点。"})},
    {kind: "business_context", status: "ARGUMENT_ERROR", retryable: true, error_code: error.code});
  const code = error instanceof BackendApiError ? error.code ?? `BACKEND_${error.status}` : error instanceof Error ? error.message : "BUSINESS_CONTEXT_ERROR";
  const safe = /^[A-Z0-9_]+$/.test(code) ? code : "BUSINESS_CONTEXT_ERROR";
  const disposition = getResolutionFailureDisposition(safe);
  // 权限范围为空或能力不支持是确定终态，不能提示模型重复原调用、改能力或扩大范围。
  if (disposition) return json({status: "error", error_code: safe, ...disposition},
    {kind: "business_context", status: "error", error_code: safe, ...disposition});
  return json({status: "error", error_code: safe, message: "业务上下文未能完成，请核对状态或稍后重试；不能绕过校验查询。"},
    {kind: "business_context", status: "error", retryable: true, error_code: safe});
}
/**
 * 执行已登记但结果未确认：Frame 保持 executing，下一轮按幂等键回查收敛。
 * 回执带原 READY frameId，同轮可直接再次执行（复用同一幂等键，不重复取数）。
 */
function unsettledExecutionReceipt(error: unknown, readyFrameId: string) {
  const status = error instanceof BackendApiError ? error.status : undefined;
  const code = error instanceof BackendApiError ? error.code ?? `BACKEND_${error.status}` : error instanceof Error ? error.message : "EXECUTION_UNCONFIRMED";
  const safe = /^[A-Z0-9_]+$/.test(code) ? code : "EXECUTION_UNCONFIRMED";
  const retryable = status !== 401 && status !== 403;
  const message = status === 401 ? "登录状态已失效，请刷新页面重新登录；本次查询是否已完成会在下一轮自动核对，无需重述条件。"
    : status === 403 ? "当前账号无权完成本次查询，请确认机构权限；不要改用其他方式绕过。"
    : safe === "QUERY_ALREADY_RUNNING" ? "查询仍在后端执行中。可稍后再次调用 execute_business_frame 获取结果，不会重复取数。"
    : "查询结果暂未确认。可再次调用 execute_business_frame 重试（同一条件不会重复取数）；仍未确认时下一轮会自动核对真实结果。";
  return json({status: "error", error_code: safe, frame_id: readyFrameId, message},
    {kind: "business_context", status: "error", retryable, error_code: safe, frame_id: readyFrameId});
}
/** 执行登记后在该时长内视为可能仍在途：崩溃恢复时请求可能晚于回查到达后端，不据 404 判定未提交。 */
const EXECUTION_GRACE_MS = 60_000;

/**
 * 上一轮遗留执行的只读对账：非取数能力看是否已保存结果快照；取数按发送前登记的幂等键回查后端。
 * 只读不重发——原请求若从未到达，重发会在用户未再提问时补跑查询。
 */
export async function reconcileExecution(request: AskMetricRequestContext, frame: BusinessFrame,
  signal: AbortSignal | undefined): Promise<ExecutionSettlement | undefined> {
  if (Date.now() - Date.parse(frame.createdAt) < EXECUTION_GRACE_MS) return undefined;
  const snapshotRef = `snapshot:${businessKey({frameId: frame.frameId})}`;
  if (await request.businessResults?.get(snapshotRef)) return {status: "success", resultRef: snapshotRef};
  const link = await request.businessResults?.executionLink(frame.frameId);
  // 未登记即说明请求没有发出（或来自升级前的记录），后端不可能有这次执行。
  if (!link) return {status: "failed", errorCode: "EXECUTION_INTERRUPTED"};
  try {
    const found = await request.backend.getBasicQueryStatus(link.idempotencyKey, link.conversationId, {signal});
    if (found.status === "running") return undefined;
    if (found.status === "succeeded") return found.result_id
      ? {status: "success", resultRef: `query:${encodeURIComponent(found.task_id)}:${encodeURIComponent(found.result_id)}`}
      : {status: "failed", errorCode: "RESULT_REFERENCE_MISSING"};
    return {status: "failed", errorCode: found.error_code ?? "QUERY_FAILED"};
  } catch (error) {
    // 只认明确的“未收到”；未升级的后端对回查路由也返回 404，不能据此把可能成功的查询记成失败。
    if (error instanceof BackendApiError && error.code === "BASIC_QUERY_NOT_FOUND") return {status: "failed", errorCode: "NOT_SUBMITTED"};
    if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
    // 回查暂不可用：保持 executing，下一轮再核对，不能把未知状态记成成功或失败。
    return undefined;
  }
}

const executeParameters = Type.Object({frameId: Type.String({minLength: 1})}, {additionalProperties: false});
export function createExecuteBusinessFrameTool(): AgentHarnessTool<AskMetricRequestContext, typeof executeParameters> {
  return {name: "execute_business_frame", label: "执行已验证查询", parameters: executeParameters,
    description: "用途：按本轮 READY Frame 执行已验证的业务目标。仅提交回执中的 frameId，不重填编码、日期、SQL 或自然语言条件。返回正式执行结果或失败；同一执行重复调用复用原请求，解析完整不等于执行成功。",
    execute: async (id, params, update, request, invocation, context) => {
      const service = contextService(request);
      let executing: BusinessFrame | undefined;
      try {
        executing = await service.beginExecution(params.frameId, identity(request));
        const done = await service.completed(executing);
        if (done?.status === "success" && done.resultRef) return await readResult(done, id, update, request, invocation, context);
        if (done) return json({status: "failed", frameId: done.frameId, error_code: done.errorCode},
          {kind: "business_context", status: "failed", public_answer: "这次查询未成功，请在确认条件后重新发起。", delivery: "business_evidence_v1"});
        const schema = service.capabilities.get(executing.capability);
        const pendingSnapshotRef = `snapshot:${businessKey({frameId: executing.frameId})}`;
        const pendingSnapshot = schema.tool !== "metric_query_structured" ? await request.businessResults?.get(pendingSnapshotRef) : undefined;
        if (pendingSnapshot) {
          const completed = await service.finishExecution(executing, {status: "success", resultRef: pendingSnapshotRef});
          return await readResult(completed, id, update, request, invocation, context);
        }
        const bound = {...request, businessExecutionFrame: executing.frameId};
        const result = await createBusinessTools().execute(schema.tool, executing, [id, {}, update, bound, invocation, context]);
        const details = result.details as Record<string, unknown>;
        const succeeded = details?.status === "succeeded";
        let resultRef: string | undefined;
        if (succeeded) {
          if (schema.tool === "metric_query_structured") {
            if (typeof details.task_id !== "string" || typeof details.result_id !== "string") throw new Error("RESULT_REFERENCE_MISSING");
            resultRef = `query:${encodeURIComponent(details.task_id)}:${encodeURIComponent(details.result_id)}`;
          } else {
            resultRef = `snapshot:${businessKey({frameId: executing.frameId})}`;
            if (!request.businessResults) throw new Error("RESULT_STORE_NOT_BOUND");
            await request.businessResults.save(resultRef, result);
          }
        }
        const completed = await service.finishExecution(executing, {status: succeeded ? "success" : "failed",
          ...(resultRef ? {resultRef} : {}), resultSummary: {rowCount: Number(details.row_count ?? 0), truncated: Boolean(details.truncated)},
          ...(!succeeded ? {errorCode: typeof details.error_code === "string" ? details.error_code : "QUERY_FAILED"} : {})});
        return {...result, content: result.content.map(block => {
          if (block.type !== "text") return block;
          let receipt: unknown;
          try { receipt = JSON.parse(block.text); } catch { receipt = {message: block.text}; }
          return {...block, text: JSON.stringify({...receipt as object, frame_id: completed.frameId, result_ref: completed.resultRef})};
        }),
          details: {...details, frame_id: completed.frameId, ...(typeof details.public_answer === "string" ? {delivery: "business_evidence_v1"} : {})}};
      } catch (error) {
        // 传输异常可能发生在后端已提交之后。保留 executing，重试使用同一幂等键，不伪造失败。
        return executing ? unsettledExecutionReceipt(error, params.frameId) : errorReceipt(error);
      }
    }};
}
async function readResult(frame: BusinessFrame, id: string, update: Parameters<AgentHarnessTool<AskMetricRequestContext>["execute"]>[2],
  request: AskMetricRequestContext, invocation: Parameters<AgentHarnessTool<AskMetricRequestContext>["execute"]>[4],
  context: Parameters<AgentHarnessTool<AskMetricRequestContext>["execute"]>[5], page: {offset?: number; limit?: number} = {}): Promise<AgentToolResult<unknown>> {
  if (!frame.resultRef || frame.status !== "success") throw new Error("RESULT_NOT_READY");
  if (frame.resultRef.startsWith("query:")) {
    const [, taskId, resultId] = frame.resultRef.split(":");
    if (!taskId || !resultId) throw new Error("RESULT_REFERENCE_INVALID");
    // 后端在每次读取时重新校验当前用户、归属及机构权限。禁止二次解释原文。
    // 重显路径重新生成 public_answer，非字面命中的机构明示随 Frame 元数据一并恢复。
    return withOrgResolutionNotices(frame, await createMetricReadTool().execute(id, {kind: "result", task_id: decodeURIComponent(taskId), result_id: decodeURIComponent(resultId), ...page, setFocus: false}, update,
      {...request, originalMessage: ""}, invocation, context));
  }
  if (!request.businessResults) throw new Error("RESULT_STORE_NOT_BOUND");
  // 覆盖结果复用不重新查询数据，只核对当前目录及授权范围；不允许返回被撤权的缓存。
  for (const field of Object.values(frame.fields)) {
    if (!["metric", "organization"].includes(field.resolver ?? "") || field.resolutionStatus !== "resolved") continue;
    const value = field.resolvedValue as {codes: string[]; names: string[]};
    const checked = await request.backend.resolveBusinessField(field.resolver!, value.codes, {signal: context.abortSignal});
    if (checked.status !== "resolved" || JSON.stringify((checked.value as {codes: string[]}).codes) !== JSON.stringify(value.codes)) throw new Error("RESULT_PERMISSION_CHANGED");
  }
  const result = await request.businessResults.get(frame.resultRef);
  if (!result) throw new Error("RESULT_SNAPSHOT_MISSING");
  const details = result.details as Record<string, unknown>;
  if (frame.capability === "metric_calculate") {
    const inputs = details.inputs as Record<string, {task_id?: string}> | undefined;
    if (!inputs || !Object.keys(inputs).length) throw new Error("RESULT_REFERENCE_INVALID");
    const taskIds = [...new Set(Object.values(inputs).filter(input => (input as {kind?: string}).kind !== "user_constant").map(input => input.task_id))];
    if (!taskIds.length) throw new Error("RESULT_REFERENCE_INVALID");
    if (taskIds.some(id => !id)) throw new Error("RESULT_REFERENCE_INVALID");
    for (const taskId of taskIds) await request.backend.getTaskResult(taskId!, 0, 1, {signal: context.abortSignal});
  }
  return {...result, details: {...details, delivery: "business_evidence_v1"}};
}
const resultParameters = Type.Object({...executeParameters.properties,
  offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 100})),
  setFocus: Type.Optional(Type.Boolean({description: "成功重显后默认切换焦点；只检查结果或辅助读取时设 false。"})),
}, {additionalProperties: false});
export function createReadBusinessResultTool(): AgentHarnessTool<AskMetricRequestContext, typeof resultParameters> {
  return {name: "read_business_result", label: "复用历史结果", parameters: resultParameters,
    description: "用途：重显或分页读取本会话业务操作的成功结果，复查当前权限，不重新取数。frameId 来自该操作的正式 READY 或 SUCCESS 回执。改变条件或刷新数据须解析新的 execute Frame；读取旧结果不能冒充重新查询。",
    execute: async (id, params, update, request, invocation, context) => {
      try {
        const service = contextService(request);
        const state = await service.store.state();
        const frame = await service.resultFrame(params.frameId);
        if (!frame) throw new Error("FRAME_NOT_FOUND");
        const result = await readResult(frame, id, update, request, invocation, context, params);
        if ((result.details as {status?: string})?.status !== "succeeded") return result;
        if (params.setFocus !== false && state.focusFrameId !== frame.frameId) await service.store.setFocus(frame.frameId, state.version);
        return result;
      } catch (error) { return errorReceipt(error); }
    }};
}
