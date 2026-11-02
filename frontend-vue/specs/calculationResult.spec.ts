import { describe, expect, it } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"
import CalculationResult from "../src/components/chat/CalculationResult.vue"
import type { CalculationDetails } from "../src/lib/agentApi"

describe("计算来源展示", () => {
  it("内部计算失败不作为独立业务正文展示", async () => {
    const calculation: CalculationDetails = { kind: "metric_calculate", status: "error", retryable: true }
    const html = await renderToString(createSSRApp(CalculationResult, { calculation }))
    expect(html).not.toContain("计算未完成")
    expect(html).not.toContain("请检查计算条件")
    expect(html).not.toContain("aria-label")
  })

  it("成功计算仍保留可展开的口径与来源", async () => {
    const calculation: CalculationDetails = { kind: "metric_calculate", status: "succeeded",
      results: [{ name: "difference", label: "差额", expression: "current - base", value: "20",
        display_value: "20元", unit: "元", variables: ["current", "base"] }],
      inputs: { current: { metric_name: "贷款余额", org_name: "甲行", date: "2026-08-27", value: "120", unit: "元" } } }
    const html = await renderToString(createSSRApp(CalculationResult, { calculation }))
    expect(html).toContain("查看计算口径和数据来源")
    expect(html).toContain("current - base")
    expect(html).toContain("贷款余额")
    expect(html).not.toContain("计算未完成")
  })
})
