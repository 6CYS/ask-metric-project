import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { BusinessInputError } from "./inputError.js";
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

/** 多条件求交，绝不按相似度选来源；序号只计算业务操作，不计算执行状态快照。 */
export function resolveFrame(selector: FrameSelector, state: BusinessSessionState, frames: BusinessFrame[]): FrameResolution {
  const operations = state.frameOrder.filter(id => state.operations[id]).map(id => state.operations[id]!);
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
  for (const [name, definition] of Object.entries(schema.fields)) {
    const change = changes.get(name);
    const previous = base?.fields[name];
    const canInherit = !!base && base.status !== "failed" && definition.inheritable
      && (base.capability === schema.capability || !!definition.allowedSourceCapabilities?.includes(base.capability));
    if (change?.operation === "clear") {
      fields[name] = missingField();
      if (!definition.clearable) fields[name]!.resolutionStatus = "invalid";
    } else if (change?.operation === "set" || (canInherit && previous?.resolutionStatus === "temporary_error"
      && (!change || change.operation === "retain"))) {
      const retryInherited = change?.operation !== "set";
      const rawValue = retryInherited ? previous?.rawValue : change.rawValue;
      if (definition.inputSchema) {
        try {
          validateToolArguments({name: "field", description: "字段输入", parameters: Type.Object({raw: Type.Unsafe(definition.inputSchema)}, {additionalProperties: false})},
            {type: "toolCall", id: "field", name: "field", arguments: {raw: rawValue}});
        } catch {
          throw new BusinessInputError("FIELD_INPUT_SCHEMA_INVALID", name,
            `rawValue 未满足 inputSchema：${JSON.stringify(definition.inputSchema)}。${definition.description ?? ""}请修正调用，原焦点未改变。`);
        }
      }
      // 编码和值只能由注册的 Resolver 返回。异常不能变成 resolved。
      let resolution;
      try {
        resolution = await registry.getResolver(definition).resolve(rawValue, definition,
          {...context, inputSource: retryInherited ? "inherited" : "explicit", ...(previous ? {previous,
            previousTurnId: typeof previous.metadata?.candidateTurnId === "string" ? previous.metadata.candidateTurnId : base!.turnId} : {})});
      } catch (error) {
        if (!(error instanceof BusinessInputError)) throw error;
        inputErrors.push(new BusinessInputError(error.code, name, error.correction));
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
      if (change?.operation === "retain") fields[name]!.resolutionStatus = "invalid";
    }
  }
  // 一次返回本次 Delta 的全部原文错误，避免模型逐字段修复触发多轮请求；错误不落盘。
  if (inputErrors.length) throw new BusinessInputError(inputErrors[0]!.code,
    inputErrors.map(error => error.field).join(","), inputErrors.map(error => `${error.field}: ${error.correction}`).join("\n"));
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
      issues.push({field: name, reason: field.resolutionStatus});
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
