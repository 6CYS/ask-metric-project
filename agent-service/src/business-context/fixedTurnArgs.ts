import {isDeepStrictEqual} from "node:util";
import {Type, validateToolArguments} from "@earendil-works/pi-ai";
import {createCapabilities} from "./capabilities.js";
import {BusinessInputError} from "./inputError.js";
import {fieldClarificationInputSchema} from "./fieldClarification.js";
import {toCompactTurnArgs, toContextDelta} from "./turnArgs.js";
import type {ContextDelta, FieldSchema, FieldTurnIntent, FrameSelector} from "./types.js";

type Schema = Record<string, unknown>;
type Action = "set" | "confirm" | "inherit" | "clear" | "remove" | "clarify";
interface Patch {action: Action; value?: unknown; source_text?: string; expected_count?: number | null; decision?: "select" | "accept"}
export interface FixedTurnArgs {protocol_version: 1; capability: string; base: FrameSelector | "current" | null;
  mode: ContextDelta["executionMode"]; changes: Record<string, Patch>}

const capabilities = createCapabilities();
const names = capabilities.list().map(item => item.capability);
const string = (maxLength = 200): Schema => ({type: "string", minLength: 1, maxLength});
const literal = (value: string | boolean | number): Schema => ({type: typeof value, const: value});
const enumeration = (values: unknown[]): Schema => ({type: typeof values[0], enum: values});
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({type: "object", properties, required, additionalProperties: false});
const array = (items: Schema, maxItems = 100, minItems = 1): Schema => ({type: "array", items, minItems, maxItems});
const count: Schema = {anyOf: [{type: "integer", minimum: 1}, {type: "null"}]};
const indices = array({type: "integer", minimum: 1});
indices.uniqueItems = true;
const selector = {...object({frameId: string(), ordinal: {type: "integer", minimum: 1}, relativePosition: {type: "integer", maximum: 0},
  capability: enumeration(names), resultRequired: {type: "boolean"}}, []), minProperties: 1};
