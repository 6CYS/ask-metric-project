import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mayDeliverWithoutEvidence } from "./replyGuard.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只精简过去成功回执的发送副本；当前轮、失败、澄清和证据不完整的消息原样保留。 */
export function projectHistoricalResults(messages: readonly AgentMessage[]): AgentMessage[] {
  let currentTurn = messages.length - 1;
  while (currentTurn >= 0 && messages[currentTurn]?.role !== "user") currentTurn -= 1;
  const factIndexes = historicalFactIndexes(messages, currentTurn);
  let hasHistoricalResult = false;
  let question = "";
  let frameTurn = false;
  return messages.map((original, index) => {
    const landed = landedAsExecution(original);
    const projected = project(landed, index);
    if (landed === original || original.role !== "toolResult" || projected.role !== "toolResult") return projected;
    // 分类用的工具名不能进入发送副本：须与助手 toolCall 的名称保持一致。
    if (projected !== landed) return {...projected, toolName: original.toolName};
    // 未裁剪的落地回执仍去掉旧版追加的说明块（失败时它会误导“查询已执行”）。
    return landed.content.length === original.content.length ? original : {...original, content: landed.content};
  });

  function project(message: AgentMessage, index: number): AgentMessage {
    if (message.role === "user") {
      hasHistoricalResult = false;
      frameTurn = (message as {businessProtocol?: string}).businessProtocol === "frame_v1";
      question = typeof message.content === "string" ? message.content
        : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    }
    if (message.role === "toolResult" && ["resolve_business_turn", "business_context_read", "execute_business_frame", "read_business_result"].includes(message.toolName)) frameTurn = true;
    if (message.role === "toolResult" && message.toolName === "resolve_business_turn") {
      let receipt: unknown;
      try { receipt = JSON.parse(firstText(message)); } catch { return message; }
      if (record(receipt) && record(receipt.fields)) {
        const fields = Object.fromEntries(Object.entries(receipt.fields).filter(([, field]) => record(field) && field.resolutionStatus !== "missing")
          .map(([name, field]) => [name, record(field) ? {rawValue: field.rawValue, resolvedValue: field.resolvedValue,
            resolutionStatus: field.resolutionStatus, ...(field.pendingChoices ? {pendingChoices: field.pendingChoices} : {})} : field]));
        // 历史解析动作已过期，只保留状态/条件/引用；本轮回执的下一动作保持完整。
        const {next_action, arguments: nextArguments, message: instruction, ...historical} = receipt;
        const projected = index < currentTurn ? {...historical, historical: true} : receipt;
        return {...message, content: [{type: "text", text: JSON.stringify({...projected, fields})}], details: undefined};
      }
    }
    if (index < currentTurn && message.role === "toolResult" && message.toolName === "business_context_read") {
      // 目录与完整 Frame 读取不在每个后续回合重复展开；权威状态由焦点/引用重新读取。
      return {...message, content: [{type: "text", text: "已读取业务状态；当前焦点见会话状态，其他历史按 frameId 或序号重新读取。"}], details: undefined};
    }
    if (!frameTurn && index < currentTurn && message.role === "assistant"
      && !message.content.some(block => block.type === "toolCall")
      && (hasHistoricalResult || !mayDeliverWithoutEvidence(message.content.filter(block => block.type === "text")
        .map(block => block.text).join("\n"), question))) {
      // 中断/取消时也可能持久化未经核验的数值片段；发送上下文不能再次传播这些片段。
      return { ...message, content: [{ type: "text" as const, text: "该轮已完成，条件和引用见工具回执。回看历史或沿用原值计算，须通过受控工具读取指定查询快照；改变条件或要求刷新时重新查询，不能凭聊天记忆重述或计算旧值。" }] };
    }
    if (index < currentTurn && message.role === "toolResult" && !message.isError
      && ["execute_business_frame", "read_business_result"].includes(message.toolName)) {
      let receipt: unknown;
      try { receipt = JSON.parse(firstText(message)); } catch { receipt = undefined; }
      if (record(receipt) && receipt.status === "succeeded") {
        hasHistoricalResult = true;
        const details = record(message.details) ? message.details : {};
        const compact = Object.fromEntries(["status", "task_id", "result_id", "frame_id", "result_ref", "row_count", "truncated", "has_more", "next_offset"]
          .filter(key => receipt[key] !== undefined || details[key] !== undefined).map(key => [key, receipt[key] ?? details[key]]));
        return {...message, content: [{type: "text", text: JSON.stringify({...compact, historical_rows_omitted: true,
          ...factIndexReceipt(factIndexes.get(index))})}],
          details: compact};
      }
    }
    if (index >= currentTurn || message.role !== "toolResult" || message.isError
      || !["metric_ask", "metric_read", "read", "metric_query_structured", "metric_calculate", "execute_business_frame", "read_business_result"].includes(message.toolName)
      || (message.toolName === "read" && (message.details as {kind?: string} | undefined)?.kind !== "metric_read")
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
        historical_values_omitted: true, usage_hint: "历史计算仅保留条件和来源；沿用原值计算时，通过受控工具读取指定查询快照并使用其 fact_id。改变条件或要求刷新时先重新查询；不能从聊天文本取值，也不能把计算结果当作查询事实引用。",
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
      ...retained, historical_rows_omitted: true, ...factIndexReceipt(factIndexes.get(index)),
    }) }] };
  }
}

