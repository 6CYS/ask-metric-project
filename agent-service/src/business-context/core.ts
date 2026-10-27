import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { BusinessInputError } from "./inputError.js";
import { clarificationOptions, selectOptions, type ReplyEvidence } from "./clarificationOptions.js";
import { hasInputEvidence } from "./inputEvidence.js";
import {withFieldClarification} from "./fieldClarification.js";
import type { BusinessFrame, BusinessSessionState, CapabilitySchema, ContextDelta, FieldResolver, FieldSchema, FrameResolution, FrameSelector, ResolvedField, ResolverContext, ValidationIssue } from "./types.js";

export class CapabilityRegistry {
  private readonly schemas = new Map<string, CapabilitySchema>();
  register(schema: CapabilitySchema): void {
    if (this.schemas.has(schema.capability)) throw new Error("CAPABILITY_ALREADY_REGISTERED");
    this.schemas.set(schema.capability, schema);
  }
  get(name: string): CapabilitySchema {
    const schema = this.schemas.get(name);
    if (!schema) throw new Error("CAPABILITY_NOT_FOUND");
    return schema;
  }
  list(): CapabilitySchema[] { return [...this.schemas.values()]; }
}
export class FieldResolverRegistry {
  private readonly resolvers = new Map<string, FieldResolver>();
  register(resolver: FieldResolver): void {
    if (this.resolvers.has(resolver.name)) throw new Error("RESOLVER_ALREADY_REGISTERED");
    this.resolvers.set(resolver.name, resolver);
  }
  getResolver(schema: FieldSchema): FieldResolver {
    const resolver = this.resolvers.get(schema.resolver);
    if (!resolver?.supports(schema)) throw new Error("RESOLVER_NOT_FOUND");
    return resolver;
  }
}
/** 范围失效只允许重解析原条件；其他失败仍不自动继承。 */
/** 执行未发生或被中断的失败不否定条件本身，用户说“再查一次”可直接继承重跑。 */
export const TRANSIENT_EXECUTION_FAILURES = new Set(["SCOPE_CHANGED", "NOT_SUBMITTED", "EXECUTION_INTERRUPTED", "QUERY_EXECUTION_INTERRUPTED"]);
export const inheritableFrame = (frame: BusinessFrame) => frame.status !== "failed" || TRANSIENT_EXECUTION_FAILURES.has(frame.errorCode ?? "");
export const missingField = (): ResolvedField => ({source: "explicit", resolutionStatus: "missing"});

function matchesConstraint(value: unknown, constraint: unknown): boolean {
  if (Array.isArray(value)) return Array.isArray(constraint)
    ? value.length === constraint.length && value.every((item, index) => matchesConstraint(item, constraint[index]))
    : value.some(item => matchesConstraint(item, constraint));
  if (constraint && typeof constraint === "object" && !Array.isArray(constraint)) {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && Object.entries(constraint).every(([key, expected]) => Object.hasOwn(value, key)
        && matchesConstraint((value as Record<string, unknown>)[key], expected));
  }
  return value === constraint;
}

/** 本轮新操作只更新焦点，不进入本轮的历史引用基准；下一用户回合才成为历史。 */
export function historicalOperations(state: BusinessSessionState, frames: BusinessFrame[], currentTurnId?: string): string[] {
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  return state.frameOrder.filter(id => state.operations[id]
    && (!currentTurnId || byId.get(id)?.turnId !== currentTurnId)).map(id => state.operations[id]!);
}

