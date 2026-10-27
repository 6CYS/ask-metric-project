import { Type, StringEnum } from "@earendil-works/pi-ai";
import {verifiedFindingsView, type VerifiedFindings} from "../analysis/verifiedFindings.js";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { commandKey } from "../harnessHost.js";
import { BackendApiError } from "../backendClient.js";
import { backendErrorResult } from "./shared.js";
import type { BusinessFrame, ResolvedOrganizations } from "../business-context/types.js";
import {analysisTopicHints} from "../analysis/bindings.js";
import {analysisFollowupSource, inquiryReview, type AnalysisInquiry} from "../analysis/inquiry.js";

export interface OverviewPlan {
  topic?: "loan" | "deposit";
  topic_version?: string;
  goal: "overview" | "growth" | "structure" | "quality";
  sections: Array<"scale" | "growth" | "structure" | "quality">;
  objective?: string;
  questions?: string[];
  metric_ids?: string[];
  comparisons?: Array<"mom" | "yoy" | "ytd">;
  rationale?: string;
  inquiry?: AnalysisInquiry;
}

/** 基础问数的“本月”截止今天；月末余额概览使用完整日历月，覆盖检查仍截止今天。 */
export function overviewMonthRange(raw: unknown, time: {start: string; end: string; dates?: string[]} | undefined) {
  if (!time || time.dates || typeof raw !== "string" || !/^(本月|这个月|当月|当前月)$/u.test(raw.trim())) return time;
  const [year, month] = time.start.split("-").map(Number);
  if (!year || !month || !time.start.endsWith("-01") || time.start.slice(0, 7) !== time.end.slice(0, 7)) return time;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {...time, end: `${time.start.slice(0, 7)}-${lastDay}`};
}

export function createBusinessTopicReadTool(): AgentHarnessTool<AskMetricRequestContext> {
  return {name: "business_topic_read", label: "读取业务主题",
    description: "读取本轮analysis_catalog已返回topic_hints中的可选存贷款分析方法。主题仅提供整理好的metric_id、关系、公式和口径，不代表完整指标目录，也不改变用户的分析目标；通用分析指标继续从analysis_catalog发现。按需用content=knowledge重读当前启用知识，知识不替代正式口径、数值或归因证据。选择专项方法时结合business-overview Skill，取数后通过business_report_present交付。",
    parameters: Type.Object({topic: StringEnum(["loan", "deposit"]), content: StringEnum(["topic", "knowledge"])}, {additionalProperties: false}),
    execute: async (_id, params, _update, request, _invocation, context) => {
      const input = params as {topic: string; content: "topic" | "knowledge"};
      const topics = analysisTopicHints(await request.turnMessages?.() ?? []);
      if (!topics.some(topic => topic === input.topic)) return {
        content: [{type: "text", text: "请先用analysis_catalog按用户原目标发现正式指标；仅可读取本轮返回topic_hints中的辅助方法，不能猜测主题或用主题范围代替整个目录。"}],
        details: {kind: "business_topic_read", status: "ARGUMENT_ERROR", available_topics: topics}, isError: true,
      };
      try {
        const result = await request.backend.businessTopic(input.topic, input.content === "knowledge", {signal: context.abortSignal});
        if (input.content === "topic" && (typeof result.version !== "string" || result.method !== "business-overview-v1" || !Array.isArray(result.metrics))) throw new Error("INVALID_TOPIC_RESPONSE");
        // 明确询问已禁用口径的含义时，只交付正式映射缺口；不能误匹配其他复合指标。
        const question = request.originalMessage.normalize("NFKC").replace(/\s+/gu, "");
        const disabled = input.content === "topic" && /区别|差别|含义|是什么意思|口径/u.test(question)
          ? (result.metrics as Array<{label: string; disabled_reason?: string; question_terms?: string[]}>).filter(metric =>
            metric.disabled_reason && metric.question_terms?.length
            && metric.question_terms.every(term => question.includes(term.normalize("NFKC").replace(/\s+/gu, "")))) : [];
        if (disabled.length) {
          const answer = `您关注的${disabled.map(metric => metric.label).join("、")}目前无法可靠区分。\n\n`
            + [...new Set(disabled.map(metric => metric.disabled_reason))].join("；")
            + "。因此当前不能提供这些口径的实际数值差异，也不能用其他活期占比或增幅指标代替。"
            + `\n\n说明依据是项目${input.topic === "deposit" ? "存款主题的指标映射（来源于提供的指标映射 Excel）" : "贷款主题的指标映射"}，本次未执行数值查询。需要业务确认定义并分别完成正式绑定后，才能进行比较。`;
          return {content: [{type: "text", text: answer}], details: {kind: "business_topic_explanation",
            status: "unsupported", delivery: "business_evidence_v1", public_answer: answer, topic: input.topic,
            topic_version: result.version, gaps: disabled.map(metric => ({label: metric.label, reason: metric.disabled_reason}))}, terminate: true};
        }
        return {content: [{type: "text", text: JSON.stringify(result)}],
          details: {kind: "business_topic_read", status: "ok", ...(input.content === "knowledge" ? {
            topic: input.topic, content: input.content, ...(typeof result.revision === "string" ? {revision: result.revision} : {}),
          } : {})}};
      } catch (error) {
        const handled = backendErrorResult(error, {kind: "business_topic_read", status: "error"});
        if (handled) return handled;
        throw error;
      }
    }};
}

