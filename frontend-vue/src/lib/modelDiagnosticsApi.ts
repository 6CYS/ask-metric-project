import { clearAccessToken, getAccessToken, setAuthFailureReason } from "./authSession"
import { agentApiBase } from "./apiBase"
import type {
  DiagnosticModelResponse,
  DiagnosticProgress,
  DiagnosticResult,
  DiagnosticStarted,
  DiagnosticTarget,
} from "@/types/modelDiagnostics"

export class ModelDiagnosticError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryAfterMs = 0,
  ) {
    super(message)
    this.name = "ModelDiagnosticError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function milliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
function invalid(): never {
  throw new ModelDiagnosticError("诊断响应不完整，请重新检测。", 502)
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("已停止检测", "AbortError")
}
function timedSignal(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(external ? abortReason(external) : undefined)
  const timer = setTimeout(
    () => controller.abort(new ModelDiagnosticError("检测连接超时，请稍后重试。")),
    timeoutMs,
  )
  external?.addEventListener("abort", forwardAbort, { once: true })
  if (external?.aborted) forwardAbort()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener("abort", forwardAbort)
    },
  }
}
function target(value: unknown): DiagnosticTarget {
  if (
    !record(value) ||
    typeof value.model !== "string" ||
    !["file", "database"].includes(String(value.configuration_source)) ||
    !(value.configuration_version === null || typeof value.configuration_version === "string") ||
    !milliseconds(value.first_response_timeout_ms) ||
    !milliseconds(value.stream_idle_timeout_ms) ||
    !milliseconds(value.max_duration_ms) ||
    !milliseconds(value.cooldown_ms)
  )
    return invalid()
  return {
    model: value.model,
    configuration_source: value.configuration_source === "database" ? "database" : "file",
    configuration_version: value.configuration_version,
    first_response_timeout_ms: value.first_response_timeout_ms,
    stream_idle_timeout_ms: value.stream_idle_timeout_ms,
    max_duration_ms: value.max_duration_ms,
    cooldown_ms: value.cooldown_ms,
  }
}
function started(value: unknown): DiagnosticStarted {
  if (
    !record(value) ||
    typeof value.diagnostic_id !== "string" ||
    !value.diagnostic_id ||
    typeof value.started_at !== "string" ||
    !Number.isFinite(Date.parse(value.started_at))
  )
    return invalid()
  return {
    diagnostic_id: value.diagnostic_id,
    started_at: value.started_at,
    target: target(value.target),
  }
}
function modelResponse(value: unknown): DiagnosticModelResponse {
  if (
    !record(value) ||
    !(
      value.http_status === null ||
      (typeof value.http_status === "number" &&
        Number.isInteger(value.http_status) &&
        value.http_status >= 100 &&
        value.http_status <= 599)
    ) ||
    typeof value.content !== "string" ||
    value.content.length > 8192 ||
    typeof value.error !== "string" ||
    value.error.length > 8192 ||
    !(
      value.error_source === null ||
      value.error_source === "http" ||
      value.error_source === "client"
    ) ||
    typeof value.truncated !== "boolean"
  )
    return invalid()
  return {
    http_status: value.http_status,
    content: value.content,
    error: value.error,
    error_source: value.error_source,
    truncated: value.truncated,
  }
}
function result(value: unknown): DiagnosticResult {
  const identity = started(value)
  if (
    !record(value) ||
    !["succeeded", "failed", "cancelled"].includes(String(value.status)) ||
    typeof value.finished_at !== "string" ||
    !Number.isFinite(Date.parse(value.finished_at)) ||
    !milliseconds(value.duration_ms) ||
    !(value.first_output_ms === null || milliseconds(value.first_output_ms)) ||
    !(value.error_code === null || typeof value.error_code === "string") ||
    typeof value.message !== "string"
  )
    return invalid()
  return {
    ...identity,
    finished_at: value.finished_at,
    status: value.status as DiagnosticResult["status"],
    first_output_ms: value.first_output_ms,
    duration_ms: value.duration_ms,
    error_code: value.error_code,
    message: value.message,
    ...(value.model_response === undefined
      ? {}
      : { model_response: modelResponse(value.model_response) }),
  }
}

async function request(method: "GET" | "POST", signal: AbortSignal) {
  const token = getAccessToken()
  let response: Response
  try {
    response = await fetch(`${agentApiBase}/model-diagnostics`, {
      method,
      signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: method === "POST" ? "text/event-stream" : "application/json",
      },
    })
  } catch (error) {
    if (signal.aborted) throw abortReason(signal)
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ModelDiagnosticError("无法连接诊断服务，请稍后重试。")
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message =
      record(body) && typeof body.detail === "string"
        ? body.detail
        : response.status === 401
          ? "登录已失效，请重新登录。"
          : "诊断服务暂不可用，请稍后重试。"
    if (response.status === 401 && clearAccessToken(token)) {
      setAuthFailureReason(message)
      if (typeof window !== "undefined")
        window.dispatchEvent(new CustomEvent("ask-metric:auth-invalid", { detail: message }))
    }
    throw new ModelDiagnosticError(
      message,
      response.status,
      record(body) && milliseconds(body.retry_after_ms) ? body.retry_after_ms : 0,
    )
  }
  return response
}

export async function getDiagnosticTarget(signal?: AbortSignal): Promise<DiagnosticTarget> {
  const timed = timedSignal(15000, signal)
  try {
    return target(await (await request("GET", timed.signal)).json())
  } finally {
    timed.dispose()
  }
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    abort = () => reject(abortReason(signal))
    timer = setTimeout(() => reject(new ModelDiagnosticError("诊断连接中断，请重新检测。")), 20000)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    else reader.read().then(resolve, reject)
  }).finally(() => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  })
}

export async function runModelDiagnostic(
  signal: AbortSignal,
  onProgress: (event: DiagnosticProgress) => void,
): Promise<DiagnosticResult> {
  const timed = timedSignal(75000, signal)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const decoder = new TextDecoder()
  let buffer = ""
  let identity: DiagnosticStarted | undefined
  try {
    const response = await request("POST", timed.signal)
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
      return invalid()
    reader = response.body.getReader()
    while (true) {
      const chunk = await readChunk(reader, timed.signal)
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      // 两段返回文本各有 8192 字符上限，JSON 转义后仍需容纳完整的结果事件。
      if (buffer.length > 131072) return invalid()
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const lines = frame.split(/\r?\n/u)
        const name = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim()
        if (!["started", "progress", "result"].includes(name ?? "")) continue
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        let value: unknown
        try {
          value = JSON.parse(data)
        } catch {
          return invalid()
        }
        if (name === "started") {
          identity = started(value)
          onProgress({ type: "started", ...identity })
        } else if (name === "progress") {
          if (
            !identity ||
            !record(value) ||
            value.phase !== "receiving" ||
            !milliseconds(value.first_output_ms)
          )
            return invalid()
          onProgress({
            type: "progress",
            phase: "receiving",
            first_output_ms: value.first_output_ms,
          })
        } else {
          const completed = result(value)
          if (!identity || identity.diagnostic_id !== completed.diagnostic_id) return invalid()
          return completed
        }
      }
    }
    throw new ModelDiagnosticError("诊断连接中断，未收到完整检测结果，请重新检测。")
  } finally {
    timed.dispose()
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