/** 多条件求交，绝不按相似度选来源；序号只计算业务操作，不计算执行状态快照。 */
export function resolveFrame(selector: FrameSelector, state: BusinessSessionState, frames: BusinessFrame[], currentTurnId?: string): FrameResolution {
  const operations = historicalOperations(state, frames, currentTurnId);
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  let candidates = selector.frameId ? frames.filter(frame => frame.frameId === selector.frameId)
    : operations.map(id => byId.get(id)).filter((frame): frame is BusinessFrame => !!frame);
  if (selector.frameId && selector.resultRequired) {
    candidates = candidates.map(frame => frame.resultRef ? frame : byId.get(state.operations[frame.operationFrameId] ?? frame.frameId))
      .filter((frame): frame is BusinessFrame => !!frame);
  }
  if (selector.ordinal !== undefined) {
    const id = operations[selector.ordinal - 1];
    candidates = candidates.filter(frame => frame.frameId === id);
  }
  if (selector.relativePosition !== undefined) {
    const id = operations[operations.length - 1 + selector.relativePosition];
    candidates = candidates.filter(frame => frame.frameId === id);
  }
  candidates = candidates.filter(frame => (!selector.capability || frame.capability === selector.capability)
    && (!selector.resultRequired || !!frame.resultRef)
    && Object.entries(selector.businessConstraints ?? {}).every(([name, constraint]) => {
      const field = frame.fields[name];
      return field?.resolutionStatus === "resolved" &&
        [field.rawValue, field.resolvedValue, field.code, field.metadata?.referenceValues].some(value => matchesConstraint(value, constraint));
    }));
  if (candidates.length === 1) return {status: "resolved", frameId: candidates[0]!.frameId};
  return candidates.length ? {status: "ambiguous", candidates: candidates.map(frame => frame.frameId)} : {status: "not_found"};
}

/** 能力字段的展示名称，按字段声明顺序；候选清单据此编号与分组。 */
export function fieldLabels(schema: CapabilitySchema): Record<string, string> {
  return Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, field.label]));
}

/** 已知缺少用户依据的恢复终态先于参数纠错；只使用唯一绑定的旧字段，不读取目录、不落盘。 */
export function preflightFieldRecovery(schema: CapabilitySchema, base: BusinessFrame, delta: ContextDelta,
  registry: FieldResolverRegistry, context: ResolverContext): void {
  for (const change of delta.fieldChanges) {
    const definition = schema.fields[change.fieldHint];
    const previous = base.fields[change.fieldHint];
    const intent = delta.fieldIntents?.[change.fieldHint];
    if (change.operation !== "set" || !definition || !previous || !definition.inheritable
      || context.requireFieldIntents && definition.requireTurnIntent && !intent
      || base.capability !== schema.capability && !definition.allowedSourceCapabilities?.includes(base.capability)) continue;
    try {
      registry.getResolver(definition).recoveryPreflight?.(change.rawValue, definition,
        {...context, fieldName: change.fieldHint, inputSource: "explicit", previous,
          previousTurnId: typeof previous.metadata?.candidateTurnId === "string" ? previous.metadata.candidateTurnId : base.turnId}, intent);
    } catch (error) {
      if (error instanceof BusinessInputError && error.recovery) {
        throw new BusinessInputError(error.code, change.fieldHint, error.correction, {frameId: base.frameId}, error.recovery, error.corrections, error.analysisDiagnostics);
      }
      throw error;
    }
  }
}

