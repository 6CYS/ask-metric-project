import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {composePartialBusinessReport, type OverviewEvidence} from "./businessReport.js";

export const PARTIAL_ANALYSIS = "analysis_partial_present";
const parameters = Type.Object({reason: Type.Union([
  Type.Literal("corrections_exhausted"), Type.Literal("tool_budget"), Type.Literal("action_incomplete"),
  Type.Literal("model_failure"),
])}, {additionalProperties: false});
const notices = {
  corrections_exhausted: "后续规划或报告参数连续未通过校验，本轮仅交付已经取得并重新核验的部分数据；原问题尚未完整分析，未完成的主题和补查不作结论。",
  tool_budget: "本轮分析达到执行次数上限，仅交付已经取得并重新核验的部分数据；原问题尚未完整分析，未完成的主题和补查不作结论。",
  action_incomplete: "本轮未能完成后续分析动作，仅交付已经取得并重新核验的部分数据；原问题尚未完整分析，未完成的主题和补查不作结论。",
  model_failure: "后续模型响应失败，未能完成分析，本轮仅交付已经取得并重新核验的部分数据；原问题尚未完整分析，未完成的主题和文字分析不作结论。",
};

/** 宿主的有界降级动作：不让模型重写事实，仍走原生工具回执和当前身份授权。 */
export function createPartialAnalysisTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: PARTIAL_ANALYSIS, label: "交付已核验的部分分析", parameters,
    description: "内部交付动作：纠错或调用预算用尽后，重新授权当前回合证据并呈现已有事实，明确分析未完成。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      try {
        const sources = (await request.answerEvidence?.() ?? []).filter(item => item.evidence.status === "succeeded"
          && ["business_overview", "analysis_evidence"].includes(item.evidence.kind));
        if (!sources.length) throw new Error("本轮没有可交付的分析证据。");
        const notice = notices[input.reason];
        const reports: Array<Record<string, unknown>> = [];
        // 各范围分别校验和呈现，不将不同日期、主题或机构合并计算。
        for (const item of sources) {
          if (item.evidence.kind === "business_overview") {
            const source = item.evidence as OverviewEvidence;
            const scope = await request.backend.resolveBusinessField("organization", source.org_codes, {signal: context.abortSignal});
            if (scope.status !== "resolved" || JSON.stringify((scope.value as {codes?: string[]})?.codes) !== JSON.stringify(source.org_codes))
              throw new Error("报告机构权限已变化。");
            for (const task of source.tasks) await request.backend.getTask(task.task_id, {signal: context.abortSignal});
            reports.push(composePartialBusinessReport([source], {evidence_refs: [item.ref], summary: "",
              sections: [], metric_ids: [...new Set(source.table_rows.map(row => row.metric_id!))]}));
          } else {
            const source = item.evidence as unknown as {run_ref: string};
            // 后端按保存的run重新校验用户、会话范围与每个基础任务，不信任传入正文。
            const report = await request.backend.analysisReport({run_refs: [source.run_ref], summary: "", sections: [], fallback: true}, {signal: context.abortSignal});
            if (report.kind !== "business_report" || report.status !== "succeeded" || typeof report.public_answer !== "string") throw new Error("INVALID_ANALYSIS_REPORT");
            reports.push({...report, public_answer: report.public_answer.replace(
              "已取得的事实如下；部分文字分析未通过校验，现交付可核验事实与缺口。", "以下为已取得的事实与缺口，完整分析尚未完成。")});
          }
        }
        const rows = reports.flatMap(report => (report.rows as Array<Record<string, unknown>>).map(row => ({...row,
          org_name: row.org_name ?? report.org_name,
          stat_date: row.stat_date ?? report.analysis_date,
        })));
        // 后续规划失败不能抹去先前已核验的判断；正文与正常报告使用相同展示契约。
        const reportBodies = reports.map(report => (report.report ?? {summary: report.public_answer}) as {summary?: string;
          sections?: Array<{title: string; text: string}>; plans?: unknown[];
          presentation?: {scope?: string; source_notices?: string[]; limitations?: string[]}});
        const body = [...reportBodies.flatMap(report => [report.summary,
          ...report.sections?.map(section => `${section.title ? `**${section.title}**\n\n` : ""}${section.text}`) ?? []]),
          "后续补查未完成，以上仅依据已取得并核验的数据；尚缺证据的原因和变化不作结论。"].filter(Boolean).join("\n\n");
        const details = {kind: "business_report", status: "succeeded", delivery: "business_evidence_v1",
          answer_policy: "verified_report_v1", partial_analysis: true, fallback_reason: input.reason,
          public_answer: body,
          columns: [...new Set(["org_name", "stat_date", ...reports.flatMap(report => report.columns as string[])])],
          org_codes: [...new Set(reports.flatMap(report => report.org_codes as string[]))],
          rows, row_count: rows.length, tasks: reports.flatMap(report => report.tasks as unknown[]),
          gaps: [notice, ...reports.flatMap(report => report.gaps as string[] ?? []),
            ...sources.flatMap(item => item.evidence.kind === "business_overview"
              ? (item.evidence as OverviewEvidence).followup_candidates?.map(candidate => `尚未完成补查：${candidate.reason}`) ?? [] : [])],
          report: {summary: body, sections: [], plans: reportBodies.flatMap(report => report.plans ?? []),
            evidence_refs: sources.map(item => item.ref),
            presentation: {version: 1, body_mode: "narrative", layout: ["summary", "analysis", "data"],
              scope: [...new Set(reportBodies.map(report => report.presentation?.scope).filter(Boolean))].join("；"),
              source_notices: [...new Set(reportBodies.flatMap(report => report.presentation?.source_notices ?? []))],
              limitations: [...new Set(reportBodies.flatMap(report => report.presentation?.limitations ?? []))]}},
          source_reports: reports};
        return {content: [{type: "text" as const, text: details.public_answer}], details, terminate: true};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        const text = "已查询的数据暂未能完成交付校验，本轮分析未完成；为避免展示未经核验的数据，本次不输出数值。原查询条件已保留。";
        return {content: [{type: "text" as const, text}], details: {kind: "business_report", status: "failed",
          delivery: "business_evidence_v1", public_answer: text}, terminate: true};
      }
    }};
}