export const fixedFrameSelectorSchema = selector;
const variable = {type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$"};

function organizationValue(capability: string, field: string): Schema {
  const sources = array(object({frame: selector, field: literal(field)}));
  // 模型按有权机构清单自主判断后的结论：编码或名称至少其一，excerpt 为用户原文片段（仅记录）。
  const suggestion = object({code: string(), name: string(), excerpt: string(2000)}, []);
  suggestion.minProperties = 1;
  const variants: Schema[] = [object({kind: literal("name"), name: string()}), object({kind: literal("names"), names: array(string())}),
    object({kind: literal("history"), combine: literal("single"), sources: {...sources, maxItems: 1}}),
    object({kind: literal("history"), combine: literal("union"), sources, add: array(string()), retainResolvedAdditions: literal(true),
      replaceAdditions: array(object({index: {type: "integer", minimum: 0}, value: string()}))}, ["kind", "combine", "sources"]),
    object({kind: literal("suggestion"), suggestion}),
  ];
  if (capability === "metric_query") variants.push(
    object({kind: literal("authorized_cohort"), cohort: literal("rural_commercial_banks")}),
    object({kind: literal("children_of"), parentName: string()}));
  return {oneOf: variants};
}

function normalValue(capability: string, name: string, field: FieldSchema): Schema {
  if (field.resolver === "organization") return organizationValue(capability, name);
  if (field.resolver === "metric") {
    // 名称与编码仍由完整原文匹配产生；公开入口不提供模型改写名称的旁路。
    return {oneOf: [object({fromQuestion: literal(true), mentionIndexes: indices}, ["fromQuestion"]), object({mentionIndexes: indices})]};
  }
  if (name === "bindings" || name === "constants") {
    const internal = field.inputSchema?.additionalProperties as {properties: Record<string, Schema>; required: string[]};
    const properties = structuredClone(internal.properties);
    // 对齐现有计算Resolver的结构上限；事实权限及常量原文依据仍留在原业务链核验。
    if (name === "bindings") properties.fact_id = string(180);
    else {properties.value = {type: "string", pattern: "^-?\\d{1,30}(\\.\\d{1,20})?$"}; properties.source_text = {type: "string", minLength: 1};}
    return array(object({name: variable, ...properties}, ["name", ...internal.required]), name === "constants" ? 20 : 100, name === "constants" ? 0 : 1);
  }
  if (field.inputSchema) return structuredClone(field.inputSchema);
  if (field.validation?.enum) return enumeration(field.validation.enum);
  if (field.resolver === "integer") return {type: "integer", minimum: field.validation?.min, maximum: field.validation?.max};
  if (field.resolver === "date") return string(2000);
  throw new Error(`FIXED_FIELD_SCHEMA_MISSING:${capability}:${name}`);
}

function patchSchema(capability: string, name: string, field: FieldSchema): Schema {
  const evidence = field.requireTurnIntent ? {source_text: string(2000), expected_count: count} : {};
  const normal = normalValue(capability, name, field);
  const variants = field.resolver === "organization" ? (normal.oneOf as Schema[]).map(value => {
    const kind = (value.properties as Record<string, Schema>).kind!.const;
    return object({action: literal("set"), ...evidence, source_text: string(kind === "name" || kind === "names" ? 2000 : 200), value});
  }) : [object({action: literal("set"), ...evidence, value: normal})];
  if (field.inheritable) variants.push(object({action: literal("inherit")}));
  if (field.clearable) variants.push(object({action: literal("clear"), ...evidence,
    ...(field.requireTurnIntent ? {expected_count: {type: "null"}} : {})}));
  if (field.resolver === "metric" || field.resolver === "organization") variants.push(object({action: literal("confirm"),
    source_text: string(2000), decision: enumeration(["select", "accept"]), ...(field.requireTurnIntent ? {expected_count: count} : {})}));
  if (field.resolver === "metric") variants.push(object({action: literal("remove"), value: object({mentionIndexes: indices})}));
  if (field.userClarification) variants.push(object({action: literal("clarify"), source_text: string(2000),
    ...(field.requireTurnIntent ? {expected_count: count} : {})}));
  return {oneOf: variants};
}

/** 恢复纠错与入口共用同一动作Schema，不将旧rawValue联合误投影成新value。 */
export function fixedFieldChangeSchema(capability: string, name: string): Schema {
  const schema = capabilities.get(capability), field = schema.fields[name];
  if (!field) invalid(name, "能力未声明该字段。");
  return patchSchema(capability, name, field);
}

const branches = capabilities.list().map(capability => {
  const fields = Object.fromEntries(Object.entries(capability.fields).map(([name, field]) => [name, patchSchema(capability.capability, name, field)]));
  // 每个能力分支独立闭合且使用同五个根键，不再叠加重复的全字段总集。
  return object({protocol_version: literal(1), capability: literal(capability.capability),
    base: {anyOf: [{type: "null"}, literal("current"), selector]}, mode: enumeration(["execute", "resolve_more", "reuse_result"]),
    changes: object(fields, Object.entries(capability.fields).filter(([, field]) => field.required && field.requireTurnIntent).map(([name]) => name))});
});

/** 真正发送给模型的固定参数；闭合联合由入口校验，不宣称网关启用了 constrained decoding。 */
export const fixedTurnParameters = Type.Unsafe<FixedTurnArgs>({type: "object",
  required: ["protocol_version", "capability", "base", "mode", "changes"], oneOf: branches});

function invalid(field: string, message: string): never {
  throw new BusinessInputError("FIXED_TURN_ARGUMENTS_INVALID", field, `${message}请按固定业务入口Schema修正；原条件未改变。`);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) invalid("$arguments", "参数必须是普通JSON对象。");
  return value as Record<string, unknown>;
}
function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object"
    && Array.isArray(before) === Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key =>
      changedPaths(left[key], right[key], path ? `${path}.${key}` : key)).slice(0, 6);
  }
  return [path || "$arguments"];
}
function validate(args: unknown): FixedTurnArgs {
  record(args);
  try {
    const validated = validateToolArguments({name: "resolve_business_turn", description: "固定业务入口", parameters: fixedTurnParameters},
      {type: "toolCall", id: "fixed-arguments", name: "resolve_business_turn", arguments: args as Record<string, unknown>});
    // Pi原生校验含宽松类型转换；固定入口拒绝转换前后不同，不能把0/false修成null或字符串修成数字。
    if (!isDeepStrictEqual(args, validated)) invalid("$arguments",
      `字段 ${changedPaths(args, validated).join("、")} 的类型或缺省值不符合Schema；固定入口不自动转换字段类型或补业务值。`);
  }
  catch (error) {
    if (error instanceof BusinessInputError) throw error;
    // 只返回Schema路径诊断；Pi原生异常后半段含Received arguments，不能复制完整输入。
    const issues = error instanceof Error ? error.message.split("\n\nReceived arguments:")[0]!.split("\n")
      .filter(line => /^\s*-\s/.test(line)).slice(0, 6).map(line => line.trim()) : [];
    invalid("$arguments", issues.length ? `固定入口字段校验失败：\n${issues.join("\n")}`
      : "必须提交protocol_version、capability、base、mode、changes；字段动作和值须满足对应能力的闭合Schema。");
  }
  return args as FixedTurnArgs;
}

