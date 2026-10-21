import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {BusinessFrame, ResolvedOrganizations} from "../business-context/types.js";
import {BackendApiError} from "../backendClient.js";
import {commandKey} from "../harnessHost.js";
import type {BusinessEvidence} from "../answerEvidence.js";
import type {EvidenceReference} from "../answerEvidence.js";
import type {AnalysisPlan} from "./contracts.js";
import {analysisBudget, analysisCandidates, analysisDiscoveryRounds, catalogBindingView, catalogBindingState, registerAnalysisDiscovery, registerAnalysisPlan} from "./bindings.js";
import {analysisCoverageReview, analysisPlanningReview} from "./coverage.js";
import {analysisInterpretationBrief} from "./interpretation.js";
import {analysisFollowupSource, inquiryReview} from "./inquiry.js";
import {normalizeReportNarrative, reviewNarrativeDensity} from "./narrative.js";
import {analysisEvidenceAliases, verifiedFindingsView, type VerifiedFindings} from "./verifiedFindings.js";

export interface AnalysisEvidence extends BusinessEvidence {
  kind: "analysis_evidence"; run_ref: string; scope_id: string; frame_id?: string;
  execution_turn_id?: string;
  analysis_date: string | null; org_codes: string[]; rows: unknown[]; plan: AnalysisPlan;
  date_selection?: string; requested_start?: string | null; requested_end?: string | null;
  checked_on?: string;
  metric_descriptors: Array<{binding_ref: string; code: string; name?: string}>;
  verified_findings?: VerifiedFindings;
  evidence_items?: Array<{ref: string; type?: string; metric_code?: string; metric_name?: string;
    org_code?: string; date?: string; value?: string; display?: string; judgment_kind?: string; input_refs?: string[]}>;
}

function successfulAnalyses(evidence: EvidenceReference[]) {
  return evidence.filter((item, index, all) => item.evidence.kind === "analysis_evidence" && item.evidence.status === "succeeded"
    && all.findIndex(other => (other.evidence as AnalysisEvidence).run_ref === (item.evidence as AnalysisEvidence).run_ref) === index);
}

const discovery = Type.Object({keywords: Type.Array(Type.String({minLength: 1, maxLength: 200}), {minItems: 1, maxItems: 4}),
  page: Type.Optional(Type.Integer({minimum: 1, maximum: 1000})), page_size: Type.Optional(Type.Integer({minimum: 1, maximum: 30}))}, {additionalProperties: false});

