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
    // 语义进展只认正式条件、候选和根因。随机引用、参数改写与重复读取不产生新进展。
    const semantic = details as typeof details & {state?: {targets?: Array<{conditions?: unknown[]; pending?: unknown[]}>};
      issues?: Array<{code?: string; field?: string; category?: string; message?: string}>; pending_questions?: Array<{scope?: {field?: string}; options?: Array<{label?: string}>}>};
    const progress = semantic?.protocol_version === 2 ? {
      conditions: semantic.state?.targets?.map(target => ({conditions: target.conditions, pending: target.pending})),
      questions: semantic.pending_questions?.map(question => ({field: question.scope?.field, options: question.options?.map(option => option.label)})),
    } : undefined;
    const fingerprint = businessKey({tool: proposal.name,
      // 同一plan字段可先后暴露漏子问题、错误引用、循环依赖；这些受控校验诊断不同，仍属有效纠错。
      // 其他根因仍忽略文案和随机引用，不能靠改写参数或错误措辞无限续命。
      failure: semantic?.protocol_version === 2 ? [...new Set(semantic.issues?.map(issue => JSON.stringify([issue.code, issue.field, issue.category,
        ["ANALYSIS_PLAN_INVALID", "INPUT_SHAPE_INVALID"].includes(issue.code ?? "") ? issue.message : undefined])))].sort() : message.content,
      progress, ...(semantic?.protocol_version === 2 ? {} : {args: proposal.args, contextEvidence})});
    if (failures.has(fingerprint)) repeated = true;
    failures.add(fingerprint);
  }
  return repeated;
}