function mapVariables(value: unknown, field: string): Record<string, unknown> {
  const rows = value as Array<{name: string} & Record<string, unknown>>;
  if (new Set(rows.map(item => item.name)).size !== rows.length) invalid(field, "同一字段的变量名不能重复。");
  return Object.fromEntries(rows.map(({name, ...entry}) => [name, entry]));
}
function organizationRaw(patch: Patch, field: string): unknown {
  const value = record(patch.value);
  if (value.kind === "name") return value.name;
  if (value.kind === "names") return structuredClone(value.names);
  if (value.kind === "suggestion") return {orgSuggestion: structuredClone(value.suggestion), sourceText: patch.source_text};
  if (value.kind === "history") {
    const {kind: _kind, ...rest} = value;
    if (rest.replaceAdditions && rest.retainResolvedAdditions !== true) invalid(field, "替换未决新增项必须声明保留同一历史组合。");
    const replacements = rest.replaceAdditions as Array<{index: number}> | undefined;
    if (replacements && new Set(replacements.map(item => item.index)).size !== replacements.length) invalid(field, "替换未决项的索引不能重复。");
    return {fromHistory: true, sourceText: patch.source_text, ...structuredClone(rest),
      ...(patch.expected_count !== null ? {expectedCount: patch.expected_count} : {})};
  }
  return {...structuredClone(value), sourceText: patch.source_text};
}

function validateInternal(field: FieldSchema, name: string, raw: unknown, clarify = false): void {
  const shape = clarify ? fieldClarificationInputSchema : field.inputSchema;
  if (!shape) return;
  try {
    const value = {raw};
    const checked = validateToolArguments({name: "fixed-field", description: "适配后的字段", parameters: Type.Object({raw: Type.Unsafe(shape)}, {additionalProperties: false})},
      {type: "toolCall", id: "fixed-field", name: "fixed-field", arguments: value});
    if (!isDeepStrictEqual(value, checked)) invalid(name, "适配后的字段类型不能自动转换。");
  } catch (error) {
    if (error instanceof BusinessInputError) throw error;
    invalid(name, "适配后的字段须满足现有能力inputSchema，不能绕过原字段结构限制。");
  }
}

