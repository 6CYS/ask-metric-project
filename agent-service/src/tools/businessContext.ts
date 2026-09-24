import { isCalendarDate } from "./shared.js";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { createCapabilities } from "../business-context/capabilities.js";
import { createFieldResolvers, businessDate } from "../business-context/resolvers.js";
import { BusinessContextService, businessKey } from "../business-context/service.js";
import type { BusinessFrame, ContextDelta, FieldResolution, OrganizationScopeInput, ResolvedOrganizations } from "../business-context/types.js";
import { createBusinessTools } from "../business-context/adapters.js";
import { createMetricReadTool } from "./readTools.js";
import { BusinessInputError } from "../business-context/inputError.js";
import { modelFields } from "../business-context/modelView.js";
import { metricMentions } from "../business-context/metricMentions.js";

const selector = Type.Object({
  frameId: Type.Optional(Type.String({minLength: 1})), ordinal: Type.Optional(Type.Integer({minimum: 1})),
  relativePosition: Type.Optional(Type.Integer({maximum: 0})), capability: Type.Optional(Type.String()),
  businessConstraints: Type.Optional(Type.Record(Type.String(), Type.Unknown())), resultRequired: Type.Optional(Type.Boolean()),
}, {additionalProperties: false});
const parameters = Type.Object({
  capabilityHint: Type.String({enum: createCapabilities().list().map(schema => schema.capability), description: "必填：选择本次业务能力；继续当前业务时使用焦点 Frame 的 capability"}),
  baseReference: Type.Optional(Type.Union([selector, Type.Null()], {description: "null 只用于明确开始独立问题。用户补充待澄清字段或继续追问时省略本参数（沿用焦点），不要传 null 清除已确定条件。明确历史引用用选择条件，多个匹配必须澄清"})),
  fieldChanges: Type.Array(Type.Object({fieldHint: Type.String(), operation: StringEnum(["set", "clear", "retain", "remove"]),
    rawValue: Type.Optional(Type.Unknown({description: "新指标传 {fromQuestion:true, mentionIndexes?:number[]}，服务端算法匹配完整原文，不自行提取指标名；机构为本轮原文名称或Schema声明的集合原文对象，operation独立表达取值/排名，日期为本轮原始日期表达；禁止生成编码或换算日期；控制字段用 Schema 枚举；确认上轮候选传 {candidateIndex}；remove=用户明确放弃某项指标，rawValue 传 {mentionIndexes:[...]}（引用上一论 Frame 的 mention 序号，从1开始）；未变化字段省略或 retain"})),
  }, {additionalProperties: false}), {maxItems: 32, description: "只提交本轮改变/补充的字段。未变字段省略或 retain；确认继续已有查询且无变化时传 []，不要重填历史名称和日期。"}),
  executionMode: StringEnum(["execute", "resolve_more", "reuse_result"], {description: "请求取得结果用 execute，校验通过立即执行；仅明确暂不执行、只补条件用 resolve_more；重显已有结果用 reuse_result 且 fieldChanges=[]。"}),
}, {additionalProperties: false});

