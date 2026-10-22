/** 排名在程序中基于完整集合计算；模型只需已核验榜单和入榜事实，完整明细留在原回执。 */
export function rankingModelView(result: Record<string, unknown>, aliases: Map<string, string>) {
  const plan = result.plan as {steps?: Array<{method: string}>} | undefined;
  if (!plan?.steps?.length || plan.steps.some(step => step.method !== "ranking")) return undefined;
  const items = result.evidence_items as Array<Record<string, unknown>>;
  const observations = result.observations as Array<{type: string; fact_refs?: string[]}>;
  if (!Array.isArray(items) || !Array.isArray(observations)) return undefined;
  const winners = new Set(observations.filter(item => item.type === "ranking").flatMap(item => item.fact_refs ?? []));
  const names = new Map([...aliases].map(([alias, ref]) => [ref, alias]));
  const judgments = items.filter(item => item.judgment_kind === "ranking");
  return {
    observations: undefined,
    verified_findings: {version: "verified-findings-v1", boundary: "排序依据完整同日有效值；缺数不补零，不能据此评价整体经营或推断原因。",
      items: judgments.map(item => ({ref: names.get(String(item.ref)), kind: "ranking", text: item.display,
        date: item.date, org_code: item.org_code, evidence_count: (item.input_refs as string[] | undefined)?.length ?? 0}))},
    evidence_items: items.filter(item => item.type !== "observation" && (["gap", "scope"].includes(String(item.type)) || winners.has(String(item.fact_id))))
      .map(item => ({ref: names.get(String(item.ref)), type: item.type, display: item.display,
        metric_name: item.metric_name, org_name: item.org_name, org_code: item.org_code, date: item.date})),
    detail_policy: "排名已由程序对完整机构集合逐期计算，判断短引用包含完整比较证据链。正文引用这些判断及关键入榜值；全部原始明细留在表格及服务端回执，未发送模型的明细不代表未分析。不得自行重算或把不同日期快照相加。",
  };
}