/** 仅供 READY Frame 调用；模型不能提交日期、编码或计算表达式。 */
export function createBusinessOverviewTool(frame: BusinessFrame): AgentHarnessTool<AskMetricRequestContext> {
  return {name: "business_overview", label: "执行经营概览", parameters: Type.Object({}, {additionalProperties: false}),
    description: "基于已校验主题计划，复用现有基础查询与受控计算形成经营概览。",
    execute: async (_id, _params, _update, request, _invocation, context) => {
      const previous = (await request.answerEvidence?.() ?? []).filter(item => item.evidence.kind === "business_overview" && item.evidence.status === "succeeded");
      if (previous.length >= 3) return {content: [{type: "text", text: "已达到三轮取数上限，请用已有证据及缺口调用 business_report_present 完成报告。"}],
        details: {kind: "business_overview", status: "ARGUMENT_ERROR", retryable: true}};
      const plan = frame.fields.plan?.resolvedValue as OverviewPlan;
      const orgs = frame.fields.organizations?.resolvedValue as ResolvedOrganizations | undefined;
      const resolvedTime = frame.fields.time?.resolvedValue as {start?: string; end?: string; dates?: string[]; date_selection?: string} | undefined;
      const latestSnapshot = !resolvedTime || resolvedTime.date_selection === "latest_snapshot";
      const time = latestSnapshot ? undefined : overviewMonthRange(frame.fields.time?.rawValue,
        resolvedTime as {start: string; end: string; dates?: string[]} | undefined);
      if (orgs?.scope || orgs && orgs.codes.length !== 1 || time?.dates) {
        return {content: [{type: "text", text: "当前概览支持单机构与连续期间，机构集合或离散日期暂需分别查询。"}],
          details: {kind: "business_overview", status: "failed", public_answer: "当前经营概览支持单机构与连续期间；机构集合或离散日期暂需分别查询。"}};
      }
      try {
        // 主题版本属于服务端契约，执行时固定当前版本，不让模型猜写版本号造成无意义澄清。
        const topic = await request.backend.businessTopic(plan.topic ?? "loan", false, {signal: context.abortSignal});
        if (typeof topic.version !== "string" || topic.method !== "business-overview-v1") throw new Error("INVALID_TOPIC_RESPONSE");
        let conversationId = await request.commands.getConversationId();
        if (!conversationId) {
          const created = await request.backend.createAgentQueryContext(request.sessionId, {signal: context.abortSignal});
          conversationId = created.conversation_id;
          await request.commands.setConversationId(conversationId);
        }
        const sameScope = previous.map(item => item.evidence as import("./businessReport.js").OverviewEvidence)
          .find(item => (item.topic ?? "loan") === (plan.topic ?? "loan")
            && JSON.stringify(item.org_codes) === JSON.stringify(orgs?.codes ?? item.org_codes)
            && item.date_selection === (latestSnapshot ? "latest_snapshot" : time?.start !== time?.end ? "available_in_range" : "exact")
            && item.analysis_date);
        const payload = {topic: plan.topic ?? "loan", method: "business-overview-v1", ...plan, topic_version: topic.version,
          org_codes: orgs?.codes ?? [], ...(time ? {start: time.start, end: time.end} : {}),
          date_selection: latestSnapshot ? "latest_snapshot" : time?.start !== time?.end ? "available_in_range" : "exact",
          ...(latestSnapshot && sameScope ? {anchor_date: sameScope.analysis_date} : {}),
          ...(sameScope?.period && sameScope.plan?.metric_ids ? {coverage_metric_ids: sameScope.plan.metric_ids} : {}),
          allow_latest_reference: false,
          conversation_id: conversationId,
          calculation_context: {scope_id: request.operationId, user_question: request.originalMessage}};
        const key = commandKey({owner: request.actor.id, session: request.sessionId, operation: request.operationId, action: "business_overview", payload});
        const result = await request.backend.businessOverview(payload, key, {signal: context.abortSignal});
        if (result.status !== "succeeded" || typeof result.public_answer !== "string" || !Array.isArray(result.tasks) || !Array.isArray(result.gaps)) throw new Error("INVALID_OVERVIEW_RESPONSE");
        // 完整不可变回执留在 details，模型读文字证据与缺口，避免每次重复发送计算输入/基期明细。
        const modelReceipt = Object.fromEntries(["status", "kind", "topic", "topic_version", "method", "goal", "sections",
          "requested_date", "analysis_date", "date_selection", "coverage_metric_ids", "period", "data_freshness", "topic_name", "source_notice", "context_notice", "metric_sources", "org_codes", "org_name", "basis", "complete", "plan", "evidence_items", "verified_findings", "table_rows", "reconciliations", "gaps", "followup_candidates"]
          .map(name => [name, result[name]]));
        return {content: [{type: "text", text: JSON.stringify({...modelReceipt,
          verified_findings: verifiedFindingsView(result.verified_findings as VerifiedFindings | undefined, new Map()),
          evidence_items: Array.isArray(result.evidence_items) ? (result.evidence_items as Array<Record<string, unknown>>)
            .map(atom => ({...atom, calculation: undefined, input_refs: undefined, compiler_version: undefined})) : result.evidence_items,
          inquiry_review: inquiryReview(plan.inquiry, previous, {ref: `e${(await request.answerEvidence?.() ?? []).length + 1}`, evidence: result as unknown as import("./businessReport.js").OverviewEvidence}),
          followup_source: await analysisFollowupSource(request),
          evidence_ref: `e${(await request.answerEvidence?.() ?? []).length + 1}`,
          next_action: result.analysis_date === null
            ? "目标日期覆盖已经核对，无可用记录。现在必须调用 business_report_present：metric_ids=[]，解释 gap 证据；不切换到 data_availability，不询问已可默认的机构，不换日期。"
            : "先回答用户目标，再从实际发现选择值得追查的具体疑问。followup_candidates是线索，不必全部查询；补查在plan.inquiry写明question、prior_judgment、basis_refs（已有事实原子）和expected_change，修改计划只取有助解决疑问的证据；source复制followup_source的完整reference配对，多目标不猜current。读取inquiry_review将新证据用于支持、修正或限定原判断。用户关注指标不在主题映射时可analysis_catalog并转通用计划，不能说整个库无数据。目标已回答或无有效补查条件即business_report_present。正文围绕重点自然成文，只引用关键数字，完整明细留表格；不自行计算。"})}], details: {
          ...result, execution_turn_id: request.semanticStep?.rootOperationId ?? request.operationId, kind: "business_overview", row_count: (result.tasks as unknown[]).length,
          answer_policy: "overview_evidence_v2",
        }};
      } catch (error) {
        if (context.abortSignal?.aborted || !(error instanceof BackendApiError) || error.status >= 500) throw error;
        if (error.status === 409 && error.code === "TOPIC_VERSION_CHANGED") {
          return {content: [{type: "text", text: "主题在执行期间更新，请重新读取主题后发起同一分析；本次尚未取数。"}],
            details: {kind: "business_overview", status: "ARGUMENT_ERROR", error_code: error.code}};
        }
        const handled = backendErrorResult(error, {kind: "business_overview", status: "error", error_code: error.code});
        if (handled) return handled;
        throw error;
      }
    }};
}
