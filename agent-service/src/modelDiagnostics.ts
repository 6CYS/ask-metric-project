import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BackendApiError, BackendClient, type BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import { databaseAgentRuntimeSnapshot, materializeAgentRuntime } from "./databaseAgentRuntime.js";
import {
  createDiagnosticResponseCapture,
  type DiagnosticModelResponse,
} from "./modelDiagnosticResponse.js";
import { modelFailure } from "./modelFailure.js";
import { createAskMetricModels } from "./models.js";

const MAX_DURATION_MS = 60_000;
const COOLDOWN_MS = 10_000;
const MAX_OUTPUT_TOKENS = 512;
const PROMPT = "这是一次模型连接诊断。请仅回复：连接正常。";
const diagnosticFields = new Set([
  "model",
  "messages",
  "stream",
  "n",
  "max_tokens",
  "max_completion_tokens",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
]);

export interface DiagnosticTarget {
  model: string;
  configuration_source: "file" | "database";
  configuration_version: string | null;
  first_response_timeout_ms: number;
  stream_idle_timeout_ms: number;
  max_duration_ms: number;
  cooldown_ms: number;
}

export interface DiagnosticResult {
  diagnostic_id: string;
  started_at: string;
  finished_at: string;
  target: DiagnosticTarget;
  status: "succeeded" | "failed" | "cancelled";
  first_output_ms: number | null;
  duration_ms: number;
  error_code: string | null;
  message: string;
  model_response: DiagnosticModelResponse;
}

async function effectiveRuntime(config: AgentServiceConfig, token: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (config.businessConfigurationStorage !== "database") return { config, version: null };
  const backend = new BackendClient(
    config.backendBaseUrl,
    token,
    Math.min(config.backendTimeoutMs, MAX_DURATION_MS),
  );
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException("检测已停止", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    // 传递取消给实际 HTTP；即使依赖未及时响应，也不延长本次检测预算。
    const snapshot = await Promise.race([
      databaseAgentRuntimeSnapshot(backend, undefined, signal),
      interrupted,
    ]);
    return {
      config: materializeAgentRuntime(config, snapshot.document),
      version: snapshot.version_id,
    };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function targetSummary(config: AgentServiceConfig, version: string | null): DiagnosticTarget {
  return {
    model: config.model.name,
    configuration_source: config.businessConfigurationStorage === "database" ? "database" : "file",
    configuration_version: version,
    first_response_timeout_ms:
      config.modelFirstResponseTimeoutMs ?? config.modelStreamIdleTimeoutMs ?? 0,
    stream_idle_timeout_ms: config.modelStreamIdleTimeoutMs ?? 0,
    max_duration_ms: MAX_DURATION_MS,
    cooldown_ms: COOLDOWN_MS,
  };
}

// 与模型首响应/空闲超时保持同一口径：思考、正文和实际工具调用均算有效输出。
function hasOutput(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "toolCall" && !!block.id && !!block.name;
    }
    case "toolcall_end":
      return !!event.toolCall.id && !!event.toolCall.name;
    default:
      return false;
  }
}

function completedError(message: AssistantMessage): string | null {
  if (message.stopReason === "length") return "MODEL_OUTPUT_TRUNCATED";
  if (!message.rawStopReason) return "MODEL_STREAM_FAILED";
  if (message.stopReason !== "stop") return "MODEL_RESPONSE_FAILED";
  return message.content.some((block) => block.type === "text" && block.text.trim())
    ? null
    : "MODEL_RESPONSE_EMPTY";
}

function failureSummary(error: string) {
  if (error === "DIAGNOSTIC_DEADLINE_EXCEEDED")
    return { code: error, message: "检测已达到 60 秒时限，模型响应未完整结束。" };
  if (error === "MODEL_RESPONSE_EMPTY")
    return { code: error, message: "模型已结束响应，但未返回有效正文。" };
  if (error === "MODEL_OUTPUT_TRUNCATED")
    return { code: error, message: "模型输出达到本次诊断预算，响应未完整结束。" };
  const failure = modelFailure(error);
  return { code: failure.code, message: `检测未完成：${failure.reason}。` };
}

