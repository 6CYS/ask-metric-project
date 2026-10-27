import {Type, type Static} from "@earendil-works/pi-ai";
import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {isCurrentAnalysisEvidence, type EvidenceReference} from "../answerEvidence.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import {narrativeEvidenceRefs, normalizeReportNarrative, verifiedNarrativeRefs} from "../analysis/narrative.js";
import {analysisEvidenceAliases} from "../analysis/verifiedFindings.js";
import {buildReportChart, reportChartHasNarrativeEvidence, reportChartSchema} from "../analysis/reportCharts.js";
import {latestInquiryChart} from "./chartTool.js";
import {currentTurnMessages} from "../tools/turnContract.js";
import {isInquiryCalculation, type InquiryCalculation} from "./calculationTool.js";

const parameters = Type.Object({
  body: Type.String({minLength: 1, maxLength: 6000,
    description: "自然回答原问题。数值用{{e1.v1}}等真实引用，依据可用{{e1.v1|cite}}关联，不手算或编写值。口径未确认的比例暂不用于分析。"}),
  chart: Type.Optional(reportChartSchema),
}, {additionalProperties: false});

type Source = EvidenceReference & {evidence: AnalysisEvidence};

function availabilityRequests(messages: AgentMessage[], sources: Source[]) {
  const requests = currentTurnMessages(messages).flatMap(message => {
    if (message.role !== "toolResult" || message.isError || message.toolName !== "metric_availability") return [];
    const receipt = message.details as {kind?: string; status?: string; request?: {
      dimension?: string; metric_codes?: string[]; org_codes?: string[]; start?: string; end?: string;
    }} | undefined;
    const spec = receipt?.request;
    const metrics = spec?.metric_codes, orgs = spec?.org_codes;
    if (receipt?.kind !== "data_availability" || receipt.status !== "succeeded" || spec?.dimension !== "dates"
      || Boolean(spec.start) !== Boolean(spec.end) || !metrics?.length || !orgs?.length) return [];
    return sources.some(({evidence}) => metrics.every(code => evidence.metric_descriptors?.some(metric => metric.code === code))
      && orgs.every(code => evidence.org_codes.includes(code))) ? [spec] : [];
  });
  // 仅传真实工具请求；日期是否可用仍由后端按当前权限重新查询。
  return [...new Map(requests.map(spec => [JSON.stringify(spec), spec])).values()].slice(-3);
}

