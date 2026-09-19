import type { AgentMessage } from "@earendil-works/pi-agent-core";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只精简过去成功回执的发送副本；当前轮、失败、澄清和证据不完整的消息原样保留。 */
export function projectHistoricalResults(messages: readonly AgentMessage[]): AgentMessage[] {
  let currentTurn = messages.length - 1;
  while (currentTurn >= 0 && messages[currentTurn]?.role !== "user") currentTurn -= 1;
  return messages.map((message, index) => {
    if (index >= currentTurn || message.role !== "toolResult" || message.isError
      || !["metric_ask", "metric_read"].includes(message.toolName)
      || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let receipt: unknown;
    try { receipt = JSON.parse(message.content[0].text); } catch { return message; }
    if (!record(receipt) || String(receipt.status).toLowerCase() !== "succeeded"
      || !receipt.task_id || !receipt.result_id || !record(receipt.query_evidence)) return message;
    const dsl = receipt.query_evidence.logical_dsl;
    if (!record(dsl) || !record(dsl.time) || !dsl.time.start || !dsl.time.end
      || !Array.isArray(dsl.metrics) || !dsl.metrics.length
      || !Array.isArray(dsl.orgs) || !dsl.orgs.length) return message;
    const { rows, sample_rows, comparisons, ...retained } = receipt;
    if (!Array.isArray(rows) && !Array.isArray(sample_rows) && !Array.isArray(comparisons)) return message;
    return { ...message, content: [{ type: "text", text: JSON.stringify({
      ...retained, historical_rows_omitted: true,
    }) }] };
  });
}
