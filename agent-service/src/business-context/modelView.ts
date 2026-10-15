import {createCapabilities} from "./capabilities.js";
import {clarificationOptions} from "./clarificationOptions.js";
import {modelFieldInputSchema} from "./fieldClarification.js";
import {fieldLabels, historicalOperations, inheritableFrame} from "./core.js";
import {turnArgumentHint} from "./turnDialect.js";
import {fixedFieldChangeSchema} from "./fixedTurnArgs.js";
import type {BusinessFrame, BusinessSessionState, FrameStore, MentionResolution, ResolvedField, ResolvedOrganizations} from "./types.js";

const CHOICES_NOTE = "服务端展示已保存的规范清单，并按用户回复或点选确定选项。仅说明待确认条件，不自行罗列、改写或挑选候选；已确定项不重复询问。";

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
    if (name !== "organizations" || !Array.isArray(value?.codes)) return [name, field];
    if (!value.scope) return [name, {...field, resolvedValue: {...value, count: value.codes.length}}];
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

/** 保留待解析集合的绝对索引；只展示未决原文和状态，不向模型暴露目录候选。 */
function unresolvedAdditions(field: ResolvedField): Array<{index: number; raw: string; status: string}> {
  const reference = field.metadata?.historyReference ?? field.rawValue;
  const issues = field.metadata?.referenceAdditionIssues;
  if (field.resolutionStatus === "resolved" || !reference || typeof reference !== "object"
    || Array.isArray(reference) || (reference as {fromHistory?: unknown}).fromHistory !== true || !Array.isArray(issues)) return [];
  return issues.flatMap(issue => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const {index, raw, status} = issue as Record<string, unknown>;
    return typeof index === "number" && Number.isInteger(index) && index >= 0 && typeof raw === "string" && raw.trim()
      && typeof status === "string" && ["missing", "ambiguous", "not_found", "needs_confirmation", "invalid", "temporary_error"].includes(status)
      ? [{index, raw, status}] : [];
  });
}

/** 恢复回执与上下文同源，公开剩余处理动作，已确认字段不再交给模型重填。 */
export function modelRecovery(frame: BusinessFrame) {
  if (!frame.recovery) return {};
  const recovery = frame.recovery;
  return {retry_reference: {frameId: frame.frameId}, pending_fields: [...recovery.pendingFields],
    pending_changes: recovery.pendingFields.map(field => {
      const change = recovery.pendingChanges?.find(item => item.field === field);
      return {field, operation: change?.operation ?? "unknown", ...(change?.sourceText ? {source_text: change.sourceText} : {}),
        ...(change?.expectedCount !== undefined ? {expected_count: change.expectedCount} : {}),
        may_retain: change?.mayRetain ?? true, inherit_allowed: change?.mayRetain === true};
    }), confirmed_fields: Object.entries(frame.fields).filter(([, field]) => field.resolutionStatus === "resolved"
      && field.metadata?.confirmationTurnId === recovery.turnId).map(([name]) => name)};
}