/** 只交付当前工具循环的可信证据；正文持续失败时由后端重新核验并交付已有事实，不补查或修改计划。 */
export function createInquiryReportTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "analysis_answer", label: "回答业务问题", parameters,
    description: "完成必要调查后依据真实结果交付自然正文，可同时选一张有助理解的图。来源自动采用本轮成功查询或已鉴权读取的结果；历史结果须先analysis_read。校验错误按所指问题修正，已有数据不重复查询，确实缺少依据时可定向补查。图表只引用现有结果，不提交手写数值。",
    prepareArguments: args => {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("回答参数必须是对象。");
      // 兼容升级前尚未执行的调用；来源不再由模型重复筛选，其余参数仍交给原 schema 校验。
      const {evidence_refs: _previousSelection, ...input} = args as Record<string, unknown>;
      return input as Static<typeof parameters>;
    },
    execute: async (_id, input, _update, request, _invocation, context) => {
      try {
        if (!input.body.trim()) throw new BackendApiError(422, "请提交完整回答正文。", "ANALYSIS_REPORT_SUMMARY");
        const turnEvidence = await request.answerEvidence?.() ?? [];
        const available = turnEvidence.filter((item): item is Source =>
          item.evidence.kind === "analysis_evidence" && item.evidence.status === "succeeded"
          && typeof (item.evidence as AnalysisEvidence).run_ref === "string");
        if (!available.length)
          throw new BackendApiError(422, "本轮还没有成功查询或已鉴权读取的来源，请先取得所需数据。", "ANALYSIS_REPORT_EVIDENCE");
        const calculations = turnEvidence.filter((item): item is EvidenceReference & {evidence: InquiryCalculation} =>
          isInquiryCalculation(item.evidence) && item.evidence.execution_turn_id === request.operationId
          && item.evidence.run_refs.every(ref => available.some(source => source.evidence.run_ref === ref)));
        const sourcesWithCalculations = [...available, ...calculations];
        const aliases = new Map(sourcesWithCalculations.flatMap(item => [...analysisEvidenceAliases(item.ref, item.evidence.evidence_items ?? [])]));
        const known = new Set(sourcesWithCalculations.flatMap(item => item.evidence.evidence_items?.map(atom => atom.ref) ?? []));
        const rawRef = (ref: string) => aliases.get(ref) ?? ref;
        const narrative = normalizeReportNarrative({body: input.body});
        const refs = [...new Set(narrativeEvidenceRefs(narrative.summary).map(rawRef))];
        const messages = await request.turnMessages?.() ?? [];
        const prepared = input.chart ? undefined : latestInquiryChart(messages);
        const chartSelection = input.chart ?? prepared?.selection;
        const chartRefs = chartSelection?.evidence_refs.map(rawRef) ?? [];
        const preparedAvailable = !prepared || prepared.run_refs.every(ref => available.some(item => item.evidence.run_ref === ref))
          && prepared.source_refs.every(ref => known.has(ref));
        if ([...refs, ...(input.chart ? chartRefs : [])].some(ref => !known.has(ref)))
          throw new BackendApiError(422, "正文或图表包含不属于本轮成功来源的原子，请使用回执中的真实引用。", "ANALYSIS_REPORT_REFERENCE");
        const referenced = new Set([...refs, ...(preparedAvailable ? chartRefs : [])]);
        const selectedCalculations = calculations.filter(item => item.evidence.evidence_items.some(atom => referenced.has(atom.ref)));
        selectedCalculations.forEach(item => item.evidence.evidence_items.forEach(atom => {
          if (referenced.has(atom.ref)) atom.input_refs.forEach(ref => referenced.add(ref));
        }));
        // 超限时只缩减未引用的历史运行；本轮实际查询目标必须保留，不能改变回答范围。
        const usable = new Set(available.map(item => item.evidence.run_ref)).size <= 6 ? available
          : available.filter(item => isCurrentAnalysisEvidence(item.evidence, request.operationId)
            || item.evidence.evidence_items?.some(atom => referenced.has(atom.ref)));
        // 同一运行重复读取可有不同短引用，但后端只需再次鉴权一次。
        const runRefs = [...new Set(usable.map(item => item.evidence.run_ref))];
        if (!runRefs.length || runRefs.length > 6)
          throw new BackendApiError(422, "单次回答最多核验6个真实运行。历史数值请使用正文或图表引用明确依据；本轮查询过多时不能省略实际查询目标。", "ANALYSIS_REPORT_EVIDENCE");
        const historical = usable.filter(item => !isCurrentAnalysisEvidence(item.evidence, request.operationId));
        const contextRefs = [...new Set(historical.map(item => item.evidence.run_ref))];
        const reuseOnly = historical.length === usable.length;
        if (reuseOnly && !refs.length)
          throw new BackendApiError(422, "请用正文中的真实引用明确本次追问关注的指标；仅关联依据可使用{{e1.v1|cite}}。", "ANALYSIS_REPORT_REFERENCE");
        const summary = narrative.summary.replace(/\{\{([^{}]+?)(\|cite)?\}\}/gu,
          (_full, ref: string, citation?: string) => `{{${rawRef(ref)}${citation ?? ""}}}`);
        const availability = availabilityRequests(messages, usable.filter(item => isCurrentAnalysisEvidence(item.evidence, request.operationId)));
        // 服务端重读不可变运行并校验权限、来源、范围、数字、单位和日期。
        const payload = {run_refs: runRefs, context_run_refs: contextRefs,
          focus_refs: reuseOnly ? refs : [], summary, sections: narrative.sections,
          ...(selectedCalculations.length ? {calculation_refs: [...new Map(selectedCalculations.map(item =>
            [item.evidence.calculation_ref.calculation_id, item.evidence.calculation_ref])).values()]} : {}),
          ...(availability.length ? {availability_requests: availability} : {})};
        let details;
        try {
          details = await request.backend.analysisReport(payload, {signal: context.abortSignal});
        } catch (error) {
          if (!(error instanceof BackendApiError) || error.status !== 422 || error.code !== "ANALYSIS_REPORT_NUMBER"
            || !currentTurnMessages(messages).some(message => message.role === "toolResult"
              && message.toolName === "analysis_answer")) throw error;
          // 丢弃未通过的草稿；后端重验原来源、权限及追问范围，只交付可确认的事实或缺数说明。
          details = await request.backend.analysisReport({...payload, summary: "", sections: [], fallback: true},
            {signal: context.abortSignal});
        }
        if (details.kind !== "business_report" || details.status !== "succeeded"
          || typeof details.public_answer !== "string" || !details.public_answer.trim()
          || !details.report || typeof details.report !== "object" || Array.isArray(details.report))
          throw new Error("INVALID_ANALYSIS_REPORT");
        const verifiedRefs = verifiedNarrativeRefs(details.report, refs) ?? [];
        const preparedInScope = preparedAvailable && (!prepared || prepared.run_refs.every(ref => runRefs.includes(ref)));
        const generated = chartSelection && (!preparedInScope || !reportChartHasNarrativeEvidence(usable, chartSelection, verifiedRefs))
          ? {charts: [], notice: "所选图表与本次回答的数据范围或指标口径不一致，暂未展示。"}
          : buildReportChart(usable, chartSelection, request.originalMessage, verifiedRefs);
        const report = details.report as Record<string, unknown>;
        let publicAnswer = details.public_answer;
        if (generated.notice) publicAnswer += `\n\n${generated.notice}`;
        details = {...details, public_answer: publicAnswer,
          ...(generated.notice ? {partial_analysis: true,
            gaps: [...(Array.isArray(details.gaps) ? details.gaps : []), generated.notice]} : {}),
          report: {...report, charts: generated.charts,
            ...(generated.notice ? {summary: `${report.summary}\n\n${generated.notice}`} : {})}};
        return {content: [{type: "text", text: publicAnswer}], details, terminate: true};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        const invalid = error instanceof BackendApiError && error.status === 422;
        return {content: [{type: "text", text: error instanceof BackendApiError ? error.message : "回答校验未完成，请稍后重试。"}],
          details: {kind: "analysis_answer", status: invalid ? "ARGUMENT_ERROR" : "error", retryable: invalid,
            ...(error instanceof BackendApiError && error.code ? {error_code: error.code} : {})}};
      }
    }};
}
