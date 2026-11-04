import { afterEach, describe, expect, it, vi } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import AgentMessageDiagnostics from "../src/components/chat/AgentMessageDiagnostics.vue"

// ESLint 的 TypeScript 解析器不生成 SFC 类型；组件实现另由 vue-tsc 检查。
const diagnostics = AgentMessageDiagnostics as Component

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("执行过程展示", () => {
  it("执行中默认展开已结束的步骤，摘要使用真实工具动作", async () => {
    vi.useFakeTimers()
    const html = await renderToString(createSSRApp(diagnostics, {
      question: "查询存款余额", taskIds: [], pending: true,
      tools: [
        { tool: "metric_search", status: "done" },
        { tool: "metric_query", status: "running" },
      ],
    }))
    expect(html).toContain('aria-label="执行过程" aria-expanded="true"')
    expect(html).toContain("正在查询指标数据")
    expect(html).toContain("<ol")
    expect(html).toContain("检索指标目录")
  })

  it("历史记录默认收起并保留真实步骤数量和耗时", async () => {
    const html = await renderToString(createSSRApp(diagnostics, {
      question: "查询存款余额", taskIds: [], pending: false, elapsedMs: 22000,
      tools: [{ tool: "metric_search", status: "done" }, { tool: "metric_query", status: "done" }],
    }))
    expect(html).toContain('aria-label="执行过程" aria-expanded="false"')
    expect(html).toContain("2 个步骤")
    expect(html).toContain("用时 22 秒")
    expect(html).not.toContain("<ol")
  })
})
