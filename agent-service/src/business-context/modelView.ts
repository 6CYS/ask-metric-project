import {createCapabilities} from "./capabilities.js";
import {clarificationOptions} from "./clarificationOptions.js";
import {fieldLabels, historicalOperations} from "./core.js";
import type {BusinessFrame, BusinessSessionState, FrameStore, MentionResolution, ResolvedField, ResolvedOrganizations} from "./types.js";

const CHOICES_NOTE = "系统会向用户展示编号清单，并按用户回复或点选确定所选项；不要罗列、改写或挑选候选，只需简短说明需要用户确认什么。";

/** 待确认候选只给模型数量和说明：清单由系统展示，模型无从打乱、合并或挑选。 */
function withoutCandidates(field: ResolvedField): ResolvedField {
  const mentions = field.metadata?.mentionResolutions;
  const stripped: ResolvedField = Array.isArray(mentions) ? {...field, metadata: {...field.metadata, mentionResolutions: (mentions as MentionResolution[])
    .map(({candidates, ...mention}) => candidates?.length ? {...mention, choices: candidates.length} : mention)}} : field;
  if (!stripped.candidates?.length) return stripped;
  const {candidates, ...rest} = stripped;
  return {...rest, pendingChoices: {count: candidates.length, instruction: CHOICES_NOTE}} as ResolvedField;
}

/** 集合只暴露描述和授权目标数量，完整编码集合留在服务端状态中。 */
export function modelFields(fields: Record<string, ResolvedField>): Record<string, ResolvedField> {
  return Object.fromEntries(Object.entries(fields).map(([name, raw]) => {
    const field = withoutCandidates(raw);
    const value = field.resolvedValue as ResolvedOrganizations | undefined;
    if (name !== "organizations" || !value?.scope) return [name, field];
    return [name, {...field, resolvedValue: {scope: value.scope, count: value.codes.length}, metadata: undefined}];
  }));
}

/** 待确认 Frame 的规范候选清单；展示与回复对应共用，保证编号一致。 */
export function frameClarificationOptions(frame: BusinessFrame) {
  return clarificationOptions(frame, fieldLabels(createCapabilities().get(frame.capability)));
}

function listedNames(names: unknown, unit: string, visible = 3): string | undefined {
  if (!Array.isArray(names) || !names.length || !names.every(name => typeof name === "string" && name)) return undefined;
  return names.length > visible ? `${names.slice(0, visible).join("、")} 等 ${names.length} ${unit}` : names.join("、");
}

/** 机构集合按用户原话展示（如“各家农商行（60 家）”），逐一点名的机构只列前两家，避免长全称铺满一行。 */
function organizationValue(raw: unknown, value: unknown): string | undefined {
  const resolved = value as Partial<ResolvedOrganizations> | undefined;
  if (!Array.isArray(resolved?.names)) return undefined;
  if (resolved.scope) {
    const sourceText = (raw as {sourceText?: unknown} | undefined)?.sourceText;
    const scopeText = typeof sourceText === "string" && sourceText.trim() ? sourceText.trim()
      : resolved.scope.kind === "authorized_cohort" ? "授权范围内农商行" : "下辖机构";
    return `${scopeText}（${resolved.names.length} 家）`;
  }
  return listedNames(resolved.names, "家", 2);
}

const selectionLabels: Record<string, string> = {latest_in_range: "范围内最新数据日", all_in_range: "范围内全部日期"};

function condition(resolver: string, raw: unknown, value: unknown): {label: string; value: string} | undefined {
  let text: string | undefined;
  let label = "";
  if (resolver === "metric") [label, text] = ["指标", listedNames((value as {names?: unknown} | undefined)?.names, "个指标")];
  else if (resolver === "organization") [label, text] = ["机构", organizationValue(raw, value)];
  else if (resolver === "date") {
    const range = value as {start?: unknown; end?: unknown; dates?: unknown} | undefined;
    label = "日期";
    if (Array.isArray(range?.dates)) text = listedNames(range.dates, "个日期");
    else if (typeof range?.start === "string" && typeof range.end === "string") {
      text = range.start === range.end ? range.start : `${range.start} 至 ${range.end}`;
    }
  } else if (resolver === "query_operation") {
    const operation = value as {kind?: unknown; position?: unknown; top_n?: unknown} | undefined;
    label = "排名";
    if (operation?.kind === "ranking" && typeof operation.top_n === "number") text = `${operation.position === "bottom" ? "后" : "前"} ${operation.top_n} 名`;
  } else if (resolver === "enum" && typeof value === "string") {
    // 单日精确取值不必说明；其余内部枚举、分页和计算引用不面向用户展示。
    [label, text] = ["取数方式", selectionLabels[value]];
  }
  return text ? {label, value: text} : undefined;
}

/**
 * 执行过程展示用的已确定条件：只列已解析字段的业务名称（指标、机构、日期、排名、取数方式），
 * 不含编码、候选或内部控制字段；名称均来自服务端按当前用户权限解析的结果。
 */
export function displayConditions(frame: BusinessFrame): Array<{label: string; value: string}> {
  // 展示信息不能影响解析回执，未知能力直接不展示条件。
  const schema = createCapabilities().list().find(item => item.capability === frame.capability);
  return Object.entries(frame.fields).flatMap(([name, field]) => {
    const definition = schema?.fields[name];
    if (!definition || field.resolutionStatus !== "resolved") return [];
    const item = condition(definition.resolver, field.rawValue, field.resolvedValue);
    return item ? [item] : [];
  });
}

