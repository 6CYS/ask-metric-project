import type {BusinessFrame, ContextDelta, ResolverContext} from "./types.js";
import type {AnalysisPlan} from "../analysis/contracts.js";
import {selectedAnalysisDates, type AnalysisDates, type AnalysisDatePolicy} from "./analysisScope.js";
import {BusinessInputError} from "./inputError.js";

/** 计划已还原正式绑定后再固定日期，避免混合分析的最大日覆盖较旧指标。 */
export function inheritAnalysisDate(fields: BusinessFrame["fields"], _delta?: ContextDelta, context?: ResolverContext): void {
  const time = fields.time, metadata = time?.metadata?.analysisDates as AnalysisDates | undefined;
  const policy = time?.metadata?.analysisDatePolicy as AnalysisDatePolicy | undefined;
  const value = time?.resolvedValue as {start?: string; end?: string; date_selection?: string} | undefined;
  if (!time || time.source !== "inherited" || !metadata
    || !policy && value?.start && value.end && value.date_selection !== "latest_snapshot"
    || fields.plan?.resolutionStatus !== "resolved") return;
  const plan = fields.plan.resolvedValue as AnalysisPlan;
  const refs = [...new Set(plan.steps.flatMap(step => step.metric_refs))];
  if (!refs.length) return;
  // 同轮补查新指标仍按原始策略发现数据；已有指标的机构拆解继续使用其实际日。
  if (policy && context?.rootOperationId && metadata.execution_turn_id === context.rootOperationId
    && refs.some(ref => !metadata.metric_dates.some(item => item.binding_ref === ref))) {
    delete time.rawValue; delete time.resolvedValue; delete time.resolver;
    Object.assign(time, structuredClone(policy));
    return;
  }
  const selected = selectedAnalysisDates(metadata, refs);
  if (!selected || selected.actual_dates.length !== 1) throw new BusinessInputError(
    "ANALYSIS_CONTINUATION_DATE_REQUIRED", "time",
    "所选历史指标没有共同且完整的实际数据日，不能重新默认最新日期。请回读原分析，按各指标已核验的实际日期分开规划，并在operations指定对应日期；只修正内部计划，不让用户重复补已有日期。");
  const day = selected.actual_dates[0]!;
  Object.assign(time, {rawValue: day, resolvedValue: {start: day, end: day, date_selection: "exact"},
    resolutionStatus: "resolved", resolver: "overview_date"});
}
