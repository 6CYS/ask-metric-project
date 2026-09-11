/** 将基础设施和第三方服务错误转换为面向业务用户的简短提示，技术细节仍保留在调试信息中。 */
export function friendlyQueryError(message?: string | null, errorCode?: string | null) {
  const modelMessages: Record<string, string> = {
    MODEL_RESPONSE_INVALID: "模型返回格式异常，本次查询未完成。请联系管理员排查。",
    MODEL_REQUEST_TIMEOUT: "模型服务响应超时。请稍后重新查询。",
    MODEL_CONNECTION_FAILED: "暂时无法连接模型服务。请稍后重新查询。",
    MODEL_HTTP_ERROR: "模型服务返回异常状态。请稍后重试或联系管理员。",
    MODEL_CONFIGURATION_MISSING: "模型服务配置异常。请联系管理员检查。",
    MODEL_CONCURRENCY_LIMIT: "当前问数请求较多。请稍后重新查询。",
    MODEL_SERVICE_UNAVAILABLE: "模型服务暂时不可用。请稍后重新查询。",
  }
  const knownMessage = Object.prototype.hasOwnProperty.call(modelMessages, errorCode ?? "")
    ? modelMessages[errorCode ?? ""] : undefined
  if (knownMessage) return knownMessage
  const raw = `${errorCode ?? ""} ${message ?? ""}`.trim()
  const normalized = raw.toLowerCase()
  if (/failed to fetch|networkerror|load failed|econnrefused|connection refused|network request/.test(normalized)) {
    return "暂时无法连接问数服务。请检查网络连接，稍后重新查询。"
  }
  if (/timeout|timed out|deadline|504|gateway time-out/.test(normalized)) {
    if (/model|llm|模型/.test(normalized)) return "模型服务响应超时。请稍后重新查询。"
    if (/database|postgres|mysql|sql|数据库/.test(normalized)) return "数据服务响应超时。请稍后重新查询。"
    return "服务响应超时。请稍后重新查询。"
  }
  if (/model|llm|模型服务/.test(normalized)) {
    return "模型服务暂时不可用。请稍后重试或联系管理员。"
  }
  if (/database|postgres|mysql|sqlalchemy|connection pool|数据库连接/.test(normalized)) {
    return "数据服务暂时不可用。请稍后重新查询。"
  }
  if (/502|503|bad gateway|service unavailable/.test(normalized)) {
    return "问数服务暂时繁忙。请稍后重新查询。"
  }
  const containsChinese = /[\u3400-\u9fff]/.test(message ?? "")
  const looksTechnical = /[a-z]{3,}[\s_:/.()-]+[a-z0-9]|traceback|exception|error|http\s*\d/i.test(message ?? "")
  if (containsChinese && !looksTechnical) return message!.trim()
  return "本次查询暂未完成。请稍后重新查询。"
}
