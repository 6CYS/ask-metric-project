export interface ModelFailure {
  code: string;
  message: string;
  retryable: boolean;
  reason: string;
}

/** 仅解释模型传输错误，不改写原生错误或其重试策略；网关正文不进入用户提示。 */
export function modelFailure(error: string): ModelFailure {
  const failure = (code: string, message: string, retryable: boolean, reason: string): ModelFailure =>
    ({code, message, retryable, reason});
  const status = Number(/^(?:HTTP\s+)?(\d{3})(?:\s|:|$)/iu.exec(error)?.[1]);
  if (error.startsWith("MODEL_STREAM_IDLE_EXCEEDED"))
    return failure("MODEL_STREAM_IDLE_EXCEEDED", "回答生成长时间没有进展，本轮已结束。可以稍后重试。", true, "模型输出暂时没有进展");
  if (/^MODEL_(?:FIRST_RESPONSE_TIMEOUT|DEADLINE_EXCEEDED)/u.test(error) || status === 408 || status === 504)
    return failure("MODEL_FIRST_RESPONSE_TIMEOUT", "模型服务响应超时，本轮未完成。可以稍后重试。", true, "模型服务暂未响应");
  if (status === 402 || /\b(?:insufficient_quota|out of budget|billing|monthly usage limit reached)\b/iu.test(error))
    return failure("MODEL_QUOTA_EXCEEDED", "模型服务额度不足，本轮未完成。请联系管理员处理后重试。", false, "模型服务额度不足");
  if (status === 401 || status === 403)
    return failure("MODEL_AUTHENTICATION_FAILED", "模型服务授权异常，本轮未完成。请联系管理员检查配置。", false, "模型服务授权异常");
  if (status === 429 || /\b(?:QPM|RPM|TPM|rate_limit_exceeded|rate.?limit|too many requests)\b/iu.test(error))
    return failure("MODEL_RATE_LIMITED", "模型服务当前请求较多，本轮暂未完成。请稍后重试。", true, "模型服务当前请求较多");
  if (status >= 500 || /\b(?:service.?unavailable|overloaded)\b/iu.test(error))
    return failure("MODEL_SERVICE_UNAVAILABLE", "模型服务暂时不可用，本轮未完成。请稍后重试。", true, "模型服务暂时不可用");
  if (/\b(?:connection.?error|connection.?refused|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up)\b/iu.test(error))
    return failure("MODEL_CONNECTION_FAILED", "与模型服务的连接中断，本轮未完成。请稍后重试。", true, "模型服务连接中断");
  if (error.startsWith("MODEL_CONFIGURATION_INVALID"))
    return failure("MODEL_CONFIGURATION_INVALID", "模型服务配置尚未就绪。请联系管理员检查配置。", false, "模型服务配置尚未就绪");
  if (/MODEL_STREAM_FAILED|Stream ended without|stream ended before|terminated/iu.test(error))
    return failure("MODEL_STREAM_FAILED", "回答生成中断，本轮未完成。可以稍后重试。", true, "模型输出中断");
  if (error.startsWith("MODEL_OUTPUT_TRUNCATED"))
    return failure("MODEL_OUTPUT_TRUNCATED", "本次回答未完整生成，可以缩小问题范围后重试。", false, "模型输出未完整生成");
  return failure("MODEL_RESPONSE_FAILED", "本轮模型响应未完成；已取得的步骤结果仍可查看，请稍后重试。", true, "模型响应暂未完成");
}
