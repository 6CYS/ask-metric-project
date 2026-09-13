import type {
  BackendNextConversationSnapshot,
  BackendNextExecutionResult,
  BackendNextTaskResult,
  DatasetItem,
  DatasetPayload,
  ConfigVersion,
  ModelRuntimeConfig,
  PromptTemplateConfig,
  SmartConfigResponse,
  SqlTemplateConfig,
  MetricItem,
  MetricPayload,
  OrgItem,
  OrgPayload,
  QueryRunItem,
  AuthUser,
  LoginResponse,
  Sm2PublicKeyResponse,
  BackendNextConversationListItem,
  BackendNextConversationCleanupResult,
  AccuracySuite,
  AccuracyRun,
  AccuracyImportPreview,
  AccuracyImportResult,
} from "@/types/api"
import { encryptLoginPassword } from "@/lib/gm"
import {
  clearAccessToken,
  getAccessToken,
  setAuthFailureReason,
} from "@/lib/authSession"

/**
 * 提取 FastAPI 的 detail 错误，同时兼容非 JSON 响应，页面可直接展示有意义的失败原因。
 */
async function getRequestErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed: ${response.status}`
  const text = await response.text()
  if (!text) return fallback

  try {
    const data = JSON.parse(text) as { detail?: unknown; code?: string; message?: string }
    if (typeof data.message === "string" && data.message.trim()) {
      return data.code ? `${data.message} (${data.code})` : data.message
    }
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail
    if (data.detail !== undefined) return JSON.stringify(data.detail)
  } catch {
    // 非 JSON 错误正文也应原样反馈，便于定位代理或后端异常。
  }

  return text.trim() || fallback
}

async function request<T>(path: string, init?: RequestInit, authenticated = true): Promise<T> {
  const token = getAccessToken()
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const message = await getRequestErrorMessage(response)
    // A request started by the previous login can finish after the user has
    // already signed in again. Only invalidate the token that actually sent
    // this request so a stale 401 cannot log out the new session.
    if (response.status === 401 && authenticated && clearAccessToken(token)) {
      setAuthFailureReason(message)
      window.dispatchEvent(new CustomEvent("ask-metric:auth-invalid", { detail: message }))
    }
    throw new Error(message)
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T
  return response.json() as Promise<T>
}

async function downloadAuthenticated(path: string, fallbackName: string) {
  const token = getAccessToken()
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(await getRequestErrorMessage(response))
  const disposition = response.headers.get("content-disposition") ?? ""
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  const filename = encoded ? decodeURIComponent(encoded) : fallbackName
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

let cachedSm2PublicKey: string | null = null

/** 登录前获取后端 SM2 公钥（模块级缓存；重启后端更换临时密钥时会随页面刷新失效）。 */
async function getSm2PublicKey(): Promise<string> {
  if (!cachedSm2PublicKey) {
    const response = await request<Sm2PublicKeyResponse>(
      apiUrl(backendNextBase, "/api/v1/auth/sm2-public-key"),
      undefined,
      false
    )
    cachedSm2PublicKey = response.public_key
  }
  return cachedSm2PublicKey
}

export async function loginUser(username: string, password: string) {
  // 国密传输：明文密码不出浏览器，SM4 加密密码、SM2 加密一次性 SM4 密钥。
  const sm2PublicKey = await getSm2PublicKey()
  const encrypted = encryptLoginPassword(password, sm2PublicKey)
  try {
    return await request<LoginResponse>(apiUrl(backendNextBase, "/api/v1/auth/login"), {
      method: "POST",
      body: JSON.stringify({
        username,
        encrypted_key: encrypted.encryptedKey,
        iv: encrypted.iv,
        password: encrypted.passwordCipher,
      }),
    }, false)
  } catch (error) {
    // 后端重启（开发环境临时密钥）或私钥轮换后，缓存的公钥已失效；
    // 清掉缓存，用户重试时会重新拉取新公钥。
    cachedSm2PublicKey = null
    throw error
  }
}

export function ssoLoginUser(token: string) {
  return request<LoginResponse>(apiUrl(backendNextBase, "/api/v1/auth/sso"), {
    method: "POST",
    body: JSON.stringify({ token }),
  }, false)
}

export function getCurrentUser() {
  return request<AuthUser>(apiUrl(backendNextBase, "/api/v1/auth/me"))
}

export function listAccuracySuites() {
  return request<AccuracySuite[]>(apiUrl(backendNextBase, "/api/v1/test-center/suites"))
}

export function createAccuracySuite(value: Pick<AccuracySuite, "name" | "description" | "cases">) {
  return request<AccuracySuite>(apiUrl(backendNextBase, "/api/v1/test-center/suites"), { method: "POST", body: JSON.stringify(value) })
}

export function updateAccuracySuite(id: string, value: Pick<AccuracySuite, "name" | "description" | "cases">) {
  return request<AccuracySuite>(apiUrl(backendNextBase, `/api/v1/test-center/suites/${encodeURIComponent(id)}`), { method: "PUT", body: JSON.stringify(value) })
}

export function deleteAccuracySuite(id: string) {
  return request<void>(apiUrl(backendNextBase, `/api/v1/test-center/suites/${encodeURIComponent(id)}`), { method: "DELETE" })
}

export function listAccuracyRuns() {
  return request<AccuracyRun[]>(apiUrl(backendNextBase, "/api/v1/test-center/runs"))
}

export function getAccuracyRun(id: string) {
  return request<AccuracyRun>(apiUrl(backendNextBase, `/api/v1/test-center/runs/${encodeURIComponent(id)}`))
}

export function startAccuracyRun(suiteId: string) {
  return request<AccuracyRun>(apiUrl(backendNextBase, `/api/v1/test-center/runs?suite_id=${encodeURIComponent(suiteId)}`), { method: "POST" })
}

export function downloadAccuracyImportTemplate() {
  return downloadAuthenticated(
    apiUrl(backendNextBase, "/api/v1/test-center/import-template"),
    "准确率测试案例导入模板.xlsx",
  )
}

export function previewAccuracyImport(
  suiteId: string,
  file: File,
  mode: "append" | "replace",
) {
  return request<AccuracyImportPreview>(
    apiUrl(
      backendNextBase,
      `/api/v1/test-center/suites/${encodeURIComponent(suiteId)}/imports/preview?mode=${mode}`,
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  )
}

export function confirmAccuracyImport(
  suiteId: string,
  value: { mode: "append" | "replace"; cases: AccuracySuite["cases"] },
) {
  return request<AccuracyImportResult>(
    apiUrl(
      backendNextBase,
      `/api/v1/test-center/suites/${encodeURIComponent(suiteId)}/imports/confirm`,
    ),
    { method: "POST", body: JSON.stringify(value) },
  )
}

export function logoutUser() {
  return request<void>(apiUrl(backendNextBase, "/api/v1/auth/logout"), { method: "POST" })
}

const backendNextBase = (import.meta.env.VITE_BACKEND_NEXT_BASE_URL ?? "").replace(/\/$/, "")

function apiUrl(base: string, path: string) {
  return `${base}${path}`
}

export function listQueryRuns() {
  return request<{ items: QueryRunItem[] }>(apiUrl(backendNextBase, "/api/v1/catalog/query-runs"))
}

export function getQueryRunDetail(taskId: string) {
  return request<QueryRunItem>(apiUrl(backendNextBase, `/api/v1/catalog/query-runs/${encodeURIComponent(taskId)}`))
}

export function getSmartConfig() {
  return request<SmartConfigResponse>(apiUrl(backendNextBase, "/api/v1/model-config"))
}

function configAdminHeaders(adminToken: string) {
  return { "X-Model-Admin-Token": adminToken }
}

export function updateSmartModel(config: ModelRuntimeConfig, adminToken: string, apiKeys: Partial<Record<"chat" | "embedding" | "reranker", string>> = {}) {
  return request<SmartConfigResponse>(apiUrl(backendNextBase, "/api/v1/model-config/model"), {
    method: "PUT",
    headers: configAdminHeaders(adminToken),
    body: JSON.stringify({ config, api_keys: apiKeys }),
  })
}

export function testSmartModel(
  role: "chat" | "embedding" | "reranker",
  adminToken: string,
  config: ModelRuntimeConfig,
  apiKeys: Partial<Record<"chat" | "embedding" | "reranker", string>> = {},
) {
  return request<{ role: string; ok: boolean; duration_ms: number; summary: string }>(apiUrl(backendNextBase, `/api/v1/model-config/model/test/${role}`), {
    method: "POST",
    headers: configAdminHeaders(adminToken),
    body: JSON.stringify({ config, api_keys: apiKeys }),
  })
}

export function updatePromptConfig(name: string, prompt: PromptTemplateConfig, adminToken: string) {
  return request<PromptTemplateConfig>(apiUrl(backendNextBase, `/api/v1/model-config/prompts/${encodeURIComponent(name)}`), {
    method: "PUT", headers: configAdminHeaders(adminToken), body: JSON.stringify(prompt),
  })
}

export function listPromptVersions(name: string) {
  return request<ConfigVersion[]>(apiUrl(backendNextBase, `/api/v1/model-config/prompts/${encodeURIComponent(name)}/versions`))
}

export function rollbackPromptConfig(name: string, versionId: string, adminToken: string) {
  return request<PromptTemplateConfig>(apiUrl(backendNextBase, `/api/v1/model-config/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}/rollback`), {
    method: "POST", headers: configAdminHeaders(adminToken),
  })
}

export function listSqlTemplates() {
  return request<SqlTemplateConfig[]>(apiUrl(backendNextBase, "/api/v1/model-config/sql-templates"))
}

export function validateSqlTemplate(sql: string) {
  return request<{ valid: boolean; parameters: string[] }>(apiUrl(backendNextBase, "/api/v1/model-config/sql-templates/validate"), {
    method: "POST", body: JSON.stringify({ sql }),
  })
}

export function trialRunSqlTemplate(sql: string, parameters: Record<string, unknown>, adminToken: string) {
  return request<{ columns: string[]; rows: Record<string, unknown>[]; row_count: number }>(apiUrl(backendNextBase, "/api/v1/model-config/sql-templates/trial-run"), {
    method: "POST", headers: configAdminHeaders(adminToken), body: JSON.stringify({ sql, parameters }),
  })
}

export function updateSqlTemplate(item: SqlTemplateConfig, adminToken: string) {
  return request<SqlTemplateConfig>(apiUrl(backendNextBase, `/api/v1/model-config/sql-templates/${encodeURIComponent(item.dialect)}/${encodeURIComponent(item.template)}`), {
    method: "PUT", headers: configAdminHeaders(adminToken), body: JSON.stringify({ sql: item.sql, enabled: item.enabled }),
  })
}

export function listSqlTemplateVersions(item: SqlTemplateConfig) {
  return request<ConfigVersion[]>(apiUrl(backendNextBase, `/api/v1/model-config/sql-templates/${encodeURIComponent(item.dialect)}/${encodeURIComponent(item.template)}/versions`))
}

export function rollbackSqlTemplate(item: SqlTemplateConfig, versionId: string, adminToken: string) {
  return request<SqlTemplateConfig>(apiUrl(backendNextBase, `/api/v1/model-config/sql-templates/${encodeURIComponent(item.dialect)}/${encodeURIComponent(item.template)}/versions/${encodeURIComponent(versionId)}/rollback`), {
    method: "POST", headers: configAdminHeaders(adminToken),
  })
}

export function listMetrics() {
  return listBackendNextMetrics()
}

export function listBackendNextMetrics() {
  return request<{ items: MetricItem[] }>(apiUrl(backendNextBase, "/api/v1/catalog/metrics"))
}

export function createMetric(payload: MetricPayload) {
  return request<MetricItem>(apiUrl(backendNextBase, "/api/v1/catalog/metrics"), { method: "POST", body: JSON.stringify(payload) })
}

export function updateMetric(metricCode: string, payload: MetricPayload) {
  return request<MetricItem>(apiUrl(backendNextBase, `/api/v1/catalog/metrics/${encodeURIComponent(metricCode)}`), { method: "PUT", body: JSON.stringify(payload) })
}

export function deleteMetric(metricCode: string) {
  return request<void>(apiUrl(backendNextBase, `/api/v1/catalog/metrics/${encodeURIComponent(metricCode)}`), { method: "DELETE" })
}

export function listOrgs() {
  return request<{ items: OrgItem[] }>(apiUrl(backendNextBase, "/api/v1/catalog/organizations"))
}

export function createOrg(payload: OrgPayload) {
  return request<OrgItem>(apiUrl(backendNextBase, "/api/v1/catalog/organizations"), { method: "POST", body: JSON.stringify(payload) })
}

export function updateOrg(orgCode: string, payload: OrgPayload) {
  return request<OrgItem>(apiUrl(backendNextBase, `/api/v1/catalog/organizations/${encodeURIComponent(orgCode)}`), { method: "PUT", body: JSON.stringify(payload) })
}

export function deleteOrg(orgCode: string) {
  return request<void>(apiUrl(backendNextBase, `/api/v1/catalog/organizations/${encodeURIComponent(orgCode)}`), { method: "DELETE" })
}

export function listDatasets() {
  return request<{ items: DatasetItem[] }>(apiUrl(backendNextBase, "/api/v1/catalog/datasets"))
}

export function createDataset(payload: DatasetPayload) {
  return request<DatasetItem>(apiUrl(backendNextBase, "/api/v1/catalog/datasets"), { method: "POST", body: JSON.stringify(payload) })
}

export function updateDataset(datasetId: number, payload: DatasetPayload) {
  return request<DatasetItem>(apiUrl(backendNextBase, `/api/v1/catalog/datasets/${datasetId}`), { method: "PUT", body: JSON.stringify(payload) })
}

export function deleteDataset(datasetId: number) {
  return request<void>(apiUrl(backendNextBase, `/api/v1/catalog/datasets/${datasetId}`), { method: "DELETE" })
}

export function createBackendNextQuestion(payload: {
  conversation_id: string
  message: string
  idempotency_key: string
}) {
  return request<BackendNextTaskResult>(apiUrl(backendNextBase, "/api/v1/questions"), {
    method: "POST",
    headers: { "Idempotency-Key": payload.idempotency_key },
    body: JSON.stringify(payload),
  })
}

export function analyzeBackendNextTask(taskId: string, expectedVersion: number) {
  return request<BackendNextTaskResult>(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/analyze`), {
    method: "POST",
    body: JSON.stringify({ expected_version: expectedVersion }),
  })
}