/** 必需目标每轮声明；可选目标仅在实际修改时强制声明，显式声明仍完整校验。 */
export function validateFieldIntents(schema: CapabilitySchema, delta: ContextDelta, context: ResolverContext): void {
  if (!context.requireFieldIntents && delta.fieldIntents === undefined) return;
  const intents = delta.fieldIntents;
  for (const [name, definition] of Object.entries(schema.fields)) {
    const changed = delta.fieldChanges.some(change => change.fieldHint === name && change.operation !== "retain");
    if (definition.requireTurnIntent && (definition.required || changed) && !intents?.[name]) throw new BusinessInputError("FIELD_INTENT_REQUIRED", name,
      `必须在fieldIntents声明${definition.label}本轮是inherit、set或confirm等操作，附sourceText和expectedCount；未重新指定用inherit/null/null。显式指代或数量要求必须set并落实来源，不能用空修改继承不同目标。原焦点未改变。`);
  }
  for (const [name, intent] of Object.entries(intents ?? {})) {
    const definition = schema.fields[name];
    if (!definition || !intent || typeof intent !== "object" || Array.isArray(intent)
      || Object.keys(intent).some(key => !["mode", "sourceText", "expectedCount"].includes(key))
      || !["inherit", "set", "confirm", "clear", "remove"].includes(intent.mode)
      || !(intent.expectedCount === null || Number.isInteger(intent.expectedCount) && intent.expectedCount > 0)) {
      throw new BusinessInputError("FIELD_INTENT_INVALID", name, "目标声明字段须属于当前能力Schema；非requireTurnIntent字段无需额外声明，当前能力没有声明要求时传{}，不复制来源能力的旧声明。检查mode、sourceText、expectedCount三键：expectedCount未指定数量时为null；inherit时sourceText和expectedCount均为null；修改或确认时sourceText取本轮相应原文。null须为真正的空值。原焦点未改变。");
    }
    const change = delta.fieldChanges.find(item => item.fieldHint === name);
    const raw = change?.rawValue;
    const confirming = raw && typeof raw === "object" && !Array.isArray(raw) && ("confirm" in raw || "candidateIndex" in raw);
    const mode = !change || change.operation === "retain" ? "inherit" : change.operation === "set" && confirming ? "confirm" : change.operation;
    if (mode !== intent.mode) throw new BusinessInputError("FIELD_INTENT_MODE_MISMATCH", name,
      "fieldIntents.mode必须与本轮字段修改一致：指代或组合用set并提交来源，候选确认用confirm，只有未重新指定才inherit。不能声明目标变化却省略字段修改。原焦点未改变。");
    if (intent.mode === "inherit") {
      if (intent.sourceText !== null || intent.expectedCount !== null) throw new BusinessInputError("FIELD_INTENT_INVALID", name,
        "inherit只表示本轮未重新指定该字段，sourceText和expectedCount必须为null；本轮指代或数量要求必须set并落实来源。原焦点未改变。");
    } else if (typeof intent.sourceText !== "string" || !hasInputEvidence(context.originalMessage, intent.sourceText)) {
      throw new BusinessInputError("FIELD_INTENT_EVIDENCE_INVALID", name, "目标声明sourceText必须是本轮表达该意图的原文片段，不能引用历史助手文字。原焦点未改变。");
    }
    if (intent.expectedCount !== null && (!definition.turnIntentCollection || intent.mode === "clear")) {
      throw new BusinessInputError("FIELD_INTENT_COUNT_UNSUPPORTED", name, "该字段或操作没有可计数的完整目标集合，不能提交数量约束。原焦点未改变。");
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "fromHistory" in raw && "expectedCount" in raw
      && (raw as {expectedCount: unknown}).expectedCount !== intent.expectedCount) {
      throw new BusinessInputError("FIELD_INTENT_COUNT_CONFLICT", name,
        "fieldIntents.expectedCount与历史引用expectedCount冲突，须按同一本轮目标声明一致数量，不得删除约束来绕过。原焦点未改变。");
    }
  }
}

function preservesTargetCount(change: ContextDelta["fieldChanges"][number] | undefined): boolean {
  if (!change || change.operation === "retain") return true;
  if (change.operation !== "set" || !change.rawValue || typeof change.rawValue !== "object" || Array.isArray(change.rawValue)) return false;
  const raw = change.rawValue as Record<string, unknown>;
  return "confirm" in raw || "candidateIndex" in raw || raw.fromHistory === true && raw.retainResolvedAdditions === true;
}

/** 数量针对完整解析集合，确认、继承和同组合续补保留已保存约束；只保留条件并澄清，不截断成员。 */
export function applyFieldIntentConstraints(schema: CapabilitySchema, fields: Record<string, ResolvedField>,
  delta: ContextDelta, base?: BusinessFrame): void {
  for (const [name, definition] of Object.entries(schema.fields)) {
    const field = fields[name];
    if (!field || !definition.turnIntentCollection) continue;
    const intent = delta.fieldIntents?.[name];
    const change = delta.fieldChanges.find(item => item.fieldHint === name);
    const continued = preservesTargetCount(change);
    const previousCount = continued ? base?.fields[name]?.metadata?.turnIntentExpectedCount : undefined;
    const savedCount = typeof previousCount === "number" && Number.isInteger(previousCount) && previousCount > 0 ? previousCount : undefined;
    if (savedCount !== undefined && intent?.expectedCount !== undefined && intent.expectedCount !== null && intent.expectedCount !== savedCount) {
      throw new BusinessInputError("FIELD_INTENT_COUNT_CONFLICT", name,
        `确认、继承或续补同一组合必须保留已保存的${savedCount}个${definition.label}数量约束，不能用本轮声明覆盖。用户明确更换完整目标时重新set完整字段；原焦点未改变。`);
    }
    const expectedCount = savedCount ?? intent?.expectedCount;
    if (typeof expectedCount !== "number" || !Number.isInteger(expectedCount) || expectedCount <= 0) continue;
    field.metadata = {...field.metadata, turnIntentExpectedCount: expectedCount};
    if (field.resolutionStatus !== "resolved") continue;
    const collection = (field.resolvedValue as Record<string, unknown> | undefined)?.[definition.turnIntentCollection];
    if (!Array.isArray(collection)) throw new Error("INVALID_RESOLVER_RESPONSE");
    if (collection.length !== expectedCount) {
      field.resolutionStatus = "not_found";
      field.metadata.referenceIssue = {code: "FIELD_INTENT_COUNT_MISMATCH", expectedCount, actualCount: collection.length,
        message: `本轮要求${expectedCount}个${definition.label}，当前完整集合有${collection.length}个；请明确需要的成员或历史来源。原条件已保留，未执行查询。`};
    }
  }
}

