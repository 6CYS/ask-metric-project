import type {AgentMessage} from "@earendil-works/pi-agent-core";

const HISTORICAL_KNOWLEDGE_NOTICE = "此为历史知识读取记录，正文不作为当前知识保留。需要业务知识时通过 business_topic_read 读取当前启用知识；知识仅用于方法和背景，不能代替正式指标口径、数值或归因证据。";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function knowledgeSource(message: Extract<AgentMessage, {role: "toolResult"}>) {
  if (message.toolName !== "business_topic_read" || message.isError
    || !record(message.details) || message.details.kind !== "business_topic_read" || message.details.status !== "ok") return;
  let source = message.details;
  if (source.content !== "knowledge") {
    // 旧回执没有内容类型；只认现有知识接口的形状，不能误裁剪正式指标目录。
    if (source.content !== undefined || message.content.length !== 1 || message.content[0]?.type !== "text") return;
    let receipt: unknown;
    try { receipt = JSON.parse(message.content[0].text); } catch { return; }
    if (!record(receipt) || !Array.isArray(receipt.entries) || "metrics" in receipt) return;
    source = receipt;
  }
  if (source.topic !== "deposit" && source.topic !== "loan") return;
  return {topic: source.topic, content: "knowledge", ...(typeof source.revision === "string" ? {revision: source.revision} : {})};
}

function historicalOverviewKnowledge(value: unknown): unknown {
  if (!record(value) || value.protocol_version !== 2 || !record(value.state) || !record(value.state.evidence)) return value;
  const evidence = value.state.evidence;
  if (evidence.kind !== "business_overview" || evidence.status !== "succeeded" || !Array.isArray(evidence.knowledge)) return value;
  // 概览回执附带同源知识；只省略该已知字段，正式数值和来源仍由原证据链使用。
  const {knowledge: _knowledge, ...retained} = evidence;
  return {...value, state: {...value.state, evidence: {...retained, knowledge_notice: HISTORICAL_KNOWLEDGE_NOTICE}}};
}

/** 维护后的知识由工具实时读取；历史正文仅在发送副本中省略，不改会话存档和页面回执。 */
export function projectBusinessKnowledgeContext(messages: readonly AgentMessage[]): AgentMessage[] {
  let currentTurn = messages.length - 1;
  while (currentTurn >= 0 && messages[currentTurn]?.role !== "user") currentTurn -= 1;
  if (currentTurn < 0) currentTurn = messages.length;
  return messages.map((message, index) => {
    if (index >= currentTurn || message.role !== "toolResult" || message.isError) return message;
    const source = knowledgeSource(message);
    if (!source) {
      if (!["resolve_business_turn", "execute_business_frame", "read_business_result"].includes(message.toolName)
        || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
      let receipt: unknown;
      try { receipt = JSON.parse(message.content[0].text); } catch { return message; }
      const projected = historicalOverviewKnowledge(receipt);
      if (projected === receipt) return message;
      return {...message, content: [{type: "text", text: JSON.stringify(projected)}], details: historicalOverviewKnowledge(message.details)};
    }
    const historical = {...source, historical: true};
    return {...message, content: [{type: "text", text: JSON.stringify({...historical,
      notice: HISTORICAL_KNOWLEDGE_NOTICE})}],
      details: {kind: "business_topic_read", status: "ok", ...historical}};
  });
}
