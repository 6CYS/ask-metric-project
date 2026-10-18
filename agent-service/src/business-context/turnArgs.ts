import { BusinessInputError } from "./inputError.js";
import type { ContextDelta, FieldChange, FieldTurnIntent, FrameSelector } from "./types.js";

const operations = ["set", "remove", "clear", "retain"] as const;
const modes = ["execute", "resolve_more", "reuse_result"] as const;
const legacyKeys = ["capabilityHint", "baseReference", "executionMode", "fieldChanges"];
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

/** 内部 Delta 记录的唯一结构；来源省略、null、current 和历史选择器保持各自语义。 */
export function toContextDelta(args: unknown): ContextDelta {
  const input = record(args, "$arguments");
  if (!legacyKeys.some(key => Object.hasOwn(input, key))) invalid("$arguments", "无法识别参数格式。");
  onlyKeys(input, [...legacyKeys, ...sharedKeys], "$arguments");
  const mode = input.executionMode;
  if (typeof mode !== "string" || !modes.includes(mode as ContextDelta["executionMode"])) invalid("$mode", "执行方式必须为已声明的枚举。");
  const delta: ContextDelta = {executionMode: mode as ContextDelta["executionMode"], fieldChanges: []};
  if (Object.hasOwn(input, "capabilityHint")) {
    const capability = input.capabilityHint;
    if (typeof capability !== "string") invalid("$capability", "业务能力必须是字符串。");
    delta.capabilityHint = capability;
  }
  if (Object.hasOwn(input, "baseReference")) delta.baseReference = baseReference(input.baseReference);
  sharedArgs(input, delta);
  const seen = new Set<string>();
  const add = (change: FieldChange) => {
    if (seen.has(change.fieldHint)) invalid("$fields", "同一字段不能出现多次。");
    seen.add(change.fieldHint);
    if (seen.size > 32) invalid("$fields", "一次调用最多修改32个字段。");
    delta.fieldChanges.push(change);
  };
  if (!Array.isArray(input.fieldChanges)) invalid("$fields", "字段修改必须是数组。");
  for (const value of input.fieldChanges) {
    const change = record(value, "$fields");
    onlyKeys(change, ["fieldHint", "operation", "rawValue"], "$fields");
    if (!operations.includes(change.operation as FieldChange["operation"])) invalid("$fields", "字段操作无效。");
    add({fieldHint: fieldName(change.fieldHint), operation: change.operation as FieldChange["operation"],
      ...(Object.hasOwn(change, "rawValue") ? {rawValue: change.rawValue} : {})});
  }
  return delta;
}
