import {inheritableFrame, resolveFrame} from "./core.js";
import {BusinessInputError} from "./inputError.js";
import {toContextDelta} from "./turnArgs.js";
import {hasInputEvidence, normalizeInputEvidence} from "./inputEvidence.js";
import type {BusinessFrame, BusinessSessionState, FieldCandidate, FieldResolution, FrameSelector, HistoryFieldReferenceInput,
  OrganizationScopeInput, ResolvedField, ResolvedOrganizations} from "./types.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

/** 与能力声明共用同一结构；未知键不能偷偷添加来源名称、编码或替换目标字段。 */
export const historyFieldReferenceSchema = {
  type: "object", required: ["fromHistory", "sourceText", "sources", "combine"],
  properties: {fromHistory: {const: true}, sourceText: {type: "string", minLength: 1, maxLength: 200},
    sources: {type: "array", minItems: 1, maxItems: 100, items: {type: "object", required: ["frame", "field"],
      properties: {field: {type: "string", minLength: 1}, frame: {type: "object", minProperties: 1, properties: {
        frameId: {type: "string", minLength: 1}, ordinal: {type: "integer", minimum: 1},
        relativePosition: {type: "integer", maximum: 0}, capability: {type: "string"},
        businessConstraints: {type: "object"}, resultRequired: {type: "boolean"},
      }, additionalProperties: false}}, additionalProperties: false}},
    combine: {enum: ["single", "union"]}, expectedCount: {type: "integer", minimum: 1},
    add: {type: "array", minItems: 1, maxItems: 100, items: {type: "string", minLength: 1, maxLength: 200}},
    retainResolvedAdditions: {const: true},
    replaceAdditions: {type: "array", minItems: 1, maxItems: 100, items: {type: "object", required: ["index", "value"],
      properties: {index: {type: "integer", minimum: 0}, value: {type: "string", minLength: 1, maxLength: 200}}, additionalProperties: false}}},
  additionalProperties: false,
};

function invalid(field: string, message: string): never {
  throw new BusinessInputError("HISTORY_REFERENCE_INVALID", field,
    `${message}请使用本会话历史索引中的明确 Frame／字段引用，不填写历史名称或编码，原焦点未改变。`);
}

function parseInput(raw: HistoryFieldReferenceInput, field: string, originalMessage: string, inherited: boolean): HistoryFieldReferenceInput {
  if (!object(raw) || !keys(raw, ["fromHistory", "sourceText", "sources", "combine", "expectedCount", "add", "retainResolvedAdditions", "replaceAdditions"])
    || raw.fromHistory !== true || typeof raw.sourceText !== "string" || !normalizeInputEvidence(raw.sourceText)
    || raw.sourceText.length > 200 || (!inherited && !hasInputEvidence(originalMessage, raw.sourceText))
    || !Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 100
    || !["single", "union"].includes(raw.combine)
    || (raw.expectedCount !== undefined && (!Number.isInteger(raw.expectedCount) || raw.expectedCount < 1))) {
    invalid(field, "历史引用结构无效或 sourceText 不在本轮原文中。");
  }
  if (raw.combine === "single" && raw.sources.length !== 1) invalid(field, "single 必须恰好引用一个来源。");
  if (raw.retainResolvedAdditions !== undefined && (raw.retainResolvedAdditions !== true || raw.combine !== "union")) {
    invalid(field, "retainResolvedAdditions 仅允许在 union 中显式保留同一组合的已解析新增项。");
  }
  if (raw.add !== undefined && (raw.combine !== "union" || !Array.isArray(raw.add) || !raw.add.length || raw.add.length > 100
    || !raw.add.every(value => typeof value === "string" && !!normalizeInputEvidence(value) && value.length <= 200
      && (inherited || hasInputEvidence(originalMessage, value))))) invalid(field, "add 仅用于 union，且每个新增名称必须来自本轮原文。");
  if (raw.replaceAdditions !== undefined && (raw.retainResolvedAdditions !== true || !Array.isArray(raw.replaceAdditions)
    || !raw.replaceAdditions.length || raw.replaceAdditions.length > 100
    || !raw.replaceAdditions.every(item => object(item) && keys(item, ["index", "value"]) && Number.isInteger(item.index)
      && item.index >= 0 && typeof item.value === "string" && !!normalizeInputEvidence(item.value) && item.value.length <= 200
      && (inherited || hasInputEvidence(originalMessage, item.value)))
    || new Set(raw.replaceAdditions.map(item => item.index)).size !== raw.replaceAdditions.length)) {
    invalid(field, "replaceAdditions 须配合 retainResolvedAdditions，引用不重复的未决项 index，value 保留本轮新名称原文。");
  }
  for (const source of raw.sources) {
    if (!object(source) || !keys(source, ["frame", "field"]) || source.field !== field || !object(source.frame)) {
      invalid(field, "来源字段必须与目标字段一致，不能跨字段替换业务含义。");
    }
    try { toContextDelta({baseReference: source.frame, executionMode: "resolve_more", fieldChanges: []}); }
    catch { invalid(field, "历史 Frame 选择器无效。"); }
  }
  return raw;
}

