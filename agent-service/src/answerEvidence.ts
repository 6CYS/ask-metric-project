/** 业务回执的确定性交付。正文、历史和重连共用；模型生成的事实不直接进入页面。 */
export interface BusinessEvidence {
  kind: string;
  status: string;
  task_id?: string | undefined;
  result_id?: string | undefined;
  row_count?: number | undefined;
  public_answer?: string | undefined;
  error_code?: string | undefined;
  clarification?: unknown;
}

export function businessEvidence(details: unknown): BusinessEvidence | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as BusinessEvidence;
  if (typeof value.status !== "string") return undefined;
  if (value.kind === "metric_read" && !value.result_id && !["error", "failed"].includes(value.status.toLowerCase())) return undefined;
  return ["metric_ask", "metric_read", "metric_query_structured", "metric_catalog_overview"].includes(value.kind) ? value : undefined;
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

/** 直接引用后端行的原始字符串；不做数值解析、单位换算或计算。 */
export function resultAnswer(result: { rows: Record<string, unknown>[]; row_count: number; truncated?: boolean | undefined; message?: string | null | undefined }): string {
  if (!result.row_count) return "查询完成，暂无匹配数据。";
  if (result.rows.every(row => typeof row.available_period === "string")) {
    if (result.message) return result.message;
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
