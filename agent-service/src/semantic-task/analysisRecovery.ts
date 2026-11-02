import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {AnalysisPlan, AnalysisPlanDiagnostic} from "../analysis/contracts.js";
import {isSemanticFeedback} from "./feedback.js";

export const ANALYSIS_REPAIR = "analysis_plan_repair";
export interface AnalysisRecoveryFeedback {
  task_ref: string; target_ref: string; revision: number; attempt: number; max_attempts: number;
  diagnostics: AnalysisPlanDiagnostic[];
  requirements: AnalysisPlan["requirements"];
  retained_step_ids: string[];
  next_action: "discover_metrics" | "repair_steps";
}
type Discovery = {keywords: string[]; page_size: number};
type AnalysisRecoveryPhase = {tool: "analysis_catalog" | typeof ANALYSIS_REPAIR; recovery: AnalysisRecoveryFeedback; discovery: Discovery}
  | {tool: "analysis_catalog" | "resolve_business_turn"; discovery: Discovery};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function analysisRecoveryPhase(messages: readonly AgentMessage[]): AnalysisRecoveryPhase | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || !isSemanticFeedback(message.details)) continue;
    const initial = message.details.analysis_discovery;
    if (message.details.status === "invalid_input" && initial) {
      const reads = messages.slice(index + 1).filter(item => item.role === "toolResult" && item.toolName === "analysis_catalog");
      const discovered = reads.some(item => item.role === "toolResult" && !item.isError && record(item.details)
        && item.details.status === "succeeded" && Array.isArray(item.details.candidate_map)
        && item.details.candidate_map.some(candidate => record(candidate) && candidate.match_type !== "semantic"
          && typeof candidate.binding_ref === "string" && !!candidate.binding_ref.trim()));
      const exhausted = reads.some(item => item.role === "toolResult" && record(item.details) && item.details.status === "budget_exhausted");
      return {tool: discovered || exhausted || reads.length >= 2 ? "resolve_business_turn" : "analysis_catalog",
        discovery: {keywords: initial.requirements.slice(0, 4).map(item => item.question.slice(0, 200)), page_size: 30}};
    }
    if (!message.details.analysis_recovery) return;
    const recovery = message.details.analysis_recovery;
    const reads = messages.slice(index + 1).filter(item => item.role === "toolResult" && item.toolName === "analysis_catalog");
    const discovered = reads.some(item => item.role === "toolResult" && !item.isError && (item.details as {status?: string})?.status === "succeeded");
    const tool = recovery.next_action === "discover_metrics" && !discovered && reads.length < 2 ? "analysis_catalog" : ANALYSIS_REPAIR;
    // 优先复用此前目录请求中与缺失子问题相符的关键词；没有匹配时保留完整业务疑问。
    const keywords = [...new Set(messages.flatMap(item => item.role === "toolResult" && item.toolName === "analysis_catalog"
      ? ((item.details as {keywords?: string[]})?.keywords ?? []).filter(word => recovery.requirements.some(req => req.question.includes(word))) : []))];
    return {tool, recovery, discovery: {keywords: (keywords.length ? keywords : recovery.requirements.map(item => item.question)).slice(0, 4).map(word => word.slice(0, 200)), page_size: 30}};
  }
}
