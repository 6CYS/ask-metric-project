import { clearAccessToken, getAccessToken, setAuthFailureReason } from "./authSession"
import { isRecord, parseDatasetInput } from "./evaluation"
import type { AgentSessionMessage } from "./agentApi"
import type {
  DatasetInput,
  EvaluationDataset,
  EvaluationReview,
  EvaluationRun,
  EvaluationTurn,
  EvaluationTurnDetail,
  RunInput,
  RunStatus,
  TurnStatus,
  ExecutionResult,
} from "../types/evaluation"

export class EvaluationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "EvaluationApiError"
  }
}
function invalidResponse(): never {
  throw new EvaluationApiError("测评服务返回了无法识别的数据，请刷新后重试。", 502)
}
function requiredString(value: unknown): string {
  if (typeof value !== "string") return invalidResponse()
  return value
}
function nullableString(value: unknown): string | null {
  return value === null ? null : requiredString(value)
}
function decodeDataset(value: unknown): EvaluationDataset {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1
  )
    return invalidResponse()
  return {
    ...parseDatasetInput(value),
    id: requiredString(value.id),
    version: value.version,
    updated_at: requiredString(value.updated_at),
  }
}
function isRunStatus(value: unknown): value is RunStatus {
  return (
    typeof value === "string" &&
    ["running", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(value)
  )
}
function isTurnStatus(value: unknown): value is TurnStatus {
  return (
    typeof value === "string" &&
    ["pending", "running", "completed", "failed", "cancelled", "skipped"].includes(value)
  )
}
function decodeReview(value: unknown): EvaluationReview | null {
  if (value === null) return null
  if (!isRecord(value) || !["passed", "failed", "needs_review"].includes(String(value.verdict)))
    return invalidResponse()
  const verdict = value.verdict
  if (verdict !== "passed" && verdict !== "failed" && verdict !== "needs_review")
    return invalidResponse()
  return {
    verdict,
    note: requiredString(value.note),
    reviewer: requiredString(value.reviewer),
    updated_at: requiredString(value.updated_at),
  }
}
function decodeResult(value: unknown): EvaluationTurn["result"] {
  if (value === null) return null
  if (!isRecord(value) || !isRecord(value.timings_ms)) return invalidResponse()
  const status = value.status
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled"
  )
    return invalidResponse()
  const timings: ExecutionResult["timings_ms"] = {}
  for (const [key, timing] of Object.entries(value.timings_ms)) {
    if (timing === null || (typeof timing === "number" && Number.isFinite(timing)))
      timings[key] = timing
    else if (
      Array.isArray(timing) &&
      timing.every(
        (item: unknown): item is number => typeof item === "number" && Number.isFinite(item),
      )
    )
      timings[key] = timing
    else return invalidResponse()
  }
  if (status === "running") {
    if (
      value.run_status !== null ||
      value.answer_status !== null ||
      value.error_code !== null ||
      value.error_message !== null
    )
      return invalidResponse()
    return {
      status,
      user_entry_id: nullableString(value.user_entry_id),
      operation_id: nullableString(value.operation_id),
      run_status: null,
      answer_status: null,
      error_code: null,
      error_message: null,
      timings_ms: timings,
    }
  }
  return {
    status,
    user_entry_id: nullableString(value.user_entry_id),
    operation_id: nullableString(value.operation_id),
    run_status: nullableString(value.run_status),
    answer_status: nullableString(value.answer_status),
    error_code: nullableString(value.error_code),
    error_message: nullableString(value.error_message),
    timings_ms: timings,
  }
}
function decodeTurn(value: unknown): EvaluationTurn {
  if (!isRecord(value) || !isTurnStatus(value.status)) return invalidResponse()
  return {
    id: requiredString(value.id),
    group_id: requiredString(value.group_id),
    question: requiredString(value.question),
    expected: requiredString(value.expected),
    status: value.status,
    session_id: nullableString(value.session_id),
    request_id: nullableString(value.request_id),
    started_at: nullableString(value.started_at),
    finished_at: nullableString(value.finished_at),
    result: decodeResult(value.result),
    review: decodeReview(value.review),
  }
}
function decodeRun(value: unknown): EvaluationRun {
  if (
    !isRecord(value) ||
    !isRunStatus(value.status) ||
    !Array.isArray(value.turns) ||
    !isRecord(value.actor)
  )
    return invalidResponse()
  return {
    id: requiredString(value.id),
    name: requiredString(value.name),
    status: value.status,
    dataset: decodeDataset(value.dataset),
    dataset_hash: requiredString(value.dataset_hash),
    version_label: requiredString(value.version_label),
    data_label: requiredString(value.data_label),
    model: requiredString(value.model),
    config_hash: requiredString(value.config_hash),
    actor: {
      id: requiredString(value.actor.id),
      name: requiredString(value.actor.name),
      org_code: requiredString(value.actor.org_code),
      role_code: requiredString(value.actor.role_code),
    },
    created_at: requiredString(value.created_at),
    finished_at: nullableString(value.finished_at),
    turns: value.turns.map(decodeTurn),
  }
}
function decodeDetail(value: unknown): EvaluationTurnDetail {
  if (!isRecord(value) || !Array.isArray(value.messages)) return invalidResponse()
  const messages = value.messages.map((message: unknown): AgentSessionMessage => {
    if (
      !isRecord(message) ||
      typeof message.role !== "string" ||
      !(message.timestamp === null || typeof message.timestamp === "number")
    )
      return invalidResponse()
    const timestamp = message.timestamp
    if (message.role === "tool") {
      if (typeof message.is_error !== "boolean") return invalidResponse()
      return {
        role: "tool",
        tool: requiredString(message.tool),
        details: message.details,
        is_error: message.is_error,
        timestamp,
      }
    }
    if (message.role === "assistant")
      return {
        role: "assistant",
        text: requiredString(message.text),
        timestamp,
        ...(typeof message.error === "string" ? { error: message.error } : {}),
      }
    if (message.role === "user")
      return { role: "user", text: requiredString(message.text), timestamp }
    return {
      role: message.role,
      text: message.text === undefined ? undefined : requiredString(message.text),
      timestamp,
    }
  })
  return { turn: decodeTurn(value.turn), messages }
}
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = getAccessToken()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  init.signal?.addEventListener("abort", cancel, { once: true })
  if (init.signal?.aborted) controller.abort()
  const timer = setTimeout(cancel, 30_000)
  try {
    const response = await fetch(`/agent-api/evaluations${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : isRecord(body) && typeof body.detail === "string"
            ? body.detail
            : `测评请求失败（${response.status}），请稍后重试。`
      if (response.status === 401 && clearAccessToken(token)) {
        setAuthFailureReason(message)
        if (typeof window !== "undefined")
          window.dispatchEvent(new CustomEvent("ask-metric:auth-invalid", { detail: message }))
      }
      throw new EvaluationApiError(message, response.status)
    }
    return body
  } catch (error) {
    if (error instanceof EvaluationApiError) throw error
    if (init.signal?.aborted) throw new DOMException("请求已取消", "AbortError")
    throw new EvaluationApiError(
      controller.signal.aborted
        ? "测评请求超时，请刷新确认服务端状态；请勿重复发起批次。"
        : "无法连接测评服务，请稍后重试。",
      0,
    )
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", cancel)
  }
}
async function list<T>(path: string, decode: (value: unknown) => T, signal?: AbortSignal) {
  const response = await request(path, { signal })
  if (!isRecord(response) || !Array.isArray(response.items)) return invalidResponse()
  return response.items.map(decode)
}
const encoded = encodeURIComponent
export const evaluationApi = {
  listDatasets: (signal?: AbortSignal) => list("/datasets", decodeDataset, signal),
  listRuns: (signal?: AbortSignal) => list("/runs", decodeRun, signal),
  async saveDataset(input: DatasetInput, existing?: EvaluationDataset) {
    return decodeDataset(
      await request(existing ? `/datasets/${encoded(existing.id)}` : "/datasets", {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify(existing ? { ...input, version: existing.version } : input),
      }),
    )
  },
  async createRun(input: RunInput) {
    return decodeRun(await request("/runs", { method: "POST", body: JSON.stringify(input) }))
  },
  async getRun(id: string, signal?: AbortSignal) {
    return decodeRun(await request(`/runs/${encoded(id)}`, { signal }))
  },
  async cancelRun(id: string) {
    return decodeRun(await request(`/runs/${encoded(id)}/cancel`, { method: "POST" }))
  },
  async getTurn(runId: string, turnId: string, signal?: AbortSignal) {
    return decodeDetail(
      await request(`/runs/${encoded(runId)}/turns/${encoded(turnId)}`, { signal }),
    )
  },
  async reviewTurn(
    runId: string,
    turnId: string,
    input: Pick<EvaluationReview, "verdict" | "note">,
  ) {
    return decodeTurn(
      await request(`/runs/${encoded(runId)}/turns/${encoded(turnId)}/review`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    )
  },
}
export type EvaluationApi = typeof evaluationApi