export function createModelDiagnosticRoutes(config: AgentServiceConfig) {
  const router = new Hono<{ Variables: { user: BackendUser; token: string } }>();
  let active: symbol | undefined;
  let lastStarted = -Infinity;
  router.onError((error, c) => {
    if (error instanceof BackendApiError && error.status === 401)
      return c.json({ code: "UNAUTHORIZED", detail: "登录状态已失效，请重新登录" }, 401);
    return c.json(
      {
        code: "DIAGNOSTIC_CONFIGURATION_UNAVAILABLE",
        detail: "当前模型配置暂不可读取，请稍后重试",
      },
      503,
    );
  });
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.get("user")?.role_code !== "SYSTEM_ADMIN")
      return c.json({ code: "DIAGNOSTIC_ADMIN_REQUIRED", detail: "需要系统管理员权限" }, 403);
    await next();
  });
  router.get("/", async (c) => {
    const runtime = await effectiveRuntime(config, c.get("token"), c.req.raw.signal);
    return c.json(targetSummary(runtime.config, runtime.version));
  });
  router.post("/", async (c) => {
    // 不采纳请求体；Node 适配器即使对空 POST 也会提供 body 流，不能据此拒绝合法检测。
    const started = Date.now();
    const remaining = Math.max(0, COOLDOWN_MS - (started - lastStarted));
    if (active || remaining > 0)
      return c.json(
        {
          code: active ? "DIAGNOSTIC_BUSY" : "DIAGNOSTIC_COOLDOWN",
          detail: active ? "当前实例已有模型检测正在进行" : "请稍后再次检测",
          retry_after_ms: active ? Math.max(remaining, 1000) : remaining,
        },
        429,
      );

    const lease = Symbol();
    active = lease;
    lastStarted = started;
    const controller = new AbortController();
    let timedOut = false;
    const release = () => {
      if (active === lease) active = undefined;
    };
    const cancel = () => {
      controller.abort();
      release();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, MAX_DURATION_MS);
    c.req.raw.signal.addEventListener("abort", cancel, { once: true });
    if (c.req.raw.signal.aborted) cancel();
    const cleanup = () => {
      clearTimeout(timer);
      c.req.raw.signal.removeEventListener("abort", cancel);
      release();
    };

    let runtime: Awaited<ReturnType<typeof effectiveRuntime>>;
    try {
      runtime = await effectiveRuntime(config, c.get("token"), controller.signal);
      controller.signal.throwIfAborted();
    } catch (error) {
      cleanup();
      if (controller.signal.aborted) {
        return c.json(
          {
            code: timedOut ? "DIAGNOSTIC_DEADLINE_EXCEEDED" : "DIAGNOSTIC_CANCELLED",
            detail: timedOut ? "检测已超时" : "检测已停止",
          },
          timedOut ? 504 : 409,
        );
      }
      throw error;
    }
    const target = targetSummary(runtime.config, runtime.version);
    const diagnosticId = randomUUID();
    const startedAt = new Date(started).toISOString();

    const response = streamSSE(c, async (stream) => {
      stream.onAbort(cancel);
      let firstOutputMs: number | null = null;
      let terminalError: string | null = "MODEL_STREAM_FAILED";
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const capture = createDiagnosticResponseCapture(runtime.config, c.get("token"));
      try {
        await stream.writeSSE({
          event: "started",
          data: JSON.stringify({
            diagnostic_id: diagnosticId,
            started_at: startedAt,
            target,
          }),
        });
        heartbeat = setInterval(() => {
          stream.write(": heartbeat\n\n").catch(cancel);
        }, 5000);
        if (!controller.signal.aborted) {
          // 扩展采样参数不能覆盖本次固定提示、无工具和单输出预算；不修改实际配置对象。
          const extraBody = Object.fromEntries(
            Object.entries(runtime.config.model.extraBody).filter(
              ([key]) => !diagnosticFields.has(key),
            ),
          );
          const maxTokens = Math.min(MAX_OUTPUT_TOKENS, runtime.config.model.maxTokens);
          const { models, model } = createAskMetricModels({
            ...runtime.config,
            model: {
              ...runtime.config.model,
              maxTokens,
              extraBody: { ...extraBody, n: 1 },
            },
          });
          const source = models.streamSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: PROMPT + runtime.config.model.userMessageSuffix,
                  timestamp: started,
                },
              ],
            },
            {
              maxTokens,
              maxRetries: 0,
              fetch: capture.fetch,
              signal: controller.signal,
              sessionId: diagnosticId,
            },
          );
          for await (const event of source) {
            capture.observe(event);
            if (firstOutputMs === null && hasOutput(event)) {
              firstOutputMs = Math.max(0, Date.now() - started);
              await stream.writeSSE({
                event: "progress",
                data: JSON.stringify({
                  phase: "receiving",
                  first_output_ms: firstOutputMs,
                }),
              });
            }
            if (event.type === "error") {
              terminalError = event.error.errorMessage ?? "MODEL_RESPONSE_FAILED";
              break;
            }
            if (event.type === "done") {
              terminalError = completedError(event.message);
              break;
            }
          }
        }
      } catch (error) {
        terminalError = error instanceof Error ? error.message : "MODEL_RESPONSE_FAILED";
      } finally {
        clearInterval(heartbeat);
        cleanup();
      }
      const cancelled = controller.signal.aborted && !timedOut;
      const failure = timedOut
        ? failureSummary("DIAGNOSTIC_DEADLINE_EXCEEDED")
        : terminalError
          ? failureSummary(terminalError)
          : null;
      const summary: Omit<DiagnosticResult, "model_response"> = {
        diagnostic_id: diagnosticId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        target,
        status: cancelled ? "cancelled" : failure ? "failed" : "succeeded",
        first_output_ms: firstOutputMs,
        duration_ms: Math.max(0, Date.now() - started),
        error_code: cancelled ? "DIAGNOSTIC_CANCELLED" : (failure?.code ?? null),
        message: cancelled ? "检测已停止。" : (failure?.message ?? "本次轻量流式请求已完整返回。"),
      };
      const result: DiagnosticResult = {
        ...summary,
        model_response: capture.result(timedOut ? "DIAGNOSTIC_DEADLINE_EXCEEDED" : terminalError),
      };
      console.info(JSON.stringify({ event: "model_diagnostic", ...summary }));
      if (!stream.aborted) await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return router;
}
