import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import type {AgentServiceConfig} from "../src/config.js";
import type {HarnessHost} from "../src/harnessHost.js";
import type {NativeSessionStore} from "../src/nativeSessions.js";
import {authorizeHistory, createApp, createHistoryAuthorizer} from "../src/routes.js";
import type {ProjectedMessage} from "../src/sessionProjection.js";

const cleanup: string[] = [];
afterEach(() => {vi.unstubAllGlobals(); for (const path of cleanup.splice(0)) rmSync(path, {recursive: true, force: true});});
const SECRET = "sensitive-fact-123";
const USER = {id: "u", username: "synthetic", org_code: "A", role_code: "USER"};
const headers = {Authorization: "Bearer synthetic"};
const resultDetails = {kind: "metric_query_structured", status: "succeeded", task_id: "t",
  rows: [{org_code: "B", metric_value: SECRET}], public_answer: SECRET};
const toolMessage = (details: unknown): ProjectedMessage => ({role: "tool", tool: "execute_business_frame",
  tool_call_id: "call", entry_id: "entry", timestamp: 1, is_error: false, details});

function fixture({revoked = false, legacy = false, readOnly = false, details = resultDetails, revokedTasks = []}: {
  revoked?: boolean; legacy?: boolean; readOnly?: boolean; details?: Record<string, unknown>; revokedTasks?: string[];
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
    const taskId = /\/api\/v1\/query-tasks\/([^/]+)$/u.exec(url)?.[1];
    if (taskId) return revoked || revokedTasks.includes(taskId)
      ? Response.json({code: "ORG_SCOPE_FORBIDDEN", message: "失权"}, {status: 403})
      : Response.json({task_id: taskId, status: "SUCCEEDED", result: {result_id: `result:${taskId}`}});
    return Response.json({message: "unexpected"}, {status: 500});
  }));
  const hosted = {sessionId: "s", createdAt: 1, open: [],
    ...(readOnly ? {readOnlyReason: "LEGACY_QUERY_REQUIRES_NEW_TURN"} : {}),
    lane: {findEntries: vi.fn(async () => entries), inspectExecution: vi.fn(async () => ({current: null}))},
    session: {getName: vi.fn(async () => "合成会话")},
  };
  const host = {openSession: vi.fn(async () => legacy ? undefined : hosted),
    watch: vi.fn(async () => ({snapshot: {transcript: entries, operation: null}, unsubscribe: vi.fn(), start: vi.fn()})),
    admitPrompt: vi.fn(async()=>({ok:false,code:"SESSION_BUSY",message:"合成忙碌状态"})), resumeOpenOperations: vi.fn(),
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
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("HISTORY_PERMISSION_DENIED"); expect(body).not.toContain(SECRET);
  }
  expect(f.calls.filter(url => url.endsWith("query-tasks/t"))).toHaveLength(2);
  expect(f.host.watch).toHaveBeenCalledTimes(readOnly ? 0 : 1);
});

it("失权历史不阻断独立新问题的接纳；模型上下文和快照分别屏蔽失权事实", async () => {
  const f = fixture({revoked: true});
  const response = await f.app.request("/sessions/s/prompt", {method: "POST",
    headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify({protocol_version: 3, request_id: "r", message: "继续"})});
  expect(response.status).toBe(409); expect(await response.text()).not.toContain(SECRET);
  expect(f.host.admitPrompt).toHaveBeenCalledTimes(1);
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
  expect(response.status).toBe(200);
  expect((await response.text()).includes(SECRET)).toBe(!revoked);
});

