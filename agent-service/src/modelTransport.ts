import {AsyncLocalStorage} from "node:async_hooks";
import {subscribe} from "node:diagnostics_channel";

export interface ModelTransportSummary {
  fetch_ms: number;
  request_created_ms: number | null;
  connect_started_ms: number | null;
  connection_ready_ms: number | null;
  headers_sent_ms: number | null;
  body_sent_ms: number | null;
  response_headers_ms: number | null;
  status: number | null;
  provider_request_ids: Record<string, string>;
  connection_reused: boolean | null;
  socket_idle_ms: number | null;
  error_code: string | null;
}

interface Trace {
  startedAt: number;
  summary: ModelTransportSummary;
}
interface SocketObservation {uses: number; active: number; lastCompletedAt: number | null;}
interface TransportEvent {request?: object; socket?: object; error?: unknown; response?: {statusCode: number};}

const active = new AsyncLocalStorage<Trace>();
const requests = new WeakMap<object, Trace>();
const requestSockets = new WeakMap<object, object>();
const sockets = new WeakMap<object, SocketObservation>();
const elapsed = (trace: Trace) => Math.max(0, Math.round(performance.now() - trace.startedAt));
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

function errorCode(error: unknown): string | null {
  try {
    if (!isObject(error)) return null;
    const value = error as {code?: unknown; name?: unknown; cause?: {code?: unknown}};
    for (const code of [value.code, value.cause?.code]) {
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)) return code;
    }
    return typeof value.name === "string" && ["AbortError", "TimeoutError", "TypeError"].includes(value.name)
      ? value.name : null;
  } catch {return null;}
}

function listen(name: string, handle: (event: TransportEvent) => void): void {
  subscribe(`undici:${name}`, event => {
    // 诊断失败不能中断底层网络请求，也不向日志复制未知事件内容。
    try {if (isObject(event)) handle(event as TransportEvent);} catch {}
  });
}

listen("request:create", ({request}) => {
  const trace = active.getStore();
  if (trace && isObject(request)) {
    requests.set(request, trace);
    trace.summary.request_created_ms ??= elapsed(trace);
  }
});
listen("client:beforeConnect", () => {
  const trace = active.getStore();
  if (trace) trace.summary.connect_started_ms ??= elapsed(trace);
});
listen("client:connected", ({socket}) => {
  const trace = active.getStore();
  if (trace && isObject(socket)) {
    sockets.set(socket, {uses: 0, active: 0, lastCompletedAt: null});
    trace.summary.connection_ready_ms ??= elapsed(trace);
  }
});
listen("client:sendHeaders", ({request, socket}) => {
  if (!isObject(request) || !isObject(socket)) return;
  const trace = requests.get(request);
  if (!trace) return;
  const previous = sockets.get(socket);
  trace.summary.connection_reused = previous ? previous.uses > 0 : null;
  trace.summary.socket_idle_ms = previous?.lastCompletedAt === null || previous?.lastCompletedAt === undefined
    ? null : Math.max(0, Math.round(performance.now() - previous.lastCompletedAt));
  sockets.set(socket, {uses: (previous?.uses ?? 0) + 1, active: (previous?.active ?? 0) + 1,
    lastCompletedAt: null});
  requestSockets.set(request, socket);
  trace.summary.connection_ready_ms ??= elapsed(trace);
  trace.summary.headers_sent_ms ??= elapsed(trace);
});
listen("request:bodySent", ({request}) => {
  const trace = isObject(request) ? requests.get(request) : undefined;
  if (trace) trace.summary.body_sent_ms ??= elapsed(trace);
});
listen("request:headers", ({request, response}) => {
  const trace = isObject(request) ? requests.get(request) : undefined;
  if (trace) {
    trace.summary.response_headers_ms ??= elapsed(trace);
    trace.summary.status = response?.statusCode ?? null;
  }
});
function requestEnded(request: unknown): void {
  if (!isObject(request)) return;
  const key = requestSockets.get(request);
  const socket = key ? sockets.get(key) : undefined;
  requestSockets.delete(request);
  if (socket && --socket.active === 0) socket.lastCompletedAt = performance.now();
}
listen("request:trailers", ({request}) => requestEnded(request));
listen("request:error", ({request, error}) => {
  const trace = isObject(request) ? requests.get(request) : undefined;
  if (trace) trace.summary.error_code ??= errorCode(error);
  requestEnded(request);
});

/** 仅统计 HTTP 响应头之前的过程；流式正文及其完成状态仍由模型层处理。 */
export function createModelTransportDiagnostics(
  baseFetch: typeof fetch, onSummary: (summary: ModelTransportSummary) => void,
): typeof fetch {
  return (input, init) => {
    const trace: Trace = {startedAt: performance.now(), summary: {
      fetch_ms: 0, request_created_ms: null, connect_started_ms: null, connection_ready_ms: null,
      headers_sent_ms: null, body_sent_ms: null, response_headers_ms: null, status: null,
      provider_request_ids: {}, connection_reused: null, socket_idle_ms: null, error_code: null,
    }};
    return active.run(trace, async () => {
      try {
        const response = await baseFetch(input, init);
        try {
          trace.summary.status = response.status;
          trace.summary.response_headers_ms ??= elapsed(trace);
          for (const name of ["x-request-id", "request-id", "x-tt-logid"]) {
            const value = response.headers.get(name);
            if (value && /^[A-Za-z0-9._:-]{1,160}$/u.test(value)) trace.summary.provider_request_ids[name] = value;
          }
        } catch {} // 非标准 fetch 缺少响应元数据时，只保留已观测到的阶段。
        return response;
      } catch (error) {
        trace.summary.error_code ??= errorCode(error);
        throw error;
      } finally {
        try {onSummary({...trace.summary, fetch_ms: elapsed(trace)});} catch {}
      }
    });
  };
}
