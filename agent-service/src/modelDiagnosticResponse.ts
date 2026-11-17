import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentServiceConfig } from "./config.js";

const DISPLAY_LIMIT = 8192;
const CAPTURE_LIMIT = 65_536;
const REDACTED = "[已脱敏]";
const SENSITIVE_KEYS = [
  "authorization",
  "proxy-authorization",
  "api-key",
  "access-key",
  "access-token",
  "refresh-token",
  "id-token",
  "session-token",
  "token",
  "password",
  "passwd",
  "secret",
  "client-secret",
  "private-key",
  "credential",
  "credentials",
  "cookie",
  "set-cookie",
];

export interface DiagnosticModelResponse {
  http_status: number | null;
  content: string;
  error: string;
  error_source: "http" | "client" | null;
  truncated: boolean;
}

function responseRedactor(config: AgentServiceConfig, token: string) {
  const secrets = new Set([config.model.apiKey, token]);
  for (const address of [
    config.model.baseUrl,
    config.backendBaseUrl,
    config.sessionStorage?.databaseUrl,
  ]) {
    if (!address) continue;
    secrets.add(address);
    try {
      const url = new URL(address);
      for (const part of [url.hostname, url.username, url.password]) {
        if (!part) continue;
        secrets.add(part);
        secrets.add(decodeURIComponent(part));
      }
    } catch {
      // 无效配置仍按完整原值脱敏，诊断本身负责报告配置错误。
    }
  }
  const known = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  const keys = [...SENSITIVE_KEYS, config.model.authHeader];
  const normalizedKeys = new Set(keys.map((key) => key.replace(/[-_\s]/gu, "").toLowerCase()));
  const sensitive = (key: string) => normalizedKeys.has(key.replace(/[-_\s]/gu, "").toLowerCase());
  const keyPattern = keys
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/-/gu, "[-_ ]?"))
    .join("|");
  const fieldPattern = new RegExp(
    String.raw`(["']?)(${keyPattern})\1\s*[:=]\s*((?:\{|\[)[\s\S]*|"(?:\\.|[^"\\])*"?|'[^']*'?|[^\r\n,;}]+)`,
    "giu",
  );
  const redactKnown = (raw: string, incomplete: boolean): string => {
    let text = raw;
    for (const secret of known) {
      // 捕获预算或取消可能落在凭据中间；先处理尾部片段，再替换完整凭据。
      if (incomplete) {
        for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
          if (text.endsWith(secret.slice(0, length))) {
            text = text.slice(0, -length) + REDACTED;
            break;
          }
        }
      }
      text = text.split(secret).join(REDACTED);
    }
    return text
      .replace(/\b(?:https?|mysql|postgres(?:ql)?):\/\/[^\s<>"']*/giu, REDACTED)
      .replace(/\bBearer\s+[^\s,"'}]+/giu, `Bearer ${REDACTED}`);
  };
  const redactText = (raw: string, incomplete: boolean) =>
    redactKnown(
      raw.replace(
        fieldPattern,
        (_match: string, _quote: string, key: string) => `${key}: ${REDACTED}`,
      ),
      incomplete,
    );
  return (raw: string, incomplete = false): string => {
    try {
      // 完整 JSON 保留错误结构，字段值在序列化前脱敏，包含嵌套对象与数组。
      const parsed: unknown = JSON.parse(raw);
      const json = JSON.stringify(
        parsed,
        (key: string, value: unknown): unknown => {
          if (sensitive(key)) return REDACTED;
          return typeof value === "string" ? redactText(value, false) : value;
        },
        2,
      );
      return redactKnown(json, false);
    } catch {
      // 非 JSON 或未完整接收的 JSON，只解析键值格式，不对错误语义作判断。
      return redactText(raw, incomplete);
    }
  };
}

/** 本次诊断独享的响应捕获，不修改公共模型调用或保存历史正文。 */
export function createDiagnosticResponseCapture(config: AgentServiceConfig, token: string) {
  const redact = responseRedactor(config, token);
  let httpStatus: number | null = null;
  let content = "";
  let httpError = "";
  let contentIncomplete = false;
  let errorIncomplete = false;
  let httpFailed = false;
  const baseFetch = globalThis.fetch;
  const fetchResponse: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    httpStatus = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    const nonStreamBody =
      /^(?:application\/(?:[\w.+-]+\+)?json|text\/(?:plain|html))(?:;|$)/iu.test(contentType);
    if (response.ok && !nonStreamBody) return response;
    httpFailed = true;
    const reader = response.body?.getReader();
    if (!reader) return response;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let interrupted = () => {};
    const cancelled = new Promise<{ done: true; value: undefined }>((resolve) => {
      interrupted = () => {
        errorIncomplete = true;
        // cancel 的底层清理可以滞后，但不得延长停止和超时的等待。
        reader.cancel().catch(() => {});
        resolve({ done: true, value: undefined });
      };
      signal?.addEventListener("abort", interrupted, { once: true });
    });
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      if (signal?.aborted) interrupted();
      while (!signal?.aborted && bytes < CAPTURE_LIMIT) {
        const part = await Promise.race([reader.read(), cancelled]);
        if (part.done) break;
        const available = CAPTURE_LIMIT - bytes;
        const received: unknown = part.value;
        if (!(received instanceof Uint8Array)) throw new TypeError("无效的 HTTP 响应数据块");
        const value = received.subarray(0, available);
        bytes += value.byteLength;
        httpError += decoder.decode(value, { stream: true });
        if (bytes === CAPTURE_LIMIT) {
          errorIncomplete = true;
          reader.cancel().catch(() => {});
        }
      }
    } catch {
      // 读取失败仍保留已收到的 HTTP 内容；SDK/超时错误由原链路分类。
      errorIncomplete = true;
    } finally {
      httpError += decoder.decode();
      signal?.removeEventListener("abort", interrupted);
      reader.releaseLock();
    }
    // SDK 继续处理同一次响应的状态与有界错误正文，不重新请求，也不无限读取错误页。
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    return new Response(httpError, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
  return {
    fetch: fetchResponse,
    observe(event: AssistantMessageEvent) {
      const message =
        event.type === "done"
          ? event.message
          : event.type === "error"
            ? event.error
            : event.partial;
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text) {
        content = text.slice(0, CAPTURE_LIMIT);
        contentIncomplete = text.length > CAPTURE_LIMIT;
      }
    },
    result(clientError: string | null): DiagnosticModelResponse {
      const safeContent = redact(content, contentIncomplete || clientError !== null);
      const safeError = redact(httpFailed ? httpError : (clientError ?? ""), errorIncomplete);
      return {
        http_status: httpStatus,
        content: safeContent.slice(0, DISPLAY_LIMIT),
        error: safeError.slice(0, DISPLAY_LIMIT),
        error_source: httpFailed ? "http" : clientError ? "client" : null,
        truncated:
          contentIncomplete ||
          errorIncomplete ||
          safeContent.length > DISPLAY_LIMIT ||
          safeError.length > DISPLAY_LIMIT,
      };
    },
  };
}
