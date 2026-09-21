import type { AnswerBlock } from "./backendClient.js";

/** 业务回执的确定性交付。正文、历史和重连共用；模型生成的事实不直接进入页面。 */
export interface BusinessEvidence {
  kind: string;
  retryable?: boolean;
  /** 只有指定能力成功才解决本条方法转交回执，其他中间成功不算。 */
  recovery_kind?: string;
  delivery?: "business_evidence_v1";
  status: string;
  task_id?: string | undefined;
  source_task_id?: string;
  result_id?: string | undefined;
  row_count?: number | undefined;
  public_answer?: string | undefined;
  /** 结构化回答正文（后端渲染块），原样透传给前端；缺省时前端解析 public_answer */
  public_answer_blocks?: unknown;
  error_code?: string | undefined;
  clarification?: unknown;
}

export function businessEvidence(details: unknown): BusinessEvidence | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as BusinessEvidence;
  if (typeof value.status !== "string") return undefined;
  if (value.kind === "metric_read" && !value.result_id && !["error", "failed"].includes(value.status.toLowerCase())) return undefined;
  if (value.delivery === "business_evidence_v1") return value;
  // 兼容已持久化的旧会话回执；新工具在注册处声明交付契约。
  return ["metric_ask", "metric_read", "metric_query_structured", "metric_catalog_overview", "data_availability", "metric_calculate"].includes(value.kind) ? value : undefined;
}

export function evidenceAnswer(evidence: BusinessEvidence): string {
  if (evidence.public_answer) return evidence.public_answer;
  if (evidence.status.toLowerCase() === "succeeded" && evidence.result_id) {
    return evidence.row_count === 0 ? "查询完成，暂无匹配数据。" : "查询完成，已读取对应结果，请查看数据明细。";
  }
  if (evidence.status === "clarification_required") {
    const clarification = evidence.clarification as { prompt?: string } | undefined;
    return clarification?.prompt ?? "请补充查询条件。";
  }
  if (["pending", "RUNNING"].includes(evidence.status)) return "本次查询结果尚未确认，请稍后回查原任务。";
  if (evidence.status === "unsupported") return "当前不支持该查询，请完整描述基础指标问题。";
  return "本次查询未取得可核验的结果，不能提供该条件下的数值。请确认条件后重试。";
}

/** 事实正文统一以后端确定性渲染的 message 为准（格式化、单位、日期口径的唯一实现）；仅当后端未给 message 时才走本地兜底拼接，兜底直接引用原始字符串，不做数值解析、单位换算或计算。 */
export function resultAnswer(result: { rows: Record<string, unknown>[]; row_count: number; truncated?: boolean | undefined; message?: string | null | undefined }): string {
  if (result.message) {
    return result.truncated ? `${result.message}（结果存在截断，完整结果请查看数据明细。）` : result.message;
  }
  if (!result.row_count) return "查询完成，暂无匹配数据。";
  if (result.rows.every(row => typeof row.available_period === "string")) {
    const groups = new Map<string, string[]>();
    for (const row of result.rows) {
      const label = `${String(row.org_name ?? row.org_code ?? "")}的${String(row.metric_name ?? row.metric_code ?? "")}`;
      const periods = groups.get(label) ?? [];
      periods.push(String(row.available_period));
      groups.set(label, periods);
    }
    return [...groups].map(([label, periods]) => `${label}有数据的期间：${periods.slice(0, 12).join("、")}。`).join("\n")
      + (result.truncated || result.row_count > 12 ? "更多期间请查看数据明细；当前展示可能未覆盖全部结果。" : "");
  }
  if (result.row_count > 3 || result.truncated) return `查询完成，已返回 ${result.row_count} 条记录，请查看数据明细${result.truncated ? "；结果存在截断" : ""}。`;
  if (!result.rows.every(row => row.org_name && row.metric_name && row.stat_date && row.metric_value !== undefined)) {
    return `查询完成，已返回 ${result.row_count} 条记录，请查看数据明细。`;
  }
  return result.rows.map(row => `${String(row.stat_date)}，${String(row.org_name)}的${String(row.metric_name)}${row.metric_value === null ? "暂无可用值" : `为${String(row.metric_value)}${String(row.unit ?? "")}`}。`).join("\n");
}

