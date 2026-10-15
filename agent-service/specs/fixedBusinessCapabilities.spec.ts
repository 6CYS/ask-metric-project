import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {BackendClient} from "../src/backendClient.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import type {BusinessFrame} from "../src/business-context/types.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeBusinessResultStore, NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../src/tools/testUtils.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks();});
async function fixture() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "fixed-capabilities-"));
  const sessions = new NativeSessionStore(dir), session = await sessions.create("synthetic-user");
  cleanup.push(async () => {await sessions.close(); rmSync(dir, {recursive: true, force: true});});
  const frames = new NativeFrameStore(session), commands = new MemoryCommandBridge();
  commands.conversationId = "synthetic-conversation";
  const availability = vi.fn(async (request: unknown) => ({status: "succeeded", request, mode: "metrics",
    org_names: ["合成机构"], items: [], groups: [], metric_count: 0, page: 1, page_size: 20, has_more: false, notice: "合成测试"}));
  const calculate = vi.fn(async () => ({status: "succeeded", calculation_id: "synthetic-calculation", results: [], inputs: {}, public_answer: "合成计算回执"}));
  const factId = "fact:synthetic-task:0:metric_value";
  const backend = {resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["O"], names: ["合成机构"]}})),
    dataAvailability: availability, calculate,
    getTaskResult: vi.fn(async () => ({status: "succeeded", task_id: "synthetic-task", result_id: "synthetic-result",
      facts: [{fact_id: factId}], truncated: false, rows: [], columns: [], row_count: 1, offset: 0, limit: 1, has_more: false})),
  } as unknown as BackendClient;
  const request = testRequestContext(backend, commands, {sessionId: session.metadata.id, frames,
    businessResults: new NativeBusinessResultStore(session), originalMessage: "查看合成机构有哪些指标有记录"});
  const tools = createAskMetricTools();
  const invoke = async (name: string, args: Record<string, unknown>, context = request) => {
    const tool = tools.find(item => item.name === name)! as AgentHarnessTool<AskMetricRequestContext>;
    const prepared = tool.prepareArguments?.(args) ?? args;
    const validated = validateToolArguments(tool, {type: "toolCall", id: "fixed-call", name, arguments: prepared as Record<string, unknown>});
    return runTool(tool, validated, context);
  };
  return {frames, request, invoke, availability, calculate, factId};
}

it("固定覆盖请求执行并复用不可变快照，重读不重复查覆盖", async () => {
  const f = await fixture();
  const resolved = receiptJson(await f.invoke("resolve_business_turn", {protocol_version: 1, capability: "data_availability",
    base: null, mode: "execute", changes: {
      organizations: {action: "set", source_text: "合成机构", expected_count: null, value: {kind: "name", name: "合成机构"}},
      dimension: {action: "set", value: "metrics"},
    }}));
  expect(resolved.status).toBe("READY");
  const executed = await f.invoke("execute_business_frame", {frameId: resolved.frameId});
  expect(executed.details.status).toBe("succeeded");
  expect(f.availability).toHaveBeenCalledExactlyOnceWith({dimension: "metrics", org_codes: ["O"]}, expect.any(Object));
  expect((await f.invoke("read_business_result", {frameId: executed.details.frame_id})).details.status).toBe("succeeded");
  expect(f.availability).toHaveBeenCalledTimes(1);
});

it("固定计算变量数组映射原事实引用，常量字符串精度及幂等保留", async () => {
  const f = await fixture();
  const source: BusinessFrame = {frameId: "prior-query", operationFrameId: "prior-query", sessionId: f.request.sessionId,
    requestId: "prior", turnId: "prior", capability: "metric_query", status: "success", fields: {}, issues: [],
    resultRef: "query:synthetic-task:synthetic-result", createdAt: "2026-10-14", delta: {executionMode: "execute", fieldChanges: []}};
  await f.frames.save(source, 0, "seed-prior-query");
  const precision = "1.00000000000000000001";
  const request = {...f.request, originalMessage: `使用刚才原值乘以${precision}`};
  const resolved = receiptJson(await f.invoke("resolve_business_turn", {protocol_version: 1, capability: "metric_calculate",
    base: null, mode: "execute", changes: {
      expressions: {action: "set", value: [{name: "product", label: "乘积", expression: "x*factor"}]},
      bindings: {action: "set", value: [{name: "x", fact_id: f.factId}]},
      constants: {action: "set", value: [{name: "factor", value: precision, source_text: precision}]},
    }}, request));
  expect(resolved.status).toBe("READY");
  const executed = await f.invoke("execute_business_frame", {frameId: resolved.frameId}, request);
  expect(executed.details.status).toBe("succeeded");
  expect(f.calculate).toHaveBeenCalledWith(expect.objectContaining({bindings: {x: {fact_id: f.factId}},
    constants: {factor: {value: precision, source_text: precision}}, conversation_id: "synthetic-conversation",
    source_policy: "conversation_snapshots", scope_id: request.operationId, user_question: request.originalMessage}), expect.any(String), expect.any(Object));
  await f.invoke("execute_business_frame", {frameId: resolved.frameId}, request);
  expect(f.calculate).toHaveBeenCalledTimes(1);
});
