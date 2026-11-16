import { afterEach, describe, expect, it, vi } from "vitest"
import { createSSRApp, type Component, type ComponentPublicInstance } from "vue"
import { renderToString } from "vue/server-renderer"
import AgentMessageDiagnostics from "../src/components/chat/AgentMessageDiagnostics.vue"
import { toolCallSummary } from "../src/lib/toolCallSummary"

// ESLint 的 TypeScript 解析器不生成 SFC 类型；组件实现另由 vue-tsc 检查。
const diagnostics = AgentMessageDiagnostics as Component

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("执行过程展示", () => {
  it("执行中默认收起已结束的步骤，摘要使用真实工具动作", async () => {
    vi.useFakeTimers()
    const html = await renderToString(createSSRApp(diagnostics, {
      question: "查询存款余额", taskIds: [], pending: true,
      tools: [
        { tool: "metric_search", status: "done" },
        { tool: "metric_query", status: "running" },
      ],
    }))
    expect(html).toContain('aria-label="执行过程" aria-expanded="false"')
    expect(html).toContain("正在查询指标数据")
    expect(html).not.toContain("<ol")
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

  it("展开态只归并相邻目录步骤，仍展示真实调用总数与独立失败", async () => {
    const search = (id: string, candidateCount: number) => ({
      id, tool: "metric_search", status: "done", elapsedMs: 10,
      summary: toolCallSummary({ kind: "analysis_catalog", status: "succeeded",
        search_summary: { candidate_count: candidateCount, has_more: false, reused: false, exhausted: false } }),
    })
    const tools = [search("first", 2), search("second", 0),
      { id: "error", tool: "metric_search", status: "error", summary: { note: "目录检索未完成", failed: true } },
      search("last", 0)]
    const app = createSSRApp(diagnostics, { question: "查询指标", taskIds: [], pending: false, tools })
    // SSR 直接设为用户已展开的状态；桌面点击与更新后的选择保留由实际浏览器验收。
    app.mixin({
      created(this: ComponentPublicInstance) {
        if (this.$.type !== diagnostics
          && this.$.type.__file !== (diagnostics as { __file?: string }).__file) return
        const state: unknown = Reflect.get(this.$, "setupState")
        if (state && typeof state === "object") Reflect.set(state, "expanded", true)
      },
    })
    const html = await renderToString(app)
    expect(html).toContain('aria-label="执行过程" aria-expanded="true"')
    expect(html).toContain("4 个步骤")
    expect(html).toContain("累计 2 次")
    expect(html).toContain("找到目录候选")
    expect(html).toContain("累计耗时 20 毫秒")
    expect(html).toContain("目录检索未完成")
    expect(html.match(/<li class="relative py-1">/g)).toHaveLength(3)
    expect(tools).toHaveLength(4)
  })
})
