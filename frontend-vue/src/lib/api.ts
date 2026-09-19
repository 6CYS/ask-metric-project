import { clearCatalogCaches, metricCatalogCache, organizationCatalogCache } from "@/lib/catalogCache"
import type {
  QueryReadiness,
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

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "ApiError"
  }
}

// Cookie 仅随同源认证请求发送；不启用跨域凭据或放宽服务端 CORS。
const browserSessionRequest = {
  credentials: "same-origin" as const,
  headers: { "X-Ask-Metric-Session": "1" },
  cache: "no-store" as const,
}

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
    throw new ApiError(message, response.status)
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

export function getBackendNextQueryReadiness(signal?: AbortSignal) {
  return request<QueryReadiness>(apiUrl(backendNextBase, "/api/v1/query-readiness"), { signal, cache: "no-store" }, false)
}

/** 每次登录获取当前公钥，避免后端重启或密钥轮换后仍使用旧公钥。 */
async function getSm2PublicKey(): Promise<string> {
  const response = await request<Sm2PublicKeyResponse>(
    "/api/v1/auth/sm2-public-key",
    { cache: "no-store" },
    false
  )
  return response.public_key
}

export async function loginUser(username: string, password: string) {
  // 国密传输：明文密码不出浏览器，SM4 加密密码、SM2 加密一次性 SM4 密钥。
  const sm2PublicKey = await getSm2PublicKey()
  const encrypted = encryptLoginPassword(password, sm2PublicKey)
  return request<LoginResponse>("/api/v1/auth/login", {
    ...browserSessionRequest,
    method: "POST",
    body: JSON.stringify({
      username,
      encrypted_key: encrypted.encryptedKey,
      iv: encrypted.iv,
      password: encrypted.passwordCipher,
    }),
  }, false)
}

export function ssoLoginUser(token: string) {
  return request<LoginResponse>("/api/v1/auth/sso", {
    ...browserSessionRequest,
    method: "POST",
    body: JSON.stringify({ token }),
  }, false)
}

export function getCurrentUser() {
  return request<AuthUser>("/api/v1/auth/me")
}

export function restoreBrowserSession() {
  // 页面刷新后内存令牌为空，浏览器自动携带 HttpOnly Cookie；前端不读取 Cookie。
  return request<LoginResponse>("/api/v1/auth/session", {
    ...browserSessionRequest,
    method: "POST",
  }, false)
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
  clearCatalogCaches()
  return request<void>("/api/v1/auth/logout", {
    ...browserSessionRequest,
    method: "POST",
  })
}

const backendNextBase = (import.meta.env.VITE_BACKEND_NEXT_BASE_URL ?? "").replace(/\/$/, "")

function apiUrl(base: string, path: string) {
  return `${base}${path}`
}

export function listQueryRuns(page = 1, pageSize = 10) {
  return request<{ items: QueryRunItem[]; total: number; page: number; page_size: number }>(apiUrl(backendNextBase, `/api/v1/catalog/query-runs?page=${page}&page_size=${pageSize}`))
}

export function getQueryRunOrganizations(taskId: string) {
  return request<{ raw_org_text?: string | null; matched_org_name?: string | null; notice?: string | null }>(
    apiUrl(backendNextBase, `/api/v1/catalog/query-runs/${encodeURIComponent(taskId)}/organizations`),
  )
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

export async function createMetric(payload: MetricPayload) {
  const result = await request<MetricItem>(apiUrl(backendNextBase, "/api/v1/catalog/metrics"), { method: "POST", body: JSON.stringify(payload) })
  metricCatalogCache.clear()
  return result
}

export async function updateMetric(metricCode: string, payload: MetricPayload) {
  const result = await request<MetricItem>(apiUrl(backendNextBase, `/api/v1/catalog/metrics/${encodeURIComponent(metricCode)}`), { method: "PUT", body: JSON.stringify(payload) })
  metricCatalogCache.clear()
  return result
}

export async function deleteMetric(metricCode: string) {
  const result = await request<void>(apiUrl(backendNextBase, `/api/v1/catalog/metrics/${encodeURIComponent(metricCode)}`), { method: "DELETE" })
  metricCatalogCache.clear()
  return result
}

export function listOrgs() {
  return request<{ items: OrgItem[] }>(apiUrl(backendNextBase, "/api/v1/catalog/organizations"))
}

export async function createOrg(payload: OrgPayload) {
  const result = await request<OrgItem>(apiUrl(backendNextBase, "/api/v1/catalog/organizations"), { method: "POST", body: JSON.stringify(payload) })
  organizationCatalogCache.clear()
  return result
}

export async function updateOrg(orgCode: string, payload: OrgPayload) {
  const result = await request<OrgItem>(apiUrl(backendNextBase, `/api/v1/catalog/organizations/${encodeURIComponent(orgCode)}`), { method: "PUT", body: JSON.stringify(payload) })
  organizationCatalogCache.clear()
  return result
}

export async function deleteOrg(orgCode: string) {
  const result = await request<void>(apiUrl(backendNextBase, `/api/v1/catalog/organizations/${encodeURIComponent(orgCode)}`), { method: "DELETE" })
  organizationCatalogCache.clear()
  return result
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

export function exportBackendNextTaskResult(taskId: string) {
  return downloadAuthenticated(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/result-export`), "查询结果.xlsx")
}

/** 不可变查询结果的分页视图（GET /query-tasks/{id}/result）；完整事实只从后端读取 */
export interface BackendTaskResultPage {
  task_id: string
  result_id: string
  status: string
  columns: string[]
  rows: Record<string, unknown>[]
  comparisons: Record<string, unknown>[]
  row_count: number
  truncated: boolean
  offset: number
  limit: number
  next_offset: number | null
  has_more: boolean
  message?: string | null
}

export function getBackendTaskResult(taskId: string, offset = 0, limit = 100) {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return request<BackendTaskResultPage>(
    apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}/result?${query}`),
    { cache: "no-store" }
  )
}

export function getCachedMetricCatalog() {
  return getAccessToken() ? metricCatalogCache.read(listBackendNextMetrics) : listBackendNextMetrics()
}

export function getCachedOrganizationCatalog() {
  return getAccessToken() ? organizationCatalogCache.read(listOrgs) : listOrgs()
}

/** 读取任务诊断，沿用当前用户 Bearer 和后端任务权限校验。 */
export function getBackendNextTask(taskId: string) {
  return request<BackendNextTaskResult>(apiUrl(backendNextBase, `/api/v1/query-tasks/${encodeURIComponent(taskId)}`), { cache: "no-store" })
}