export function submitBackendNextClarification(
  taskId: string,
  payload: { expected_version: number; clarification_id: string; answers: unknown },
) {
  return request<BackendNextTaskResult>(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/clarifications`), {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export function cancelBackendNextClarification(
  taskId: string,
  payload: { expected_version: number; clarification_id: string },
) {
  return request<BackendNextTaskResult>(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/clarifications/cancel`), {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export function executeBackendNextTask(taskId: string, expectedVersion: number, requestId: string) {
  return request<BackendNextExecutionResult>(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/execute`), {
    method: "POST",
    headers: { "Idempotency-Key": requestId },
    body: JSON.stringify({ expected_version: expectedVersion }),
  })
}

export function getBackendNextTask(taskId: string) {
  return request<BackendNextTaskResult>(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}`))
}

export function getBackendNextConversation(conversationId: string) {
  return request<BackendNextConversationSnapshot>(apiUrl(backendNextBase, `/api/v1/conversations/${encodeURIComponent(conversationId)}`))
}

export function listBackendNextConversations(limit = 12, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request<{ items: BackendNextConversationListItem[]; has_more: boolean }>(apiUrl(backendNextBase, `/api/v1/conversations?${params}`))
}

export function renameBackendNextConversation(conversationId: string, title: string) {
  return request<BackendNextConversationListItem>(apiUrl(backendNextBase, `/api/v1/conversations/${encodeURIComponent(conversationId)}`), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  })
}

export function deleteBackendNextConversation(conversationId: string) {
  return request<void>(apiUrl(backendNextBase, `/api/v1/conversations/${encodeURIComponent(conversationId)}`), {
    method: "DELETE",
  })
}

export function cleanupBackendNextConversations(keepLatest: number) {
  const params = new URLSearchParams({ keep_latest: String(keepLatest) })
  return request<BackendNextConversationCleanupResult>(apiUrl(backendNextBase, `/api/v1/conversations?${params}`), {
    method: "DELETE",
  })
}

export function exportBackendNextConversation(conversationId: string) {
  return downloadAuthenticated(apiUrl(backendNextBase, `/api/v1/conversations/${encodeURIComponent(conversationId)}/export`), "会话记录.xlsx")
}

export function exportBackendNextTaskResult(taskId: string) {
  return downloadAuthenticated(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/result-export`), "查询结果.xlsx")
}
