import { isCalendarDate } from "./shared.js";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { createCapabilities, FIELD_CONFIRMATION_DESCRIPTION } from "../business-context/capabilities.js";
import {modelFieldInputSchema} from "../business-context/fieldClarification.js";
import { createFieldResolvers, businessDate } from "../business-context/resolvers.js";
import { BusinessContextService, businessKey } from "../business-context/service.js";
import type { BusinessFrame, DateModelValue, ExecutionSettlement, FieldResolution, HistoryFieldReferenceInput, OrganizationScopeInput, ResolvedField, ResolvedOrganizations } from "../business-context/types.js";
import { createBusinessTools } from "../business-context/adapters.js";
import { createMetricReadTool } from "./readTools.js";
import { BusinessInputError } from "../business-context/inputError.js";
import { displayConditions, frameClarificationOptions, modelFields, modelRecovery, projectFixedBusinessReceipt } from "../business-context/modelView.js";
import { renderClarificationOptions } from "../business-context/clarificationOptions.js";
import { metricMentions } from "../business-context/metricMentions.js";
import { historicalOperations, inheritableFrame, resolveFrame } from "../business-context/core.js";
import { toCompactTurnArgs, toContextDelta, toLegacyTurnArgs } from "../business-context/turnArgs.js";
import { turnArgumentHint } from "../business-context/turnDialect.js";
import { getResolutionFailureDisposition } from "../business-context/resolutionFailure.js";
import { resolveHistoryFieldReference } from "../business-context/historyReferences.js";
import {fixedTurnParameters, fixedFrameSelectorSchema, fromFixedTurnArgs} from "../business-context/fixedTurnArgs.js";
import {withOrgResolutionNotices} from "../business-context/resolutionNotice.js";

const selector = Type.Object({
  frameId: Type.Optional(Type.String({minLength: 1})), ordinal: Type.Optional(Type.Integer({minimum: 1, description: "历史业务操作的绝对序号，从1开始；以历史条件索引为准，执行状态快照不计数。"})),
  relativePosition: Type.Optional(Type.Integer({maximum: 0, description: "相对本轮开始前的最新历史业务操作：0=最新，-1=倒数第二。本轮新操作和焦点切换不改变基准；已选中来源后普通续接用 baseReference=current，不重复计算相对位置。"})), capability: Type.Optional(Type.String()),
  businessConstraints: Type.Optional(Type.Record(Type.String(), Type.Unknown())), resultRequired: Type.Optional(Type.Boolean()),
}, {additionalProperties: false, minProperties: 1});
// 目标声明要求与能力注册表同源；这里只生成说明，不改变参数或字段校验。
const turnIntentRequirements = Object.fromEntries(createCapabilities().list().map(schema => [schema.capability,
  {
    required: Object.entries(schema.fields).filter(([, field]) => field.requireTurnIntent && field.required).map(([name]) => name),
    onChange: Object.entries(schema.fields).filter(([, field]) => field.requireTurnIntent && !field.required).map(([name]) => name),
  },
]));
const fieldIntents = Type.Record(Type.String({minLength: 1}), Type.Object({
  sourceText: Type.Union([Type.String({minLength: 1}), Type.Null()], {description: "inherit 必须为真正的 null；其余操作使用本轮表达该意图的完整原文。confirm 使用本轮同意或明确选择的原文；本轮以名称或编号选择时保留该原文，不以未出现在本轮的候选标签代替，也不复制历史条件。这只声明意图，不能替代确认字段值中的 evidence。"}),
  expectedCount: Type.Union([Type.Integer({minimum: 1}), Type.Null()], {description: "仅用户本轮明确声明完整目标集合数量时填写，否则为真正的 null。来源唯一或来源集合的已知数量不代表本轮数量要求；inherit 固定为 null，机构数量不同于排名条数。"}),
  mode: StringEnum(["set", "confirm", "clear", "remove", "inherit"], {description: "与本轮实际字段修改一致：新条件、特定字段独立指代、明确数量约束或组合用 set，回复已保存候选用 confirm。整笔历史业务由明确来源定位且该字段未重新指定时可 inherit，无需重复包装字段引用；inherit 两个证据键均为 null。"}),
}, {additionalProperties: false}), {maxProperties: 32,
  description: `必填对象，按本次能力的声明要求：${JSON.stringify(turnIntentRequirements)}。required 清单字段即使未改变也不可省略，未变时声明 {sourceText:null,expectedCount:null,mode:'inherit'}；onChange 清单的可选字段仅在实际修改（set/remove/clear，含候选确认）时必须声明，省略或 retain 且未改变时可省略声明。没有必需声明且本轮未修改可选字段时，空清单传{}。声明字段须属于当前能力Schema，非要求字段无需额外声明，不复制来源能力的旧声明。三键与实际修改同步：特定字段独立指代、明确数量约束或组合用 set 并提交来源，候选回复用 confirm；整笔历史业务已由明确来源定位、该字段未变时可 inherit，无需再包装字段引用。显式提供的声明仍须通过来源、数量与操作校验，null 必须是真正空值。`});
