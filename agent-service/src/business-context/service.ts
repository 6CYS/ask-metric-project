import { createHash, randomUUID } from "node:crypto";
import { CapabilityRegistry, FieldResolverRegistry, mergeFields, resolveFrame, validateFrame } from "./core.js";
import type { BusinessFrame, ContextDelta, FrameStore, ResolverContext } from "./types.js";
import { BusinessInputError } from "./inputError.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const businessKey = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export interface TurnIdentity { sessionId: string; turnId: string; requestId: string }
export class BusinessContextService {
  constructor(readonly store: FrameStore, readonly capabilities: CapabilityRegistry, readonly resolvers: FieldResolverRegistry) {}
  async resolve(delta: ContextDelta, identity: TurnIdentity, context: ResolverContext): Promise<BusinessFrame> {
    const key = businessKey({phase: "resolve", ...identity, delta: {...delta, fieldChanges: [...delta.fieldChanges].sort((a, b) => a.fieldHint.localeCompare(b.fieldHint))}});
    const existing = await this.store.command(key);
    if (existing) return existing;
    const state = await this.store.state();
    let base: BusinessFrame | undefined;
    let referenceIssue: "ambiguous" | "not_found" | "invalid" | undefined;
    let candidates: string[] | undefined;
    if (delta.baseReference) {
      const resolution = resolveFrame(delta.baseReference, state, await this.store.list());
      if (resolution.status === "resolved") base = await this.store.get(resolution.frameId!);
      else { referenceIssue = resolution.status; candidates = resolution.candidates; }
    } else if (delta.baseReference !== null && state.focusFrameId) {
      const focus = await this.store.get(state.focusFrameId);
      const latest = focus ? await this.store.get(state.operations[focus.operationFrameId] ?? focus.frameId) : undefined;
      if (latest?.status === "failed" || latest?.status === "executing" || latest?.issues.some(issue => issue.field === "$base")) {
        referenceIssue = "invalid";
        base = latest; // 仅保留失败来源及能力用于澄清，下面门禁禁止合并其字段。
      }
      else base = focus;
    }
    if (delta.executionMode === "reuse_result" && delta.fieldChanges.length) {
      throw new BusinessInputError("RESULT_REUSE_HAS_CHANGES", "$result",
        "reuse_result 只回读历史结果，fieldChanges 必须为空数组，不清除或改写历史条件；用 baseReference 明确用户所指历史 Frame，原焦点未改变。");
    }
    // READY 是操作的解析快照；复用结果需定位同一操作的最终快照，不重查或修改旧 Frame。
    if (delta.executionMode === "reuse_result" && base && !base.resultRef) {
      const completed = await this.store.get(state.operations[base.operationFrameId] ?? base.frameId);
      if (completed?.status === "success" && completed.resultRef) base = completed;
    }
    if (base?.status === "failed" || base?.status === "executing") referenceIssue = "invalid";
    const capability = delta.capabilityHint ?? base?.capability ?? "";
    let schema;
    try { schema = this.capabilities.get(capability); } catch {
      throw new BusinessInputError("CAPABILITY_REQUIRED", "$capability", "无可继承能力时必须提供 capabilityHint，使用 business_context_read 中的能力名称；不要向用户询问内部能力名称。原焦点未改变。");
    }
    const id = randomUUID();
    const frame: BusinessFrame = {frameId: id, ...identity, capability, operationFrameId: id,
      ...(base ? {parentFrameId: base.frameId} : {}), fields: {}, delta: structuredClone(delta), issues: [],
      status: "clarifying", createdAt: new Date().toISOString()};
    if (referenceIssue) frame.issues.push({field: "$base", reason: referenceIssue,
      ...(candidates ? {message: JSON.stringify({candidates})} : {})});
    if (!schema) frame.issues.push({field: "$capability", reason: "not_found"});
    if (delta.executionMode === "reuse_result") {
      if (!base?.resultRef || base.status !== "success" || capability !== base.capability) frame.issues.push({field: "$result", reason: "invalid"});
      if (!frame.issues.length) {
        frame.fields = structuredClone(base!.fields);
        frame.status = "success";
        frame.resultRef = base!.resultRef!;
        if (base!.resultSummary) frame.resultSummary = structuredClone(base!.resultSummary);
      }
    } else if (schema && !referenceIssue) {
      const merged = await mergeFields(schema, base, delta, this.resolvers, context);
      if (merged.issues.length) throw new BusinessInputError("FIELD_CHANGES_INVALID", "$fields", "fieldChanges 含未声明或重复字段。请按目标能力 Schema 修正字段，不要切换业务目标来绕过错误；原焦点未改变。");
      frame.fields = merged.fields;
      const validation = validateFrame(schema, merged.fields, merged.issues);
      frame.issues.push(...validation.issues);
      frame.status = validation.status === "READY" ? "ready" : "clarifying";
    }
    const saved = await this.store.save(frame, state.version, key);
    this.trace(saved);
    return saved;
  }
  async beginExecution(frameId: string, identity: TurnIdentity): Promise<BusinessFrame> {
    const frame = await this.store.get(frameId);
    if (!frame || frame.sessionId !== identity.sessionId) throw new Error("FRAME_NOT_CURRENT_TURN");
    if (frame.turnId !== identity.turnId) throw new BusinessInputError("FRAME_NOT_CURRENT_TURN", "$frame",
      "不能直接执行上轮 Frame。用户确认继续已有查询时，调用 resolve_business_turn，沿用焦点或明确 baseReference，未变化字段省略（fieldChanges=[]），executionMode=execute，再执行返回的本轮 READY frameId。不要把确认话语当成新指标解析。原焦点未改变。");
    if (frame.status !== "ready" || frame.delta.executionMode !== "execute") throw new Error("FRAME_NOT_EXECUTABLE");
    if (validateFrame(this.capabilities.get(frame.capability), frame.fields, frame.issues).status !== "READY") throw new Error("FRAME_NOT_READY");
    const key = businessKey({phase: "execute", frameId});
    const previous = await this.store.command(key);
    if (previous) return previous;
    const state = await this.store.state();
    const executing: BusinessFrame = {...structuredClone(frame), frameId: randomUUID(), parentFrameId: frame.frameId,
      status: "executing", createdAt: new Date().toISOString()};
    const saved = await this.store.save(executing, state.version, key);
    this.trace(saved);
    return saved;
  }
  async finishExecution(executing: BusinessFrame, result: Pick<BusinessFrame, "status" | "resultRef" | "resultSummary" | "errorCode">): Promise<BusinessFrame> {
    const key = businessKey({phase: "finish", frameId: executing.frameId});
    const prior = await this.store.command(key);
    if (prior) return prior;
    const state = await this.store.state();
    const next: BusinessFrame = {...structuredClone(executing), ...result, frameId: randomUUID(),
      parentFrameId: executing.frameId, createdAt: new Date().toISOString()};
    // 网络执行期间若焦点已改变，只追加审计快照，旧请求不能夺回焦点。
    const saved = await this.store.save(next, state.version, key, state.focusFrameId === executing.frameId);
    this.trace(saved);
    return saved;
  }
  /** 任意执行阶段的引用均可定位同一操作的已完成结果；不跨操作猜测。 */
  async resultFrame(frameId: string): Promise<BusinessFrame | undefined> {
    const frame = await this.store.get(frameId);
    if (!frame || frame.resultRef) return frame;
    const state = await this.store.state();
    const completed = await this.store.get(state.operations[frame.operationFrameId] ?? frameId);
    return completed?.status === "success" && completed.resultRef ? completed : frame;
  }
  completed(executing: BusinessFrame) { return this.store.command(businessKey({phase: "finish", frameId: executing.frameId})); }
  private trace(frame: BusinessFrame): void {
    const declared = new Set(this.capabilities.list().flatMap(schema => Object.keys(schema.fields)));
    console.info(JSON.stringify({event: "business_frame", session_id: frame.sessionId, turn_id: frame.turnId,
      frame_id: frame.frameId, parent_frame_id: frame.parentFrameId, capability: frame.capability,
      status: frame.status, result_ref: frame.resultRef, issues: frame.issues.map(({field, reason}) => ({field: declared.has(field) || ["$base", "$capability", "$result"].includes(field) ? field : "$unknown", reason})),
      fields: Object.fromEntries(Object.entries(frame.fields).map(([name, field]) => [name,
        {source: field.source, source_frame_id: field.sourceFrameId, resolver: field.resolver, status: field.resolutionStatus}]))}));
  }
}
