import { BusinessInputError } from "./inputError.js";
import type { ContextDelta, FieldChange, FieldTurnIntent, FrameSelector } from "./types.js";

const operations = ["set", "remove", "clear", "retain"] as const;
const modes = ["execute", "resolve_more", "reuse_result"] as const;
const legacyKeys = ["capabilityHint", "baseReference", "executionMode", "fieldChanges"];
const compactKeys = ["capability", "base", "mode", ...operations];
const sharedKeys = ["goal", "purpose", "fieldIntents"];

function invalid(field: string, message: string, code = "FIELD_CHANGES_INVALID"): never {
  throw new BusinessInputError(code, field, `${message}请修正调用参数，原焦点未改变。`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    invalid(field, "参数必须是对象。");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(field, "参数含未知键或混合了两种参数格式。");
}

function baseReference(value: unknown): FrameSelector | "current" | null {
  if (value === null || value === "current") return value;
  const selector = record(value, "$base");
  const allowed = ["frameId", "ordinal", "relativePosition", "capability", "businessConstraints", "resultRequired"];
  if (!Object.keys(selector).length || Object.keys(selector).some(key => !allowed.includes(key))) {
    invalid("$base", "历史来源选择器必须包含已声明的选择条件。", "FRAME_SELECTOR_INVALID");
  }
  for (const [key, entry] of Object.entries(selector)) {
    const valid = key === "frameId" ? typeof entry === "string" && entry.length > 0
      : key === "ordinal" ? typeof entry === "number" && Number.isInteger(entry) && entry >= 1
      : key === "relativePosition" ? typeof entry === "number" && Number.isInteger(entry) && entry <= 0
      : key === "capability" ? typeof entry === "string"
      : key === "resultRequired" ? typeof entry === "boolean"
      : entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && [Object.prototype, null].includes(Object.getPrototypeOf(entry) as object | null);
    if (!valid) invalid("$base", "历史来源选择条件结构无效。", "FRAME_SELECTOR_INVALID");
  }
  return {...selector} as FrameSelector;
}

function fieldName(value: unknown): string {
  if (typeof value !== "string" || !value.length) invalid("$fields", "字段名必须是非空字符串。");
  return value;
}

/** 精简格式会被发送为 JSON；无法原样传输的旧值必须拒绝转换，而不能消失或补成 null。 */
function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  ancestors.add(value);
  const valid = array
    ? value.length === Object.keys(value).length && Array.from(value).every(entry => jsonValue(entry, ancestors))
    : Object.values(value).every(entry => jsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function sharedArgs(args: Record<string, unknown>, delta: ContextDelta): void {
  if (Object.hasOwn(args, "fieldIntents")) {
    const intents = record(args.fieldIntents, "$fieldIntents");
    if (Object.keys(intents).length > 32) invalid("$fieldIntents", "目标声明最多32个字段。", "FIELD_INTENT_INVALID");
    delta.fieldIntents = Object.fromEntries(Object.entries(intents).map(([field, raw]) => {
      fieldName(field);
      const intent = record(raw, field);
      onlyKeys(intent, ["mode", "sourceText", "expectedCount"], field);
      if (!["inherit", "set", "confirm", "clear", "remove"].includes(intent.mode as string)
        || !(intent.sourceText === null || typeof intent.sourceText === "string" && !!intent.sourceText.trim())
        || !(intent.expectedCount === null || typeof intent.expectedCount === "number" && Number.isInteger(intent.expectedCount) && intent.expectedCount > 0)) {
        invalid(field, "目标声明须包含有效mode、sourceText和expectedCount，未指定数量用null。", "FIELD_INTENT_INVALID");
      }
      return [field, {...intent} as unknown as FieldTurnIntent];
    }));
  }
  if (Object.hasOwn(args, "purpose")) {
    if (args.purpose !== "goal" && args.purpose !== "supporting") invalid("$purpose", "业务用途无效。");
    delta.purpose = args.purpose;
  }
  if (Object.hasOwn(args, "goal")) {
    const goal = record(args.goal, "$goal");
    onlyKeys(goal, ["capability", "sourceText"], "$goal");
    if (typeof goal.capability !== "string" || typeof goal.sourceText !== "string") invalid("$goal", "业务目标结构无效。");
    delta.goal = {capability: goal.capability, sourceText: goal.sourceText};
  }
}

/** 新旧格式仅改表达；来源省略、null、current 和历史选择器保持各自语义。 */
export function toContextDelta(args: unknown): ContextDelta {
  const input = record(args, "$arguments");
  const legacy = legacyKeys.some(key => Object.hasOwn(input, key));
  const compact = compactKeys.some(key => Object.hasOwn(input, key));
  if (legacy === compact) invalid("$arguments", "无法识别唯一的参数格式。");
  onlyKeys(input, [...(legacy ? legacyKeys : compactKeys), ...sharedKeys], "$arguments");
  const mode = input[legacy ? "executionMode" : "mode"];
  if (typeof mode !== "string" || !modes.includes(mode as ContextDelta["executionMode"])) invalid("$mode", "执行方式必须为已声明的枚举。");
  const delta: ContextDelta = {executionMode: mode as ContextDelta["executionMode"], fieldChanges: []};
  const capabilityKey = legacy ? "capabilityHint" : "capability";
  if (Object.hasOwn(input, capabilityKey)) {
    const capability = input[capabilityKey];
    if (typeof capability !== "string") invalid("$capability", "业务能力必须是字符串。");
    delta.capabilityHint = capability;
  }
  const baseKey = legacy ? "baseReference" : "base";
  if (Object.hasOwn(input, baseKey)) delta.baseReference = baseReference(input[baseKey]);
  sharedArgs(input, delta);
  const seen = new Set<string>();
  const add = (change: FieldChange) => {
    if (seen.has(change.fieldHint)) invalid("$fields", "同一字段不能出现多次或属于多个修改分组。");
    seen.add(change.fieldHint);
    if (seen.size > 32) invalid("$fields", "一次调用最多修改32个字段。");
    delta.fieldChanges.push(change);
  };
  if (legacy) {
    if (!Array.isArray(input.fieldChanges)) invalid("$fields", "字段修改必须是数组。");
    for (const value of input.fieldChanges) {
      const change = record(value, "$fields");
      onlyKeys(change, ["fieldHint", "operation", "rawValue"], "$fields");
      if (!operations.includes(change.operation as FieldChange["operation"])) invalid("$fields", "字段操作无效。");
      add({fieldHint: fieldName(change.fieldHint), operation: change.operation as FieldChange["operation"],
        ...(Object.hasOwn(change, "rawValue") ? {rawValue: change.rawValue} : {})});
    }
  } else {
    for (const operation of operations) {
      if (!Object.hasOwn(input, operation)) continue;
      const group = input[operation];
      if (operation === "clear" || operation === "retain") {
        if (!Array.isArray(group)) invalid("$fields", "清除和保留分组必须是字段名数组。");
        for (const name of group) add({fieldHint: fieldName(name), operation});
      } else {
        for (const [name, rawValue] of Object.entries(record(group, "$fields"))) add({fieldHint: fieldName(name), operation, rawValue});
      }
    }
  }
  return delta;
}

/** 发送副本使用精简分组；不改原始 Delta 或原生会话记录。 */
export function toCompactTurnArgs(delta: ContextDelta): Record<string, unknown> {
  const value = toContextDelta(delta);
  const args: Record<string, unknown> = {
    ...(Object.hasOwn(value, "capabilityHint") ? {capability: value.capabilityHint} : {}),
    ...(Object.hasOwn(value, "baseReference") ? {base: value.baseReference} : {}),
    mode: value.executionMode,
    ...(Object.hasOwn(value, "goal") ? {goal: value.goal} : {}),
    ...(Object.hasOwn(value, "purpose") ? {purpose: value.purpose} : {}),
    ...(Object.hasOwn(value, "fieldIntents") ? {fieldIntents: value.fieldIntents} : {}),
  };
  for (const operation of operations) {
    const changes = value.fieldChanges.filter(change => change.operation === operation);
    if (!changes.length) continue;
    if (changes.some(change => operation === "clear" || operation === "retain"
      ? Object.hasOwn(change, "rawValue")
      : !Object.hasOwn(change, "rawValue") || !jsonValue(change.rawValue))) {
      invalid("$fields", "字段操作的原始值无法无损转换为精简分组。");
    }
    args[operation] = operation === "clear" || operation === "retain"
      ? changes.map(change => change.fieldHint)
      : Object.fromEntries(changes.map(change => [change.fieldHint, change.rawValue]));
  }
  if (!jsonValue(args)) invalid("$arguments", "参数无法无损转换为JSON发送副本。");
  return args;
}

/** 回滚发送副本保留可选键和原始值，不补猜能力或来源。 */
export function toLegacyTurnArgs(delta: ContextDelta): Record<string, unknown> {
  return {...toContextDelta(delta)};
}
