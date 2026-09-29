import { describe, expect, it, vi } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import ChatResultContent from "./ChatResultContent.vue"
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

describe("数据明细默认收起", () => {
  it("有结果时只展示带条数的入口，不渲染明细表", async () => {
    const html = await render({ response })
    expect(html).toContain("查看 2 条数据明细")
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("<table")
    expect(html).not.toContain("收起数据明细")
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

  it("无数据时仍直接展示空结果提示", async () => {
    const empty = { ...response, result: { type: "metric_query", table: { columns: [], rows: [] } } }
    const html = await render({ response: empty })
    expect(html).toContain("当前条件下暂未查询到数据。")
    expect(html).not.toContain("条数据明细")
  })
})