const parameters = Type.Object({
  fieldIntents,
  capabilityHint: Type.String({enum: createCapabilities().list().map(schema => schema.capability), description: "必填，按本轮实际用户目标选择能力；未改变目标时沿用既有能力。继承来源由 baseReference 单独选择，覆盖后取值或取值后计算不受焦点旧能力锁定；不为通过校验而替换用户目标。"}),
  baseReference: Type.Union([selector, Type.Null(), Type.Literal("current")], {description: "必填：null=独立新问题，current=继续当前焦点，选择对象=明确历史业务。该来源继承未变化条件；字段 sources 可独立选择其他来源。明确历史指代优先于焦点；多个合理来源须澄清，索引不足时可用 business_context_read 定位。参数纠错沿用 retry_reference 或原来源，不用 null 丢弃续接条件。"}),
  fieldChanges: Type.Array(Type.Object({fieldHint: Type.String(), operation: StringEnum(["set", "clear", "retain", "remove"]),
    rawValue: Type.Optional(Type.Unknown({description: `使用本次能力字段的 inputSchema/description：新指标用 fromQuestion，具体机构用本轮原文，特定字段独立历史指代或组合用 fromHistory 的明确 sources/组合，日期保留完整本轮表达；整笔业务已明确定位且字段未变时直接继承，不生成编码或重填历史名称。业务控制值须有本轮表达、可信继承或Schema明确无损派生的依据，合法枚举不授权默认业务选择。${FIELD_CONFIRMATION_DESCRIPTION}仅声明 userClarification 的字段可在必要选择缺失时提交 {clarify:true,sourceText:本轮相关原文}，一次保存全部必要未决选择，不给其它无依据字段试填正常值，不填写问题或候选；有依据的参数错误自行纠正。移除指标的 mentionIndexes 引用上一轮Frame清单，普通指标选择引用本轮清单，均从1开始。`})),
  }, {additionalProperties: false}), {maxItems: 32, description: "一次提交本轮全部变化。特定字段独立指代、明确数量约束或集合组合须提交该字段的来源与数量约束；整笔历史业务由 baseReference 明确定位且字段未变时省略或 retain，无需重复包装字段引用。继续已有查询且无变化时传 []。sources 只决定被引用字段，其余未变条件由 baseReference 继承。参数失败后的纠正调用重提该失败调用的全部变化，仅修正错误项，不用 retain 替代尚未保存的新值。"}),
  executionMode: StringEnum(["execute", "resolve_more", "reuse_result"], {description: "请求取得结果用 execute，校验通过立即执行；仅明确暂不执行、只补条件用 resolve_more；重显已有结果用 reuse_result 且 fieldChanges=[]。"}),
}, {additionalProperties: false});

// 来源仍须显式选择：精简表达不放宽现有模型调用的来源校验。
const schemaDescription = (schema: unknown) => (schema as {description?: string}).description ?? "";
const compactSelector = Type.Object({...selector.properties,
  relativePosition: Type.Optional(Type.Integer({maximum: 0,
    description: turnArgumentHint(schemaDescription(selector.properties.relativePosition), true)})),
}, {additionalProperties: false, minProperties: 1});

/**
 * 精简结构把字段名放在 set 的属性位置，输入说明也须贴近该位置；值仍由业务服务校验。
 * 跨能力同名字段分别保留各自契约，不能用某一能力的约束覆盖其他能力。
 */
