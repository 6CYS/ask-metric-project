import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import type {EvidenceReference} from "../answerEvidence.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import {analysisEvidenceAliases} from "../analysis/verifiedFindings.js";
import {buildReportChart, prefersReportText, reportChartSchema, reportChartTopic, reportChartCompositionSelections, reportChartSectionCharts, type ReportChartSelection} from "../analysis/reportCharts.js";
import {currentTurnMessages} from "../tools/turnContract.js";
import {selectedReportPlan, type SelectedReportPlan} from "./reportFormat.js";

export interface InquiryChartSelection {
  kind: "inquiry_chart";
  status: "succeeded";
  selection: ReportChartSelection;
  source_refs: string[];
  run_refs: string[];
}

function readInquiryChart(message: AgentMessage): InquiryChartSelection | undefined {
  if (message.role !== "toolResult" || message.toolName !== "analysis_chart" || message.isError) return;
  const value = message.details as Partial<InquiryChartSelection> | undefined;
  if (value?.kind === "inquiry_chart" && value.status === "succeeded"
    && ["bar", "line", "pie", "grouped_bar"].includes(value.selection?.type ?? "")
    && Array.isArray(value.source_refs) && value.source_refs.length >= 2 && value.source_refs.length <= 24
    && value.source_refs.every(ref => typeof ref === "string" && !!ref)
    && Array.isArray(value.run_refs) && value.run_refs.length > 0 && value.run_refs.every(ref => typeof ref === "string" && !!ref)
    && Array.isArray(value.selection?.evidence_refs)
    && value.selection.evidence_refs.length === value.source_refs.length
    && value.selection.evidence_refs.every((ref, index) => ref === value.source_refs?.[index])) return value as InquiryChartSelection;
  return undefined;
}

/** 选择只在当前用户回合内生效；同一图的引用重排不重复占用报告位置。 */
export function inquiryCharts(messages: AgentMessage[]): InquiryChartSelection[] {
  const selected = new Map<string, InquiryChartSelection>();
  for (const message of currentTurnMessages(messages)) {
    const value = readInquiryChart(message);
    if (!value) continue;
    const key = JSON.stringify([value.selection.type, [...value.source_refs].sort()]);
    if (!selected.has(key)) selected.set(key, value);
  }
  return [...selected.values()];
}

/** 比较与趋势直接按事实维度成图；仅结构候选读取正式组成关系，不额外取数。 */
export async function buildInquiryChart(sources: Parameters<typeof buildReportChart>[0], selection: ReportChartSelection | undefined,
  request: AskMetricRequestContext, narrativeRefs?: readonly string[], signal?: AbortSignal,
  reportPlan?: SelectedReportPlan | null) {
  signal?.throwIfAborted();
  if (prefersReportText(request.originalMessage)) return {charts: []};
  const topics = new Map<string, Record<string, unknown> | undefined>();
  async function readTopic(id: string) {
    if (!topics.has(id)) {
      try {
        const topic = await request.backend.businessTopic(id, false, {signal});
        signal?.throwIfAborted();
        topics.set(id, topic);
      } catch (error) {
        if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        topics.set(id, undefined);
      }
    }
    return topics.get(id);
  }
  if (selection?.type === "pie") {
    const id = reportChartTopic(sources, selection);
    const topic = id ? await readTopic(id) : undefined;
    if (id && !topic) return {charts: [], notice: "暂时无法读取组成关系，已保留查询结果，本次未生成饼图。"};
    return buildReportChart(sources, selection, request.originalMessage, narrativeRefs, topic);
  }
  const result = buildReportChart(sources, selection, request.originalMessage, narrativeRefs);
  if (selection) return result;
  // 报告准备阶段可显式传入已解析结果；null 不再为选图回读无关历史。
  const plan = reportPlan === undefined ? selectedReportPlan((await request.turnMessages?.()) ?? []) : reportPlan;
  if (plan) {
    const sectionCharts = reportChartSectionCharts(sources, plan.report_layout.sections.filter(section => section.table),
      plan.org_codes, narrativeRefs);
    const covered = new Set(sectionCharts.flatMap(chart => chart.source_refs));
    result.charts = [...sectionCharts, ...result.charts.filter(chart =>
      chart.type !== "bar" || !chart.source_refs.every(ref => covered.has(ref)))];
  }
  for (const candidate of reportChartCompositionSelections(sources, narrativeRefs)) {
    const topic = await readTopic(candidate.topic);
    if (!topic) continue;
    const composition = buildReportChart(sources, undefined, request.originalMessage,
      candidate.selection.evidence_refs, topic);
    result.charts.push(...composition.charts.filter(chart => chart.type === "pie"));
  }
  return result;
}

/** 只保存引用选择；数值在最终报告鉴权成功后从所选来源重新生成。 */
export function createInquiryChartTool(): AgentHarnessTool<AskMetricRequestContext, typeof reportChartSchema> {
  return {name: "analysis_chart", label: "选择图表", parameters: reportChartSchema,
    description: "可选：从本轮已有结果选择柱图、分组柱图、折线图或结构饼图，随后正常撰写回答。分组柱图用于同日同口径的多指标、多机构完整对比。饼图需同日总量及完整分项的余额或数量，程序计算占比；不能把总量同时画成扇区。只引用真实数值原子，不取数、不提交手写图值。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      try {
        const sources = (await request.answerEvidence?.() ?? []).filter((item): item is EvidenceReference & {evidence: AnalysisEvidence} =>
          item.evidence.kind === "analysis_evidence" && item.evidence.status === "succeeded"
          && typeof (item.evidence as AnalysisEvidence).run_ref === "string");
        const aliases = new Map(sources.flatMap(item => [...analysisEvidenceAliases(item.ref, item.evidence.evidence_items ?? [])]));
        const known = new Set(sources.flatMap(item => item.evidence.evidence_items?.map(atom => atom.ref) ?? []));
        const selection = {...input, evidence_refs: input.evidence_refs.map(ref => aliases.get(ref) ?? ref)};
        if (selection.evidence_refs.some(ref => !known.has(ref)))
          throw new BackendApiError(422, "图表包含不属于本轮成功来源的引用，请使用取数回执中的真实引用。", "ANALYSIS_CHART_REFERENCE");
        const generated = await buildInquiryChart(sources, selection, request, undefined, context.abortSignal);
        if (!generated.charts.length) throw new BackendApiError(422, generated.notice ?? "本次问题要求文字回答，暂未准备图表。", "ANALYSIS_CHART_SELECTION");
        const sourceRefs = [...new Set(generated.charts.flatMap(chart => chart.source_refs))];
        const runRefs = [...new Set(sources.filter(item => item.evidence.evidence_items?.some(atom => sourceRefs.includes(atom.ref)))
          .map(item => item.evidence.run_ref))];
        const details: InquiryChartSelection = {kind: "inquiry_chart", status: "succeeded",
          selection: {type: selection.type, evidence_refs: sourceRefs}, source_refs: sourceRefs, run_refs: runRefs};
        return {content: [{type: "text", text: "图表已准备，将在回答核验后展示。请继续撰写正文。"}], details};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        const invalid = error instanceof BackendApiError && error.status === 422;
        return {content: [{type: "text", text: error instanceof BackendApiError ? error.message : "暂未准备好图表，可以继续回答正文。"}],
          details: {kind: "inquiry_chart", status: invalid ? "ARGUMENT_ERROR" : "error", retryable: invalid,
            ...(error instanceof BackendApiError && error.code ? {error_code: error.code} : {})}};
      }
    }};
}
