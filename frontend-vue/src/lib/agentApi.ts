import { clearAccessToken, getAccessToken, setAuthFailureReason } from "@/lib/authSession"
import type { BackendNextClarification } from "@/types/api"

/**
 * 智能助手（agent-service）接口封装。
 * 使用同源相对路径 /agent-api：开发环境由 vite proxy 代理到本机 agent-service，
 * 生产环境由 Nginx 同源代理，产物代码不写入任何固定服务地址。
 */
const agentApiBase = "/agent-api"

export class AgentApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "AgentApiError"
  }
}

/** 原生会话持久化；404 不可自动重建并重发。 */
export class AgentSessionNotFoundError extends AgentApiError {
  constructor(message = "智能助手会话不存在，请选择其他会话或新建会话。") {
    super(message, 404)
    this.name = "AgentSessionNotFoundError"
  }
}

/** 会话条目；legacy 为旧格式只读会话，不可再提问。 */
export interface AgentSessionItem {
  session_id: string
  title?: string
  created_at: string
  last_active_at: string
  running: boolean
  legacy?: boolean
}

/** 历史消息条目：用户提问、助手回答（含调用过的工具名）、工具结果明细。 */
export type AgentSessionMessage =
  | { role: "user"; text: string; timestamp: number | null }
  | { role: "assistant"; text: string; tools?: string[]; timestamp: number | null }
  | { role: "tool"; tool: string; details: unknown; is_error: boolean; timestamp: number | null }
  | { role: string; text?: string; timestamp: number | null }

export interface AgentSessionDetail {
  session_id: string
  title?: string
  created_at: string
  running: boolean
  /** 当前活动原生 operation；重连后用于显式停止 */
  operation_id?: string | null
  legacy?: boolean
  messages: AgentSessionMessage[]
}

/** metric_ask / 结构化查询工具结束时附带的结构化结果引用；完整明细经后端 result 接口分页读取。 */
export interface MetricAskDetails {
  kind: "metric_ask" | "metric_query_structured" | "metric_read"
  task_id?: string
  version?: number
  result_id?: string
  status: string
  public_answer?: string
  columns?: string[]
  rows?: Record<string, unknown>[]
  row_count?: number
  truncated?: boolean
  clarification_prompt?: string
  /** 后端结构化澄清对象原样透传，供前端渲染澄清表单。 */
  clarification?: BackendNextClarification | null
}

/** 提问输入（协议 V3）：request_id 由浏览器每次确认发送生成，网络重试不变 */
export interface AgentPromptInput {
  request_id: string
  message: string
  send_as?: "new_question"
  clarification_target?: { task_id: string; version: number; clarification_id: string }
  selected_answers?: Record<string, unknown>
}

export type AgentSnapshot = Pick<AgentSessionDetail, "messages" | "running" | "operation_id">

export type AgentStreamEvent =
  | { type: "accepted"; operation_id?: string; request_id?: string; snapshot?: AgentSnapshot }
  | ({ type: "snapshot" } & AgentSnapshot)
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; tool: string; tool_call_id?: string }
  | { type: "tool_end"; tool: string; tool_call_id?: string; details: unknown; isError: boolean }
  | { type: "message_done"; text: string }
  | {
      type: "run_terminal"
      run_status: string
      answer_status: string
      error_code?: string | null
      business_tasks?: Array<{ task_id: string; status: string; result_id?: string | null; error_code?: string | null }>
      timings_ms?: { auth_ms: number; total_ms: number; model_ms?: number[]; tool_ms?: number[] }
    }
  | { type: "error"; message?: string }