function compactSetProperties() {
  const descriptions = new Map<string, Map<string, {targets: string[]; input: string}>>();
  for (const schema of createCapabilities().list()) {
    for (const [name, field] of Object.entries(schema.fields)) {
      // 移除操作属于 remove 分组，不把它继续混入 set.metrics 的说明。
      const fieldDescription = name === "metrics"
        ? (field.description ?? "").split("；用户明确放弃某项指标时 operation=remove，rawValue")[0]!
        : field.description ?? "";
      const description = schema.capability === "metric_query" && name === "operation"
        ? fieldDescription.replace(/^省略为普通取值。/, "") : fieldDescription;
      const operationMeaning = schema.capability === "metric_query" && name === "operation"
        ? "独立问题未要求排序时省略为普通取值；续接且未改变操作时省略并继承。"
        : "";
      const input = operationMeaning + turnArgumentHint(description, true)
        + (field.validation ? ` 值约束：${JSON.stringify(field.validation)}。` : "")
        // 已有说明给出值格式时不重复序列化完整 Schema；权威输入约束仍在能力块中。
        + (!description && field.inputSchema ? ` 输入契约：${JSON.stringify(field.inputSchema)}。` : "")
        + (field.userClarification ? " 业务控制值须有本轮表达、可信继承或Schema明确无损派生的依据；合法枚举或唯一合法值不代表用户选择。必要业务选择缺失时传{clarify:true,sourceText:本轮相关原文}，同次保存全部必要未决选择，不给其它无依据字段试填正常值，不填写问题或候选。有明确依据的参数错误自行纠正。" : "");
      const entries = descriptions.get(name) ?? new Map<string, {targets: string[]; input: string}>();
      const key = JSON.stringify([field.description, field.validation, field.inputSchema, field.userClarification, operationMeaning]);
      const entry = entries.get(key) ?? {targets: [], input};
      entry.targets.push(`${schema.capability}（${field.label}）`);
      entries.set(key, entry);
      descriptions.set(name, entries);
    }
  }
  return Object.fromEntries([...descriptions].map(([name, entries]) => [name,
    Type.Optional(Type.Unknown({description: `set.${name}；按本次 capability 采用对应输入契约。`
      + [...entries.values()].map(entry => `${entry.targets.join("、")}：${entry.input}`).join("\n")}))]));
}