/** 确认意图只提供原文依据，不提供候选事实；无依据的语义声明属于可修复参数错误。 */
function confirmationAffirmation(raw: unknown, originalMessage: string, field: string): ReplyEvidence["affirmation"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("confirm" in raw) || !("evidence" in raw)) return undefined;
  const evidence = (raw as {evidence: unknown}).evidence;
  if ((raw as {confirm: unknown}).confirm !== true || !evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || Object.keys(evidence).some(key => !["decision", "sourceText"].includes(key))
    || (evidence as {decision?: unknown}).decision !== "accept"
    || typeof (evidence as {sourceText?: unknown}).sourceText !== "string"
    || !hasInputEvidence(originalMessage, (evidence as {sourceText: string}).sourceText)) {
    throw new BusinessInputError("CONFIRMATION_EVIDENCE_INVALID", field,
      "确认 evidence 必须是 {decision:'accept',sourceText:本轮表达同意的完整原文片段}；不截去否定或转折，不能用历史话语。没有明确同意依据时只保留待确认状态，原焦点未改变。");
  }
  return evidence as NonNullable<ReplyEvidence["affirmation"]>;
}

/** 主循环不认识指标/机构/日期；跨能力继承必须由目标字段显式许可。 */
export async function mergeFields(schema: CapabilitySchema, base: BusinessFrame | undefined, delta: ContextDelta,
  registry: FieldResolverRegistry, context: ResolverContext): Promise<{fields: Record<string, ResolvedField>; issues: ValidationIssue[]}> {
  const fields: Record<string, ResolvedField> = {};
  const issues: ValidationIssue[] = [];
  const inputErrors: BusinessInputError[] = [];
  const changes = new Map<string, ContextDelta["fieldChanges"][number]>();
  for (const change of delta.fieldChanges) {
    if (!Object.hasOwn(schema.fields, change.fieldHint) || changes.has(change.fieldHint)) {
      issues.push({field: change.fieldHint, reason: "invalid", message: "字段未声明或被重复修改"});
    } else changes.set(change.fieldHint, change);
  }
  // 待确认候选由系统按用户回复对应：清单与展示同源，模型只判断本轮在回答确认问题，不挑选候选。
  // 只对候选产生于更早回合的字段对应回复；同轮不能自造确认。
  const pending = base ? clarificationOptions(base, fieldLabels(schema)).filter(group =>
    (base.fields[group.field]?.metadata?.candidateTurnId ?? base.turnId) !== context.turnId) : [];
  const replyEvidence: ReplyEvidence = pending.length && context.replyEvidence
    ? await context.replyEvidence(base!.frameId) : {reply: context.originalMessage};
  const selected = pending.length ? selectOptions(pending, replyEvidence) : [];
  for (const [name, definition] of Object.entries(schema.fields)) {
    const explicit = changes.get(name);
    const affirmation = explicit?.operation === "set" ? confirmationAffirmation(explicit.rawValue, context.originalMessage, name) : undefined;
    // 语义同意只作用于本次显式确认的字段，不能顺带确认其它字段；候选内容仍取已保存清单。
    const chosen = affirmation ? selectOptions(pending.filter(group => group.field === name), {...replyEvidence, affirmation})
      : selected.filter(option => option.field === name);
    // 用户已明确选定候选而模型漏传该字段时，同样按确认处理。
    const change = chosen.length && (!explicit || explicit.operation === "retain")
      ? {fieldHint: name, operation: "set" as const, rawValue: {confirm: true}} : explicit;
    const previous = base?.fields[name];
    const canInherit = !!base && inheritableFrame(base) && definition.inheritable
      && (base.capability === schema.capability || !!definition.allowedSourceCapabilities?.includes(base.capability));
    if (change?.rawValue && typeof change.rawValue === "object" && !Array.isArray(change.rawValue) && "clarify" in change.rawValue) {
      const raw = change.rawValue as Record<string, unknown>;
      if (change.operation !== "set" || !definition.userClarification || raw.clarify !== true
        || Object.keys(raw).some(key => !["clarify", "sourceText"].includes(key))
        || typeof raw.sourceText !== "string" || !hasInputEvidence(context.originalMessage, raw.sourceText)) {
        throw new BusinessInputError("FIELD_CLARIFICATION_INVALID", name,
          "仅Schema声明允许的字段可在用户业务条件不足时set {clarify:true,sourceText:本轮相关原文}；不提供问题、候选或其它键，参数错误仍须按Schema修正。原焦点未改变。");
      }
      fields[name] = {rawValue: structuredClone(raw), source: "explicit", resolver: definition.resolver, resolutionStatus: "ambiguous",
        metadata: {userInputIssue: true, userClarificationQuestion: definition.userClarification.question}};
      continue;
    }
    if (change?.operation === "clear") {
      fields[name] = missingField();
      if (!definition.clearable) fields[name]!.resolutionStatus = "invalid";
    } else if (change?.operation === "set" || change?.operation === "remove" || (canInherit && (previous?.resolutionStatus === "temporary_error" || (base?.capability === schema.capability && previous?.metadata?.refreshOnInherit === true))
      && (!change || change.operation === "retain"))) {
      // remove 必须显式路由给声明支持的 Resolver；未声明的字段报参数错误，不能静默落入继承分支。
      const resolver = registry.getResolver(definition);
      if (change?.operation === "remove" && !resolver.removable) {
        inputErrors.push(new BusinessInputError("FIELD_REMOVE_NOT_SUPPORTED", name,
          "该字段不支持 remove；放弃整个字段用 clear，或重新提出新问题。原焦点未改变。"));
        continue;
      }
      const retryInherited = change?.operation !== "set" && change?.operation !== "remove";
      const rawValue = retryInherited ? previous?.rawValue : change.rawValue;
      if (definition.inputSchema) {
        try {
          validateToolArguments({name: "field", description: "字段输入", parameters: Type.Object({raw: Type.Unsafe(definition.inputSchema)}, {additionalProperties: false})},
            {type: "toolCall", id: "field", name: "field", arguments: {raw: rawValue}});
        } catch {
          const message = `rawValue 未满足 inputSchema：${JSON.stringify(definition.inputSchema)}。${definition.description ?? ""}请修正调用，原焦点未改变。`;
          throw new BusinessInputError("FIELD_INPUT_SCHEMA_INVALID", name,
            message, undefined, undefined, [withFieldClarification(definition, {field: name, reason: "invalid", message,
              inputSchema: definition.inputSchema, ...(definition.validation?.enum ? {allowedValues: definition.validation.enum} : {})})]);
        }
      }
      // 编码和值只能由注册的 Resolver 返回。异常不能变成 resolved。
      let resolution;
      try {
        resolution = await resolver.resolve(rawValue, definition,
          {...context, fieldName: name, inputSource: retryInherited ? "inherited" : "explicit", ...(change ? {fieldOperation: change.operation} : {}),
            ...(pending.some(group => group.field === name) ? {confirmation: {selected: chosen,
              options: pending.filter(group => group.field === name).flatMap(group => group.options)}} : {}), ...(previous ? {previous,
            previousTurnId: typeof previous.metadata?.candidateTurnId === "string" ? previous.metadata.candidateTurnId : base!.turnId} : {})});
      } catch (error) {
        if (!(error instanceof BusinessInputError)) throw error;
        const inputSchema = definition.inputSchema ?? (definition.validation?.enum ? {enum: definition.validation.enum} : undefined);
        const corrections = error.corrections?.length ? error.corrections : error.recovery || !inputSchema && !definition.validation?.enum ? undefined
          : [withFieldClarification(definition, {field: name, reason: "invalid" as const, message: error.correction,
            ...(definition.validation?.enum ? {allowedValues: definition.validation.enum} : {}),
            ...(inputSchema ? {inputSchema} : {})})];
        inputErrors.push(new BusinessInputError(error.code, name, error.correction, error.baseReference, error.recovery, corrections, error.analysisDiagnostics));
        continue;
      }
      fields[name] = {
        rawValue: resolution.metadata?.confirmedRawValues ?? resolution.metadata?.extractedRawValues ?? rawValue, resolvedValue: resolution.value,
        source: retryInherited ? "inherited" : resolution.metadata?.confirmed === true ? "confirmed" : "explicit",
        ...(base && (retryInherited || resolution.metadata?.confirmed) ? {sourceFrameId: base.frameId} : {}), resolver: definition.resolver, resolutionStatus: resolution.status,
        ...(resolution.code ? {code: resolution.code} : {}),
        ...(resolution.candidates ? {candidates: resolution.candidates} : {}),
        ...(resolution.metadata || resolution.candidates ? {metadata: {...resolution.metadata,
          ...(resolution.candidates ? {candidateTurnId: context.turnId} : {})}} : {}),
      };
      if (definition.confirmationRequired && resolution.status === "resolved") {
        // 确认要求一次新的用户回合，并与先前待确认值一致；LLM 不能传 confirmed 绕过。
        const confirmed = previous?.resolutionStatus === "needs_confirmation"
          && JSON.stringify(previous.resolvedValue) === JSON.stringify(resolution.value)
          && base?.turnId !== context.turnId;
        fields[name]!.resolutionStatus = confirmed ? "resolved" : "needs_confirmation";
        if (confirmed) fields[name]!.source = "confirmed";
      }
    } else if (canInherit && previous) {
      fields[name] = {...structuredClone(previous), source: "inherited", sourceFrameId: base!.frameId};
    } else {
      fields[name] = missingField();
      // 从未提供的条件仍是缺项；retain 不能把正常澄清升级成调用错误。
      if (change?.operation === "retain" && previous && previous.resolutionStatus !== "missing") fields[name]!.resolutionStatus = "invalid";
    }
  }
  // 一次返回本次 Delta 的全部原文错误，避免模型逐字段修复触发多轮请求；错误不落盘。
  if (inputErrors.length) {
    // 只要其中一项缺少用户证据，本轮参数重写就无法完成；优先交付这一恢复动作，全部字段均不落盘。
    const awaiting = inputErrors.find(error => error.recovery?.action === "ask_user");
    throw new BusinessInputError((awaiting ?? inputErrors[0]!).code,
      inputErrors.map(error => error.field).join(","), inputErrors.map(error => `${error.field}: ${error.correction}`).join("\n"),
      undefined, awaiting?.recovery, inputErrors.flatMap(error => error.corrections ?? []),
      inputErrors.flatMap(error => error.analysisDiagnostics ?? []));
  }
  // 结构错误先交回调用方，避免语义补全掩盖未声明或重复字段的诊断。
  if (!issues.length) await schema.completeFields?.(fields, delta, context, base);
  return {fields, issues};
}