/** 提取 agent-service 的 detail 错误，兼容非 JSON 响应，页面可直接展示失败原因。 */
async function getRequestErrorMessage(response: Response): Promise<string> {
  const fallback = `智能助手请求失败（${response.status}）`
  const text = await response.text()
  if (!text) return fallback
  try {
    const data = JSON.parse(text) as { detail?: unknown }
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail
    if (data.detail !== undefined) return JSON.stringify(data.detail)
  } catch {
    // 非 JSON 错误正文原样反馈，便于定位代理或服务异常。
  }
  return text.trim() || fallback
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken()
  let response: Response
  try {
    response = await fetch(`${agentApiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new AgentApiError("无法连接智能助手服务，请确认服务已启动后重试。", 0)
  }
  if (!response.ok) {
    const message = await getRequestErrorMessage(response)
    // 与主接口一致：仅使本次请求实际使用的令牌失效，避免过期 401 顶掉新登录会话。
    if (response.status === 401 && clearAccessToken(token)) {
      setAuthFailureReason(message)
      window.dispatchEvent(new CustomEvent("ask-metric:auth-invalid", { detail: message }))
    }
    if (response.status === 404) throw new AgentSessionNotFoundError(message)
    throw new AgentApiError(message, response.status)
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T
  return response.json() as Promise<T>
}

export function createAgentSession() {
  return request<{ session_id: string; created_at: string }>("/sessions", { method: "POST" })
}

export function listAgentSessions() {
  return request<{ items: AgentSessionItem[] }>("/sessions", { cache: "no-store" })
}

export function getAgentSession(sessionId: string) {
  return request<AgentSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" })
}

export function deleteAgentSession(sessionId: string) {
  return request<void>(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
}

/** 显式停止：原生取消指定 operation；只停止观察不等于取消执行 */
export function cancelAgentOperation(sessionId: string, operationId: string) {
  return request<void>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ operation_id: operationId }),
  })
}

export interface AgentPromptOptions {
  signal?: AbortSignal
  onEvent: (event: AgentStreamEvent) => void
}

/**
 * 发起提问并读取 SSE 事件流（协议 V3）。
 * EventSource 不支持 POST 与自定义请求头，这里用 fetch + ReadableStream 手动解析。
 * fetch abort 只停止观察，不取消服务端执行；停止需调用 cancelAgentOperation。
 */
export async function promptAgentSession(sessionId: string, input: AgentPromptInput, options: AgentPromptOptions) {
  return streamAgentSession(sessionId, input, options)
}

export function observeAgentSession(sessionId: string, options: AgentPromptOptions) {
  return streamAgentSession(sessionId, undefined, options)
}

async function streamAgentSession(sessionId: string, input: AgentPromptInput | undefined, options: AgentPromptOptions) {
  const token = getAccessToken()
  let response: Response
  try {
    response = await fetch(`${agentApiBase}/sessions/${encodeURIComponent(sessionId)}/${input ? "prompt" : "stream"}`, {
      method: input ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(input ? { body: JSON.stringify({ protocol_version: 3, ...input }) } : {}),
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new AgentApiError("无法连接智能助手服务，请确认服务已启动后重试。", 0)
  }
  if (!response.ok) {
    const messageText = await getRequestErrorMessage(response)
    if (response.status === 401 && clearAccessToken(token)) {
      setAuthFailureReason(messageText)
      window.dispatchEvent(new CustomEvent("ask-metric:auth-invalid", { detail: messageText }))
    }
    if (response.status === 404) throw new AgentSessionNotFoundError(messageText)
    throw new AgentApiError(messageText, response.status)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new AgentApiError("当前浏览器不支持流式响应，请更换浏览器后重试。", 0)

  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let terminated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // 统一 CRLF，按空行切分事件块。
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseBlock(block)
        if (event) {
          if (event.type === "run_terminal" || event.type === "error") terminated = true
          options.onEvent(event)
        }
        boundary = buffer.indexOf("\n\n")
      }
      if (terminated) return
    }
    if (!terminated) {
      throw new AgentApiError("智能助手连接中断，回答可能不完整；请刷新查看最终状态。", 0)
    }
  } catch (error) {
    if (isAgentAbortError(error) || error instanceof AgentApiError) throw error
    throw new AgentApiError("智能助手连接中断，正在重新获取执行状态。", 0)
  } finally {
    // 断线只停止观察：服务端原生 operation 继续执行，重连后可读快照恢复。
    reader.cancel().catch(() => {})
  }
}

function parseSseBlock(block: string): AgentStreamEvent | null {
  let eventName = ""
  const dataLines: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
  }
  if (!eventName || !dataLines.length) return null
  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>
  } catch {
    return null
  }
  return { ...data, type: eventName } as AgentStreamEvent
}

export function isAgentAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
