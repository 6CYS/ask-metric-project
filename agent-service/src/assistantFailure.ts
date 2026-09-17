import { messageText } from "./sessionStore.js";

/** 仅返回面向用户的固定提示，不向浏览器透传模型原始异常或思考内容。 */
export function assistantFailure(message: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } | undefined): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted") return "模型调用已中止，请重新发送问题。";
  if (message.stopReason === "error" || message.errorMessage) return "模型调用失败或连接中断，请重试。";
  if (message.stopReason === "length") return "模型输出达到长度限制，回答可能不完整，请重试。";
  const hasTools = Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall");
  if (!hasTools && !messageText(message.content)) return "模型未返回有效回答，请重试。";
  return undefined;
}
