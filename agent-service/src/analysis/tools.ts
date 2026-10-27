import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {BusinessFrame, ResolvedOrganizations} from "../business-context/types.js";
import {BackendApiError} from "../backendClient.js";
import {commandKey} from "../harnessHost.js";
import {isCurrentAnalysisEvidence, type BusinessEvidence} from "../answerEvidence.js";
import type {EvidenceReference} from "../answerEvidence.js";
import type {AnalysisPlan} from "./contracts.js";
import {analysisBudget, analysisCandidates, analysisDiscoveryRounds, catalogBindingView, catalogBindingState, registerAnalysisDiscovery, registerAnalysisPlan} from "./bindings.js";
import {analysisCoverageReview, analysisPlanningReview} from "./coverage.js";
import {analysisInterpretationBrief} from "./interpretation.js";
import {analysisFollowupSource, inquiryReview} from "./inquiry.js";
import {narrativeEvidenceRefs, normalizeReportNarrative, verifiedNarrativeRefs} from "./narrative.js";
import {rememberReportSelection} from "./reportSelection.js";
import {publicTextProblem} from "../runtime/delivery.js";
import {isReportProseErrorCode, reportProseRepairTool} from "../runtime/recovery.js";
import {analysisEvidenceAliases, verifiedFindingsView, type VerifiedFindings} from "./verifiedFindings.js";
import {rankingModelView} from "./rankingView.js";
import {buildReportChart, reportChartSchema} from "./reportCharts.js";
import {queryRecoveryCatalogSource, recoveryMetricCandidates} from "../semantic-task/queryRecovery.js";

export interface AnalysisEvidence extends BusinessEvidence {
  kind: "analysis_evidence"; run_ref: string; scope_id: string; frame_id?: string;
  execution_turn_id?: string;
  result_reused?: boolean;
  analysis_date: string | null; org_codes: string[]; rows: unknown[]; plan: AnalysisPlan;
  date_selection?: string; requested_start?: string | null; requested_end?: string | null;
  checked_on?: string;
  requirement_dispositions?: Array<{id: string; question: string; status: string; step_ids: string[]}>;
  metric_descriptors: Array<{binding_ref: string; code: string; name?: string}>;
  verified_findings?: VerifiedFindings;
  evidence_items?: Array<{ref: string; type?: string; metric_code?: string; metric_name?: string;
    org_code?: string; date?: string; value?: string; display?: string; judgment_kind?: string; input_refs?: string[]; step_ids?: string[]}>;
}

function successfulAnalyses(evidence: EvidenceReference[]) {
  return evidence.filter((item, index, all) => item.evidence.kind === "analysis_evidence" && item.evidence.status === "succeeded"
    && all.findIndex(other => (other.evidence as AnalysisEvidence).run_ref === (item.evidence as AnalysisEvidence).run_ref) === index);
}

const discovery = Type.Object({keywords: Type.Array(Type.String({minLength: 1, maxLength: 200}), {minItems: 1, maxItems: 4}),
  page: Type.Optional(Type.Integer({minimum: 1, maximum: 1000})), page_size: Type.Optional(Type.Integer({minimum: 1, maximum: 30}))}, {additionalProperties: false});