/**
 * 结构化回答正文的透传出口：后端给了 answer_blocks 就原样返回，
 * 截断时把 resultAnswer 同款截断提示以独立段落块追加在末尾；
 * 后端未给（null/缺省/空数组）时返回 undefined，由前端回退纯文本解析 public_answer。
 */
export function resultAnswerBlocks(result: { answer_blocks?: AnswerBlock[] | null | undefined; truncated?: boolean | undefined }): AnswerBlock[] | undefined {
  const blocks = result.answer_blocks;
  if (!blocks || blocks.length === 0) return undefined;
  if (!result.truncated) return blocks;
  return [...blocks, { type: "paragraph", segments: [{ text: "（结果存在截断，完整结果请查看数据明细。）", bold: false }] }];
}

/** 收集本轮所有步骤，重放同一结果去重；失败不能被较早成功回执覆盖。 */
export function combinedEvidenceAnswer(evidences: BusinessEvidence[]): string {
  return activeEvidence(evidences).map(evidenceAnswer).join("\n\n");
}

export function activeEvidence(evidences: BusinessEvidence[]): BusinessEvidence[] {
  const unique = new Map<string, BusinessEvidence>();
  for (const [index, item] of evidences.entries()) {
    // 为修改条件而读取的来源不是本轮目标答案；后续追问即使无数据也不能夹带来源旧值。
    if (item.kind === "metric_read" && item.task_id && evidences.slice(index + 1).some(next =>
      next.kind === "metric_ask" && next.source_task_id === item.task_id)) continue;
    if (item.retryable && item.recovery_kind && evidences.slice(index + 1).some(next =>
      next.kind === item.recovery_kind && next.status === "succeeded")) continue;
    // 可纠正参数失败被同工具后续成功明确解决时，不把旧提示作为最终失败交付。
    if (item.retryable && evidences.slice(index + 1).some(next => next.kind === item.kind && next.status === "succeeded")) continue;
    const calculation = (item as BusinessEvidence & {calculation_id?: string}).calculation_id;
    const key = calculation ?? `${item.kind}:${item.task_id ?? item.result_id ?? ""}:${evidenceAnswer(item)}`;
    unique.set(key, item);
  }
  return [...unique.values()];
}

export interface EvidenceReference { ref: string; evidence: BusinessEvidence }

/** 引用由当前原生用户回合投影，压缩/重开不另存状态，也不能引用上一轮结果。 */
export function currentTurnEvidence(messages: {role?: string; details?: unknown}[]): EvidenceReference[] {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  return messages.slice(start + 1).filter(message => message.role === "toolResult")
    .map(message => businessEvidence(message.details)).filter(item => item !== undefined)
    .map((evidence, index) => ({ref: `e${index + 1}`, evidence}));
}

export interface PresentedAnswer {
  kind: "answer_present";
  delivery: "business_answer_v1";
  status: "delivered";
  evidence_refs: string[];
  public_answer: string;
}

export function presentedAnswer(details: unknown): PresentedAnswer | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as PresentedAnswer;
  return value.kind === "answer_present" && value.delivery === "business_answer_v1"
    && value.status === "delivered" && typeof value.public_answer === "string"
    && Array.isArray(value.evidence_refs) ? value : undefined;
}

/** pi 决定相关性与顺序；宿主校验引用和未解决失败，正文只取不可变回执。 */
export function selectEvidence(references: EvidenceReference[], refs: string[]): PresentedAnswer {
  if (!refs.length || new Set(refs).size !== refs.length) throw new Error("请选择非空且不重复的本轮证据引用。");
  const selected = refs.map(ref => {
    const entry = references.find(item => item.ref === ref);
    if (!entry) throw new Error(`证据引用 ${ref} 不属于当前回合，请核对当前证据列表。`);
    return entry.evidence;
  });
  const active = activeEvidence(references.map(item => item.evidence));
  if (selected.some(item => !active.includes(item))) throw new Error("所选证据已被后续回执替代，请选择纠正后的结果。");
  const unresolved = active.filter(item => !["succeeded", "catalog"].includes(item.status.toLowerCase()));
  if (unresolved.some(item => !selected.includes(item))) throw new Error("本轮仍有未解决的失败或待确认状态，请继续处理，或同时引用该状态，不得仅交付局部成功。");
  return {kind: "answer_present", delivery: "business_answer_v1", status: "delivered",
    evidence_refs: refs, public_answer: selected.map(evidenceAnswer).join("\n\n")};
}
