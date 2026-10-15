import {createHmac, randomBytes} from "node:crypto";

// 仅本进程内可比较；业务原文/数值不写日志，也不能靠公开字典反推出低熵字段。
const diagnosticKey = randomBytes(32);
const signature = (value: unknown) => createHmac("sha256", diagnosticKey).update(JSON.stringify(value) ?? "null").digest("hex");
export function modelPayloadDiagnostics(payload: Record<string, unknown>) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  return {
    final_payload_bytes: Buffer.byteLength(JSON.stringify(payload)),
    system_signature: signature(messages.filter(message => message && typeof message === "object" && ["system", "developer"].includes(String(message.role)))),
    tools_signature: signature(tools), messages_signature: signature(messages),
    tool_names: tools.map(tool => tool?.function?.name ?? tool?.name ?? "unknown"),
    message_count: messages.length,
    messages: messages.map(message => ({role: typeof message?.role === "string" ? message.role : "unknown",
      bytes: Buffer.byteLength(JSON.stringify(message) ?? "null"), signature: signature(message)})),
    tool_choice: payload.tool_choice ?? "auto",
  };
}