export function createAnalysisCatalogTool(): AgentHarnessTool<AskMetricRequestContext, typeof discovery> {
  return {name: "analysis_catalog", label: "发现分析指标与方法", parameters: discovery,
    description: "按用户原目标发现完整目录中的正式指标和方法，不需先选业务主题。返回完整名称、别名、定义、单位、口径缺口及binding_ref；topic_hints只推荐可选辅助方法。semantic_suggestions为近似推荐，核对含义后用完整名称或编码查证，不得直接执行。相关关键词可合并检索，宏观问题可用page_size=30；分页未完不声称目录不存在。查证后按原意提交resolve_business_turn：普通取值用query，分析用analyze，不因检索改变意图。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      try {
        if (analysisDiscoveryRounds(request) >= analysisBudget(request).discovery) return {content: [{type: "text", text: "本轮目录发现预算已用完。请按原目标提交resolve_business_turn，使用已查证指标；尚未确认的含义须澄清，分析缺项写gap_reason，不能把预算限制说成全目录不存在。"}], details: {kind: "analysis_catalog", status: "budget_exhausted"}};
        // “经营”是业务范围而非指标名；展开到收益和质量入口，避免搜索同名词后只剩存贷款。
        // 只扩展泛称，不改写明确指标词；仍受同一批四个关键词的预算约束。
        const keywords = [...new Set(input.keywords.flatMap(keyword => {
          const term = keyword.trim();
          if (/^存\s*贷(?:款)?$/u.test(term)) return ["存款", "贷款"];
          if (/^(?:整体|总体)?经营(?:情况|概况|表现|状况)?$/u.test(term)) return ["利润", "不良"];
          return [keyword];
        }))].slice(0, 4);
        const candidates = await recoveryMetricCandidates(request);
        const known = new Set(analysisCandidates(request).map(item => item.code));
        const pending = candidates.filter(item => !known.has(item.code));
        // 恢复阶段只补账本中已确认的身份，避免主题推荐和分页遮住正式候选。
        // 每批至多十二项；撤权或取消必须整体终止，普通单项失败保留其他成功发现。
        const lookups = pending.slice(0, 12);
        const lookupFailures: string[] = [];
        const methods = await request.backend.analysisMethods({signal: context.abortSignal});
        const results = candidates.length ? await Promise.all(lookups.map(async candidate => {
          try {
            const result = await request.backend.analysisCatalog(candidate.code, 1, 1, {signal: context.abortSignal});
            const items = Array.isArray(result.items) ? result.items.filter(raw => {
              const item = raw as {code?: unknown; binding_ref?: unknown};
              return item.code === candidate.code && typeof item.binding_ref === "string" && !!item.binding_ref;
            }) : [];
            if (!items.length) lookupFailures.push(candidate.code);
            return {...result, items};
          } catch (error) {
            if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
            lookupFailures.push(candidate.code);
            return {items: [], semantic_suggestions: []};
          }
        })) : await Promise.all(keywords.map(keyword => request.backend.analysisCatalog(keyword,
          input.page ?? 1, input.page_size ?? 12, {signal: context.abortSignal})));
        if (lookups.length && lookupFailures.length === lookups.length && !candidates.some(item => known.has(item.code)))
          throw new Error("RECOVERY_CATALOG_UNAVAILABLE");
        const count = registerAnalysisDiscovery(request);
        const view = catalogBindingView(request, results, await queryRecoveryCatalogSource(request));
        const suggestionCount = results.reduce((total, result) => total
          + (Array.isArray(result.semantic_suggestions) ? result.semantic_suggestions.length : 0), 0);
        const planning = analysisPlanningReview(request);
        return {content: [{type: "text", text: JSON.stringify({methods, results: view, discovery_rounds_remaining: analysisBudget(request).discovery - count,
          ...(planning.length ? {planning_review: planning} : {}),
          next_action: "先核对完整名称、定义和限定词。semantic_suggestions没有执行引用，必要时在剩余预算内按完整名称或编码查证；相似度和目录身份都不等于用户已确认含义。保留原机构、日期和排序，提交resolve_business_turn：普通取值沿原query，分析需求才用intent=analyze及business_analysis计划。分析时用binding_ref（如k1），requirements.id与steps.answers关联；正式比较指标用observe，同指标跨日期用compare。没有审核关系不自行加总；有歧义才澄清，缺口如实说明。"})}],
          details: {kind: "analysis_catalog", status: "succeeded", keywords: input.keywords,
            topic_hints: results.flatMap(result => "topic_hints" in result && Array.isArray(result.topic_hints) ? result.topic_hints : []),
            semantic_suggestion_count: suggestionCount,
            ...(lookups.length ? {recovery_lookup_codes: lookups.map(item => item.code), unresolved_lookup_codes: lookupFailures} : {}),
            binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request),
            catalog_answer: results.flatMap(result => Array.isArray(result.items) ? result.items : []).flatMap(raw => {
              const item = raw as {name?: unknown; description?: unknown; explanation?: unknown; unit?: unknown};
              if (typeof item.name !== "string") return [];
              const knowledge = [...new Set([item.explanation, item.description]
                .filter((value): value is string => typeof value === "string" && !!value.trim()))].join("；");
              return [`${item.name}${typeof item.unit === "string" && item.unit ? `（单位：${item.unit}）` : ""}：${knowledge || "目录暂未提供完整业务定义。"}`];
            }).join("\n") || "本次目录检索未返回可说明的指标定义，可以换用完整指标名称继续检索。"}};
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
      const time = frame.fields.time?.resolvedValue as {start?: string; end?: string; dates?: string[]; date_selection?: string; record_selection?: string} | undefined;
      const latest = !time || time.date_selection === "latest_snapshot";
      let conversation = await request.commands.getConversationId();
      if (!conversation) {
        conversation = (await request.backend.createAgentQueryContext(request.sessionId, {signal: context.abortSignal})).conversation_id;
        await request.commands.setConversationId(conversation);
      }
      const first = previous[0]?.evidence as AnalysisEvidence | undefined;
      const payload = {plan, conversation_id: conversation,
        ...(orgs?.scope ? {organization_scope: orgs.scope, scope_fingerprint: orgs.scope_fingerprint, org_codes: []} : {org_codes: orgs?.codes ?? []}),
        date_selection: latest ? "latest_snapshot" : time?.record_selection === "all_in_range" ? "all_in_range"
          : time?.record_selection === "latest_in_range" ? "latest_in_range"
          : time?.start === time?.end || time?.dates ? "exact" : "available_in_range",
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
        ...rankingModelView(result, aliases),
        evidence_ref: evidenceRef, next_action: "coverage_review是可选探索方向，不是必须补齐的报告栏目。根据用户目标和analysis_brief实际发现选择具体疑问；补查计划inquiry写question、prior_judgment、basis_refs（此前事实原子）、expected_change，随后用inquiry_review的新证据支持、修正或限定判断；没有有效疑问就交付，不穷举候选。补查source复制followup_source中的完整reference配对，不自行拼接；没有该字段时只在唯一目标下用{kind:current}，多目标先读取上下文选择已签发reference。原句明确机构时operations保留机构set，同一范围的补查放在一份analysis计划中，只提交新增步骤。必要时analysis_catalog发现正式指标，遵守remaining_execution_rounds。报告自然组织，可直接回答、按发现展开或深入一个问题，不强制分主题栏目。正文只引用关键数字，其他明细留表格。数字用{{e1.v1}}等实际ref，值已含单位，不自行计算或截取。日期用actual_dates，不编造变量。未知会计口径不得假定累计或单月；不以余额推断业务原因或无标准评价好坏。"})}],
        details: {...result, execution_turn_id: request.semanticStep?.rootOperationId ?? request.operationId, binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request), answer_policy: "general_analysis_evidence_v1"}};
    }};
}

