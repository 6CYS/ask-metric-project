import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { assistantFailure } from "./assistantFailure.js";
import { messageText } from "./sessionStore.js";

/** 列表只返回最近一轮可展示文本的短摘要，不发送思考、工具参数或结果明细。 */
export function sessionPreview(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" && message.role !== "user") continue;
    const failure = assistantFailure(message);
    const text = failure || messageText(message.content);
    if (text) return text.replace(/\s+/g, " ").slice(0, 200);
  }
  return "尚未开始";
}