export function contextService(request: AskMetricRequestContext): BusinessContextService {
  if (!request.frames) throw new Error("BUSINESS_CONTEXT_NOT_BOUND");
  return new BusinessContextService(request.frames, createCapabilities(), createFieldResolvers());
}
const identity = (request: AskMetricRequestContext) => ({sessionId: request.sessionId, requestId: request.requestId, turnId: request.operationId});
function json(payload: unknown, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return {content: [{type: "text", text: JSON.stringify(payload)}], details};
}
function errorReceipt(error: unknown, originalMessage?: string) {
  if (error instanceof BusinessInputError) return json({status: "ARGUMENT_ERROR", error_code: error.code,
    field: error.field, message: error.correction, current_user_input: originalMessage, focus_preserved: true},
    {kind: "business_context", status: "ARGUMENT_ERROR", retryable: true, error_code: error.code});
  const code = error instanceof BackendApiError ? error.code ?? `BACKEND_${error.status}` : error instanceof Error ? error.message : "BUSINESS_CONTEXT_ERROR";
  const safe = /^[A-Z0-9_]+$/.test(code) ? code : "BUSINESS_CONTEXT_ERROR";
  return json({status: "error", error_code: safe, message: "业务上下文未能完成，请核对状态或稍后重试；不能绕过校验查询。"},
    {kind: "business_context", status: "error", retryable: true, error_code: safe});
}
function resolverContext(request: AskMetricRequestContext, signal: AbortSignal | undefined) {
  return {originalMessage: request.originalMessage, currentDate: businessDate(), turnId: request.operationId,
    // 正式 BackendClient 总是提供完整原文解析；独立 Resolver 测试可注入自己的事实源。
    ...(typeof request.backend.matchMetricQuestion === "function" ? {resolveMetricMentions: () => metricMentions(request)} : {}),
    async resolveFactBindings(bindings: Record<string, {fact_id: string}>): Promise<FieldResolution> {
      const frames = await request.frames?.list() ?? [];
      const allowedTasks = new Set(frames.filter(frame => frame.turnId === request.operationId && frame.status === "success"
        && frame.resultRef?.startsWith("query:")).map(frame => decodeURIComponent(frame.resultRef!.split(":")[1]!)));
      for (const binding of Object.values(bindings)) {
        const match = binding.fact_id.match(/^fact:([^:]+):(\d+):([^:]+)$/);
        if (!match || !allowedTasks.has(match[1]!)) return {status: "invalid"};
        try {
          const page = await request.backend.getTaskResult(match[1]!, Number(match[2]), 1, {signal});
          if (page.calculation_scope_id !== request.operationId || page.truncated
            || !page.facts?.some(fact => fact.fact_id === binding.fact_id)) return {status: "invalid"};
        } catch (error) {
          if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
          return {status: "temporary_error"};
        }
      }
      return {status: "resolved", value: bindings};
    },
    async resolveOrganizationScope(scope: OrganizationScopeInput): Promise<FieldResolution> {
      // 配置/权限失败由后端错误码保留，不能转为“机构缺项”询问用户。
      let response: FieldResolution;
      try {
        response = await request.backend.resolveOrganizationScope(scope, {signal});
      } catch (error) {
        if (error instanceof BackendApiError && error.code === "SCOPE_SOURCE_INVALID") {
          throw new BusinessInputError("SCOPE_SOURCE_INVALID", "organizations",
            "集合 sourceText 必须是本轮明确的集合表达（如各家农商行、全省各行、账号权限内农商行）。具体机构名称应作为普通 organizations 名称提交；未知机构不能回退为集合，不能裁掉限定词扩大范围。原焦点未改变。");
        }
        throw error;
      }
      if (!response || !["resolved", "ambiguous", "not_found", "needs_confirmation"].includes(response.status)) throw new Error("INVALID_RESOLVER_RESPONSE");
      if (response.status === "resolved") {
        const value = response.value as ResolvedOrganizations | undefined;
        if (!value || !Array.isArray(value.codes) || !value.codes.length || !value.codes.every(code => typeof code === "string" && code)
          || !Array.isArray(value.names) || value.names.length !== value.codes.length || !value.names.every(name => typeof name === "string" && name)
          || typeof value.scope_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.scope_fingerprint) || !value.scope || value.scope.kind !== scope.kind
          || (value.scope.kind === "authorized_cohort" ? value.scope.cohort !== "rural_commercial_banks" : typeof value.scope.parent_code !== "string" || !value.scope.parent_code)) throw new Error("INVALID_RESOLVER_RESPONSE");
      }
      return response;
    },
    async resolveCatalog(entity: string, raw: string[], referenceYear?: number): Promise<FieldResolution> {
      try {
        const response = await request.backend.resolveBusinessField(entity, raw, {signal}, referenceYear);
        if (!response || !["resolved", "missing", "ambiguous", "not_found", "needs_confirmation", "invalid", "temporary_error"].includes(response.status)) throw new Error("INVALID_RESOLVER_RESPONSE");
        if (response.status === "resolved" && entity === "date") {
          const value = response.value as {start?: unknown; end?: unknown; dates?: unknown} | undefined;
          if (!value || typeof value.start !== "string" || typeof value.end !== "string"
            || !isCalendarDate(value.start) || !isCalendarDate(value.end) || value.start > value.end) throw new Error("INVALID_RESOLVER_RESPONSE");
          // 离散多点：dates 必须是升序去重的日历日期数组，且首尾等于 start/end。
          if (value.dates !== undefined) {
            const dates = value.dates;
            if (!Array.isArray(dates) || dates.length < 2 || !dates.every(item => typeof item === "string" && isCalendarDate(item))
              || dates.some((item, index) => index > 0 && (item as string) <= (dates[index - 1] as string))
              || dates[0] !== value.start || dates[dates.length - 1] !== value.end) throw new Error("INVALID_RESOLVER_RESPONSE");
          }
        }
        if (response.status === "resolved" && entity !== "date") {
          const value = response.value as {codes?: unknown; names?: unknown} | undefined;
          if (!value || !Array.isArray(value.codes) || !value.codes.length || !value.codes.every(code => typeof code === "string" && code)
            || !Array.isArray(value.names) || value.names.length !== value.codes.length) throw new Error("INVALID_RESOLVER_RESPONSE");
        }
        return response;
      } catch (error) {
        if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {status: "temporary_error"};
      }
    }};
}
export function createResolveBusinessTurnTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "resolve_business_turn", label: "解析业务上下文", parameters,
    description: "解析本轮目标与变化，未变化条件直接继承。READY + execute 必须立即接 execute_business_frame，不追加确认；READY + resolve_more 仅保存；REUSE_RESULT 接 read_business_result；ARGUMENT_ERROR 当轮纠正调用、不让用户重填；NEEDS_CLARIFICATION 只询问 issues。",
    execute: async (_id, params, _update, request, _invocation, context) => {
      try {
        const frame = await contextService(request).resolve(params as ContextDelta, identity(request), resolverContext(request, context.abortSignal));
        const status = frame.status === "draft" && frame.errorCode === "TEMPORARY_ERROR" ? "TEMPORARY_ERROR" : frame.status === "success" ? "REUSE_RESULT" : frame.status === "ready" ? "READY" : "NEEDS_CLARIFICATION";
        return json({status, frameId: frame.frameId, capability: frame.capability, fields: modelFields(frame.fields), issues: frame.issues,
          resultRef: frame.resultRef, executionMode: frame.delta.executionMode,
          ...(status === "TEMPORARY_ERROR" ? {error_code: "TEMPORARY_ERROR", retry_reference: {frameId: frame.frameId},
            message: "目录服务暂时不可用，原始条件已保存但不可执行。需要重试时用该 baseReference 解析，不要求用户重述业务条件。"} : {}),
          ...(status === "NEEDS_CLARIFICATION" ? {next_action: "ask_user", message: "请针对 issues 询问用户并结束本轮，不重复解析或通过其他能力绕过。"} : {}),
          ...(status === "READY" && frame.delta.executionMode === "execute" ? {
            next_action: "execute_business_frame", arguments: {frameId: frame.frameId},
            message: "条件已全部确定（包括继承条件），立即执行此 frameId，不再向用户重复确认。",
          } : {})},
          {kind: "business_context", status, frame_id: frame.frameId, execution_mode: frame.delta.executionMode, issues: frame.issues});
      } catch (error) { return errorReceipt(error, request.originalMessage); }
    }};
}
const readContextParameters = Type.Object({
  frameId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 30})),
}, {additionalProperties: false});
export function createBusinessContextReadTool(): AgentHarnessTool<AskMetricRequestContext, typeof readContextParameters> {
  return {name: "business_context_read", label: "读取业务状态", parameters: readContextParameters,
    description: "读取本会话 Frame、焦点、操作序号与能力 Schema；历史支持分页。无业务数据查询，不读取完整历史结果。序号按用户业务操作计算。",
    execute: async (_id, params, _update, request) => {
      const service = contextService(request);
      if (params.frameId) {
        const frame = await service.store.get(params.frameId);
        return json({frame: frame ? {...frame, fields: modelFields(frame.fields)} : null});
      }
      const state = await service.store.state();
      const operationIds = state.frameOrder.filter(id => state.operations[id]);
      const offset = params.offset ?? Math.max(0, operationIds.length - 10);
      const ids = operationIds.slice(offset, offset + (params.limit ?? 10));
      const frames = await Promise.all(ids.map(async (id, index) => {
        const frame = await service.store.get(state.operations[id]!);
        return {ordinal: offset + index + 1, frame: frame ? {...frame, fields: modelFields(frame.fields)} : undefined};
      }));
      return json({version: state.version, focusFrameId: state.focusFrameId, frames,
        next_offset: offset + ids.length < operationIds.length ? offset + ids.length : null,
        schemas: service.capabilities.list().map(({capability, fields, tool}) => ({capability, fields, tool}))});
    }};
}
const executeParameters = Type.Object({frameId: Type.String({minLength: 1})}, {additionalProperties: false});
export function createExecuteBusinessFrameTool(): AgentHarnessTool<AskMetricRequestContext, typeof executeParameters> {
  return {name: "execute_business_frame", label: "执行已验证查询", parameters: executeParameters,
    description: "仅凭本轮 READY Frame 执行业务查询。不能提交业务编码、日期、SQL 或自然语言参数；失败生成新快照，重复调用复用原执行。",
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
        return errorReceipt(error);
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
    return createMetricReadTool().execute(id, {kind: "result", task_id: decodeURIComponent(taskId), result_id: decodeURIComponent(resultId), ...page}, update,
      {...request, originalMessage: ""}, invocation, context);
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
    const taskIds = [...new Set(Object.values(inputs).map(input => input.task_id))];
    if (taskIds.some(id => !id)) throw new Error("RESULT_REFERENCE_INVALID");
    for (const taskId of taskIds) await request.backend.getTaskResult(taskId!, 0, 1, {signal: context.abortSignal});
  }
  return {...result, details: {...details, delivery: "business_evidence_v1"}};
}
const resultParameters = Type.Object({...executeParameters.properties,
  offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 100})),
}, {additionalProperties: false});
export function createReadBusinessResultTool(): AgentHarnessTool<AskMetricRequestContext, typeof resultParameters> {
  return {name: "read_business_result", label: "复用历史结果", parameters: resultParameters,
    description: "按 Frame 所属业务操作的成功结果引用读取（可传该操作的 READY 或 SUCCESS frameId），复查当前权限，不重新访问指标数据源。改变条件或更新数据必须解析为新的 execute Frame。",
    execute: async (id, params, update, request, invocation, context) => {
      try {
        const service = contextService(request);
        const frame = await service.resultFrame(params.frameId);
        if (!frame) throw new Error("FRAME_NOT_FOUND");
        const result = await readResult(frame, id, update, request, invocation, context, params);
        if ((result.details as {status?: string})?.status !== "succeeded") return result;
        const state = await service.store.state();
        if (state.focusFrameId !== frame.frameId) await service.store.setFocus(frame.frameId, state.version);
        return result;
      } catch (error) { return errorReceipt(error); }
    }};
}