export function createAnalysisCatalogTool(): AgentHarnessTool<AskMetricRequestContext, typeof discovery> {
  return {name: "analysis_catalog", label: "发现分析指标与方法", parameters: discovery,
    description: "跨业务主题发现正式指标，返回完整名称、别名、定义、单位、口径缺口、服务端binding_ref和公共方法。经营、盈利、收入、资本等没有专项主题配置也使用本工具。多主题关键词合并一次发现，无需先逐一读取专项主题来获取相同目录；宏观问题可用page_size=30覆盖主要候选。先按用户目标提出关键词，再读候选并选适合指标；分页未完不声称目录不存在。查询数值需resolve_business_turn的business_analysis计划。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      try {
        if (analysisDiscoveryRounds(request) >= analysisBudget(request).discovery) return {content: [{type: "text", text: "本轮目录发现预算已用完。请用已发现的k短引用规划business_analysis；未找到的项目写gap_reason，不能把预算限制说成全目录不存在。先展示有依据的结果。"}], details: {kind: "analysis_catalog", status: "budget_exhausted"}};
        // “经营”是业务范围而非指标名；展开到收益和质量入口，避免搜索同名词后只剩存贷款。
        // 只扩展泛称，不改写明确指标词；仍受同一批四个关键词的预算约束。
        const keywords = [...new Set(input.keywords.flatMap(keyword => {
          const term = keyword.trim();
          if (/^存\s*贷(?:款)?$/u.test(term)) return ["存款", "贷款"];
          if (/^(?:整体|总体)?经营(?:情况|概况|表现|状况)?$/u.test(term)) return ["利润", "不良"];
          return [keyword];
        }))].slice(0, 4);
        const [methods, ...results] = await Promise.all([request.backend.analysisMethods({signal: context.abortSignal}),
          ...keywords.map(keyword => request.backend.analysisCatalog(keyword, input.page ?? 1, input.page_size ?? 12, {signal: context.abortSignal}))]);
        const count = registerAnalysisDiscovery(request);
        const view = catalogBindingView(request, results);
        const planning = analysisPlanningReview(request);
        return {content: [{type: "text", text: JSON.stringify({methods, results: view, discovery_rounds_remaining: analysisBudget(request).discovery - count,
          ...(planning.length ? {planning_review: planning} : {}),
          next_action: "根据用户目标选择binding_ref短引用（如k1），提交intent=analyze、target.analysis.kind=business_analysis计划。目录预算按已发现主题和子问题分配，有可用指标就先查；找不到的项目写gap_reason，不反复搜索追求完整目录。requirements用id关联，steps.answers填这些id。规模/水平选当日数等当前水平指标，不能用较上月/较同期差额代替。正式比较指标用observe；compare用于同指标跨日期。没有已审核关系用observe并列读取。不退回metric_query要求用户挑内部口径。"})}],
          details: {kind: "analysis_catalog", status: "succeeded", keywords: input.keywords, binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request)}};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {content: [{type: "text", text: "指标发现服务未完成，请重试；检索失败不能视为没有相关指标。"}],
          details: {kind: "analysis_catalog", status: "error", retryable: true}};
      }
    }};
}

