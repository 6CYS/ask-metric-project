import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT, value, type AgentHarnessToolInvocation, type OpenOperation} from "@earendil-works/pi-agent-core";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {FixedTurnCompatibility} from "../src/fixedTurnCompatibility.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {createFixedResolveBusinessTurnTool} from "../src/tools/businessContext.js";
import {BusinessContextService} from "../src/business-context/service.js";
import {toCompactTurnArgs, toContextDelta} from "../src/business-context/turnArgs.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import type {BusinessFrame} from "../src/business-context/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!();});
const delta = {capabilityHint: "metric_query", baseReference: "current" as const, executionMode: "execute" as const,
  fieldIntents: {organizations: {mode: "inherit" as const, sourceText: null, expectedCount: null}}, fieldChanges: [
    {fieldHint: "metrics", operation: "retain" as const}, {fieldHint: "time", operation: "set" as const, rawValue: "4月末"}]};

async function setup(compact: boolean, options: {protocol?: string; status?: string; operationId?: string} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fixed-legacy-pending-"));
  const store = new NativeSessionStore(dir), session = await store.create("synthetic-user");
  cleanup.push(async () => {await store.close(); rmSync(dir, {recursive: true, force: true});});
  const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
  const args = compact ? toCompactTurnArgs(delta) : delta;
  const source = await branch.appendMessage({role: "assistant", timestamp: 1,
    content: [{type: "toolCall", id: "old-call", name: "resolve_business_turn", arguments: args}]} as import("@earendil-works/pi-agent-core").AgentMessage, BACKGROUND_CONTEXT);
  await session.setValue(value("askmetric", "operation/old-op"), "old-request", BACKGROUND_CONTEXT);
  await session.setValue(value("askmetric", "request/old-request"), {operationId: options.operationId ?? "old-op",
    ...(options.protocol ? {toolProtocol: options.protocol} : {})}, BACKGROUND_CONTEXT);
  await session.setValue(value("pi.op.state", "old-op"), {at: "tools", batch: {assistantEntryId: source,
    calls: [{sourceIndex: 0, status: options.status ?? "planned"}]}}, BACKGROUND_CONTEXT);
  const compatibility = new FixedTurnCompatibility();
  await compatibility.capture(session, [{lane: "main", kind: "run", operationId: "old-op"} as OpenOperation]);
  const tool = compatibility.wrap(createFixedResolveBusinessTurnTool());
  const request = {operationId: "old-op", sessionId: session.metadata.id, requestId: "old-request", originalMessage: "4月末",
    frames: {}, backend: {}} as AskMetricRequestContext;
  const invocation = {operationId: "old-op"} as AgentHarnessToolInvocation;
  const prepared = () => validateToolArguments(tool, {type: "toolCall", id: "old-call", name: tool.name,
    arguments: tool.prepareArguments!(structuredClone(args)) as Record<string, unknown>});
  return {session, compatibility, tool, args, request, invocation, prepared};
}

describe.each([false, true])("已保存旧在途调用桥接 compact=%s", compact => {
  it("原操作和callId执行原Delta一次，retain及幂等身份不经固定格式重写", async () => {
    const f = await setup(compact);
    const frame = {frameId: "f", operationFrameId: "f", sessionId: f.request.sessionId, requestId: "old-request", turnId: "old-op",
      capability: "metric_query", status: "clarifying", createdAt: "2026-01-01", fields: {}, issues: [], delta} as BusinessFrame;
    const resolve = vi.spyOn(BusinessContextService.prototype, "resolve").mockResolvedValue(frame);
    await f.tool.execute("old-call", f.prepared(), () => {}, f.request, f.invocation, BACKGROUND_CONTEXT);
    expect(resolve).toHaveBeenCalledTimes(1); expect(resolve.mock.calls[0]?.[0]).toEqual(toContextDelta(f.args));
    expect(resolve.mock.calls[0]?.[0].fieldChanges).toContainEqual({fieldHint: "metrics", operation: "retain"});
    await expect(f.tool.execute("old-call", f.args, () => {}, f.request, f.invocation, BACKGROUND_CONTEXT)).rejects.toThrow("LEGACY_TURN_NOT_TRUSTED");
    const entry = (await f.session.findEntries({type: "message"}, BACKGROUND_CONTEXT))[0];
    expect(entry?.type === "message" && entry.message.role === "assistant" && entry.message.content[0]).toMatchObject({arguments: f.args});
  });

  it.each(["callId", "requestOperation", "invocationOperation", "arguments"])("精确原参数仍不能越过%s绑定", async mismatch => {
    const f = await setup(compact), prepared = f.prepared();
    const request = mismatch === "requestOperation" ? {...f.request, operationId: "new-op"} : f.request;
    const invocation = mismatch === "invocationOperation" ? {...f.invocation, operationId: "new-op"} : f.invocation;
    const args = mismatch === "arguments" ? {...prepared, injected: true} : prepared;
    await expect(f.tool.execute(mismatch === "callId" ? "new-call" : "old-call", args, () => {}, request, invocation,
      BACKGROUND_CONTEXT)).rejects.toThrow("LEGACY_TURN_NOT_TRUSTED");
  });

  it.each([{protocol: "fixed_v1"}, {status: "effect_pending"}, {status: "completed"}, {operationId: "foreign-op"}])(
    "新操作/未知副作用/已完成/错关联不授予旧格式许可：%j", async options => {
      const f = await setup(compact, options);
      expect(() => f.prepared()).toThrow("FIXED_TURN_ARGUMENTS_REQUIRED");
    });

  it("下一模型请求关闭旧白名单，参数指纹不能继续授权旧格式", async () => {
    const f = await setup(compact);
    expect(f.prepared()).toEqual(f.args);
    f.compatibility.close();
    expect(() => f.prepared()).toThrow("FIXED_TURN_ARGUMENTS_REQUIRED");
  });
});
