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
  })

  it("历史记录默认展开并保留真实步骤数量和耗时", async () => {
    const html = await renderToString(createSSRApp(diagnostics, {
      question: "查询存款余额", taskIds: [], pending: false, elapsedMs: 22000,
      tools: [{ tool: "metric_search", status: "done" }, { tool: "metric_query", status: "done" }],
    }))
    expect(html).toContain('aria-label="执行过程" aria-expanded="true"')
    expect(html).toContain("2 个步骤")
    expect(html).toContain("用时 22 秒")
    expect(html).toContain("<ol")
  })

  it("展开态只归并相邻目录步骤，仍展示真实调用总数与独立失败", async () => {
    const search = (id: string, candidateCount: number) => ({
      id, tool: "metric_search", status: "done", elapsedMs: 10,
      summary: toolCallSummary({ kind: "analysis_catalog", status: "succeeded",
        search_summary: { candidate_count: candidateCount, has_more: false, reused: false, exhausted: false } }),
    })
    const tools = [search("first", 2), search("second", 0),
      { id: "error", tool: "metric_search", status: "error", summary: { note: "指标查找未完成", failed: true } },
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
    expect(html).toContain("找到可能相关的指标")
    expect(html).toContain("累计耗时 20 毫秒")
    expect(html).toContain("指标查找未完成")
    expect(html).not.toContain("执行失败")
    expect(html.match(/<li class="relative py-1">/g)).toHaveLength(3)
    expect(tools).toHaveLength(4)
  })

  it("展开查询异常时读出具体原因，没有摘要的异常仍明确提示失败", async () => {
    const tools = [
      { id: "binding", tool: "metric_query", status: "error", summary: toolCallSummary({
        kind: "inquiry_query_error", status: "error", code: "ANALYSIS_BINDING_INVALID",
      }, true) },
      { id: "unknown", tool: "metric_query", status: "error" },
    ]
    const app = createSSRApp(diagnostics, { question: "查询存款", taskIds: [], pending: false, tools })
    app.mixin({
      created(this: ComponentPublicInstance) {
        if (this.$.type !== diagnostics
          && this.$.type.__file !== (diagnostics as { __file?: string }).__file) return
        const state: unknown = Reflect.get(this.$, "setupState")
        if (state && typeof state === "object") Reflect.set(state, "expanded", true)
      },
    })
    const html = await renderToString(app)
    expect(html).toContain("指标选择需调整，本次未执行")
    expect(html.match(/执行失败/g)).toHaveLength(1)
    expect(html.match(/<li class="relative py-1">/g)).toHaveLength(2)
    expect(tools[0]?.status).toBe("error")
  })

  it.each([true, false])("后续查询确实取到数据时在异常步骤交代进展（执行中 %s）", async (pending) => {
    const evidence = { kind: "analysis_evidence", status: "succeeded", row_count: 60 }
    const query = (details: object, tool = "metric_query", status = "done") =>
      ({ tool, status, summary: toolCallSummary(details, status === "error") })
    const before = [query({ ...evidence, result_reused: true }),
      query({ kind: "inquiry_query_error", status: "error" }, "metric_query", "error")]
    const render = (after: typeof before) => renderToString(createSSRApp(diagnostics, {
      question: "净利润排名前五的机构", taskIds: [], pending, tools: [...before, ...after],
    }))
    const html = await render([query(evidence),
      query({ kind: "business_report", status: "succeeded" }, "analysis_answer")])
    expect(html).toContain("这一步没有返回结果，后续查询已取得数据")
    expect(html).toContain("已取得 60 条数据")
    for (const after of [[], [query({ ...evidence, row_count: 0 })], [query(evidence, "analysis_read")],
      [query({ ...evidence, result_reused: true })], [query(evidence, "metric_query", "running")],
      [query(evidence, "metric_query", "error")]]) {
      const unconfirmed = await render(after)
      expect(unconfirmed).toContain("这一步没有返回结果")
      expect(unconfirmed).not.toContain("后续查询已取得数据")
    }
  })
})


describe("共享模型等待提示", () => {
  it("长等待保留实际计时，说明可停止，不假称正在排队或一定会成功", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-17T00:00:30Z"))
    const html = await renderToString(createSSRApp(diagnostics, {
      question: "查询存款", taskIds: [], pending: true, startedAt: "2026-11-17T00:00:00Z", tools: [],
    }))
    expect(html).toContain("30 秒")
    expect(html).toContain("本轮用时较长")
    expect(html).toContain("停止")
    expect(html).not.toContain("正在排队")
  })

  it("已执行工具后仍显示实际模型恢复活动，普通快请求不显示长等待提示", async () => {
    vi.useFakeTimers()
    const html = await renderToString(createSSRApp(diagnostics, {
      question: "查询存款", taskIds: [], pending: true, startedAt: new Date().toISOString(),
      tools: [{ tool: "metric_query", status: "done" }],
      activities: [{ id: "model-retry:1", label: "模型服务繁忙，稍后重试", status: "running", summary: { note: "等待 2 秒后重试" } }],
    }))
    expect(html).toContain("模型服务繁忙，稍后重试")
    expect(html).toContain("等待 2 秒后重试")
    expect(html).not.toContain("本轮用时较长")
  })
})