/** 模型视图只给决策所需的字段；完整溯源留在 Frame Store，按引用读取。 */
export function modelFrame(frame: BusinessFrame, currentTurnId: string, compactTurnArgs = false) {
  const current = frame.turnId === currentTurnId;
  return {frameId: frame.frameId, parentFrameId: frame.parentFrameId, capability: frame.capability,
    currentTurn: current, ...modelRecovery(frame),
    ...(frame.status === "draft" && frame.errorCode === "TEMPORARY_ERROR" ? {errorCode: frame.errorCode,
      retry_reference: {frameId: frame.frameId}, instruction: "服务暂时不可用，需重试时沿用此引用和原字段，不要求用户重述条件。"} : {}),
    status: frame.status, ...(compactTurnArgs ? {mode: frame.delta.executionMode} : {executionMode: frame.delta.executionMode}),
    resultRef: frame.resultRef, issues: compactTurnArgs ? frame.issues.map(issue => ({...issue,
      ...(typeof issue.message === "string" ? {message: turnArgumentHint(issue.message, true)} : {})})) : frame.issues,
    ...(!current && ["clarifying", "ready"].includes(frame.status) ? {continuation: {
      tool: "resolve_business_turn", ...(compactTurnArgs ? {base: {frameId: frame.frameId}} : {baseReference: {frameId: frame.frameId}}),
      unresolvedFields: frame.issues.map(issue => issue.field),
      instruction: turnArgumentHint("后续用户回合先解析本轮 Frame；未变化字段省略或 retain，不直接执行历史 frameId。", compactTurnArgs),
    }} : {}),
    ...(current && frame.status === "ready" ? {nextAction: frame.delta.executionMode === "execute"
      ? {tool: "execute_business_frame", arguments: {frameId: frame.frameId}}
      : {action: "conditions_saved"}} : {}),
    fields: Object.fromEntries(Object.entries(modelFields(frame.fields)).filter(([, field]) => field.resolutionStatus !== "missing")
      .map(([name, field]) => {
        const locked = lockedMentions(field);
        const additions = name === "organizations" ? unresolvedAdditions(field) : [];
        return [name, {rawValue: field.rawValue, value: field.resolvedValue,
          status: field.resolutionStatus,
          ...((field as {pendingChoices?: unknown}).pendingChoices ? {pendingChoices: (field as {pendingChoices?: unknown}).pendingChoices} : {}),
          ...(additions.length ? {unresolvedAdditions: additions} : {}),
          ...(locked.length ? {lockedMentions: locked} : {})}];
      }))};
}

/** 数量只描述可见历史快照，不据此选择目标；真正引用仍复核最新状态、目录和权限。 */
function historyFieldSourceFacts(visible: Array<{frame: BusinessFrame; ordinal: number}>, state: BusinessSessionState,
  currentTurnId: string, indexTruncated: boolean) {
  const schemas = new Map(createCapabilities().list().map(schema => [schema.capability, schema]));
  type Source = {frame: {frameId: string}; field: string; ordinal: number; capability: string; count: number; dynamicScope?: true};
  const groups = new Map<string, {sources: Source[]; identities: Set<string>; contracts: Set<string>; dynamic: boolean}>();
  for (const {frame, ordinal} of visible) {
    if (frame.sessionId !== state.sessionId || frame.turnId === currentTurnId
      || state.operations[frame.operationFrameId] !== frame.frameId || !state.frameOrder.includes(frame.operationFrameId)
      || !inheritableFrame(frame) || frame.status === "executing" || frame.issues.some(issue => issue.field === "$base")) continue;
    const schema = schemas.get(frame.capability);
    for (const [name, definition] of Object.entries(schema?.fields ?? {})) {
      if (!definition.requireTurnIntent || !definition.inheritable || !definition.turnIntentCollection) continue;
      const field = frame.fields[name];
      const value = field?.resolvedValue as Record<string, unknown> | undefined;
      const collection = value?.[definition.turnIntentCollection];
      if (field?.resolutionStatus !== "resolved" || !Array.isArray(collection) || !collection.length
        || !collection.every(item => typeof item === "string" && item.trim())) continue;
      const dynamic = !!value?.scope;
      const group = groups.get(name) ?? {sources: [], identities: new Set<string>(), contracts: new Set<string>(), dynamic: false};
      group.sources.push({frame: {frameId: frame.frameId}, field: name, ordinal, capability: frame.capability,
        count: collection.length, ...(dynamic ? {dynamicScope: true as const} : {})});
      group.contracts.add(`${definition.resolver}:${definition.turnIntentCollection}`);
      group.dynamic ||= dynamic;
      // 动态范围只有快照数量，不能把范围成员摘要为可供组合的固定集合。
      if (!dynamic) for (const identity of collection) group.identities.add(identity);
      groups.set(name, group);
    }
  }
  return {factsOnly: true, scope: "visible_history_entries", indexTruncated,
    fields: Object.fromEntries([...groups].map(([name, group]) => [name, {sources: group.sources,
      ...(!group.dynamic && group.contracts.size === 1 ? {staticUnion: {
        distinctCount: group.identities.size, sources: group.sources.map(({frame, field}) => ({frame, field})),
      }} : {}),
    }])),
    instruction: "这些来源与数量只描述可见历史快照，不指定本轮目标。结合用户语义选择 sources，不按数量凑选来源；来源唯一且未要求数量时无需额外澄清。indexTruncated 时可见并集不代表全部历史。引用仍须服务端复核状态、目录和权限；动态范围不能展开为固定名单合并。"};
}

