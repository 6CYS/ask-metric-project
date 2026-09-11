let accessToken: string | null = null
let authFailureReason = ""

/**
 * 认证令牌仅保存在当前页面的模块内存中，禁止写入 Web Storage。
 * 页面刷新或关闭后令牌自动失效，避免令牌被持久化并被其他脚本读取。
 */
export function getAccessToken() {
  return accessToken
}

export function setAccessToken(token: string) {
  accessToken = token
}

export function clearAccessToken(expectedToken?: string | null) {
  if (expectedToken !== undefined && accessToken !== expectedToken) return false
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