export function createGeneralAnalysisTool(frame: BusinessFrame): AgentHarnessTool<AskMetricRequestContext> {
  return {name: "general_analysis", label: "执行通用分析计划", parameters: Type.Object({}, {additionalProperties: false}),
    description: "仅从已校验Frame执行计划，复用后端基础取数、覆盖与计算。",
    execute: async (_id, _input, _update, request, _invocation, context) => {
      const previous = successfulAnalyses(await request.answerEvidence?.() ?? []);
      const plan = frame.fields.plan?.resolvedValue as AnalysisPlan;
      registerAnalysisPlan(request, plan);
      if (previous.length >= analysisBudget(request).executions) throw new Error("ANALYSIS_ROUND_LIMIT");
      const orgs = frame.fields.organizations?.resolvedValue as ResolvedOrganizations | undefined;
      const time = frame.fields.time?.resolvedValue as {start?: string; end?: string; dates?: string[]; date_selection?: string} | undefined;
      const latest = !time || time.date_selection === "latest_snapshot";
      let conversation = await request.commands.getConversationId();
      if (!conversation) {
        conversation = (await request.backend.createAgentQueryContext(request.sessionId, {signal: context.abortSignal})).conversation_id;
        await request.commands.setConversationId(conversation);
      }
      const first = previous[0]?.evidence as AnalysisEvidence | undefined;
      const payload = {plan, conversation_id: conversation,
        ...(orgs?.scope ? {organization_scope: orgs.scope, scope_fingerprint: orgs.scope_fingerprint, org_codes: []} : {org_codes: orgs?.codes ?? []}),
        date_selection: latest ? "latest_snapshot" : time?.start === time?.end || time?.dates ? "exact" : "available_in_range",
        ...(!latest ? {start: time?.start, end: time?.end, ...(time?.dates ? {dates: time.dates} : {})} : {}),
        // 不同主题可以有不同发布日；首批利润的旧观测日不能遮住新发现的存贷款记录。
        ...(latest && (first?.checked_on ?? first?.analysis_date) ? {anchor_date: first!.checked_on ?? first!.analysis_date} : {}),
        calculation_context: {scope_id: request.operationId, user_question: request.originalMessage}};
      const identity = (value: AnalysisPlan) => JSON.stringify(value.steps.map(step => ({method: step.method,
        refs: [...step.metric_refs].sort(), comparisons: step.comparisons ?? [], top_n: step.top_n ?? 10, position: step.position ?? "top",
        relation_id: step.relation_id ?? null})));
      const duplicate = previous.find(item => identity((item.evidence as AnalysisEvidence).plan) === identity(plan)
        && JSON.stringify((item.evidence as AnalysisEvidence).org_codes) === JSON.stringify(orgs?.codes ?? [])
        && (item.evidence as AnalysisEvidence).date_selection === payload.date_selection
        && ((item.evidence as AnalysisEvidence).requested_start ?? null) === (payload.start ?? null)
        && ((item.evidence as AnalysisEvidence).requested_end ?? null) === (payload.end ?? null));
      if (duplicate) return {content: [{type: "text", text: JSON.stringify({status: "succeeded", reused: true, evidence_ref: duplicate.ref,
        message: "本轮相同范围和计划已经执行，继续使用该回执，不再重复查询。若目标已覆盖，调用analysis_report_present汇总；确需补查时仅提交新增步骤，保留原始子问题及此前回执。无记录时先核对领域绑定和口径，不能推断整个业务没有数据。"})}],
        // 复用是成功的控制回执，不重新登记同一份事实，也不把焦点推进到失败分支。
        details: {kind: "analysis_plan_review", status: "succeeded", reused: true, evidence_ref: duplicate.ref,
          org_codes: orgs?.codes ?? [], tasks: [], row_count: 0}};
      const key = commandKey({owner: request.actor.id, session: request.sessionId, operation: request.operationId, action: "general_analysis", payload});
      if (request.businessExecutionFrame) await request.businessResults?.linkExecution(request.businessExecutionFrame,
        {tool: "general_analysis", idempotencyKey: key, conversationId: conversation});
      const result = await request.backend.analysisExecute(payload, key, {signal: context.abortSignal});
      if (result.kind !== "analysis_evidence" || result.status !== "succeeded" || typeof result.run_ref !== "string" || !Array.isArray(result.evidence_items)) throw new Error("INVALID_ANALYSIS_RESPONSE");
      const evidenceRef = `e${(await request.answerEvidence?.() ?? []).length + 1}`;
      const atoms = (result.evidence_items as Array<Record<string, unknown>>).filter(atom => atom.type !== "observation");
      const aliases = analysisEvidenceAliases(evidenceRef, result.evidence_items as Array<{ref: string; type?: string; judgment_kind?: string}>);
      const followupMetrics = catalogBindingView(request, result.followup_metrics ?? []);
      const review = analysisCoverageReview(request, [...previous.map(item => item.evidence as AnalysisEvidence), result as unknown as AnalysisEvidence]);
      return {content: [{type: "text", text: JSON.stringify({...result, metric_descriptors: undefined, rows: undefined, tasks: undefined,
        followup_metrics: followupMetrics,
        analysis_brief: analysisInterpretationBrief(request, [...previous, {ref: evidenceRef, evidence: result as unknown as AnalysisEvidence}]),
        inquiry_review: inquiryReview(plan.inquiry, previous, {ref: evidenceRef, evidence: result as unknown as AnalysisEvidence}),
        followup_source: await analysisFollowupSource(request),
        coverage_review: review, remaining_execution_rounds: analysisBudget(request).executions - previous.length - 1,
        observations: result.observations,
        verified_findings: verifiedFindingsView(result.verified_findings as VerifiedFindings | undefined, aliases),
        evidence_items: atoms.map((atom, index) => ({...atom, ref: `${evidenceRef}.v${index + 1}`,
          value: undefined, fact_id: undefined, metadata_version: undefined, calculation_id: undefined, input_fact_refs: undefined,
          calculation: undefined, input_refs: undefined})),
        evidence_ref: evidenceRef, next_action: "coverage_review是可选探索方向，不是必须补齐的报告栏目。根据用户目标和analysis_brief实际发现选择具体疑问；补查计划inquiry写question、prior_judgment、basis_refs（此前事实原子）、expected_change，随后用inquiry_review的新证据支持、修正或限定判断；没有有效疑问就交付，不穷举候选。补查source复制followup_source中的完整reference配对，不自行拼接；没有该字段时只在唯一目标下用{kind:current}，多目标先读取上下文选择已签发reference。原句明确机构时operations保留机构set，同一范围的补查放在一份analysis计划中，只提交新增步骤。必要时analysis_catalog发现正式指标，遵守remaining_execution_rounds。报告自然组织，可直接回答、按发现展开或深入一个问题，不强制分主题栏目。正文只引用关键数字，其他明细留表格。数字用{{e1.v1}}等实际ref，值已含单位，不自行计算或截取。日期用actual_dates，不编造变量。未知会计口径不得假定累计或单月；不以余额推断业务原因或无标准评价好坏。"})}],
        details: {...result, execution_turn_id: request.semanticStep?.rootOperationId ?? request.operationId, binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request), answer_policy: "general_analysis_evidence_v1"}};
    }};
}