/** 历史来源索引只给最近操作的条件与引用；更早记录按需分页，不读取结果或改动焦点。 */
export async function modelHistoryIndex(store: FrameStore, state: BusinessSessionState, currentTurnId: string, compactTurnArgs = false) {
  const frames = await store.list();
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  const operations = historicalOperations(state, frames, currentTurnId);
  const offset = Math.max(0, operations.length - 10);
  const indexes = operations.slice(offset).map((_, index) => offset + index);
  const entries = indexes.map(index => {
    const frame = byId.get(operations[index]!);
    if (!frame) return {ordinal: index + 1, unavailable: true};
    const view = modelFrame(frame, currentTurnId, compactTurnArgs);
    return {ordinal: index + 1, frameId: frame.frameId, capability: frame.capability,
      currentTurn: view.currentTurn, status: frame.status, fields: view.fields};
  });
  const focus = state.focusFrameId ? byId.get(state.focusFrameId) : undefined;
  const focusIndex = focus ? operations.indexOf(state.operations[focus.operationFrameId]!) : -1;
  const partial = entries.length < operations.length;
  const visible = indexes.flatMap(index => {
    const frame = byId.get(operations[index]!);
    return frame ? [{frame, ordinal: index + 1}] : [];
  });
  return {total: operations.length, latestOrdinal: operations.length || null, focusOrdinal: focusIndex < 0 ? null : focusIndex + 1,
    fieldSourceFacts: historyFieldSourceFacts(visible, state, currentTurnId, partial),
    entries, partial, currentTurnExcluded: true,
    usage: turnArgumentHint("索引以本轮开始前的业务操作为固定基准；ordinal 是稳定序号，relativePosition 相对最新历史操作，均不随焦点切换或本轮新操作变化。选定来源后不重新解释同一句指代。整笔业务用 baseReference 继承，其余字段可通过 sources 独立引用。转回历史业务即使暂不查询，也通过 business_context_read 的 selector/frameId 保存焦点再回答；后续普通续接用 baseReference=current。仅检查候选用 setFocus=false，分页不切焦点；索引不足时按 selector 或分页读取。", compactTurnArgs)};
}

/** 一次提供必要输入契约，避免模型为了构造参数反复读取完整历史和 Schema。 */
export function modelCapabilitySchemas(compactTurnArgs = false) {
  return createCapabilities().list().map(schema => ({capability: schema.capability,
    fields: Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, {
      label: field.label, required: field.required, inherit: field.inheritable,
      ...(field.requireTurnIntent ? {requireTurnIntent: true} : {}),
      ...(field.description ? {description: turnArgumentHint(field.description, compactTurnArgs)} : {}),
      ...(field.validation ? {validation: field.validation} : {}),
      ...(field.resolver === "date" ? {input: turnArgumentHint("未改变则省略或 retain；改变时保留本轮完整日期原文，省略年份由解析器处理", compactTurnArgs)} : {}),
      ...(field.resolver === "organization" ? {input: turnArgumentHint("按 description/inputSchema 区分本轮名称、范围对象和 fromHistory 字段来源。特定字段独立指代、数量要求或组合是字段变化，不能用空变化继承不同集合；整笔历史业务由 baseReference 明确定位且机构未变时可直接继承。expectedCount 是用户明确的完整机构数量，不是排名条数；确认仅绑定已保存候选。", compactTurnArgs)} : {}),
      ...(field.resolver === "metric" ? {input: turnArgumentHint("新指标使用本轮算法匹配清单，确认使用已保存候选；本轮 mentionIndexes 不跨轮复用，移除操作引用上一轮Frame清单。未变化则省略或 retain，详细形状见 description/inputSchema。", compactTurnArgs)} : {}),
      ...(modelFieldInputSchema(field) ? {inputSchema: modelFieldInputSchema(field)} : {}),
      ...(field.userClarification ? {userClarification: field.userClarification,
        clarificationInput: "正常业务值须有本轮表达、可信继承或Schema明确无损派生的依据，合法枚举或唯一合法值不代表用户选择。必要选择缺失时显式set {clarify:true,sourceText:本轮相关原文}，同次保存全部必要未决选择及其它条件，不给其它无依据字段试填正常值，由服务端提出声明的问题。不得填写问题或候选；有明确依据的参数错误自行纠正。"} : {}),
    }]))}));
}

