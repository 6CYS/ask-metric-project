import { BackendApiError } from "../backendClient.js";
import { authenticationFailure } from "../runtime/authentication.js";
import { inquiryPermissionDenied } from "../inquiry/authorization.js";
import type { ProjectedMessage } from "../sessionProjection.js";
import type { EvaluationRequest, ExecutionIdentity, SessionEvaluationClient } from "./types.js";

interface ClientOptions {
  turnTimeoutMs?: number;
  cancelTimeoutMs?: number;
}
interface SessionSnapshot {
  running: boolean;
  messages: ProjectedMessage[];
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function messages(value: unknown): ProjectedMessage[] {
  if (!Array.isArray(value))
    throw new BackendApiError(502, "会话快照格式不完整", "EVALUATION_PROTOCOL_INVALID");
  return value.map((item: unknown) => {
    const record = object(item);
    if (!record || typeof record.entry_id !== "string")
      throw new BackendApiError(502, "会话缺少消息身份", "EVALUATION_PROTOCOL_INVALID");
    const base = {
      entry_id: record.entry_id,
      timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
    };
    if (record.role === "user" && typeof record.text === "string")
      return { ...base, role: "user", text: record.text };
    if (record.role === "assistant" && typeof record.text === "string")
      return {
        ...base,
        role: "assistant",
        text: record.text,
        tools: Array.isArray(record.tools)
          ? record.tools.filter((tool: unknown): tool is string => typeof tool === "string")
          : [],
        ...(typeof record.error === "string" ? { error: record.error } : {}),
        ...(record.business_protocol === "frame_v1"
          ? { business_protocol: "frame_v1" as const }
          : {}),
        ...(Array.isArray(record.tool_calls)
          ? {
              tool_calls: record.tool_calls.flatMap((call: unknown) => {
                const item = object(call);
                return typeof item?.id === "string" && typeof item.tool === "string"
                  ? [{ id: item.id, tool: item.tool }]
                  : [];
              }),
            }
          : {}),
      };
    if (
      record.role === "tool" &&
      typeof record.tool === "string" &&
      typeof record.tool_call_id === "string" &&
      typeof record.is_error === "boolean"
    )
      return {
        ...base,
        role: "tool",
        tool: record.tool,
        tool_call_id: record.tool_call_id,
        is_error: record.is_error,
        details: record.details,
      };
    throw new BackendApiError(502, "会话消息格式不完整", "EVALUATION_PROTOCOL_INVALID");
  });
}

function currentTurn(all: ProjectedMessage[], id: string): ProjectedMessage[] {
  const start = all.findIndex((message) => message.role === "user" && message.entry_id === id);
  if (start < 0)
    throw new BackendApiError(
      409,
      "该轮消息已不可读取，请查看原会话",
      "EVALUATION_TURN_UNAVAILABLE",
    );
  const next = all.findIndex((message, index) => index > start && message.role === "user");
  return all.slice(start, next < 0 ? undefined : next);
}

/** 请求和读取都响应取消；只取消观察不会停止问数，调用方另外执行正式 cancel 接口。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("操作已取消"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function consumeEvents(
  response: Response,
  signal: AbortSignal,
  receive: (type: string, value: JsonObject) => void,
): Promise<void> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new BackendApiError(502, "问数服务未返回事件流", "EVALUATION_PROTOCOL_INVALID");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      const value: unknown = chunk.value;
      if (value !== undefined && !(value instanceof Uint8Array)) {
        throw new BackendApiError(502, "事件流不是字节数据", "EVALUATION_PROTOCOL_INVALID");
      }
      buffer += decoder.decode(value, { stream: !chunk.done });
      // 快照可能包含整组历史；限制仅保护协议资源，不判断正文语义。
      if (buffer.length > 20_000_000)
        throw new BackendApiError(502, "会话事件超过读取上限", "EVALUATION_EVENT_TOO_LARGE");
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        let type = "message";
        const lines: string[] = [];
        for (const line of frame.split(/\r?\n/u)) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
        }
        if (!lines.length) continue;
        const value: unknown = JSON.parse(lines.join("\n"));
        const record = object(value);
        if (!record)
          throw new BackendApiError(502, "事件数据格式不完整", "EVALUATION_PROTOCOL_INVALID");
        receive(type, record);
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 只消费当前服务已经公开的会话协议；不持有模型或查询实现。 */
export function createSessionEvaluationClient(
  request: EvaluationRequest,
  options: ClientOptions = {},
): SessionEvaluationClient {
  const turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000;

  async function call(
    token: string,
    path: string,
    init: RequestInit = {},
    signal = AbortSignal.timeout(cancelTimeoutMs),
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await abortable(request(path, { ...init, headers, signal }), signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new BackendApiError(
        response.status,
        response.status === 401 || response.status === 403
          ? "当前登录或访问权限已失效，测评已停止"
          : `问数接口调用失败（HTTP ${response.status}）`,
        response.status === 401 || response.status === 403
          ? "AUTHENTICATION_REQUIRED"
          : "EVALUATION_SESSION_REQUEST_FAILED",
      );
    }
    return response;
  }

  async function snapshot(
    token: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    const response = await call(
      token,
      `/sessions/${encodeURIComponent(sessionId)}?resume=false`,
      {},
      signal,
    );
    const value = object(await response.json());
    if (!value || typeof value.running !== "boolean")
      throw new BackendApiError(502, "会话状态不可确认", "EVALUATION_PROTOCOL_INVALID");
    return { running: value.running, messages: messages(value.messages) };
  }

  async function cancelTurn(token: string, sessionId: string, requestId: string): Promise<void> {
    const signal = AbortSignal.timeout(cancelTimeoutMs);
    try {
      await call(
        token,
        `/sessions/${encodeURIComponent(sessionId)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ request_id: requestId }),
        },
        signal,
      );
      while ((await snapshot(token, sessionId, signal)).running) {
        await abortable(new Promise((resolve) => setTimeout(resolve, 100)), signal);
      }
    } catch (error) {
      if (error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
      throw new BackendApiError(
        503,
        "已请求停止，但未能确认问数结束，请检查原会话后再运行测评",
        "EVALUATION_CANCEL_UNCONFIRMED",
      );
    }
  }

  return {
    async createSession(token) {
      const value = object(await (await call(token, "/sessions", { method: "POST" })).json());
      if (typeof value?.session_id !== "string")
        throw new BackendApiError(502, "未取得测评会话身份", "EVALUATION_PROTOCOL_INVALID");
      return value.session_id;
    },
    async deleteSession(token, sessionId, signal) {
      try {
        await call(
          token,
          `/sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
          signal,
        );
      } catch (error) {
        // 清理中断后允许继续；权限、运行中和服务异常仍交由调用方处理。
        if (!(error instanceof BackendApiError && error.status === 404)) throw error;
      }
    },
    cancelTurn,
    async readTurn(token, sessionId, userEntryId) {
      return currentTurn((await snapshot(token, sessionId)).messages, userEntryId);
    },
    async executeTurn(input) {
      const startedAt = performance.now();
      const timeout = AbortSignal.timeout(turnTimeoutMs);
      const signal = AbortSignal.any([input.signal, timeout]);
      let finalSnapshot: SessionSnapshot | undefined;
      let terminal: JsonObject | undefined;
      let operationId: string | null = null;
      let userEntryId: string | null = null;
      let reportedIdentity: ExecutionIdentity | undefined;
      let streamFailure = false;
      let identityFailure: { error: unknown } | undefined;
      if (input.signal.aborted)
        return {
          status: "cancelled",
          run_status: null,
          user_entry_id: null,
          operation_id: null,
          answer_status: null,
          error_code: "EVALUATION_CANCELLED",
          error_message: "测评已停止",
          timings_ms: {},
        };
      try {
        const response = await call(
          input.token,
          `/sessions/${encodeURIComponent(input.sessionId)}/prompt`,
          {
            method: "POST",
            headers: { "X-Agent-Answer-Streaming": "v1" },
            body: JSON.stringify({
              protocol_version: 3,
              request_id: input.requestId,
              message: input.question,
            }),
          },
          signal,
        );
        await consumeEvents(response, signal, (type, value) => {
          if (value.session_id !== input.sessionId || value.request_id !== input.requestId) {
            throw new BackendApiError(
              502,
              "问数事件不属于当前测评请求",
              "EVALUATION_PROTOCOL_INVALID",
            );
          }
          if (type === "accepted") operationId = text(value.operation_id);
          if (
            operationId &&
            ((typeof value.operation_id === "string" && value.operation_id !== operationId) ||
              (type === "run_terminal" && value.operation_id !== operationId))
          ) {
            throw new BackendApiError(
              502,
              "问数事件的操作身份发生变化",
              "EVALUATION_PROTOCOL_INVALID",
            );
          }
          const raw =
            type === "accepted" ? object(value.snapshot) : type === "snapshot" ? value : undefined;
          if (raw) {
            const all = messages(raw.messages);
            const lastUser = all.filter((message) => message.role === "user").at(-1);
            if (lastUser?.role === "user" && lastUser.text === input.question)
              userEntryId = lastUser.entry_id;
            if (type === "snapshot" && raw.running === false)
              finalSnapshot = { running: false, messages: all };
          }
          if (
            operationId &&
            (reportedIdentity?.operation_id !== operationId ||
              reportedIdentity.user_entry_id !== userEntryId)
          ) {
            try {
              input.onIdentity?.({ operation_id: operationId, user_entry_id: userEntryId });
              reportedIdentity = { operation_id: operationId, user_entry_id: userEntryId };
            } catch (error) {
              identityFailure = { error };
              throw error;
            }
          }
          if (type === "run_terminal") terminal = value;
        });
      } catch (error) {
        if (error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        streamFailure = true;
      }
      if (signal.aborted || streamFailure || !terminal || !finalSnapshot) {
        await (input.cancel?.() ?? cancelTurn(input.token, input.sessionId, input.requestId));
        if (identityFailure) throw identityFailure.error;
        return {
          status: input.signal.aborted ? "cancelled" : "failed",
          user_entry_id: userEntryId,
          operation_id: operationId,
          run_status: text(terminal?.run_status),
          answer_status: text(terminal?.answer_status),
          error_code: input.signal.aborted
            ? "EVALUATION_CANCELLED"
            : timeout.aborted
              ? "EVALUATION_TIMEOUT"
              : "EVALUATION_STREAM_INCOMPLETE",
          error_message: input.signal.aborted
            ? "测评已停止"
            : timeout.aborted
              ? "本题执行超时，已停止当前请求"
              : "未收到完整执行结果，已停止当前请求",
          timings_ms: { observed_ms: Math.round(performance.now() - startedAt) },
        };
      }
      const finalMessages = userEntryId ? currentTurn(finalSnapshot.messages, userEntryId) : [];
      const hasAnswer = finalMessages.some(
        (message) => message.role === "assistant" && message.text.trim() && !message.error,
      );
      const authorizationFailed = finalMessages.some(
        (message) => message.role === "tool" && authenticationFailure(message.details),
      );
      const permissionDenied = finalMessages.some(
        (message) => message.role === "tool" && inquiryPermissionDenied(message.details),
      );
      const succeeded =
        terminal.run_status === "completed" &&
        terminal.answer_status === "ok" &&
        hasAnswer &&
        !!operationId &&
        !authorizationFailed &&
        !permissionDenied;
      const timing: Record<string, number | number[] | null> = {
        observed_ms: Math.round(performance.now() - startedAt),
      };
      for (const [key, value] of Object.entries(object(terminal.timings_ms) ?? {})) {
        if (value === null || (typeof value === "number" && Number.isFinite(value)))
          timing[key] = value;
        else if (
          Array.isArray(value) &&
          value.every((item) => typeof item === "number" && Number.isFinite(item))
        )
          timing[key] = value as number[];
      }
      return {
        status: succeeded ? "completed" : "failed",
        run_status: text(terminal.run_status),
        user_entry_id: userEntryId,
        operation_id: operationId,
        answer_status: text(terminal.answer_status),
        error_code: authorizationFailed
          ? "AUTHENTICATION_REQUIRED"
          : permissionDenied
            ? "INQUIRY_FORBIDDEN"
            : (text(terminal.error_code) ?? (succeeded ? null : "EVALUATION_ANSWER_INCOMPLETE")),
        error_message:
          text(terminal.error_message) ?? (succeeded ? null : "本题未交付完整回答，请查看执行记录"),
        timings_ms: timing,
      };
    },
  };
}