/** 入口强制校验后才适配旧Delta；只改表达，不选择来源、默认业务值或执行工具。 */
export function fromFixedTurnArgs(args: unknown): ContextDelta {
  const input = validate(args), schema = capabilities.get(input.capability);
  const delta: ContextDelta = {capabilityHint: input.capability, baseReference: structuredClone(input.base), executionMode: input.mode,
    fieldChanges: [], fieldIntents: {}};
  for (const [name, patch] of Object.entries(input.changes)) {
    const field = schema.fields[name]!;
    if (field.requireTurnIntent || patch.action === "confirm" || patch.action === "inherit") delta.fieldIntents![name] = {
      mode: patch.action === "clarify" ? "set" : patch.action, sourceText: patch.action === "inherit" ? null : patch.source_text!,
      expectedCount: patch.action === "inherit" ? null : patch.expected_count ?? null,
    };
    if (patch.action === "inherit") continue;
    if (patch.action === "clear") {delta.fieldChanges.push({fieldHint: name, operation: "clear"}); continue;}
    if (patch.action === "confirm") {
      delta.fieldChanges.push({fieldHint: name, operation: "set", rawValue: {confirm: true,
        ...(patch.decision === "accept" ? {evidence: {decision: "accept", sourceText: patch.source_text}} : {})}});
      continue;
    }
    if (patch.action === "clarify") {
      delta.fieldChanges.push({fieldHint: name, operation: "set", rawValue: {clarify: true, sourceText: patch.source_text}}); continue;
    }
    const value = field.resolver === "organization" ? organizationRaw(patch, name)
      : name === "bindings" || name === "constants" ? mapVariables(patch.value, name) : structuredClone(patch.value);
    delta.fieldChanges.push({fieldHint: name, operation: patch.action === "remove" ? "remove" : "set", rawValue: value});
  }
  for (const change of delta.fieldChanges) if (change.operation !== "clear") {
    validateInternal(schema.fields[change.fieldHint]!, change.fieldHint, change.rawValue,
      !!change.rawValue && typeof change.rawValue === "object" && "clarify" in change.rawValue);
  }
  if (input.mode === "reuse_result" && delta.fieldChanges.length) invalid("$mode", "复用结果不能同时修改条件。");
  if (input.capability === "metric_calculate") {
    const variables = ["bindings", "constants"].flatMap(name => input.changes[name]?.action === "set"
      ? (input.changes[name]!.value as Array<{name: string}>).map(item => item.name) : []);
    if (new Set(variables).size !== variables.length) invalid("bindings,constants", "事实绑定与常量不能重复使用同一变量名。");
    const expressions = input.changes.expressions?.action === "set" ? input.changes.expressions.value as Array<{name: string}> : [];
    if (new Set(expressions.map(item => item.name)).size !== expressions.length) invalid("expressions", "表达式名称不能重复。");
  }
  return delta;
}

export function isFixedTurnArgs(args: unknown): args is FixedTurnArgs {
  try {fromFixedTurnArgs(args); return true;} catch {return false;}
}

function organizationProjection(raw: unknown, intent: FieldTurnIntent, field: string): unknown {
  if (typeof raw === "string") return {kind: "name", name: raw};
  if (Array.isArray(raw)) return {kind: "names", names: structuredClone(raw)};
  const value = record(raw);
  if (value.sourceText !== intent.sourceText) invalid(field, "旧来源原文与目标声明不一致，不能静默合并。");
  if (value.fromHistory === true) {
    if ((value.expectedCount ?? null) !== intent.expectedCount) invalid(field, "旧历史引用与目标声明数量不一致。");
    const {fromHistory: _fromHistory, sourceText: _sourceText, expectedCount: _expectedCount, ...rest} = value;
    return {kind: "history", ...structuredClone(rest)};
  }
  if (value.orgSuggestion !== undefined) {
    const {sourceText: _sourceText, orgSuggestion, ...rest} = value;
    if (Object.keys(rest).length) invalid(field, "旧机构建议含无法无损投影的附加键。");
    return {kind: "suggestion", suggestion: structuredClone(orgSuggestion)};
  }
  const {sourceText: _sourceText, ...rest} = value;
  return structuredClone(rest);
}
function comparable(delta: ContextDelta): unknown {
  return {...delta, fieldIntents: delta.fieldIntents ?? {}, fieldChanges: delta.fieldChanges.filter(item => item.operation !== "retain")
    .sort((a, b) => a.fieldHint.localeCompare(b.fieldHint))};
}