/** 固定入口的上下文只描述职责和业务限制，参数形状唯一来自实际 function Schema。 */
export function modelFixedCapabilitySchemas() {
  return createCapabilities().list().map(schema => ({capability: schema.capability,
    fields: Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, {
      label: field.label, required: field.required, inheritable: field.inheritable,
      clearable: field.clearable, ...(field.requireTurnIntent ? {intentRequired: field.required ? "always" : "on_change"} : {}),
      ...(field.validation ? {validation: field.validation} : {}),
      ...(field.userClarification ? {clarificationRequiredWhenUnspecified: true} : {}),
    }]))}));
}

function fixedHint(text: string): string {
  return text.replaceAll("baseReference", "base").replaceAll("capabilityHint", "capability")
    .replaceAll("executionMode", "mode").replaceAll("fieldIntents", "changes 中的动作与依据")
    .replaceAll("fieldChanges", "changes").replaceAll("fieldHint", "字段名")
    .replaceAll("rawValue", "value").replaceAll("sourceText", "source_text").replaceAll("expectedCount", "expected_count")
    .replace(/\bretain\b/g, "inherit").replaceAll("{confirm:true}", "action=confirm");
}

/** 保存的恢复状态不改写；只把公开动作表达统一为固定入口术语。 */
function fixedRecovery(frame: BusinessFrame) {
  const recovery = modelRecovery(frame);
  if (!("pending_changes" in recovery)) return recovery;
  return {...recovery, pending_changes: recovery.pending_changes.map(({operation, may_retain, ...change}) => ({...change,
    action: operation === "retain" ? "inherit" : operation, inherit_allowed: change.inherit_allowed && may_retain}))};
}

export function modelFixedFrame(frame: BusinessFrame, currentTurnId: string) {
  const view = modelFrame(frame, currentTurnId) as ReturnType<typeof modelFrame> & {executionMode?: string; continuation?: unknown};
  const {executionMode: _mode, continuation: _continuation, ...rest} = view;
  return {...rest, ...fixedRecovery(frame), mode: frame.delta.executionMode,
    issues: frame.issues.map(issue => ({...issue, ...(typeof issue.message === "string" ? {message: fixedHint(issue.message)} : {}),
      ...(issue.correction ? {correction: fixedCorrection(issue.correction as unknown as Record<string, unknown>, frame.capability)} : {})})),
    ...(!view.currentTurn && ["clarifying", "ready"].includes(frame.status) ? {continuation: {
      tool: "resolve_business_turn", base: {frameId: frame.frameId}, unresolvedFields: frame.issues.map(issue => issue.field),
      instruction: "后续用户回合先解析本轮条件；未变字段继承，必需声明用 action=inherit，不直接执行历史 frameId。",
    }} : {})};
}

