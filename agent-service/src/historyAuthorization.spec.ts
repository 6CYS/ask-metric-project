import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {BackendApiError, type BackendClient} from "./backendClient.js";
import type {AgentServiceConfig} from "./config.js";
import type {HarnessHost} from "./harnessHost.js";
import type {NativeSessionStore} from "./nativeSessions.js";
import {authorizeHistory, createApp, createHistoryAuthorizer} from "./routes.js";
import type {ProjectedMessage} from "./sessionProjection.js";

const cleanup: string[] = [];
afterEach(() => {vi.unstubAllGlobals(); for (const path of cleanup.splice(0)) rmSync(path, {recursive: true, force: true});});
const SECRET = "sensitive-fact-123";
const USER = {id: "u", username: "synthetic", org_code: "A", role_code: "USER"};
const headers = {Authorization: "Bearer synthetic"};
const resultDetails = {kind: "metric_query_structured", status: "succeeded", task_id: "t",
  rows: [{org_code: "B", metric_value: SECRET}], public_answer: SECRET};
const toolMessage = (details: unknown): ProjectedMessage => ({role: "tool", tool: "execute_business_frame",
  tool_call_id: "call", entry_id: "entry", timestamp: 1, is_error: false, details});

function fixture({revoked = false, legacy = false, readOnly = false, details = resultDetails}: {
  revoked?: boolean; legacy?: boolean; readOnly?: boolean; details?: Record<string, unknown>;
} = {}) {
  const path = mkdtempSync(join(tmpdir(), "history-auth-")); cleanup.push(path);
  const messages = [
    {role: "user", content: "合成查询", businessProtocol: "frame_v1", timestamp: 1},
    {role: "toolResult", toolName: "execute_business_frame", toolCallId: "call", details,
      content: [{type: "text", text: SECRET}], timestamp: 2},
    {role: "assistant", content: [{type: "text", text: SECRET}], timestamp: 3},
  ];
  const entries = messages.map((message, index) => ({id: String(index), type: "message", message}));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/api/v1/auth/me")) return Response.json(USER);
    if (url.endsWith("/api/v1/query-tasks/t")) return revoked
      ? Response.json({code: "ORG_SCOPE_FORBIDDEN", message: "失权"}, {status: 403})
      : Response.json({task_id: "t", status: "SUCCEEDED", result: {result_id: "result:t"}});
    return Response.json({message: "unexpected"}, {status: 500});
  }));
  const hosted = {sessionId: "s", createdAt: 1, open: [],
    ...(readOnly ? {readOnlyReason: "LEGACY_QUERY_REQUIRES_NEW_TURN"} : {}),
    lane: {findEntries: vi.fn(async () => entries), inspectExecution: vi.fn(async () => ({current: null}))},
    session: {getName: vi.fn(async () => "合成会话")},
  };
  const host = {openSession: vi.fn(async () => legacy ? undefined : hosted),
    watch: vi.fn(async () => ({snapshot: {transcript: entries, operation: null}, unsubscribe: vi.fn(), start: vi.fn()})),
    admitPrompt: vi.fn(), resumeOpenOperations: vi.fn(),
  };
  if (legacy) writeFileSync(join(path, "s.json"), JSON.stringify({
    id: "s", userId: "u", username: "synthetic", title: "历史", createdAt: 1, lastActiveAt: 2, messages,
  }));
  const app = createApp({dataDir: path, backendBaseUrl: "http://backend.test", backendTimeoutMs: 1000} as AgentServiceConfig,
    host as unknown as HarnessHost, {} as NativeSessionStore);
  return {app, host, calls, path, entries};
}

it.each([false, true])("原生会话刷新/重连失权时不返回缓存正文或行，旧协议只读=%s", async readOnly => {
  const f = fixture({revoked: true, readOnly});
  for (const suffix of ["", "/stream"]) {
    const response = await f.app.request(`/sessions/s${suffix}`, {headers});
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("HISTORY_PERMISSION_DENIED"); expect(body).not.toContain(SECRET);
  }
  expect(f.calls.filter(url => url.endsWith("query-tasks/t"))).toHaveLength(2);
  expect(f.host.watch).not.toHaveBeenCalled();
});

it("失权历史不能通过提新问题进入模型或accepted快照", async () => {
  const f = fixture({revoked: true});
  const response = await f.app.request("/sessions/s/prompt", {method: "POST",
    headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify({protocol_version: 3, request_id: "r", message: "继续"})});
  expect(response.status).toBe(403); expect(await response.text()).not.toContain(SECRET);
  expect(f.host.admitPrompt).not.toHaveBeenCalled();
});

it.each([false, true])("仍有权限的原生会话能正常刷新/重连，旧协议只读=%s", async readOnly => {
  const f = fixture({readOnly});
  const detail = await f.app.request("/sessions/s", {headers});
  expect(detail.status).toBe(200); expect(await detail.text()).toContain(SECRET);
  const stream = await f.app.request("/sessions/s/stream", {headers});
  expect(stream.status).toBe(200); expect(await stream.text()).toContain(SECRET);
  expect(f.calls.every(url => url.endsWith("auth/me") || url.endsWith("query-tasks/t"))).toBe(true);
});

