import { BACKGROUND_CONTEXT, setValue, value, type Session } from "@earendil-works/pi-agent-core";
import type { BusinessFrame, BusinessSessionState, FrameStore } from "./types.js";

const NS = "askmetric.business.v1";
const stateAddress = value<BusinessSessionState>(NS, "state");
const frameAddress = (id: string) => value<BusinessFrame>(NS, `frame/${id}`);
const commandAddress = (id: string) => value<string>(NS, `command/${id}`);
export class ContextConflict extends Error {
  constructor() { super("BUSINESS_CONTEXT_CONFLICT"); }
}
/** Pi Session 的事务屏障保证同进程并发串行；部署沿用数据根单写锁。 */
export class NativeFrameStore implements FrameStore {
  constructor(private readonly session: Session) {}
  private empty(): BusinessSessionState {
    return {sessionId: this.session.metadata.id, version: 0, frameOrder: [], operations: {}};
  }
  async state(): Promise<BusinessSessionState> {
    return structuredClone((await this.session.getValue(stateAddress, BACKGROUND_CONTEXT))?.value ?? this.empty());
  }
  async get(id: string): Promise<BusinessFrame | undefined> {
    return structuredClone((await this.session.getValue(frameAddress(id), BACKGROUND_CONTEXT))?.value);
  }
  async list(): Promise<BusinessFrame[]> {
    const state = await this.state();
    const frames = await Promise.all(state.frameOrder.map(id => this.get(id)));
    return frames.filter((frame): frame is BusinessFrame => !!frame);
  }
  async command(key: string): Promise<BusinessFrame | undefined> {
    const saved = await this.session.getValue(commandAddress(key), BACKGROUND_CONTEXT);
    return saved ? this.get(saved.value) : undefined;
  }
  async save(frame: BusinessFrame, expectedVersion: number, commandKey: string, focus = true): Promise<BusinessFrame> {
    return this.session.mutate(async (tx, context) => {
      const existing = await tx.getValue(commandAddress(commandKey), context);
      if (existing) {
        const stored = await tx.getValue(frameAddress(existing.value), context);
        if (!stored) throw new Error("FRAME_STORE_CORRUPT");
        return structuredClone(stored.value);
      }
      const state = (await tx.getValue(stateAddress, context))?.value ?? this.empty();
      if (state.version !== expectedVersion) throw new ContextConflict();
      if (frame.sessionId !== state.sessionId || await tx.getValue(frameAddress(frame.frameId), context)) throw new Error("FRAME_IMMUTABLE");
      if (frame.parentFrameId && !await tx.getValue(frameAddress(frame.parentFrameId), context)) throw new Error("FRAME_PARENT_NOT_FOUND");
      const next: BusinessSessionState = {...state, version: state.version + 1,
        frameOrder: [...state.frameOrder, frame.frameId], operations: {...state.operations, [frame.operationFrameId]: frame.frameId},
        ...(focus && frame.status !== "failed" ? {focusFrameId: frame.frameId} : {})};
      // Frame、序号、焦点和幂等引用一次提交，崩溃不能留下半份状态。
      await tx.commit([setValue(frameAddress(frame.frameId), frame), setValue(stateAddress, next),
        setValue(commandAddress(commandKey), frame.frameId)], context);
      return structuredClone(frame);
    }, BACKGROUND_CONTEXT);
  }
  async setFocus(frameId: string, expectedVersion: number): Promise<void> {
    await this.session.mutate(async (tx, context) => {
      const state = (await tx.getValue(stateAddress, context))?.value ?? this.empty();
      const frame = (await tx.getValue(frameAddress(frameId), context))?.value;
      if (!frame || frame.status === "failed") throw new Error("INVALID_FOCUS_FRAME");
      if (state.version !== expectedVersion) throw new ContextConflict();
      await tx.commit([setValue(stateAddress, {...state, version: state.version + 1, focusFrameId: frameId})], context);
    }, BACKGROUND_CONTEXT);
  }
}

/** 非取数工具结果与 Frame 分离持久化；模型只看到引用，正文按需读取。 */
export class NativeBusinessResultStore {
  constructor(private readonly session: Session) {}
  async save(ref: string, result: import("@earendil-works/pi-agent-core").AgentToolResult<unknown>): Promise<void> {
    await this.session.mutate(async (tx, context) => {
      const address = value<import("@earendil-works/pi-agent-core").AgentToolResult<unknown>>(NS, `result/${ref}`);
      if (await tx.getValue(address, context)) return;
      await tx.commit([setValue(address, result)], context);
    }, BACKGROUND_CONTEXT);
  }
  async get(ref: string) {
    return structuredClone((await this.session.getValue(value<import("@earendil-works/pi-agent-core").AgentToolResult<unknown>>(NS, `result/${ref}`), BACKGROUND_CONTEXT))?.value);
  }
}