/** 可选字段只允许缺省，已提供但不确定的可选条件同样阻止执行，防止静默扩大范围。 */
export function validateFrame(schema: CapabilitySchema, fields: Record<string, ResolvedField>, initial: ValidationIssue[] = []) {
  const issues = [...initial];
  for (const [name, definition] of Object.entries(schema.fields)) {
    const field = fields[name];
    if (!field || field.resolutionStatus === "missing") {
      if (definition.required) issues.push({field: name, reason: "missing"});
      continue;
    }
    if (field.resolutionStatus !== "resolved") {
      const referenceIssue = field.metadata?.referenceIssue as {message?: unknown} | undefined;
      const question = definition.userClarification && field.metadata?.userInputIssue === true
        && typeof field.metadata.userClarificationQuestion === "string" ? field.metadata.userClarificationQuestion : undefined;
      issues.push({field: name, reason: field.resolutionStatus,
        ...(question ? {message: question} : typeof referenceIssue?.message === "string" ? {message: referenceIssue.message} : {})});
      continue;
    }
    const value = field.resolvedValue;
    const validation = definition.validation;
    if (value === undefined || (validation?.enum && !validation.enum.includes(value))
      || (validation?.min !== undefined && (typeof value !== "number" || value < validation.min))
      || (validation?.max !== undefined && (typeof value !== "number" || value > validation.max))) {
      issues.push({field: name, reason: "invalid"});
    }
  }
  issues.push(...(schema.validate?.(fields) ?? []));
  return {status: issues.length ? "NEEDS_CLARIFICATION" as const : "READY" as const, issues};
}
