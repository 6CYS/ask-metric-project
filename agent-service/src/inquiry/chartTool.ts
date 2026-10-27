import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import type {EvidenceReference} from "../answerEvidence.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import {analysisEvidenceAliases} from "../analysis/verifiedFindings.js";
import {buildReportChart, reportChartSchema, type ReportChartSelection} from "../analysis/reportCharts.js";
import {currentTurnMessages} from "../tools/turnContract.js";

interface InquiryChartSelection {
  kind: "inquiry_chart";
  status: "succeeded";
  selection: ReportChartSelection;
  source_refs: string[];
  run_refs: string[];
}

/** 选择只在当前用户回合内生效，重连后也只读取真实工具回执。 */
export function latestInquiryChart(messages: AgentMessage[]): InquiryChartSelection | undefined {
  for (const message of [...currentTurnMessages(messages)].reverse()) {
    if (message.role !== "toolResult" || message.toolName !== "analysis_chart" || message.isError) continue;
    const value = message.details as Partial<InquiryChartSelection> | undefined;
    if (value?.kind === "inquiry_chart" && value.status === "succeeded"
      && ["bar", "line"].includes(value.selection?.type ?? "")
      && Array.isArray(value.source_refs) && value.source_refs.length >= 2 && value.source_refs.length <= 24
      && value.source_refs.every(ref => typeof ref === "string" && !!ref)
      && Array.isArray(value.run_refs) && value.run_refs.length > 0 && value.run_refs.every(ref => typeof ref === "string" && !!ref)
      && Array.isArray(value.selection?.evidence_refs)
      && value.selection.evidence_refs.length === value.source_refs.length
      && value.selection.evidence_refs.every((ref, index) => ref === value.source_refs?.[index])) return value as InquiryChartSelection;
  }
  return undefined;
}

/** 只保存引用选择；数值在最终报告鉴权成功后从所选来源重新生成。 */
export function createInquiryChartTool(): AgentHarnessTool<AskMetricRequestContext, typeof reportChartSchema> {
  return {name: "analysis_chart", label: "选择图表", parameters: reportChartSchema,
    description: "可选：从本轮已有结果选择有助说明的柱图或趋势图，随后正常撰写回答。只引用真实数值原子，不取数、不提交手写图值。",
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
        const generated = buildReportChart(sources, selection, request.originalMessage), chart = generated.charts[0];
        if (!chart) throw new BackendApiError(422, generated.notice ?? "本次问题要求文字回答，暂未准备图表。", "ANALYSIS_CHART_SELECTION");
        const runRefs = [...new Set(sources.filter(item => item.evidence.evidence_items?.some(atom => chart.source_refs.includes(atom.ref)))
          .map(item => item.evidence.run_ref))];
        const details: InquiryChartSelection = {kind: "inquiry_chart", status: "succeeded",
          selection: {type: chart.type, evidence_refs: chart.source_refs}, source_refs: chart.source_refs, run_refs: runRefs};
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