const FACT_REFERENCE_FIELDS = ["fact_id", "org_code", "org_name", "metric_code", "metric_name", "date", "unit"] as const;
type FactReference = Record<typeof FACT_REFERENCE_FIELDS[number], string>;

/** 只保留少量完整查询的事实身份，不携带金额；执行端仍按引用重新鉴权取值。 */
function historicalFactIndexes(messages: readonly AgentMessage[], currentTurn: number): Map<number, FactReference[]> {
  const indexes = new Map<number, FactReference[]>();
  const results = new Set<string>();
  let remaining = 60;
  for (let index = currentTurn - 1; index >= 0 && remaining > 0 && results.size < 3; index -= 1) {
    const message = landedAsExecution(messages[index]!);
    if (message.role !== "toolResult" || message.isError
      || !["execute_business_frame", "read_business_result", "metric_ask", "metric_read", "metric_query_structured", "read"].includes(message.toolName)
      || message.toolName === "read" && (message.details as {kind?: string} | undefined)?.kind !== "metric_read") continue;
    let receipt: unknown;
    try { receipt = JSON.parse(firstText(message)); } catch { continue; }
    if (!record(receipt) || receipt.status !== "succeeded" || typeof receipt.task_id !== "string"
      || typeof receipt.result_id !== "string" || receipt.calculation_id || results.has(receipt.result_id)
      || receipt.truncated || receipt.result_truncated || receipt.facts_truncated || receipt.has_more
      || record(receipt.query_evidence) && receipt.query_evidence.missing_metric_notice
      || !Array.isArray(receipt.facts) || !receipt.facts.length || receipt.facts.length > Math.min(20, remaining)
      || receipt.fact_count !== receipt.facts.length) continue;
    const refs: FactReference[] = [];
    for (const fact of receipt.facts) {
      if (!record(fact) || fact.task_id !== receipt.task_id
        || !FACT_REFERENCE_FIELDS.every(key => typeof fact[key] === "string" && fact[key].length > 0 && fact[key].length <= 180)) break;
      const match = (fact.fact_id as string).match(/^fact:([^:]+):(\d+):(metric_value|current_value|base_value)$/);
      if (!match || match[1] !== receipt.task_id) break;
      refs.push(Object.fromEntries(FACT_REFERENCE_FIELDS.map(key => [key, fact[key]])) as FactReference);
    }
    // 不把不完整/非法索引当作完整清单，回退到原有受控结果读取。
    if (refs.length !== receipt.facts.length || new Set(refs.map(ref => ref.fact_id)).size !== refs.length) continue;
    indexes.set(index, refs);
    results.add(receipt.result_id);
    remaining -= refs.length;
  }
  return indexes;
}

function factIndexReceipt(refs: FactReference[] | undefined) {
  return refs ? {fact_refs: refs,
    fact_reference_hint: "以上为完整查询的事实引用索引，不含数值。沿用这些原值计算可直接将对应 fact_id 填入 bindings，执行端会鉴权并读取原值，无需先回读结果。result_id 是整份结果编号，不能当作 fact_id。改变条件或刷新时先重新查询。"} : {};
}

function firstText(message: Extract<AgentMessage, {role: "toolResult"}>): string {
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

/**
 * 解析回执就地落地执行后，原生记录的工具名仍是 resolve_business_turn，内容却是查询/回读结果；
 * 投影时按 execute_business_frame 处理，才能与普通执行回执一样裁剪历史行值。
 * 旧版本落地回执另追加过一段说明文本（第二块），只取首块 JSON。
 */
function landedAsExecution(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult" || message.toolName !== "resolve_business_turn") return message;
  let receipt: unknown;
  try { receipt = JSON.parse(firstText(message)); } catch { return message; }
  if (!record(receipt) || record(receipt.fields)) return message;
  return {...message, toolName: "execute_business_frame", content: message.content.slice(0, 1)};
}