export async function modelFixedHistoryIndex(store: FrameStore, state: BusinessSessionState, currentTurnId: string) {
  const index = await modelHistoryIndex(store, state, currentTurnId);
  return {...index, usage: "序号以本轮开始前的历史业务操作为基准，不随焦点或本轮新操作改变。整笔来源用 base，字段独立来源用 history 的 sources。选定后续接用 base=current；只检查候选用 setFocus=false，转回历史业务用 business_context_read 保存焦点。"};
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixedFieldSchema(capability: unknown, field: unknown): unknown {
  if (typeof field !== "string") return undefined;
  const capabilities = createCapabilities().list();
  if (typeof capability === "string" && capabilities.some(schema => schema.capability === capability && schema.fields[field])) {
    return fixedFieldChangeSchema(capability, field);
  }
  const variants = capabilities.filter(schema => schema.fields[field]).map(schema => fixedFieldChangeSchema(schema.capability, field));
  return variants.length ? {anyOf: variants} : undefined;
}

function fixedCorrection(correction: Record<string, unknown>, capability: unknown): Record<string, unknown> {
  const {inputSchema: _oldSchema, ...rest} = correction;
  const inputSchema = fixedFieldSchema(capability, correction.field);
  return {...rest, ...(typeof correction.message === "string" ? {message: fixedHint(correction.message)} : {}), ...(inputSchema ? {inputSchema} : {})};
}

/** 仅投影已知回执控制位；用户原文、业务值、事实与查询证据保持原样，不递归改名。 */
export function projectFixedBusinessReceipt(value: unknown): unknown {
  if (!plain(value)) return value;
  const result = {...value};
  const capability = value.capability ?? (plain(value.frame) ? value.frame.capability : undefined);
  for (const [before, after] of [["capabilityHint", "capability"], ["baseReference", "base"], ["executionMode", "mode"]]) {
    if (Object.hasOwn(result, before!)) {result[after!] = result[before!]; delete result[before!];}
  }
  // 完整 Frame 的旧 delta 是审计记录，不能作为新模型参数示例重新发送。
  if (Object.hasOwn(result, "delta")) {
    if (plain(result.delta) && typeof result.delta.executionMode === "string") result.mode = result.delta.executionMode;
    delete result.delta;
  }
  if (plain(value.recovery) && typeof value.frameId === "string" && plain(value.fields) && Array.isArray(value.issues)) {
    Object.assign(result, fixedRecovery(value as unknown as BusinessFrame));
    delete result.recovery;
  }
  if (plain(value.frame)) result.frame = projectFixedBusinessReceipt(value.frame);
  if (Array.isArray(value.frames)) result.frames = value.frames.map(entry => plain(entry) && plain(entry.frame)
    ? {...entry, frame: projectFixedBusinessReceipt(entry.frame)} : entry);
  if (Array.isArray(value.schemas)) result.schemas = modelFixedCapabilitySchemas();
  if (Array.isArray(value.pending_changes)) result.pending_changes = value.pending_changes.map(change => {
    if (!plain(change)) return change;
    const {operation, may_retain, ...rest} = change;
    const action = operation ?? change.action;
    return {...rest, action: action === "retain" ? "inherit" : action,
      inherit_allowed: change.inherit_allowed === true && may_retain !== false};
  });
  if (typeof value.field === "string") result.field = fixedHint(value.field);
  for (const key of ["message", "reference_hint", "instruction"] as const) {
    if (typeof value[key] === "string" && (value.status === "ARGUMENT_ERROR" || value.error_code || value.retry_reference)) result[key] = fixedHint(value[key]);
  }
  if (Array.isArray(value.issues)) result.issues = value.issues.map(issue => plain(issue)
    ? {...issue, ...(typeof issue.message === "string" ? {message: fixedHint(issue.message)} : {}),
      ...(plain(issue.correction) ? {correction: fixedCorrection(issue.correction, capability)} : {})} : issue);
  if (Array.isArray(value.corrections)) result.corrections = value.corrections.map(correction => {
    if (!plain(correction)) return correction;
    return fixedCorrection(correction, capability);
  });
  if (plain(value.continuation)) result.continuation = projectFixedBusinessReceipt(value.continuation);
  return result;
}