const compactParameters = Type.Object({
  fieldIntents,
  capability: Type.String({enum: createCapabilities().list().map(schema => schema.capability),
    description: turnArgumentHint(schemaDescription(parameters.properties.capabilityHint), true)}),
  base: Type.Union([compactSelector, Type.Null(), Type.Literal("current")], {
    description: turnArgumentHint(schemaDescription(parameters.properties.baseReference), true)}),
  mode: StringEnum(["execute", "resolve_more", "reuse_result"], {
    description: "请求取得结果用 execute，校验通过立即执行；仅明确暂不执行、只补条件用 resolve_more；重显已有结果用 reuse_result，省略所有字段修改分组。"}),
  set: Type.Optional(Type.Object(compactSetProperties(), {additionalProperties: true, maxProperties: 32,
    description: "一次提交本轮全部新值或补充值，按对应能力字段 inputSchema/description 构造。未变字段省略或列入 retain；继续且无变化时省略所有修改分组。确认依托已保存候选，必要业务选择缺失使用声明的 clarify 输入，形状见对应字段。参数失败后重提该失败调用的全部变化，仅修正错误项，不用 retain 替代尚未保存的新 set。不生成编码或重填历史名称和日期，同一字段只属于一个分组。"})),
  remove: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {maxProperties: 32,
    description: "仅用户明确放弃指标时用 remove.metrics={mentionIndexes:[...]}，引用来源 Frame 的 mention 序号，从1开始。"})),
  clear: Type.Optional(Type.Array(Type.String({minLength: 1}), {maxItems: 32, description: "仅提交本轮明确清除的字段名；字段是否允许清除由业务 Schema 校验。未变化字段不要列入 clear。"})),
  retain: Type.Optional(Type.Array(Type.String({minLength: 1}), {maxItems: 32, description: "只保留本轮未变化字段，也可直接省略，不重填历史名称和日期。retain 继承来源中的旧值，不能代替本轮新 set。待确认的用户回复应在 set 对应字段传 {confirm:true}。"})),
}, {additionalProperties: false});

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
    async resolveCatalogSuggested(entity: string, suggested: {code?: string; name?: string; excerpt?: string}): Promise<FieldResolution> {
      try {
        const response = await request.backend.resolveBusinessFieldSuggestion(entity, [suggested], {signal});
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
        if (resolutionSource !== undefined && resolutionSource !== "deterministic" && resolutionSource !== "model") throw new Error("INVALID_RESOLVER_RESPONSE");
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
/** 仅供内部旧记录及受信在途操作恢复；新模型使用下方固定协议入口。 */
export function createResolveBusinessTurnTool(options: {compactTurnArgs?: boolean | undefined} = {}): AgentHarnessTool<AskMetricRequestContext, typeof parameters | typeof compactParameters> {
  const compact = options.compactTurnArgs === true;
  return {name: "resolve_business_turn", label: "解析业务上下文", parameters: compact ? compactParameters : parameters,
    description: turnArgumentHint("用途：解析本轮业务目标与全部条件变化，保存或执行受校验的业务Frame。显式选择 baseReference 继承未变条件，字段历史来源单独提交；一次提交全部变化，避免中间完整状态执行非用户目标。取数目标用 execute，READY 后按回执继续执行，不追加确认；resolve_more 仅保存，REUSE_RESULT 读取原结果。ARGUMENT_ERROR 未应用该调用，保留来源并重提该调用全部变化，有依据则修正参数；必要业务选择缺失且不可唯一确定时用字段声明的 userClarification 输入保存条件。NEEDS_CLARIFICATION 仅询问 issues 并结束，不重复解析或换能力绕过。字段形状与枚举见能力Schema，不猜默认值或填写澄清问题、候选。", compact),
    prepareArguments: args => {
      // 必须在原生 Schema 校验之前转换；失败保留原参数，由原生校验报告错误。
      try {
        if (args && typeof args === "object" && !Array.isArray(args)
          && (compact ? "mode" in args : "executionMode" in args)) return args as Static<typeof parameters | typeof compactParameters>;
        const delta = toContextDelta(args);
        return (compact ? toCompactTurnArgs(delta) : toLegacyTurnArgs(delta)) as Static<typeof parameters | typeof compactParameters>;
      } catch { return args as Static<typeof parameters | typeof compactParameters>; }
    },
    execute: async (_id, params, _update, request, _invocation, context) => {
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

/** 模型只提交一份字段动作；旧 Delta 及目标声明由校验后的固定请求确定性生成。 */
export function createFixedResolveBusinessTurnTool(): AgentHarnessTool<AskMetricRequestContext, typeof fixedTurnParameters> {
  const internal = createResolveBusinessTurnTool();
  return {name: "resolve_business_turn", label: "解析业务上下文", parameters: fixedTurnParameters,
    description: "通过唯一固定请求格式解析本轮业务目标与全部变化。严格按参数Schema选择能力、显式继承来源及字段动作；每项变化只声明一次，保留完整原文和用户明确数量。execute取得结果，resolve_more仅保存，reuse_result回读已有结果。条件缺失用字段声明的clarify动作保存已知项，由服务端提问，不补日期、机构范围或排名条数。确认只针对已保存候选；接口结构正确后仍须通过目录、来源、权限、口径和执行校验。参数错误沿用回执来源修正，已确认内容保留。",
    prepareArguments: args => {
      try {fromFixedTurnArgs(args); return args as Static<typeof fixedTurnParameters>;}
      catch (error) {
        if (error instanceof BusinessInputError) throw new Error(`${error.code}: ${error.correction}`);
        throw error;
      }
    },
    execute: async (id, args, update, request, invocation, context) => {
      try {
        const delta = fromFixedTurnArgs(args);
        const result = await internal.execute(id, delta as Static<typeof parameters>, update, request, invocation, context);
        return fixedBusinessResult(result);
      } catch (error) {return fixedBusinessResult(errorReceipt(error, request.originalMessage));}
    }};
}

/** 只改模型回执的协议字段，业务文本、原文跨度与结果值由专用投影保持原样。 */
function fixedBusinessResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
  return {...result, content: result.content.map(block => {
    if (block.type !== "text") return block;
    try {return {...block, text: JSON.stringify(projectFixedBusinessReceipt(JSON.parse(block.text)))};}
    catch {return block;}
  })};
}

export function createFixedBusinessContextReadTool(): AgentHarnessTool<AskMetricRequestContext, typeof fixedReadContextParameters> {
  const internal = createBusinessContextReadTool();
  return {...internal, parameters: fixedReadContextParameters,
    description: "读取当前焦点、明确历史业务或分页历史条件索引；只读列表不切换焦点。返回统一固定协议的续接来源、已知条件及待确认项，字段输入结构以resolve_business_turn实际参数Schema为准。",
    execute: async (...args) => fixedBusinessResult(await internal.execute(...args))};
}
const readContextParameters = Type.Object({
  frameId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 30})),
  selector: Type.Optional(selector),
  setFocus: Type.Optional(Type.Boolean({description: "选择单个历史业务时默认切换焦点；只检查候选而不转移讨论目标时显式设false。切换须提供唯一定位的selector或frameId，不创建新操作，也不执行查询。分页浏览始终不切焦点。"})),
}, {additionalProperties: false});
const fixedReadContextParameters = Type.Object({...readContextParameters.properties,
  selector: Type.Optional(Type.Unsafe<Static<typeof selector>>(fixedFrameSelectorSchema))}, {additionalProperties: false});
export function createBusinessContextReadTool(options: {compactTurnArgs?: boolean | undefined} = {}): AgentHarnessTool<AskMetricRequestContext, typeof readContextParameters> {
  return {name: "business_context_read", label: "读取业务状态", parameters: options.compactTurnArgs
    ? Type.Object({...readContextParameters.properties, selector: Type.Optional(compactSelector)}, {additionalProperties: false}) : readContextParameters,
    description: turnArgumentHint("用途：读取本会话业务条件、焦点、稳定操作序号及能力Schema。索引足够时无需额外读取。用 selector/frameId 选中唯一历史业务默认切焦点，后续 baseReference=current 继承该业务；只检查候选用 setFocus=false。分页、无匹配或歧义不切焦点。不执行查询或读取完整结果；历史结果通过受控结果读取工具取得。", options.compactTurnArgs === true),
    execute: async (_id, params, _update, request) => {
      const service = contextService(request);
      const state = await service.store.state();
      const allFrames = await service.store.list();
      const operationIds = historicalOperations(state, allFrames, request.operationId);
      if (params.selector || params.frameId || params.setFocus) {
        if (params.selector && params.frameId || params.setFocus && !params.selector && !params.frameId) {
          return errorReceipt(new BusinessInputError("FRAME_SELECTOR_REQUIRED", "$base",
            "单个历史来源使用 selector 或 frameId，不同时传入；切换焦点必须先提供明确来源，不能把分页列表当作来源。"));
        }
        const resolution = resolveFrame(params.selector ?? {frameId: params.frameId!}, state, allFrames, request.operationId);
        if (resolution.status !== "resolved") return json({...resolution, frame: null, focusFrameId: state.focusFrameId,
          ...(resolution.status === "ambiguous" ? {message: "来源匹配多个业务操作，请补充选择条件，不得自动选择最近一项。"} : {})});
        const frame = (await service.store.get(resolution.frameId!))!;
        const setFocus = params.setFocus !== false;
        if (setFocus) {
          if (!inheritableFrame(frame) || frame.status === "executing" || frame.issues.some(issue => issue.field === "$base")) {
            return errorReceipt(new BusinessInputError("INVALID_FOCUS_FRAME", "$base", "所选业务状态不能作为当前焦点，原焦点保持不变。请核对其状态和历史来源。"));
          }
          try {
            await service.store.setFocus(frame.frameId, state.version);
          } catch (error) { return errorReceipt(error); }
        }
        return json({status: "resolved", frame: {...frame, fields: modelFields(frame.fields)},
          ordinal: operationIds.indexOf(state.operations[frame.operationFrameId]!) + 1 || null, latestOrdinal: operationIds.length,
          focusFrameId: setFocus ? frame.frameId : state.focusFrameId, baseReference: {frameId: frame.frameId}});
      }
      const offset = params.offset ?? Math.max(0, operationIds.length - 10);
      const ids = operationIds.slice(offset, offset + (params.limit ?? 10));
      const frames = await Promise.all(ids.map(async (id, index) => {
        const frame = await service.store.get(id);
        return {ordinal: offset + index + 1, frame: frame ? {...frame, fields: modelFields(frame.fields)} : undefined};
      }));
      return json({version: state.version, focusFrameId: state.focusFrameId, frames,
        next_offset: offset + ids.length < operationIds.length ? offset + ids.length : null,
        schemas: service.capabilities.list().map(({capability, fields, tool}) => ({capability,
          fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, {...field,
            ...(modelFieldInputSchema(field) ? {inputSchema: modelFieldInputSchema(field)} : {})}])), tool}))});
    }};
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