/** 已 resolved 的 mention 名称；让模型在回执和焦点注入里看到哪些项已锁定，不用再澄清。 */
function lockedMentions(field: ResolvedField): string[] {
  const resolutions = field.metadata?.mentionResolutions;
  if (!Array.isArray(resolutions)) return [];
  return (resolutions as MentionResolution[])
    .filter(mention => mention.status === "resolved" && typeof mention.value?.names?.[0] === "string")
    .map(mention => mention.value!.names[0]!);
}

/** 模型视图只给决策所需的字段；完整溯源留在 Frame Store，按引用读取。 */
export function modelFrame(frame: BusinessFrame, currentTurnId: string) {
  const current = frame.turnId === currentTurnId;
  return {frameId: frame.frameId, parentFrameId: frame.parentFrameId, capability: frame.capability,
    currentTurn: current,
    ...(frame.status === "draft" && frame.errorCode === "TEMPORARY_ERROR" ? {errorCode: frame.errorCode,
      retry_reference: {frameId: frame.frameId}, instruction: "服务暂时不可用，需重试时沿用此引用和原字段，不要求用户重述条件。"} : {}),
    status: frame.status, executionMode: frame.delta.executionMode, resultRef: frame.resultRef, issues: frame.issues,
    ...(!current && ["clarifying", "ready"].includes(frame.status) ? {continuation: {
      tool: "resolve_business_turn", baseReference: {frameId: frame.frameId},
      unresolvedFields: frame.issues.map(issue => issue.field),
      instruction: "后续用户回合先解析本轮 Frame；未变化字段省略或 retain，不直接执行历史 frameId。",
    }} : {}),
    ...(current && frame.status === "ready" ? {nextAction: frame.delta.executionMode === "execute"
      ? {tool: "execute_business_frame", arguments: {frameId: frame.frameId}}
      : {action: "conditions_saved"}} : {}),
    fields: Object.fromEntries(Object.entries(modelFields(frame.fields)).filter(([, field]) => field.resolutionStatus !== "missing")
      .map(([name, field]) => {
        const locked = lockedMentions(field);
        return [name, {rawValue: field.rawValue, value: field.resolvedValue,
          status: field.resolutionStatus,
          ...((field as {pendingChoices?: unknown}).pendingChoices ? {pendingChoices: (field as {pendingChoices?: unknown}).pendingChoices} : {}),
          ...(locked.length ? {lockedMentions: locked} : {})}];
      }))};
}

/** 历史来源索引只给最近操作的条件与引用；更早记录按需分页，不读取结果或改动焦点。 */
export async function modelHistoryIndex(store: FrameStore, state: BusinessSessionState, currentTurnId: string) {
  const frames = await store.list();
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  const operations = historicalOperations(state, frames, currentTurnId);
  const offset = Math.max(0, operations.length - 10);
  const indexes = operations.slice(offset).map((_, index) => offset + index);
  const entries = indexes.map(index => {
    const frame = byId.get(operations[index]!);
    if (!frame) return {ordinal: index + 1, unavailable: true};
    const view = modelFrame(frame, currentTurnId);
    return {ordinal: index + 1, frameId: frame.frameId, capability: frame.capability,
      currentTurn: view.currentTurn, status: frame.status, fields: view.fields};
  });
  const focus = state.focusFrameId ? byId.get(state.focusFrameId) : undefined;
  const focusIndex = focus ? operations.indexOf(state.operations[focus.operationFrameId]!) : -1;
  return {total: operations.length, latestOrdinal: operations.length || null, focusOrdinal: focusIndex < 0 ? null : focusIndex + 1,
    entries, partial: entries.length < operations.length, currentTurnExcluded: true,
    usage: "历史基准固定为本轮开始前的操作，本轮新操作仅见当前焦点；不能在查询后重新解释同一句历史指代。ordinal 是稳定的历史操作序号，切焦点不改变序号或最新历史操作；relativePosition 从最新历史操作计算，与焦点无关。明确引用历史并修改时，resolve_business_turn.baseReference 必须使用对应条目的 frameId/ordinal，只提交本轮变化，不能省略来源而继承当前焦点。用户转回历史业务但暂不查询时，即使索引已显示条件，也先用 business_context_read 的 selector/frameId 选中它保存焦点，再回答。选中后普通续接可baseReference=current，无需重新计算来源。仅检查候选用 setFocus=false，分页浏览不切换。未列出的记录通过 selector 或分页读取。"};
}

/** 一次提供必要输入契约，避免模型为了构造参数反复读取完整历史和 Schema。 */
export function modelCapabilitySchemas() {
  return createCapabilities().list().map(schema => ({capability: schema.capability,
    fields: Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, {
      label: field.label, required: field.required, inherit: field.inheritable,
      ...(field.description ? {description: field.description} : {}),
      ...(field.validation ? {validation: field.validation} : {}),
      ...(field.resolver === "date" ? {input: "未改变则省略或 retain；改变时传本轮完整日期原文，省略年份由解析器处理"} : {}),
      ...(field.resolver === "organization" ? {input: "未改变则省略或 retain；具体机构与其指代（“上述三家”“那两家”等）传本轮原文名称或名称数组，原样直传、不展开为历史机构名，由服务端按会话历史解析；机构集合或上下级范围（“各家农商行”“某某下辖”等）必须传集合原文对象（形式见 description），传纯文本无法解析；用户回复待确认问题传 {confirm:true}"} : {}),
      ...(field.resolver === "metric" ? {input: "未改变则省略或 retain；新指标用 {fromQuestion:true, mentionIndexes?:number[]}（index 属于本轮算法清单，每轮重新抽取、不跨轮）；用户回复待确认问题传 {confirm:true}；放弃某项用 operation=remove"} : {}),
      ...(field.inputSchema ? {inputSchema: field.inputSchema} : {}),
    }]))}));
}