it("成功结果无持久化任务引用时不猜权限", async () => {
  const f = fixture({details: {kind: "metric_query_structured", status: "succeeded", rows: [{metric_value: SECRET}]}});
  const response = await f.app.request("/sessions/s", {headers});
  expect(response.status).toBe(200); expect(await response.text()).not.toContain(SECRET);
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

it("失败且空结果的真实查询回执不阻断后续历史授权，嵌套失败payload也不要求成功任务", async () => {
  const backend = {getTask: vi.fn(async () => ({task_id: "failed-task", status: "FAILED"}))};
  const failed = {kind: "metric_query_structured", status: "failed", task_id: "failed-task", rows: [], row_count: 0,
    public_answer: "查询未成功。", payloads: [{status: "failed", task_id: "failed-task", sample_rows: [], facts: [], fact_count: 0, row_count: 0}]};
  await expect(authorizeHistory([toolMessage(failed)], backend as unknown as BackendClient)).resolves.toBeUndefined();
  expect(backend.getTask).not.toHaveBeenCalled();
});

it.each([
  {rows: [{metric_value: SECRET}], row_count: 1},
  {rows: [], row_count: 1},
  {rows: [], row_count: 0, facts: [{value: SECRET}]},
  {rows: [], row_count: 0, truncated: true},
  {rows: [], row_count: 0, payloads: [{status: "failed", task_id: "failed-task", sample_rows: [{metric_value: SECRET}]}]},
])("失败回执仍含事实或完整性未知时继续失败关闭：%j", async extra => {
  const backend = {getTask: vi.fn(async () => ({task_id: "failed-task", status: "FAILED"}))};
  await expect(authorizeHistory([toolMessage({kind: "metric_query_structured", status: "failed", task_id: "failed-task", ...extra})],
    backend as unknown as BackendClient)).rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
});

it("成功零行正式结果仍须核验当前权限", async () => {
  const backend = {getTask: vi.fn(async () => {throw new BackendApiError(403, "ORG_SCOPE_FORBIDDEN");})};
  await expect(authorizeHistory([toolMessage({kind: "metric_query_structured", status: "succeeded", task_id: "empty-task", result_id: "result:empty-task", rows: [], row_count: 0})],
    backend as unknown as BackendClient)).rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.getTask).toHaveBeenCalledExactlyOnceWith("empty-task");
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

const query = (task_id: string, extra: Record<string, unknown> = {}) => ({kind: "metric_query_structured", status: "succeeded",
  task_id, result_id: `result:${task_id}`, rows: [{metric_value: SECRET}], ...extra});
const semantic = (evidence: unknown, extra: Record<string, unknown> = {}) => ({protocol_version: 2, status: "succeeded",
  state: {task_status: "completed", completion: "full", evidence, targets: []}, issues: [], continuation: {actor: "pi", action: "answer"}, ...extra});
const taskBackend = (denied?: string) => ({getTask: vi.fn(async (taskId: string) => {
  if (taskId === denied) throw new BackendApiError(403, "失权");
  return {task_id: taskId, status: "SUCCEEDED", result: {task_id: taskId, result_id: `result:${taskId}`}};
})});

it("语义聚合逐项复核：最后成功不能掩盖另一个已失权来源", async () => {
  const backend = taskBackend("revoked");
  await expect(authorizeHistory([toolMessage(semantic({kind: "semantic_results", status: "partial",
    results: [query("revoked"), query("allowed")]}))], backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.getTask.mock.calls.map(([id]) => id).sort()).toEqual(["allowed", "revoked"]);
});

it.each(["", "/stream", "/prompt"])("聚合任一来源失权屏蔽整轮事实，独立新问题仍进入接纳门禁：%s", async suffix => {
  const f = fixture({revokedTasks: ["revoked"], details: semantic({kind: "semantic_results", status: "succeeded",
    results: [query("t"), query("revoked")], public_answer: SECRET})});
  const response = await f.app.request(`/sessions/s${suffix}`, suffix === "/prompt" ? {
    method: "POST", headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify({protocol_version: 3, request_id: "multi-denied", message: "继续"}),
  } : {headers});
  expect(response.status).toBe(suffix === "/prompt" ? 409 : 200); expect(await response.text()).not.toContain(SECRET);
  if (suffix === "/prompt") expect(f.host.admitPrompt).toHaveBeenCalledTimes(1);
});

it.each([
  semantic({kind: "semantic_results", status: "succeeded", results: [query("t"), query("missing", {task_id: undefined})]}),
  semantic({kind: "unknown_results", status: "succeeded", rows: [{value: SECRET}]}),
  semantic({kind: "semantic_results", status: "succeeded", results: [null]}),
  semantic({kind: "semantic_results", status: "succeeded", results: [{}], public_answer: SECRET}),
  semantic({kind: "semantic_results", status: "succeeded", results: [{status: "succeeded", public_answer: SECRET}]}),
  {unknown_wrapper: {rows: [{value: SECRET}]}},
  query("t", {payloads: [{status: "succeeded", task_id: "other", result_id: "result:other", sample_rows: [{value: SECRET}]}]}),
  query("t", {result: {task_id: "other", status: "succeeded", rows: [{value: SECRET}]}}),
])("不完整或冲突的嵌套事实引用失败关闭：%j", async details => {
  const backend = taskBackend();
  await expect(authorizeHistory([toolMessage(details)], backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
  expect(backend.getTask).not.toHaveBeenCalled();
});

it("计算 inputs 和 sources 的全部任务均鉴权，额外声明的来源不能绕过", async () => {
  const backend = taskBackend("revoked");
  await expect(authorizeHistory([toolMessage(semantic({kind: "metric_calculate", status: "succeeded",
    inputs: {a: {task_id: "allowed", fact_id: "fact:allowed:0:metric_value"}},
    sources: [{task_id: "allowed", result_id: "result:allowed"}, {task_id: "revoked", result_id: "result:revoked"}],
    results: [{value: SECRET}]}))], backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.getTask).toHaveBeenCalledTimes(2);
});

it.each([
  {inputs: {a: {task_id: "t"}}, sources: [{task_id: "other", result_id: "result:other"}]},
  {inputs: {a: {task_id: "t", fact_id: "fact:other:0:value"}}},
  {inputs: {a: {task_id: "t"}}, sources: [{result_id: "result:t"}]},
])("计算声明来源缺失或事实引用不属于任务时拒绝：%j", async extra => {
  await expect(authorizeHistory([toolMessage({kind: "metric_calculate", status: "succeeded", ...extra})], taskBackend() as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
});

it("后端重新核验结果与任务绑定，同轮缓存不能复用给另一result_id", async () => {
  const backend = taskBackend(), authorize = createHistoryAuthorizer(backend as unknown as BackendClient);
  await authorize([toolMessage(query("t"))]);
  await expect(authorize([toolMessage(query("t", {result_id: "result:other"}))]))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
  expect(backend.getTask).toHaveBeenCalledTimes(1);
  await expect(authorizeHistory([toolMessage(query("t", {result_id: "result:other"}))], backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
});

it("旧metric_ask和回读的task.version不同但指向同一不可变结果时兼容，并只复核一次", async () => {
  const backend = taskBackend();
  backend.getTask.mockImplementation(async taskId => ({task_id: taskId, status: "SUCCEEDED", version: 9,
    result: {task_id: taskId, result_id: `result:${taskId}`}}));
  const messages = [toolMessage(query("t", {kind: "metric_ask", version: 2})),
    toolMessage(query("t", {kind: "metric_read", version: 7})), toolMessage(query("t", {version: 9}))];
  await expect(authorizeHistory(messages, backend as unknown as BackendClient)).resolves.toBeUndefined();
  expect(backend.getTask).toHaveBeenCalledExactlyOnceWith("t");
});

it("当前任务可访问不能证明不同旧result的原范围，现有只返回单快照的端点须失败关闭", async () => {
  const backend = taskBackend();
  const messages = [toolMessage(query("t", {kind: "metric_ask", version: 2, result_id: "old-result"})),
    toolMessage(query("t", {kind: "metric_read", version: 9}))];
  await expect(authorizeHistory(messages, backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
  expect(backend.getTask).not.toHaveBeenCalled();
  await expect(authorizeHistory(messages.slice(0, 1), backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
  expect(backend.getTask).toHaveBeenCalledExactlyOnceWith("t");
});

it("重复的页面证据、语义证据和payloads只鉴权一次，下一轮撤权重新生效", async () => {
  const backend = taskBackend(), receipt = query("t", {payloads: [{status: "succeeded", task_id: "t", result_id: "result:t", sample_rows: []}]});
  const messages = [toolMessage({...receipt, semantic_task: semantic(receipt)})];
  const authorize = createHistoryAuthorizer(backend as unknown as BackendClient);
  await authorize(messages); await authorize(messages);
  expect(backend.getTask).toHaveBeenCalledTimes(1);
  backend.getTask.mockRejectedValue(new BackendApiError(403, "失权"));
  await expect(createHistoryAuthorizer(backend as unknown as BackendClient)(messages))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.getTask).toHaveBeenCalledTimes(2);
});

it("直接交付快照的全部来源也复核，不能只授权当前最后一条表格", async () => {
  const backend = taskBackend("revoked");
  const details = semantic(query("t"), {direct_answer: {version: 1, delivery_path: "direct_query", public_answer: SECRET,
    sources: ["t", "revoked"].map(task_id => ({task_id, result_id: `result:${task_id}`,
      result_ref: `query:${task_id}:${encodeURIComponent(`result:${task_id}`)}`}))}});
  await expect(authorizeHistory([toolMessage(details)], backend as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
  expect(backend.getTask).toHaveBeenCalledTimes(2);
});

it("实时聚合回执失权后串行发送器阻断后续正文与终态快照", async () => {
  const details = semantic({kind: "semantic_results", status: "succeeded", results: [query("t"), query("revoked")], public_answer: SECRET});
  const f = fixture({revokedTasks: ["revoked"]});
  f.entries.splice(1);
  const watch = f.host.watch as unknown as {mockImplementation: (callback: () => Promise<unknown>) => void};
  watch.mockImplementation(async () => ({snapshot: {transcript: [...f.entries], operation: {id: "active"}}, unsubscribe: vi.fn(),
    start: (callback: (event: Record<string, unknown>) => void) => {
      f.entries.push({id: "live", type: "message", message: {role: "toolResult", toolName: "resolve_business_turn",
        toolCallId: "live-call", details, content: [{type: "text", text: SECRET}], timestamp: 2}});
      callback({type: "tool_end", toolName: "resolve_business_turn", toolCallId: "live-call", result: {details}});
      callback({type: "run_end", status: "completed"});
    }}));
  const response = await f.app.request("/sessions/s/stream", {headers});
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("HISTORY_PERMISSION_DENIED"); expect(body).not.toContain(SECRET);
  expect(body).not.toContain("event: tool_end"); expect(body).not.toContain("event: message_done");
  expect(body).not.toContain("event: run_terminal");
});
