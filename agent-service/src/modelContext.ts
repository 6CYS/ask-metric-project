import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mayDeliverWithoutEvidence } from "./replyGuard.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只精简过去成功回执的发送副本；当前轮、失败、澄清和证据不完整的消息原样保留。 */
export function projectHistoricalResults(messages: readonly AgentMessage[]): AgentMessage[] {
  let currentTurn = messages.length - 1;
  while (currentTurn >= 0 && messages[currentTurn]?.role !== "user") currentTurn -= 1;
  let hasHistoricalResult = false;
  let question = "";
  return messages.map((message, index) => {
    if (message.role === "user") {
      hasHistoricalResult = false;
      question = typeof message.content === "string" ? message.content
        : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    }
    if (index < currentTurn && message.role === "assistant"
      && !message.content.some(block => block.type === "toolCall")
      && (hasHistoricalResult || !mayDeliverWithoutEvidence(message.content.filter(block => block.type === "text")
        .map(block => block.text).join("\n"), question))) {
      // 中断/取消时也可能持久化未经核验的数值片段；发送上下文不能再次传播这些片段。
      return { ...message, content: [{ type: "text" as const, text: "该轮已完成，条件和引用见工具回执。新查询或计算须重新取数；明确回看查询历史时才回读快照，不能凭记忆重述旧值。" }] };
    }
    if (index >= currentTurn || message.role !== "toolResult" || message.isError
      || !["metric_ask", "metric_read", "metric_query_structured", "metric_calculate"].includes(message.toolName)
      || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let receipt: unknown;
    try { receipt = JSON.parse(message.content[0].text); } catch { return message; }
    if (record(receipt) && message.toolName === "metric_calculate" && receipt.status === "succeeded") {
      hasHistoricalResult = true;
      const inputs = record(receipt.inputs) ? Object.fromEntries(Object.entries(receipt.inputs).map(([name, input]) =>
        [name, record(input) ? Object.fromEntries(["task_id", "metric_code", "metric_name", "org_code", "org_name", "date", "unit"]
          .filter(key => input[key] !== undefined).map(key => [key, input[key]])) : {}])) : {};
      return {...message, content: [{type: "text", text: JSON.stringify({
        status: receipt.status, calculation_id: receipt.calculation_id, inputs,
        historical_values_omitted: true, usage_hint: "历史计算仅保留条件；再次计算必须重新取数并使用本轮 fact_id。",
      })}]};
    }
    if (!record(receipt) || String(receipt.status).toLowerCase() !== "succeeded"
      || !receipt.task_id || !receipt.result_id || !record(receipt.query_evidence)) return message;
    const dsl = receipt.query_evidence.logical_dsl;
    if (!record(dsl) || !record(dsl.time)
      || typeof dsl.time.start !== "string" || typeof dsl.time.end !== "string"
      || !Array.isArray(dsl.metrics) || !dsl.metrics.length
      || !Array.isArray(dsl.orgs)) return message;
    const { rows, sample_rows, comparisons, facts, message: answer, public_answer, answer_blocks, public_answer_blocks, ...retained } = receipt;
    if (!Array.isArray(rows) && !Array.isArray(sample_rows) && !Array.isArray(comparisons)) return message;
    hasHistoricalResult = true;
    return { ...message, content: [{ type: "text", text: JSON.stringify({
      ...retained, historical_rows_omitted: true,
    }) }] };
  });
}
