import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {businessKey} from "./business-context/service.js";

/** 完全相同的历史读取没有新增依据；第三次先拦截纠错，不能靠成功读取耗尽整轮预算。 */
export function repeatedContextRead(messages: readonly AgentMessage[], args: unknown): number {
  const calls = new Set(messages.flatMap(message => message.role === "assistant" ? message.content.flatMap(block =>
    block.type === "toolCall" && block.name === "business_context_read" && businessKey(block.arguments) === businessKey(args) ? [block.id] : []) : []));
  return messages.filter(message => message.role === "toolResult" && message.toolName === "business_context_read" && calls.has(message.toolCallId)).length;
}

/** 从原生本轮记录识别已重复的失败提案；读取旁支不重置，业务终态重置。 */
export function repeatedToolFailure(messages: readonly AgentMessage[]): boolean {
  const proposals = new Map<string, {name: string; args: string}>();
  const failures = new Set<string>();
  let repeated = false;
  let contextEvidence = "";
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") {
        proposals.set(block.id, {name: block.name, args: businessKey(block.arguments)});
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    if (message.toolName === "business_context_read" && !message.isError) {
      const context = (message.details as {context?: {references?: unknown[]; tasks?: Array<{task_ref?: string}>}} | undefined)?.context;
      if (context?.references?.length || context?.tasks?.some(task => task.task_ref)) contextEvidence = businessKey(context);
    }
    const details = message.details as {protocol_version?: number; status?: string; retryable?: boolean; issues?: unknown} | undefined;
    const businessResolved = message.toolName === "resolve_business_turn"
      && ["READY", "REUSE_RESULT", "NEEDS_CLARIFICATION", "ready", "needs_user", "prepared", "succeeded", "reused", "failed"].includes(details?.status ?? "");
    const businessExecuted = message.toolName === "execute_business_frame"
      && ["succeeded", "failed"].includes(details?.status ?? "");
    const businessRead = message.toolName === "read_business_result" && details?.status === "succeeded";
    if (!message.isError && (businessResolved || businessExecuted || businessRead)) {
      failures.clear();
      repeated = false;
      continue;
    }
    if (!message.isError && !["needs_interpretation", "invalid_input"].includes(details?.status ?? "") && !details?.retryable && details?.status !== "ARGUMENT_ERROR"
      && details?.status !== "reference_mismatch") continue;
    const proposal = proposals.get(message.toolCallId);
    if (!proposal || proposal.name !== message.toolName) continue;
    // 参数或错误变化仍交回模型纠正；同一失败提案再次出现才认定循环，总调用预算另行兜底。
    const fingerprint = businessKey({tool: proposal.name, args: proposal.args,
      failure: details?.protocol_version === 2 ? details.issues : message.content, contextEvidence});
    if (failures.has(fingerprint)) repeated = true;
    failures.add(fingerprint);
  }
  return repeated;
}
