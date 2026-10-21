import {expect, it} from "vitest"
import {businessReportPresentation} from "./businessReportPresentation"
import type {MetricAskDetails} from "./agentApi"

const details: MetricAskDetails = {kind: "business_report", status: "succeeded", partial_analysis: true,
  gaps: ["缺少基期记录"], report: {summary: "规模增加，利润下降。", sections: [{title: "利润", text: "尚需核验收入成本。"}],
    presentation: {version: 1, scope: "隔离样本 · 2026-07-31", source_notices: ["测试来源"], limitations: ["口径未确认"]}, plans: []}}

it("结构化报告保留结论、来源及可见缺口，不以正文解析代替契约", () => {
  expect(businessReportPresentation(details)).toMatchObject({summary: "规模增加，利润下降。", partial: true,
    gaps: ["缺少基期记录"], source_notices: ["测试来源"], sections: [{title: "利润"}]})
})
it("自然正文模式保留空展开段落，旧版契约仍能显示", () => {
  const value = {...details, report: {...details.report!, sections: [],
    presentation: {...details.report!.presentation!, body_mode: "narrative" as const, layout: ["summary", "analysis", "data"] as const}}}
  expect(businessReportPresentation({...value, report: {...value.report, presentation: {...value.report.presentation,
    layout: ["summary", "analysis", "data"]}}})).toMatchObject({body_mode: "narrative", sections: []})
  expect(businessReportPresentation({...value, report: {...value.report, presentation: {...value.report.presentation,
    body_mode: "unknown"}}} as unknown as MetricAskDetails)).toBeUndefined()
  expect(businessReportPresentation(details)?.body_mode).toBeUndefined()
})
it("保留服务端选择的表达风格、密度、布局和动态标题", () => {
  const value = businessReportPresentation({...details, report: {
    summary: details.report!.summary,
    sections: details.report!.sections,
    plans: details.report!.plans ?? [],
    presentation: {...details.report!.presentation!, profile: "diagnostic", density: "detailed", variant: 1,
      layout: ["summary", "analysis", "data"], labels: {summary: "问题判断", data: "证据数据"}},
  }})
  expect(value).toMatchObject({profile: "diagnostic", density: "detailed", layout: ["summary", "analysis", "data"],
    labels: {summary: "问题判断", data: "证据数据"}})
})
it("旧快照、普通查数、未知版本及不完整结构回退原正文", () => {
  for (const value of [{...details, kind: "metric_read"}, {...details, report: {plans: []}},
    {...details, report: {...details.report, presentation: {...details.report!.presentation, version: 2}}},
    {...details, report: {...details.report, sections: [null]}}])
    expect(businessReportPresentation(value as MetricAskDetails)).toBeUndefined()
})