const reportParameters = Type.Object({evidence_refs: Type.Array(Type.String({description: "分析回执编号，如e1、e2；原子引用e1.v1等用于body正文，不在此处填写。"}), {minItems: 1, maxItems: 6}),
  body: Type.String({minLength: 1, maxLength: 6000, description: "必填完整自然正文，可用段落、要点或Markdown标题，无固定栏目。先回答最值得关注的发现，按证据展开判断、差异或待核验问题。只引用影响判断的关键数字，不逐行抄表，不在开篇与展开重复数字。补查后回答原疑问，说明判断获得支持、被修正或受到限制。展示关键数值用{{实际原子ref}}；无需展示数值的判断在句后用{{实际原子ref|cite}}关联依据，仍核验并保存在证据中。日期逐字采用actual_dates，不自算、不认定未经证实因果。"}),
  presentation: Type.Optional(Type.Object({
    profile: Type.Optional(Type.Union([
      Type.Literal("brief"), Type.Literal("snapshot"), Type.Literal("trend"),
      Type.Literal("diagnostic"), Type.Literal("multi_topic"),
    ], {description: "表达风格建议；事实和证据不随风格改变。"})),
    density: Type.Optional(Type.Union([
      Type.Literal("compact"), Type.Literal("medium"), Type.Literal("detailed"),
    ], {description: "信息密度建议；简单问题不要选择 detailed。"})),
  }, {additionalProperties: false, description: "只控制报告组织方式，不改变取数计划、事实和结论。省略时由服务端根据问题和证据选择。"}))
}, {additionalProperties: false});
const reportFailures = new WeakMap<AskMetricRequestContext, number>();