/** 仅能无损表达的历史参数可投影；缺来源、非法旧值或无法闭合的结构须保留旧记录而非修成新调用。 */
export function toFixedTurnArgs(delta: ContextDelta): FixedTurnArgs {
  const input = toContextDelta(delta);
  toCompactTurnArgs(input); // 提前拒绝undefined、非JSON值及带值的clear/retain。
  if (input.capabilityHint === undefined || !Object.hasOwn(input, "baseReference") || input.goal || input.purpose) {
    invalid("$arguments", "旧参数缺少明确能力/来源或包含无法无损投影的目标用途。");
  }
  let schema;
  try {schema = capabilities.get(input.capabilityHint);} catch {invalid("$capability", "旧能力不属于固定入口。");}
  const changes: Record<string, Patch> = {};
  for (const [name, intent] of Object.entries(input.fieldIntents ?? {})) if (intent.mode === "inherit") {
    if (intent.sourceText !== null || intent.expectedCount !== null) invalid(name, "inherit不能携带原文或数量。");
    changes[name] = {action: "inherit"};
  }
  for (const change of input.fieldChanges) {
    const field = schema.fields[change.fieldHint];
    if (!field) invalid(change.fieldHint, "旧字段未在能力Schema声明。");
    const intent = input.fieldIntents?.[change.fieldHint];
    if (field.requireTurnIntent && !intent) invalid(change.fieldHint, "旧参数缺少必需的目标声明。");
    const evidence = field.requireTurnIntent ? {source_text: intent!.sourceText as string, expected_count: intent!.expectedCount} : {};
    const raw = change.rawValue;
    let patch: Patch;
    if (change.operation === "retain") patch = {action: "inherit"};
    else if (change.operation === "clear") patch = {action: "clear", ...evidence};
    else if (change.operation === "remove") patch = {action: "remove", value: structuredClone(raw)};
    else if (raw && typeof raw === "object" && !Array.isArray(raw) && "confirm" in raw) {
      const value = record(raw), confirmation = value.evidence as {decision?: string; sourceText?: string} | undefined;
      const source = intent?.sourceText ?? confirmation?.sourceText;
      if (!source) invalid(change.fieldHint, "旧确认没有可追溯的本轮原文。");
      patch = {action: "confirm", ...evidence, source_text: source, decision: confirmation?.decision === "accept" ? "accept" : "select"};
    } else if (raw && typeof raw === "object" && !Array.isArray(raw) && "clarify" in raw) {
      patch = {action: "clarify", ...evidence, source_text: record(raw).sourceText as string};
    } else {
      const value = field.resolver === "organization" ? organizationProjection(raw, intent!, change.fieldHint)
        : change.fieldHint === "bindings" || change.fieldHint === "constants" ? Object.entries(record(raw)).map(([name, entry]) => ({name, ...record(entry)}))
          : structuredClone(raw);
      patch = {action: "set", ...evidence, value};
    }
    changes[change.fieldHint] = patch;
  }
  const output = {protocol_version: 1 as const, capability: input.capabilityHint, base: structuredClone(input.baseReference!), mode: input.executionMode, changes};
  const restored = fromFixedTurnArgs(output);
  if (!isDeepStrictEqual(comparable(input), comparable(restored))) invalid("$arguments", "旧参数不能在固定协议中无损表示，不能丢弃字段、意图或证据。");
  return output;
}
