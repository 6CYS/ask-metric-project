import type {QueryDatesEvidence} from "../backendClient.js";
import {isCalendarDate} from "../tools/shared.js";
import type {BusinessFrame} from "./types.js";

/** 只接受后端全量日期证据；样例行、截断结果和不一致的单日声明不能固定续问日期。 */
export function verifiedQueryDates(raw: unknown, rowCount: number, truncated: boolean): QueryDatesEvidence {
  const evidence = raw as Partial<QueryDatesEvidence> | null | undefined;
  const dates = evidence?.actual_dates;
  const complete = !truncated && evidence?.complete === true && Number.isInteger(rowCount) && rowCount >= 0
    && Array.isArray(dates) && dates.every(date => typeof date === "string" && isCalendarDate(date))
    && new Set(dates).size === dates.length && dates.length <= rowCount;
  if (!complete) return {complete: false, actual_dates: [], uniform_date: null};
  const uniform = evidence?.uniform_date;
  return {complete: true, actual_dates: dates,
    uniform_date: rowCount > 0 && dates.length === 1 && typeof uniform === "string" && uniform === dates[0] ? uniform : null};
}

/** 完成快照保存实际时点；原始 latest 意图留在元数据，不成为下一轮隐式刷新命令。 */
export function settleLatestQueryFields(frame: BusinessFrame, raw: unknown, rowCount: number, truncated: boolean): BusinessFrame["fields"] {
  const fields = structuredClone(frame.fields);
  const time = fields.time;
  if (frame.capability !== "metric_query" || (time?.resolvedValue as {preset?: string} | undefined)?.preset !== "latest") return fields;
  const dates = verifiedQueryDates(raw, rowCount, truncated);
  time!.metadata = {...time!.metadata, timePolicy: "latest", queryDates: dates};
  if (dates.uniform_date) {
    time!.rawValue = dates.uniform_date;
    time!.resolvedValue = {start: dates.uniform_date, end: dates.uniform_date};
    fields.selection = {rawValue: "实际数据日", resolvedValue: "exact", resolutionStatus: "resolved", source: "resolved", resolver: "enum"};
  }
  return fields;
}
