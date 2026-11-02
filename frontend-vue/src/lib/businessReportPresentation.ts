import type { MetricAskDetails } from "./agentApi"
import type { AnalysisReportView } from "@/types/api"
import { isBusinessReportChart } from "./businessReportChart"

/** 只接受完整的版本化展示契约；旧快照和异常响应保留原正文，避免静默丢失内容。 */
export function businessReportPresentation(details: MetricAskDetails): AnalysisReportView | undefined {
  const report = details.report
  const view = report?.presentation
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string")
  const profiles = ["brief", "snapshot", "trend", "diagnostic", "multi_topic"]
  const densities = ["compact", "medium", "detailed"]
  const blocks = ["summary", "data", "analysis"]
  const validLayout = (value: unknown): value is Array<"summary" | "data" | "analysis"> =>
    value === undefined || Array.isArray(value) && value.length > 0 && value.every(item => blocks.includes(item as string))
  const validLabels = (value: unknown): value is Record<string, string> =>
    value === undefined || !!value && typeof value === "object" && !Array.isArray(value)
      && Object.values(value).every(item => typeof item === "string" && item.trim())
  if (details.kind !== "business_report" || details.status !== "succeeded" || view?.version !== 1
    || typeof report?.summary !== "string" || !report.summary.trim() || typeof view.scope !== "string"
    || !strings(view.source_notices) || !strings(view.limitations) || !strings(details.gaps ?? [])
    || !Array.isArray(report.sections) || !report.sections.every(section => section && typeof section.title === "string" && typeof section.text === "string")
    || view.profile !== undefined && !profiles.includes(view.profile)
    || view.density !== undefined && !densities.includes(view.density)
    || !validLayout(view.layout) || !validLabels(view.labels)) return undefined
  if (view.body_mode !== undefined && view.body_mode !== "narrative") return undefined
  const charts = Array.isArray(report.charts) ? report.charts.filter(isBusinessReportChart) : []
  return { summary: report.summary, sections: report.sections, scope: view.scope,
    source_notices: [...new Set(view.source_notices.filter(Boolean))], limitations: [...new Set(view.limitations.filter(Boolean))],
    gaps: [...new Set(details.gaps ?? [])], partial: details.partial_analysis === true,
    ...(charts.length ? { charts } : {}),
    ...(view.body_mode ? { body_mode: view.body_mode } : {}),
    ...(view.profile ? { profile: view.profile } : {}), ...(view.density ? { density: view.density } : {}),
    ...(view.layout ? { layout: view.layout } : {}), ...(view.labels ? { labels: view.labels } : {}) }
}
