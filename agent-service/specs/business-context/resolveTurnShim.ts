/**
 * 业务解析工具退役后的测试桥：以生产同一入口驱动 BusinessContextService.resolve。
 * 只保留字段解析、执行与历史行为断言所需的执行路径（Delta 转换、Resolver 接线、回执映射），
 * 不再携带旧模型参数 Schema；模型可见协议由 semantic_v2 测试覆盖。
 */
import type { Context } from "@earendil-works/pi-agent-core";
import { isCalendarDate } from "../../src/tools/shared.js";
import type { AskMetricRequestContext } from "../../src/requestContext.js";
import { BackendApiError } from "../../src/backendClient.js";
import { businessDate } from "../../src/business-context/resolvers.js";
import type { BusinessFrame, DateModelValue, FieldResolution, HistoryFieldReferenceInput, OrganizationScopeInput, ResolvedField, ResolvedOrganizations } from "../../src/business-context/types.js";
import { BusinessInputError } from "../../src/business-context/inputError.js";
import { displayConditions, frameClarificationOptions, modelFields, modelRecovery } from "../../src/business-context/modelView.js";
import { renderClarificationOptions } from "../../src/business-context/clarificationOptions.js";
import { metricMentions } from "../../src/business-context/metricMentions.js";
import { inheritableFrame, resolveFrame } from "../../src/business-context/core.js";
import { toContextDelta } from "../../src/business-context/turnArgs.js";
import { getResolutionFailureDisposition } from "../../src/business-context/resolutionFailure.js";
import { resolveHistoryFieldReference } from "../../src/business-context/historyReferences.js";
import { contextService, reconcileExecution } from "../../src/tools/businessContext.js";

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

