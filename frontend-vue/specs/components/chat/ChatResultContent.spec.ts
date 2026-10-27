import { describe, expect, it, vi } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import ChatResultContent from "../../../src/components/chat/ChatResultContent.vue"
import type { ChatResponse } from "@/types/api"

const rows = [
  { metric_name: "信贷客户数量当日数", org_name: "常熟农商行", stat_date: "2026-04-30", metric_value: "311312", rank: 1 },
  { metric_name: "信贷客户数量当日数", org_name: "江南农商行", stat_date: "2026-04-30", metric_value: "237854", rank: 2 },
]
const response = {
  message_id: "m1",
  intent: "metric_query",
  answer: "2026年04月30日：第1名常熟农商行信贷客户数量当日数为311,312户。",
  result: { type: "metric_query", table: { columns: Object.keys(rows[0]!), rows } },
  metric_definition: null,
  clarification: null,
  debug: null,
} as unknown as ChatResponse

const render = (props: Record<string, unknown>) => renderToString(createSSRApp(ChatResultContent, props))

describe("数据明细默认展开", () => {
  it("自然报告的明细和复制位于同一行，入口前没有分隔线或空的正文占位", async () => {
    const html = await render({response: {...response, analysis_report: {
      summary: "隔离样本报告正文。", scope: "隔离机构 · 2026-07-31", partial: false,
      body_mode: "narrative", sections: [], gaps: [], source_notices: [], limitations: []}}})
    const toolbar = html.match(/<div[^>]*role="group"[^>]*aria-label="数据明细操作"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? ""
    expect(toolbar).toContain("查看 2 条数据明细")
    expect(toolbar).toContain('aria-label="复制回答"')
    expect(toolbar).not.toContain("border-t")
    expect(toolbar).not.toContain("absolute")
    expect(html.match(/aria-label="复制回答"/g)).toHaveLength(1)
    expect(html).not.toContain("group/answer")
    expect(html.indexOf("隔离样本报告正文")).toBeLessThan(html.indexOf("数据明细操作"))
  })
  it.each(["hidden", "empty", "missing"])("自然报告在明细不可显示时仍保留复制入口：%s", async mode => {
    const value = {...response, ...(mode === "empty" ? {result: {type: "metric_query", table: {columns: [], rows: []}}} : {}),
      ...(mode === "missing" ? {result: undefined} : {}), analysis_report: {
        summary: "隔离样本报告正文。", scope: "隔离机构", partial: false,
        body_mode: "narrative", sections: [], gaps: [], source_notices: [], limitations: []}}
    const html = await render({response: value, showDataDetails: mode !== "hidden"})
    expect(html.match(/aria-label="复制回答"/g)).toHaveLength(1)
    expect(html).not.toContain('aria-label="数据明细操作"')
  })
  it("历史报告中的转义换行按标题、正文和局部强调显示，不改写原始响应", async () => {
    const value = {...response, analysis_report: {summary: String.raw`## 费用观察\n\n费用为7.40亿元。\n\n**费用与收入存在分化**，仍需核查具体动因。`,
      scope: "隔离样本 · 2026-07-31", partial: false, body_mode: "narrative" as const,
      sections: [], gaps: [], source_notices: [], limitations: []}}
    const restored = JSON.parse(JSON.stringify(value))
    const before = JSON.stringify(restored)
    const html = await render({response: restored})
    expect(html).toContain("<h2>费用观察</h2>")
    expect(html).toContain("<p>费用为7.40亿元。</p>")
    expect(html).toContain("<strong>费用与收入存在分化</strong>")
    expect(html).not.toContain(String.raw`\n`)
    expect(JSON.stringify(restored)).toBe(before)
  })
  it("自然正文不强加摘要栏目，完整数据折叠且不重复旧版全文", async () => {
    const html = await render({response: {...response, answer: "不应重复的完整旧版文本",
      analysis_report: {summary: "重点是不同业务的变化分化。", scope: "隔离机构 · 2026-07-31", partial: false,
        body_mode: "narrative", layout: ["summary", "analysis", "data"], sections: [{title: "总量掩盖了哪些差异", text: "补查限定了总量判断。"}],
        gaps: [], source_notices: ["授权查询库"], limitations: []}}})
    expect(html).toContain("重点是不同业务的变化分化。")
    expect(html).toContain("总量掩盖了哪些差异")
    expect(html).toContain("查看 2 条数据明细")
    for (const value of ["<table", "主要结论", "关键数据", "不应重复的完整旧版文本", "bg-muted/20 p-4"])
      expect(html).not.toContain(value)
    expect(html).not.toContain("授权查询库")
    expect(html).not.toContain("数据来源与分析依据")
  })
  it("新版报告保留正文末尾的缺口说明，不展示部分完成标签或重复缺口卡片", async () => {
    const html = await render({response: {...response, answer: "旧版完整正文",
      analysis_report: {summary: "规模增加而利润回落。", scope: "隔离机构 · 2026-07-31", partial: true,
        sections: [{title: "存款分析", text: "存款规模观察。"}, {title: "贷款分析", text: "贷款规模观察。"}, {title: "利润分析", text: "利润差异观察。\n\n成本明细缺失，因此暂不能判断成本对利润的影响。"}],
        gaps: ["成本明细缺失"], source_notices: ["来自授权查询结果"], limitations: ["不推断原因"]}}})
    expect(html.indexOf("规模增加而利润回落")).toBeLessThan(html.indexOf("<table"))
    expect(html.indexOf("<table")).toBeLessThan(html.indexOf("存款分析"))
    for (const text of ["关键数据", "贷款分析", "利润分析", "成本明细缺失"]) expect(html).toContain(text)
    for (const text of ["部分完成", "未完成项与数据缺口", 'aria-label="数据缺口"', "数据来源与分析依据", "来自授权查询结果", "不推断原因"]) expect(html).not.toContain(text)
    expect(html.match(/成本明细缺失/g)).toHaveLength(1)
    expect(html.indexOf("成本明细缺失")).toBeGreaterThan(html.indexOf("利润差异观察"))
    expect(html).not.toContain("旧版完整正文")
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })
  it("报告不展示自定义来源栏目或回退分析计划，原始依据仍保留在响应中", async () => {
    const value = {...response, analysis_plan: ["内部分析依据问题"], analysis_report: {
      summary: "贷款质量环比改善。", scope: "隔离机构 · 2026-08-27", partial: false,
      sections: [], gaps: [], source_notices: ["后台来源记录"], limitations: ["后台口径记录"],
      labels: {sources: "证据与边界"}}}
    const before = JSON.stringify(value)
    const html = await render({response: value})
    expect(html).toContain("贷款质量环比改善。")
    expect(html).toContain("收起数据明细")
    for (const text of ["数据来源与分析依据", "证据与边界", "后台来源记录", "后台口径记录", "内部分析依据问题", "分析思路"])
      expect(html).not.toContain(text)
    expect(JSON.stringify(value)).toBe(before)
  })
  it("自然正文报告及历史快照只保留正文中的期间限制，内部部分状态不被改写", async () => {
    const report = {summary: "截至8月27日，贷款质量环比改善。\n\n所问三季度目前只有一个快照，7月和9月暂无可用数据，无法判断整个季度的变化。",
      scope: "隔离机构 · 2026-07-01至2026-09-30", partial: true, body_mode: "narrative" as const,
      sections: [], gaps: ["以下月份无可用记录：2026-07、2026-09，不能判断这些月份的变化"], source_notices: [], limitations: []}
    // 序列化后重新渲染，覆盖从历史消息快照恢复的路径。
    const restored = JSON.parse(JSON.stringify({...response, analysis_report: report})) as ChatResponse
    const before = JSON.stringify(restored)
    const html = await render({response: restored})
    expect(html).toContain("7月和9月暂无可用数据，无法判断整个季度的变化。")
    expect(html.match(/所问三季度/g)).toHaveLength(1)
    for (const text of ["部分完成", "未完成项与数据缺口", "以下月份无可用记录", 'aria-label="数据缺口"']) expect(html).not.toContain(text)
    expect(JSON.stringify(restored)).toBe(before)
    expect(restored.analysis_report?.partial).toBe(true)
    expect(restored.analysis_report?.gaps).toEqual(report.gaps)
  })
  it("指标值附带较长口径说明时完整换行，不挤占相邻的数据用途列", async () => {
    const value = "原始值 -0.0133673076（目录单位%，数值编码待确认）"
    const reportRows = [{ metric_name: "资产总额较上月增幅", org_name: "隔离机构",
      stat_date: "2026-07-31", metric_value: value, value_role: "分析时点" }]
    const html = await render({ response: { ...response,
      result: { type: "metric_query", table: { columns: Object.keys(reportRows[0]!), rows: reportRows } } } })
    expect(html).toContain(value)
    const valueSpan = html.match(/<span[^>]*class="([^"]+)"[^>]*>原始值[^<]+<\/span>/)?.[1] ?? ""
    for (const token of ["whitespace-normal", "break-words", "[overflow-wrap:anywhere]"])
      expect(valueSpan.split(" ")).toContain(token)
    expect(html).toContain("分析时点")
  })

  it("经营报告保留比较列、基础表格、正文和可展开分析计划", async () => {
    const reportRows = [
      { metric_name: "各项贷款", current_value: "120.00亿元", mom_change: "5.00亿元；4.35%", yoy_change: "10.00亿元", ytd_change: "8.00亿元", share: "—" },
      { metric_name: "个人贷款", current_value: "40.00亿元", mom_change: "-2.00亿元", yoy_change: "-1.00亿元", ytd_change: "-3.00亿元", share: "33.33%" },
    ]
    const html = await render({ response: { ...response, answer: "总量增长与个人贷款回落并存，动因仍需验证。",
      analysis_plan: ["规模如何？", "下降集中在哪些分项？"],
      result: { type: "metric_query", table: { columns: Object.keys(reportRows[0]!), rows: reportRows } } } })
    for (const text of ["较上月", "较同期", "较年初", "占比", "120.00亿元", "-2.00亿元", "33.33%", "分析思路", "下降集中在哪些分项？", "总量增长与个人贷款回落并存"]) expect(html).toContain(text)
  })

  it("有结果时直接展示明细表，指标名称提到表头说明", async () => {
    const html = await render({ response })
    expect(html).toContain("收起数据明细")
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain("<table")
    expect(html).toContain("指标：信贷客户数量当日数")
    expect(html).toContain("311,312")
  })

  it("正文生成中不展示数据明细入口", async () => {
    // 冻结逐字动画在首帧，模拟生成进行中
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined })
    try {
      const html = await render({ response, streamAnswer: true })
      expect(html).not.toContain("数据明细")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("没有正文的空结果提供正常完成提示", async () => {
    const empty = { ...response, answer: "", result: { type: "metric_query", table: { columns: [], rows: [] } } }
    const html = await render({ response: empty })
    expect(html).toContain("查询已完成，未查到符合当前条件的数据记录。")
    expect(html).not.toContain("可以确认统计日期或机构名称")
    expect(html).not.toContain("条数据明细")
  })

  it("已有空结果正文时不追加重复提示或要求更改查询条件", async () => {
    const answer = "查询已完成，未查到隔离机构在2026年8月31日的各项存款余额记录。"
    const empty = { ...response, answer, result: { type: "metric_query", table: { columns: [], rows: [] } },
      time_variants: [{ label: "最近3个完整年度", start: "2023-01-01", end: "2025-12-31" }] }
    const html = await render({ response: empty })
    expect(html).toContain(answer)
    expect(html).not.toContain("当前条件下暂未查询到数据。")
    expect(html).not.toContain("可以切换下方备选口径重新查询。")
    expect(html).not.toContain("可以确认统计日期或机构名称")
  })

  it("自然报告空结果和历史回放仅显示已有事实说明", async () => {
    const summary = "查询已完成，未查到隔离机构在2026年8月31日的各项存款余额记录。"
    const value = JSON.parse(JSON.stringify({...response, answer: summary,
      result: {type: "metric_query", table: {columns: [], rows: []}},
      analysis_report: {summary, scope: "隔离样本", partial: false, body_mode: "narrative",
        sections: [], gaps: [], source_notices: [], limitations: []}}))
    const html = await render({response: value})
    expect(html.match(/查询已完成，未查到/g)).toHaveLength(1)
    expect(html).not.toContain("扩大时间范围")
    expect(html).not.toContain('role="status"')
  })
})