const reportParameters = Type.Object({evidence_refs: Type.Array(Type.String({description: "分析回执编号，如e1、e2；原子引用e1.v1等用于body正文，不在此处填写。"}), {minItems: 1, maxItems: 6}),
  chart: Type.Optional(reportChartSchema),
  body: Type.String({minLength: 1, maxLength: 6000, description: "必填完整自然正文，可用段落、要点或Markdown标题，无固定栏目。先回答最值得关注的发现，按证据展开判断、差异或待核验问题。只引用影响判断的关键数字，不逐行抄表，不在开篇与展开重复数字。补查后回答原疑问，说明判断获得支持、被修正或受到限制。展示关键数值用{{实际原子ref}}；verified_findings帮助理解比较方向与范围，可以自然改述，不要求照搬判断句。{{实际原子ref|cite}}可关联事实依据。注意区分基期、金额与比例，不能以余额变化认定未经证实的业务原因。日期采用actual_dates，不自行计算数值。"}),
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
export function createAnalysisReportTool(): AgentHarnessTool<AskMetricRequestContext, typeof reportParameters> {
  return {name: "analysis_report_present", label: "交付通用分析报告", parameters: reportParameters,
    description: "通用分析取数和必要补查后，依据本轮analysis_evidence交付body，并用chart主动配一张有助理解结论的图：机构或分类比较选bar，真实时间序列选line，只填已取得的数值原子引用。图选正文重点，通常3至8点，不必囊括全部明细；单值、无可比数据或用户只要文字时省略chart。正文和图在本次调用一起交付，不为画图重新取数。追问仅讨论已有结果时先read_business_result，body用{{实际原子ref}}或{{实际原子ref|cite}}明确关注指标，无需重复上一轮无关主题；新取数仍须覆盖原始目标。相同日期在顶部说明，不同日期须区分。presentation仅控制表达，不改变事实和权限。",
    execute: async (_id, rawInput, _update, request, _invocation, context) => {
      try {
        let input = {...rawInput, ...normalizeReportNarrative(rawInput)};
        const proseProblem = [input.summary, ...input.sections.flatMap(section => [section.title, section.text])]
          .map(publicTextProblem).find(problem => problem !== undefined);
        const evidence = await request.answerEvidence?.() ?? [];
        const allSources = successfulAnalyses(evidence);
        if (new Set(input.evidence_refs).size !== input.evidence_refs.length)
          throw new BackendApiError(422, "请选择非重复的本轮分析回执。", "ANALYSIS_REPORT_EVIDENCE");
        // 已知原子引用可准确回溯到本轮来源；不接受猜测、历史或越界引用。
        const atomOwners = new Map<string, string>();
        for (const item of allSources) {
          for (const alias of analysisEvidenceAliases(item.ref, (item.evidence as AnalysisEvidence).evidence_items ?? []).keys()) atomOwners.set(alias, item.ref);
        }
        input = {...input, evidence_refs: [...new Set(input.evidence_refs.map(ref => atomOwners.get(ref) ?? ref))]};
        const selected = input.evidence_refs.map(ref => evidence.find(item => item.ref === ref));
        if (new Set(input.evidence_refs).size !== input.evidence_refs.length || selected.some(item => item?.evidence.kind !== "analysis_evidence" || item.evidence.status !== "succeeded"))
          throw new BackendApiError(422, "请选择本轮成功的analysis_evidence回执e1/e2，不使用历史编号或目录回执。", "ANALYSIS_REPORT_EVIDENCE");
        const sources = selected.map(item => item!.evidence as AnalysisEvidence);
        const historical = (source: AnalysisEvidence) => !isCurrentAnalysisEvidence(source,
          request.semanticStep?.rootOperationId ?? request.operationId);
        const reuseOnly = allSources.every(item => historical(item.evidence as AnalysisEvidence));
        if (!reuseOnly && allSources[0] && !input.evidence_refs.includes(allSources[0].ref))
          throw new BackendApiError(422, "报告必须保留本轮首批计划及原始子问题，不能只交付最后一次补查。", "ANALYSIS_REPORT_COVERAGE");
        // 目录方向只是探索建议；用户原始子问题的证据覆盖仍由后端逐项校验。
        const aliases = new Map(input.evidence_refs.flatMap((ref, index) =>
          [...analysisEvidenceAliases(ref, sources[index]?.evidence_items ?? [])]));
        const translate = (text: string) => text.replace(/\{\{([^{}]+?)(\|cite)?\}\}/g,
          (full, ref: string, citation?: string) => aliases.has(ref) ? `{{${aliases.get(ref)}${citation ?? ""}}}` : full);
        const payload = {run_refs: allSources.filter(item => input.evidence_refs.includes(item.ref)).map(item => (item.evidence as AnalysisEvidence).run_ref), summary: input.summary,
          context_run_refs: sources.filter(historical).map(source => source.run_ref),
          focus_refs: [] as string[],
          ...(input.presentation ? {presentation: input.presentation} : {}),
          planning_gaps: [],
          sections: input.sections.map(section => ({...section, title: translate(section.title), text: translate(section.text), evidence_refs: [...new Set(section.evidence_refs.flatMap(ref => {
            const index = input.evidence_refs.indexOf(ref);
            return index < 0 ? [aliases.get(ref) ?? ref] : (sources[index]?.evidence_items ?? []).map(atom => atom.ref);
          }))]}))};
        payload.summary = translate(input.summary);
        const refs = [...new Set([payload.summary, ...payload.sections.flatMap(section => [section.title, section.text])]
          .flatMap(narrativeEvidenceRefs))];
        const known = new Set(sources.flatMap(source => source.evidence_items?.map(atom => atom.ref) ?? []));
        if ([...refs, ...payload.sections.flatMap(section => section.evidence_refs)].some(ref => !known.has(ref)))
          throw new BackendApiError(422, "报告包含不属于所选回执的原子引用，请使用真实证据引用。", "ANALYSIS_REPORT_REFERENCE");
        if (reuseOnly) {
          if (!refs.length) return {content: [{type: "text", text: "已读取历史分析，无需重新查询。请按本次追问选择相关指标，在body中使用回执的{{e1.v1}}等真实原子引用；无需展示数字时用{{e1.v1|cite}}。这些引用同时确定追问的证据范围，不要求重复上一轮无关主题，不能直接手写数值。"}],
            details: {kind: "analysis_report", status: "needs_revision", retryable: true}};
          payload.focus_refs = refs;
          rememberReportSelection(request, allSources.map(item => (item.evidence as AnalysisEvidence).run_ref), payload);
        }
        let details;
        try {
          details = await request.backend.analysisReport(payload, {signal: context.abortSignal});
          // 文案问题不能遮住服务端权限、范围及引用错误；完整核验通过后才恢复表达。
          if (proseProblem) throw new BackendApiError(422, proseProblem, "ANALYSIS_REPORT_SUMMARY");
        }
        catch (error) {
          // 仅正文错误可由已授权事实重建；来源、引用、权限和目标覆盖错误不能降级放行。
          if (context.abortSignal?.aborted || !(error instanceof BackendApiError) || [401, 403].includes(error.status)
            || !isReportProseErrorCode(error.code)) throw error;
          if (reportProseRepairTool(await request.turnMessages?.() ?? []) !== "analysis_report_present")
            return {content: [{type: "text", text: `${error.message}\n请基于本轮已有证据完整重写正文，保证比较对象、基期和前后指代一致，回应已取得证据的各个子问题并说明缺口。不逐句删除后拼接，不推断没有证据的原因。用完整body重新提交analysis_report_present，只修正文，不重新取数。`}],
              details: {kind: "analysis_report", status: "ARGUMENT_ERROR", error_code: error.code, retryable: true}};
          // 重写仍未通过时由后端整篇重建可靠事实；保留原引用供核验，不在这里拼接草稿句子。
          const repaired = await request.backend.analysisReport({...payload, fallback: true}, {signal: context.abortSignal});
          // 后端已重新核验事实与缺口，不丢弃有效回执再要求模型重复改写。
          details = {...repaired, narrative_repair: {reason_code: error.code}};
        }
        if (details.kind !== "business_report" || details.status !== "succeeded" || typeof details.public_answer !== "string") throw new Error("INVALID_ANALYSIS_REPORT");
        let publicAnswer = details.public_answer;
        // 正文整篇重建后，草稿选点失去上下文；随最终正文重新选图。
        const generated = buildReportChart(sources.map((evidence, index) => ({ref: input.evidence_refs[index]!, evidence})),
          details.narrative_repaired ? undefined : rawInput.chart, request.originalMessage,
          verifiedNarrativeRefs(details.report, details.narrative_repaired ? [] : refs));
        if (generated.charts.length || generated.notice) {
          const report = details.report as Record<string, unknown>;
          const notice = generated.notice;
          if (notice) publicAnswer += `\n\n${notice}`;
          details = {...details, partial_analysis: details.partial_analysis || !!notice,
            gaps: notice ? [...(Array.isArray(details.gaps) ? details.gaps : []), notice] : details.gaps,
            public_answer: publicAnswer,
            report: {...report, charts: generated.charts, summary: notice ? `${report.summary}\n\n${notice}` : report.summary}};
        }
        if (sources.length > 1 && request.frames && sources[0]?.frame_id) {
          const state = await request.frames.state(), root = await request.frames.get(sources[0].frame_id);
          if (root?.turnId === request.operationId && root.status === "success" && state.focusFrameId !== root.frameId) await request.frames.setFocus(root.frameId, state.version);
        }
        return {content: [{type: "text", text: publicAnswer}], details, terminate: true};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {content: [{type: "text", text: error instanceof Error ? error.message : "通用报告校验未完成"}],
          details: {kind: "analysis_report", status: "ARGUMENT_ERROR", retryable: true, ...(error instanceof BackendApiError ? {error_code: error.code} : {})}};
      }
    }};
}
