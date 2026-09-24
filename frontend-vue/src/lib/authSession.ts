import { clearCatalogCaches } from "@/lib/catalogCache"

let accessToken: string | null = null
let authFailureReason = ""

/**
 * 认证令牌仅保存在当前页面的模块内存中，禁止写入 Web Storage。
 * 刷新会清空内存副本；有效期内由后端校验 HttpOnly Cookie 后恢复，前端不读取 Cookie。
 */
export function getAccessToken() {
  return accessToken
}

export function setAccessToken(token: string) {
  clearCatalogCaches()
  accessToken = token
}

export function clearAccessToken(expectedToken?: string | null) {
  if (expectedToken !== undefined && accessToken !== expectedToken) return false
  clearCatalogCaches()
  accessToken = null
  return true
}

export function hasAccessToken() {
  return Boolean(accessToken)
}

export function setAuthFailureReason(reason: string) {
  authFailureReason = reason
}

export function consumeAuthFailureReason() {
  const reason = authFailureReason
  authFailureReason = ""
  return reason
}

// 仅保存非敏感的入口偏好；不参与鉴权，不保存令牌或用户信息。
export function setLoginMethod(method: "password" | "sso") {
  loginMethod = method
  try { sessionStorage.setItem("ask-metric:login-method", method) } catch { /* 存储禁用时使用内存。 */ }
}
let loginMethod: "password" | "sso" | null = null
export function getLoginMethod(): "password" | "sso" | null {
  if (loginMethod) return loginMethod
  try {
    const value = sessionStorage.getItem("ask-metric:login-method")
    return value === "password" || value === "sso" ? value : null
  } catch { return null }
}