function organizations(value: unknown): value is ResolvedOrganizations {
  if (!object(value) || !Array.isArray(value.codes) || !value.codes.length || !Array.isArray(value.names)
    || value.codes.length !== value.names.length || new Set(value.codes).size !== value.codes.length
    || !value.codes.every(code => typeof code === "string" && code.trim())
    || !value.names.every(name => typeof name === "string" && name.trim())) return false;
  if (value.scope === undefined) return value.scope_fingerprint === undefined;
  return object(value.scope) && typeof value.scope_fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.scope_fingerprint)
    && (value.scope.kind === "authorized_cohort" ? value.scope.cohort === "rural_commercial_banks"
      : value.scope.kind === "children_of" && typeof value.scope.parent_code === "string" && !!value.scope.parent_code);
}

export interface HistoryReferenceContext {
  sessionId: string;
  turnId: string;
  originalMessage: string;
  inputSource?: "explicit" | "inherited";
  /** 仅接受字段合并入口绑定的上一字段，模型不能注入此对象。 */
  previous?: ResolvedField;
  state: BusinessSessionState;
  frames: BusinessFrame[];
  resolveCatalog(entity: string, values: string[]): Promise<FieldResolution>;
  resolveOrganizationScope?(input: OrganizationScopeInput): Promise<FieldResolution>;
}