const identity = (request: AskMetricRequestContext) => ({sessionId: request.sessionId, requestId: request.requestId, turnId: request.operationId});
function json(payload: unknown, details: Record<string, unknown> = {}): {content: Array<{type: "text"; text: string}>; details: Record<string, unknown>} {
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

function resolverContext(request: AskMetricRequestContext, signal: AbortSignal | undefined) {
  return {originalMessage: request.originalMessage, currentDate: businessDate(), turnId: request.operationId,
    // 宿主绑定的口径切换（前端 time_override）；模型参数不能创建或改写。
    ...(request.timeOverride ? {timeOverride: request.timeOverride} : {}),
    ...(typeof request.backend.getBasicQueryStatus === "function"
      ? {reconcileExecution: (frame: BusinessFrame) => reconcileExecution(request, frame, signal)} : {}),
    // 正式 BackendClient 总是提供完整原文解析；独立 Resolver 测试可注入自己的事实源。
    ...(typeof request.backend.matchMetricQuestion === "function" ? {resolveMetricMentions: (question?: string) => metricMentions(request, question)} : {}),
    // 用户回复的依据：原文、原文的目录识别编码、针对该待确认 Frame 的前端点选。
    async replyEvidence(frameId: string) {
      const selection = request.clarificationSelection;
      // 点选限定本次确认范围；“是”等展示文字不能顺带确认未点选的其它候选。
      if (selection) return {reply: "", codes: [], optionIds: selection.frame_id === frameId ? selection.option_ids : []};
      const matched = typeof request.backend.matchMetricQuestion === "function" ? await metricMentions(request) : {mentions: []};
      return {reply: request.originalMessage,
        codes: matched.mentions.filter(mention => mention.resolution.status === "resolved")
          .flatMap(mention => (mention.resolution.value as {codes: string[]}).codes),
        optionIds: []};
    },
    // 模型明确指代来源；服务端只读定位并复核当前授权，不按词语或最近数量猜测。
    async resolveFieldReference(input: HistoryFieldReferenceInput, targetField: string, inputSource?: "explicit" | "inherited", previous?: ResolvedField): Promise<FieldResolution> {
      if (!request.frames) throw new Error("BUSINESS_CONTEXT_NOT_BOUND");
      return resolveHistoryFieldReference(input, targetField, {sessionId: request.sessionId, turnId: request.operationId,
        originalMessage: request.originalMessage, ...(inputSource ? {inputSource} : {}), ...(previous ? {previous} : {}), state: await request.frames.state(), frames: await request.frames.list(),
        async resolveCatalog(entity, values) {
          try { return await request.backend.resolveBusinessField(entity, values, {signal}); }
          catch (error) {
            if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
            return {status: "temporary_error"};
          }
        },
        async resolveOrganizationScope(input) {
          try { return await request.backend.resolveOrganizationScope(input, {signal}); }
          catch (error) {
            if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
            if (error instanceof BackendApiError && error.code === "SCOPE_SOURCE_INVALID") return {status: "not_found",
              metadata: {referenceIssue: {code: "HISTORY_SCOPE_SOURCE_UNAVAILABLE", message: "历史范围原始条件已不再有效，请重新明确机构范围。"}}};
            return {status: "temporary_error"};
          }
        }});
    },
    async resolveFactBindings(bindings: Record<string, {fact_id: string}>): Promise<FieldResolution> {
      const frames = await request.frames?.list() ?? [];
      // 轮次标识计算归属，不标识事实有效性；只接纳本会话成功查询 Frame 的精确引用。
      const allowedTasks = new Set(frames.filter(frame => frame.status === "success"
        && frame.resultRef?.startsWith("query:")).map(frame => decodeURIComponent(frame.resultRef!.split(":")[1]!)));
      for (const binding of Object.values(bindings)) {
        const match = binding.fact_id.match(/^fact:([^:]+):(\d+):([^:]+)$/);
        if (!match || !allowedTasks.has(match[1]!)) throw new BusinessInputError("CALCULATION_SOURCE_UNAVAILABLE", "bindings",
          "引用没有对应的本会话成功查询。先用 read_business_result 读取用户指定的查询快照，使用回执中的 fact_id；不要猜测引用或反复提交同一引用。");
        try {
          const page = await request.backend.getTaskResult(match[1]!, Number(match[2]), 1, {signal});
          if (page.status !== "succeeded" || page.task_id !== match[1]) throw new BusinessInputError("CALCULATION_SOURCE_NOT_READY", "bindings",
            "所选查询尚未成功或结果引用不匹配，不能计算。请核对指定来源，不自动换成其他历史结果。");
          if (page.truncated) throw new BusinessInputError("CALCULATION_SOURCE_INCOMPLETE", "bindings",
            "所选查询快照已截断，不能据此计算完整结果。请补齐查询结果，不把分页样例当完整输入。");
          if (!page.facts?.some(fact => fact.fact_id === binding.fact_id)) throw new BusinessInputError("CALCULATION_FACT_UNAVAILABLE", "bindings",
            "所选快照中没有该精确数值引用。读取对应结果页并使用其真实 fact_id，不能手填业务数值。");
        } catch (error) {
          if (error instanceof BusinessInputError) throw error;
          if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
          if (error instanceof BackendApiError && [404, 410, 422].includes(error.status)) throw new BusinessInputError(
            error.status === 410 ? "CALCULATION_SOURCE_EXPIRED" : "CALCULATION_SOURCE_UNAVAILABLE", "bindings",
            "指定快照已失效或不可读取。请明确告知用户，保留原查询条件；需要重新查询时使用新回执，不静默替换用户指定的历史数值。");
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
    // 模型建议通道与原文通道共用同一后端 resolve-field；失败同样按临时错误降级，不吞 401/403。
    async resolveCatalogSuggested(entity: string, suggested: {code?: string; name?: string; excerpt?: string}, rawValues: string[], sourceQuestion: string): Promise<FieldResolution> {
      try {
        const response = await request.backend.resolveBusinessFieldSuggestion(entity, [suggested], {signal}, sourceQuestion, rawValues);
        if (!response || !["resolved", "missing", "ambiguous", "not_found", "needs_confirmation", "invalid", "temporary_error"].includes(response.status)) throw new Error("INVALID_RESOLVER_RESPONSE");
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
    },
    async resolveCatalog(entity: string, raw: string[], referenceYear?: number, modelValue?: DateModelValue | null): Promise<FieldResolution> {
      try {
        const response = await request.backend.resolveBusinessField(entity, raw, {signal}, referenceYear, undefined, modelValue);
        if (!response || !["resolved", "missing", "ambiguous", "not_found", "needs_confirmation", "invalid", "temporary_error"].includes(response.status)) throw new Error("INVALID_RESOLVER_RESPONSE");
        // 模型换算请求不在这里严格校验（服务端裁定）；响应的备选口径与解析来源须符合契约形状才透传。
        const alternative = response.alternative;
        if (alternative !== undefined && (!alternative || typeof alternative.label !== "string" || !alternative.label.trim()
          || typeof alternative.start !== "string" || typeof alternative.end !== "string"
          || !isCalendarDate(alternative.start) || !isCalendarDate(alternative.end) || alternative.start > alternative.end)) throw new Error("INVALID_RESOLVER_RESPONSE");
        const resolutionSource = response.metadata?.resolution_source;
        // 机构解析来源词汇表随目录阶梯扩展（exact/contains/corrected/model_inferred）；
        // date 另有 deterministic/model。未知来源一律视为契约破坏，不得透传。
        if (resolutionSource !== undefined && !["deterministic", "model", "exact", "contains", "corrected", "model_inferred"].includes(String(resolutionSource))) throw new Error("INVALID_RESOLVER_RESPONSE");
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

/** 转换失败也须保留已明确且唯一的来源；只读定位，不切焦点、不展开正常调用的 current。 */
async function turnDelta(args: unknown, request: AskMetricRequestContext) {
  try { return toContextDelta(args); }
  catch (error) {
    if (!(error instanceof BusinessInputError) || !request.frames || !args || typeof args !== "object" || Array.isArray(args)) throw error;
    const input = args as Record<string, unknown>;
    // 混合格式或没有明确来源时不能替模型选来源。
    const legacy = ["capabilityHint", "baseReference", "executionMode", "fieldChanges"].some(key => Object.hasOwn(input, key));
    const compact = ["capability", "base", "mode", "set", "remove", "clear", "retain"].some(key => Object.hasOwn(input, key));
    if (legacy === compact) throw error;
    const reference = input[legacy ? "baseReference" : "base"];
    if (reference === undefined || reference === null) throw error;
    let delta;
    try { delta = toContextDelta({executionMode: "resolve_more", fieldChanges: [], baseReference: reference}); }
    catch { throw error; }
    const state = await request.frames.state();
    let frame: BusinessFrame | undefined;
    if (delta.baseReference === "current") {
      const focus = state.focusFrameId ? await request.frames.get(state.focusFrameId) : undefined;
      const latest = focus ? await request.frames.get(state.operations[focus.operationFrameId] ?? focus.frameId) : undefined;
      // 与业务服务的 current 来源门禁一致，不能通过旧 READY 快照绕过最新在途/失败状态。
      if (!latest || inheritableFrame(latest) && latest.status !== "executing" && !latest.issues.some(issue => issue.field === "$base")) {
        frame = latest?.status === "failed" ? latest : focus;
      }
    } else {
      const resolution = resolveFrame(delta.baseReference!, state, await request.frames.list(), request.operationId);
      frame = resolution.status === "resolved" && resolution.frameId ? await request.frames.get(resolution.frameId) : undefined;
    }
    if (frame && inheritableFrame(frame) && frame.status !== "executing" && !frame.issues.some(issue => issue.field === "$base")) {
      throw new BusinessInputError(error.code, error.field, error.correction, {frameId: frame.frameId}, error.recovery, error.corrections);
    }
    throw error;
  }
}

/**
 * 退役解析工具的执行路径替身：与生产工具相同地转换 Delta、接线 Resolver 并映射回执。
 * 仅供 specs 驱动 BusinessContextService 行为断言；不注册进任何运行时工具集。
 */
export function createResolveTurnShim() {
  return {name: "resolve_business_turn",
    prepareArguments: (args: Record<string, unknown>) => {
      try { return {...toContextDelta(args)}; } catch { return args; }
    },
    execute: async (_id: string, params: unknown, _update: () => void, request: AskMetricRequestContext, _invocation: unknown, context: Context) => {
      try {
        // current 交给服务端解析，幂等指纹保持不变；不能在工具层展开成会随执行推进的焦点快照。
        const frame = await contextService(request).resolve(await turnDelta(params, request), identity(request),
          {...resolverContext(request, context.abortSignal), requireFieldIntents: true});
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
          {kind: "business_context", status, frame_id: frame.frameId, execution_mode: frame.delta.executionMode, issues: frame.issues,
            // 仅供页面“执行过程”展示已确定条件，不进入模型上下文。
            display_conditions: displayConditions(frame),
            ...(status === "NEEDS_CLARIFICATION" ? clarificationDetails(frame) : {})});
      } catch (error) {
        const preserved = error instanceof BusinessInputError && error.baseReference
          ? await request.frames?.get(error.baseReference.frameId) : undefined;
        return errorReceipt(error, request.originalMessage, preserved?.sessionId === request.sessionId ? preserved : undefined);
      }
    }};
}