export function createAnalysisReportTool(): AgentHarnessTool<AskMetricRequestContext, typeof reportParameters> {
  return {name: "analysis_report_present", label: "交付通用分析报告", parameters: reportParameters,
    description: "通用分析取数和必要补查后，依据本轮analysis_evidence的e1/e2回执交付文字报告与程序生成的事实表格，并结束。可按需提交presentation选择表达风格；它只改变组织方式，不改变事实、证据或权限。报告内容随用户目标和证据变化；不把无数据、缺口或服务错误伪装成完整结论。",
    execute: async (_id, rawInput, _update, request, _invocation, context) => {
      try {
        let input = {...rawInput, ...normalizeReportNarrative(rawInput)};
        const evidence = await request.answerEvidence?.() ?? [];
        const allSources = successfulAnalyses(evidence);
        if (new Set(input.evidence_refs).size !== input.evidence_refs.length) throw new Error("请选择非重复的本轮分析回执。");
        // 已知原子引用可准确回溯到本轮来源；不接受猜测、历史或越界引用。
        const atomOwners = new Map<string, string>();
        for (const item of allSources) {
          for (const alias of analysisEvidenceAliases(item.ref, (item.evidence as AnalysisEvidence).evidence_items ?? []).keys()) atomOwners.set(alias, item.ref);
        }
        input = {...input, evidence_refs: [...new Set(input.evidence_refs.map(ref => atomOwners.get(ref) ?? ref))]};
        const selected = input.evidence_refs.map(ref => evidence.find(item => item.ref === ref));
        if (new Set(input.evidence_refs).size !== input.evidence_refs.length || selected.some(item => item?.evidence.kind !== "analysis_evidence" || item.evidence.status !== "succeeded")) throw new Error("请选择本轮成功的analysis_evidence回执e1/e2，不使用历史编号或目录回执。");
        const sources = selected.map(item => item!.evidence as AnalysisEvidence);
        if (allSources[0] && !input.evidence_refs.includes(allSources[0].ref)) throw new Error("报告必须保留本轮首批计划及原始子问题，不能只交付最后一次补查。");
        // 目录方向只是探索建议；用户原始子问题的证据覆盖仍由后端逐项校验。
        const aliases = new Map(input.evidence_refs.flatMap((ref, index) =>
          [...analysisEvidenceAliases(ref, sources[index]?.evidence_items ?? [])]));
        const translate = (text: string) => text.replace(/\{\{([^{}]+?)(\|cite)?\}\}/g,
          (full, ref: string, citation?: string) => aliases.has(ref) ? `{{${aliases.get(ref)}${citation ?? ""}}}` : full);
        const payload = {run_refs: allSources.filter(item => input.evidence_refs.includes(item.ref)).map(item => (item.evidence as AnalysisEvidence).run_ref), summary: input.summary,
          context_run_refs: sources.filter(source => source.execution_turn_id
            && source.execution_turn_id !== (request.semanticStep?.rootOperationId ?? request.operationId)).map(source => source.run_ref),
          ...(input.presentation ? {presentation: input.presentation} : {}),
          planning_gaps: [],
          sections: input.sections.map(section => ({...section, title: translate(section.title), text: translate(section.text), evidence_refs: [...new Set(section.evidence_refs.flatMap(ref => {
            const index = input.evidence_refs.indexOf(ref);
            return index < 0 ? [aliases.get(ref) ?? ref] : (sources[index]?.evidence_items ?? []).map(atom => atom.ref);
          }))]}))};
        payload.summary = translate(input.summary);
        const editorial = reviewNarrativeDensity(request, rawInput.body,
          sources.flatMap((source, index) => source.evidence_items?.filter(atom => atom.type !== "observation")
            .map((atom, atomIndex) => ({...atom, ref: `${input.evidence_refs[index]}.v${atomIndex + 1}`})) ?? []),
          analysisInterpretationBrief(request, selected as EvidenceReference[]).signals);
        if (editorial) return editorial;
        let details;
        try {details = await request.backend.analysisReport(payload, {signal: context.abortSignal});}
        catch (error) {
          const count = (reportFailures.get(request) ?? 0) + 1;
          reportFailures.set(request, count);
            // 已选来源先通过当前回合校验；服务端逐段保留有效分析，不兜底权限或范围错误。
          if (count < 2 || !(error instanceof BackendApiError) || !["ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_CAUSE", "ANALYSIS_REPORT_DIRECTION", "ANALYSIS_REPORT_SUMMARY", "ANALYSIS_REPORT_REFERENCE"].includes(error.code ?? "")) throw error;
          details = await request.backend.analysisReport({...payload, fallback: true}, {signal: context.abortSignal});
        }
        if (details.kind !== "business_report" || details.status !== "succeeded" || typeof details.public_answer !== "string") throw new Error("INVALID_ANALYSIS_REPORT");
        if (sources.length > 1 && request.frames && sources[0]?.frame_id) {
          const state = await request.frames.state(), root = await request.frames.get(sources[0].frame_id);
          if (root?.turnId === request.operationId && root.status === "success" && state.focusFrameId !== root.frameId) await request.frames.setFocus(root.frameId, state.version);
        }
        return {content: [{type: "text", text: details.public_answer}], details, terminate: true};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {content: [{type: "text", text: error instanceof Error ? error.message : "通用报告校验未完成"}],
          details: {kind: "analysis_report", status: "ARGUMENT_ERROR", retryable: true, ...(error instanceof BackendApiError ? {error_code: error.code} : {})}};
      }
    }};
}