/** 只读来源选择；集合组合不切焦点，编码须经当前授权目录逐项复核。 */
export async function resolveHistoryFieldReference(raw: HistoryFieldReferenceInput, targetField: string,
  context: HistoryReferenceContext): Promise<FieldResolution> {
  const input = parseInput(raw, targetField, context.originalMessage, context.inputSource === "inherited");
  if (targetField !== "organizations") invalid(targetField, "当前能力尚未声明该字段的历史组合契约。");
  if (context.state.sessionId !== context.sessionId) invalid(targetField, "会话状态不属于当前会话。");
  const byId = new Map(context.frames.map(frame => [frame.frameId, frame]));
  const sourceFrames: BusinessFrame[] = [];
  const canonicalSources: HistoryFieldReferenceInput["sources"] = [];
  const resolvedAdditions: ResolvedOrganizations = {codes: [], names: []};
  let canonicalInput = input;
  let additions = input.add;
  let expectedCount = input.expectedCount;
  const carryResolved = input.retainResolvedAdditions === true
    || context.inputSource === "inherited" && context.previous?.metadata?.referenceResolvedAdditions !== undefined;
  let retentionValidated = false;
  let pendingFacts: Record<string, unknown> = {};
  const metadata = () => ({referenceSource: "session_history", referenceSourceFrames: sourceFrames.map(frame => frame.frameId),
    referenceSessionId: context.sessionId, referenceField: targetField,
    referenceSourceOperations: sourceFrames.map(frame => frame.operationFrameId), historyReference: input, ...pendingFacts,
    ...(resolvedAdditions.codes.length ? {referenceResolvedAdditions: structuredClone(resolvedAdditions)} : {}),
    // 首次定位后固定精确来源，跨轮重试不能按相对位置重新选择自己刚保存的草稿。
    ...(canonicalSources.length === input.sources.length ? {confirmedRawValues: {...canonicalInput, sources: canonicalSources}} : {})});
  const unresolved = (code: string, message: string, details: Record<string, unknown> = {}, status: "not_found" | "ambiguous" | "temporary_error" = "not_found"): FieldResolution => {
    if ((input.retainResolvedAdditions || context.inputSource === "inherited") && !retentionValidated) {
      // 尚未完成同组合来源绑定时，不能保存半份提案覆盖原来的已确定项和候选。
      throw new BusinessInputError(code, targetField, message, undefined, {action: "ask_user", message});
    }
    return {status, metadata: {...metadata(), referenceIssue: {code, message, ...details}}};
  };
  const seen = new Set<string>();
  for (const source of input.sources) {
    const selector = source.frame as FrameSelector;
    const resolution = resolveFrame(selector, context.state, context.frames, context.turnId);
    if (resolution.status !== "resolved") {
      if (selector.frameId && !byId.has(selector.frameId)) invalid(targetField, "指定 Frame 不属于当前会话的可用历史。");
      return unresolved("HISTORY_SOURCE_NOT_UNIQUE", "历史来源无法唯一确定，请说明要引用哪次查询中的机构。",
        {sourceCandidates: resolution.candidates ?? []}, resolution.status);
    }
    const selected = byId.get(resolution.frameId!);
    const latestId = selected && context.state.operations[selected.operationFrameId];
    const latest = latestId ? byId.get(latestId) : undefined;
    if (!selected || selected.sessionId !== context.sessionId || selected.turnId === context.turnId
      || !latest || latest.sessionId !== context.sessionId || latest.turnId === context.turnId
      || latest.operationFrameId !== selected.operationFrameId
      || !context.state.frameOrder.includes(selected.operationFrameId)) invalid(targetField, "来源必须属于本会话更早的用户回合。");
    // 显式指定旧 READY 也要检查同操作最新状态；不能绕过在途或失败门禁。
    if (!inheritableFrame(latest) || latest.status === "executing" || latest.issues.some(issue => issue.field === "$base")) {
      return unresolved("HISTORY_SOURCE_UNAVAILABLE", "所选历史操作尚未完成或不可继承，请确认可用的来源后再继续。");
    }
    if (seen.has(latest.operationFrameId)) invalid(targetField, "同一历史业务操作被重复引用。");
    seen.add(latest.operationFrameId);
    canonicalSources.push({frame: {frameId: latest.frameId}, field: source.field});
    sourceFrames.push(latest);
    const field = latest.fields[targetField];
    if (field?.resolutionStatus !== "resolved" || !organizations(field.resolvedValue)) {
      return unresolved("HISTORY_FIELD_UNRESOLVED", "所选历史来源中的机构尚未确定，请先明确机构或选择已确定的来源。");
    }
  }
  const values = sourceFrames.map(frame => frame.fields[targetField]!.resolvedValue as ResolvedOrganizations);
  if (input.combine === "union" && values.some(value => value.scope)) {
    return unresolved("HISTORY_SCOPE_COMBINATION_UNSUPPORTED", "历史来源包含动态机构范围，请明确完整范围或具体机构后再组合，不能将范围静默展开为固定名单。");
  }
  if (carryResolved) {
    const previous = context.previous;
    const previousRaw = previous?.rawValue;
    const previousOperations = previous?.metadata?.referenceSourceOperations;
    const kept = previous?.metadata?.referenceResolvedAdditions;
    if (!previous || !object(previousRaw) || previousRaw.fromHistory !== true || previousRaw.combine !== "union"
      || previous.metadata?.referenceSessionId !== context.sessionId || previous.metadata?.referenceField !== targetField
      || !Array.isArray(previousOperations) || previousOperations.length !== seen.size
      || !previousOperations.every(operation => typeof operation === "string" && seen.has(operation))
      || new Set(previousOperations).size !== seen.size
      || (kept === undefined ? !(Array.isArray(previous.metadata?.referenceAdditionIssues) && previous.metadata.referenceAdditionIssues.length)
          && !(Array.isArray(previousRaw.add) && previousRaw.add.length)
        : !organizations(kept) || !!kept.scope)) {
      invalid(targetField, "没有可保留的同一会话、字段和历史来源组合中的已解析新增项。");
    }
    const previousCount = previousRaw.expectedCount ?? previous.metadata?.referenceExpectedCount ?? previous.metadata?.turnIntentExpectedCount;
    if (typeof previousCount === "number" && Number.isInteger(previousCount) && previousCount > 0) {
      if (expectedCount !== undefined && expectedCount !== previousCount) {
        invalid(targetField, "同一组合续补不能改写已保存的数量约束；明确改变完整目标须提交新的字段提案。");
      }
      expectedCount = previousCount;
      canonicalInput = {...canonicalInput, expectedCount};
    }
    if (context.inputSource !== "inherited") {
      // 兼容早期暂时失败草稿：完整可信 proposal 中的未决名称不能因缺少派生索引而被遗漏。
      const prefixCount = new Set(values.flatMap(value => value.codes)).size + (organizations(kept) ? kept.codes.length : 0);
      const canonicalPending = Array.isArray(previousRaw.add) ? previousRaw.add.filter((name): name is string => typeof name === "string"
        && !(organizations(kept) && kept.codes.includes(name))) : [];
      const pending = previous.metadata?.referenceAdditionIssues ?? canonicalPending.map((raw, offset) => ({index: prefixCount + offset, raw}));
      if (pending !== undefined && (!Array.isArray(pending) || !pending.every(item => object(item)
        && Number.isInteger(item.index) && (item.index as number) >= 0 && typeof item.raw === "string" && item.raw.trim()))) {
        invalid(targetField, "上一组合的未决项记录不完整，不能丢弃未知条件继续执行。");
      }
      const issues = (pending ?? []) as Array<{index: number; raw: string}>;
      const savedPending = previous.metadata?.pendingRawValues;
      if (new Set(issues.map(issue => issue.index)).size !== issues.length
        || Array.isArray(savedPending) && issues.some(issue => savedPending[issue.index] !== issue.raw)) {
        invalid(targetField, "上一组合的未决项索引与保存内容不一致，不能猜测要替换的条件。");
      }
      const replacements = new Map(input.replaceAdditions?.map(item => [item.index, item.value]));
      if ([...replacements.keys()].some(index => !issues.some(issue => issue.index === index))) {
        invalid(targetField, "replaceAdditions.index 不属于上一组合已保存的未决项，不能替换已确定项或其它 Frame 的条件。");
      }
      // add 只追加；修改已有未知项必须给出索引。未提及的未知项不能被一条新名称静默覆盖。
      additions = [...issues.map(issue => replacements.get(issue.index) ?? issue.raw), ...(input.add ?? [])];
      const {replaceAdditions: _replaced, add: _add, ...retained} = canonicalInput;
      canonicalInput = {...retained, ...(additions.length ? {add: additions} : {})};
    }
    if (organizations(kept)) {resolvedAdditions.codes.push(...kept.codes); resolvedAdditions.names.push(...kept.names);}
  }
  retentionValidated = true;
  // 授权复核也可能提前失败；先保存完整待处理提案，不能在下一用户回合丢失尚未查目录的项。
  if (additions?.length) {
    const historyCodes = [...new Set(values.flatMap(value => value.codes))];
    const unprocessed = additions.filter(name => context.inputSource !== "inherited" || !carryResolved || !resolvedAdditions.codes.includes(name));
    const previousIssues = carryResolved && Array.isArray(context.previous?.metadata?.referenceAdditionIssues)
      ? context.previous.metadata.referenceAdditionIssues : [];
    pendingFacts = {referenceHistoryCodes: historyCodes,
      pendingRawValues: [...historyCodes, ...resolvedAdditions.codes.map(code => [code]), ...unprocessed],
      referenceAdditionIssues: unprocessed.map((raw, offset) => {
        const prior = previousIssues.find(item => object(item) && item.raw === raw);
        return {index: historyCodes.length + resolvedAdditions.codes.length + offset, raw,
          status: object(prior) && ["not_found", "ambiguous", "needs_confirmation", "temporary_error", "invalid"].includes(String(prior.status))
            ? prior.status : "temporary_error"};
      }),
      ...(expectedCount !== undefined ? {referenceExpectedCount: expectedCount} : {})};
  }
  let result: ResolvedOrganizations;
  let scopeInput: OrganizationScopeInput | undefined;
  const scoped = values[0]!;
  if (scoped.scope) {
    if (!context.resolveOrganizationScope) return unresolved("HISTORY_SCOPE_UNAVAILABLE", "当前无法复核所选历史机构范围，请稍后再试。", {}, "temporary_error");
    const sourceRaw = sourceFrames[0]!.fields[targetField]!.rawValue;
    if (!object(sourceRaw) || sourceRaw.kind !== scoped.scope.kind || typeof sourceRaw.sourceText !== "string" || !sourceRaw.sourceText.trim()) {
      return unresolved("HISTORY_SCOPE_SOURCE_UNAVAILABLE", "历史机构范围缺少可复核的原始条件，请重新明确该范围。");
    }
    // 后端范围校验沿用已保存的集合原文，不把本轮指代伪装成新的集合表达。
    scopeInput = scoped.scope.kind === "authorized_cohort"
      ? {...scoped.scope, sourceText: sourceRaw.sourceText}
      : {kind: "children_of", parentName: scoped.scope.parent_code, sourceText: sourceRaw.sourceText};
    const refreshed = await context.resolveOrganizationScope(scopeInput);
    if (refreshed.status !== "resolved") return {...refreshed, metadata: {...refreshed.metadata, ...metadata()}};
    const refreshedScope = organizations(refreshed.value) ? refreshed.value.scope : undefined;
    if (!organizations(refreshed.value) || !refreshedScope || refreshedScope.kind !== scoped.scope.kind
      || (refreshedScope.kind === "authorized_cohort" ? scoped.scope.kind !== "authorized_cohort" || refreshedScope.cohort !== scoped.scope.cohort
        : scoped.scope.kind !== "children_of" || refreshedScope.parent_code !== scoped.scope.parent_code)) throw new Error("INVALID_RESOLVER_RESPONSE");
    result = refreshed.value;
  } else {
    result = {codes: [], names: []};
    for (const value of values) for (const [index, code] of value.codes.entries()) {
      if (!result.codes.includes(code)) {result.codes.push(code); result.names.push(value.names[index]!);}
    }
    const confirmedNames: string[] = [];
    for (const code of result.codes) {
      const checked = await context.resolveCatalog("organization", [code]);
      if (checked.status === "temporary_error") return unresolved("HISTORY_AUTHORIZATION_TEMPORARY", "当前机构目录暂时无法复核，原历史条件已保留。", {}, "temporary_error");
      if (checked.status !== "resolved" || !organizations(checked.value) || checked.value.scope
        || checked.value.codes.length !== 1 || checked.value.codes[0] !== code) {
        return unresolved("HISTORY_AUTHORIZATION_CHANGED", "所选历史机构无法通过当前目录或权限复核，请重新明确可查询机构。");
      }
      confirmedNames.push(checked.value.names[0]!);
    }
    result.names = confirmedNames;
  }
  const historyCodes = [...result.codes];
  const historyNames = [...result.names];
  if (carryResolved) {
    const kept = resolvedAdditions;
    // 保留动作只接受主循环绑定的可信字段快照；仍逐项复核当前目录与权限。
    for (const code of kept.codes) {
      const checked = await context.resolveCatalog("organization", [code]);
      if (checked.status === "temporary_error") return unresolved("HISTORY_AUTHORIZATION_TEMPORARY", "当前机构目录暂时无法复核，原历史条件已保留。", {}, "temporary_error");
      if (checked.status !== "resolved" || !organizations(checked.value) || checked.value.scope
        || checked.value.codes.length !== 1 || checked.value.codes[0] !== code) {
        return unresolved("HISTORY_AUTHORIZATION_CHANGED", "已确认的新增机构无法通过当前目录或权限复核，请重新明确可查询机构。");
      }
      resolvedAdditions.names[resolvedAdditions.codes.indexOf(code)] = checked.value.names[0]!;
      if (!result.codes.includes(code)) {result.codes.push(code); result.names.push(checked.value.names[0]!);}
    }
  }
  // 确认回调会展开整个 pending 集合；已显式保留的可信编码不再重复创建新增项。
  additions = additions?.filter(name => context.inputSource !== "inherited" || !carryResolved
    || !resolvedAdditions.codes.includes(name));
  if (additions?.length) {
    const pending: unknown[] = [...historyCodes, ...resolvedAdditions.codes.map(code => [code])];
    const extracted = [...historyNames, ...resolvedAdditions.names, ...additions];
    const candidates: FieldCandidate[] = [];
    const statuses: FieldResolution["status"][] = [];
    const additionIssues: Array<{index: number; raw: string; status: FieldResolution["status"]}> = [];
    const canonicalAdditions: string[] = [];
    for (const name of additions) {
      const pendingIndex = pending.length;
      const response = await context.resolveCatalog("organization", [name]);
      if (response.status === "resolved" && organizations(response.value) && !response.value.scope) {
        pending.push([...response.value.codes]);
        canonicalAdditions.push(...response.value.codes);
        for (const [codeIndex, code] of response.value.codes.entries()) {
          if (!resolvedAdditions.codes.includes(code)) {resolvedAdditions.codes.push(code); resolvedAdditions.names.push(response.value.names[codeIndex]!);}
          if (!result.codes.includes(code)) {result.codes.push(code); result.names.push(response.value.names[codeIndex]!);}
        }
      } else {
        pending.push(name);
        canonicalAdditions.push(name);
        const status = response.status === "resolved" ? "not_found" : response.status;
        statuses.push(status); additionIssues.push({index: pendingIndex, raw: name, status});
        // 候选仍是目录的单项编码，可复用既有跨轮确认；不构造没有执行语义的整组候选。
        candidates.push(...(response.candidates ?? []).map(candidate => ({...candidate,
          metadata: {...candidate.metadata, rawValueIndex: pendingIndex}})));
      }
    }
    // 规范化只作用于可信保存副本，确认/临时失败重试按正式编码复核已确定新增项。
    canonicalInput = {...canonicalInput, add: canonicalAdditions};
    pendingFacts = {};
    if (statuses.length) {
      const status = statuses.includes("temporary_error") ? "temporary_error" : candidates.length
        ? statuses.includes("ambiguous") ? "ambiguous" : "needs_confirmation" : "not_found";
      return {status, ...(candidates.length ? {candidates} : {}), metadata: {
        ...metadata(), referenceHistoryCodes: historyCodes,
        ...(expectedCount !== undefined ? {referenceExpectedCount: expectedCount} : {}),
        pendingRawValues: pending, extractedRawValues: extracted, referenceAdditionIssues: additionIssues,
        referenceIssue: {code: "HISTORY_ADDITION_UNRESOLVED", message: "历史机构已保留，新增机构尚未确定，请补充或选择目录候选后再继续。"}}};
    }
  }
  pendingFacts = {};
  if (expectedCount !== undefined && result.codes.length !== expectedCount) {
    return unresolved("HISTORY_REFERENCE_COUNT_MISMATCH", "指代数量与所选历史机构集合不一致，请明确希望包含的机构或历史来源。",
      {expectedCount, actualCount: result.codes.length});
  }
  return {status: "resolved", value: result, metadata: {...metadata(), referenceValues: [...result.codes, ...result.names],
    // 供现有范围继承路径重验权限；不表示用户完成候选确认，原结构化引用仍保留作来源证据。
    ...(scopeInput ? {refreshOnInherit: true, confirmedRawValues: scopeInput, historyReference: input} : {})}};
}