it.each([false, true])("旧JSON历史按相同后端任务复核；失权=%s", async revoked => {
  const f = fixture({legacy: true, revoked});
  const response = await f.app.request("/sessions/s", {headers});
  expect(response.status).toBe(revoked ? 403 : 200);
  expect((await response.text()).includes(SECRET)).toBe(!revoked);
});

it("成功结果无持久化任务引用时不猜权限", async () => {
  const f = fixture({details: {kind: "metric_query_structured", status: "succeeded", rows: [{metric_value: SECRET}]}});
  const response = await f.app.request("/sessions/s", {headers});
  expect(response.status).toBe(409); expect(await response.text()).not.toContain(SECRET);
});

it("覆盖历史复用只查权限目录且拒绝裁剪后集合", async () => {
  const backend = {resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["A"]}}))};
  await expect(authorizeHistory([toolMessage({kind: "data_availability", status: "succeeded",
    request: {org_codes: ["A", "B"]}})], backend as unknown as BackendClient)).rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.resolveBusinessField).toHaveBeenCalledWith("organization", ["A", "B"]);
});

it("计算结果复核每个来源任务而不重算", async () => {
  const backend = {getTask: vi.fn(async (id: string) => {
    if (id === "revoked") throw new BackendApiError(403, "失权");
    return {task_id: id, status: "SUCCEEDED"};
  })};
  await expect(authorizeHistory([toolMessage({kind: "metric_calculate", status: "succeeded",
    inputs: {a: {task_id: "allowed"}, b: {task_id: "revoked"}}})], backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.getTask).toHaveBeenCalledTimes(2);
});

it.each([false, true])("带用户常量的正常计算仅复核事实来源；来源失权=%s", async revoked => {
  const backend = {getTask: vi.fn(async () => {
    if (revoked) throw new BackendApiError(403, "失权");
    return {task_id: "source", status: "SUCCEEDED"};
  })};
  const checked = authorizeHistory([toolMessage({kind: "metric_calculate", status: "succeeded",
    inputs: {a: {task_id: "source"}, b: {kind: "user_constant", value: "10", source_text: "10"}}})],
    backend as unknown as BackendClient);
  if (revoked) await expect(checked).rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  else await expect(checked).resolves.toBeUndefined();
  expect(backend.getTask).toHaveBeenCalledExactlyOnceWith("source");
});

it("没有业务结果的历史不要求查询引用", async () => {
  const backend = {getTask: vi.fn()};
  await authorizeHistory([{role: "user", text: "你好", timestamp: 1, entry_id: "u"},
    toolMessage({kind: "business_context", status: "NEEDS_CLARIFICATION"})], backend as unknown as BackendClient);
  expect(backend.getTask).not.toHaveBeenCalled();
});

it("同一轮复核去重：任务与机构范围只请求一次，新一轮重新全量复核", async () => {
  const backend = {
    getTask: vi.fn(async (id: string) => ({task_id: id, status: "SUCCEEDED"})),
    resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["A", "B"]}})),
  };
  const messages = [
    toolMessage({kind: "metric_query_structured", status: "succeeded", task_id: "t"}),
    toolMessage({kind: "data_availability", status: "succeeded", request: {org_codes: ["A", "B"]}}),
  ];
  // 同一轮内（入口复核 + accepted/tool_end/最终 snapshot）同一任务与范围不重复请求
  const authorize = createHistoryAuthorizer(backend as unknown as BackendClient);
  await authorize(messages);
  await authorize(messages);
  expect(backend.getTask).toHaveBeenCalledTimes(1);
  expect(backend.resolveBusinessField).toHaveBeenCalledTimes(1);
  // 下一轮提问使用新实例重新复核，撤权在轮间即时生效
  const next = createHistoryAuthorizer(backend as unknown as BackendClient);
  await next(messages);
  expect(backend.getTask).toHaveBeenCalledTimes(2);
  expect(backend.resolveBusinessField).toHaveBeenCalledTimes(2);
});

it("只有正文而无可信结果引用的旧JSON仅降级展示，不改写原文件", async () => {
  const f = fixture({legacy: true});
  const legacy = {id: "s", userId: "u", title: "旧记录", createdAt: 1,
    messages: [{role: "user", content: "原始问题"}, {role: "assistant", content: SECRET}]};
  writeFileSync(join(f.path, "s.json"), JSON.stringify(legacy));
  const response = await f.app.request("/sessions/s", {headers});
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("原始问题"); expect(body).toContain("缺少可复核的结果引用");
  expect(body).not.toContain(SECRET);
  const {readFileSync} = await import("node:fs");
  expect(JSON.parse(readFileSync(join(f.path, "s.json"), "utf8"))).toEqual(legacy);
});

it("原生Pi没有业务结果的问候和澄清仍原样显示", async () => {
  const f = fixture();
  f.entries.splice(1, 2, {id: "hello", type: "message", message: {
    role: "assistant", content: [{type: "text", text: "你好，请提供日期。"}], timestamp: 3,
  }});
  const response = await f.app.request("/sessions/s", {headers});
  expect(response.status).toBe(200); expect(await response.text()).toContain("你好，请提供日期。");
  expect(f.calls.filter(url => url.endsWith("query-tasks/t"))).toHaveLength(0);
});
