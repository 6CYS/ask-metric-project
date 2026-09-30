import { describe, expect, it } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import AgentMessageDiagnostics from "./AgentMessageDiagnostics.vue"

const tools = [
  { id: "1", tool: "business_skill_read", status: "done" },
  {
    id: "2", tool: "resolve_business_turn", status: "done", elapsedMs: 1830, label: "解析条件并执行查询",
    summary: { conditions: [{ label: "机构", value: "江苏紫金农村商业银行" }], note: "取得 1 行数据" },
  },
]

const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp(AgentMessageDiagnostics, { question: "q", taskIds: [], tools, ...props }))

const count = (html: string, text: string) => html.split(text).length - 1

describe("执行过程", () => {
  it("执行中默认展开：标题是唯一的实时阶段，时间线只列已结束步骤及其条件和结果", async () => {
    const html = await render({ pending: true, hasAnswer: true })
    expect(html).toContain('aria-expanded="true"')
    expect(count(html, "正在生成回答")).toBe(1)
    expect(html).toContain("解析条件并执行查询")
    expect(html).toContain("江苏紫金农村商业银行")
    expect(html).toContain("取得 1 行数据")
    expect(html).toContain("1.8 秒")
  })

  it("进行中的步骤只在标题出现，不在时间线重复", async () => {
    const html = await render({ pending: true, tools: [...tools, { id: "3", tool: "business_context_read", status: "running" }] })
    expect(count(html, "正在读取查询历史")).toBe(1)
    expect(html).not.toContain(">读取查询历史<")
    expect(html).not.toContain("执行中")
  })

  it("尚无已结束步骤时只显示一行阶段，不展开空时间线", async () => {
    const html = await render({ pending: true, tools: [] })
    expect(count(html, "正在理解问题")).toBe(1)
    expect(html).toMatch(/aria-label="执行过程"[^>]*disabled/)
    expect(html).not.toContain("<ol")
  })

  it("已完成的回答默认收起，只保留步骤数与用时", async () => {
    const html = await render({ pending: false, elapsedMs: 12_400 })
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("2 个步骤")
    expect(html).toContain("用时 12 秒")
    expect(html).not.toContain("江苏紫金农村商业银行")
  })

  it("理解问题阶段逐项展示读取的上下文和识别结果，进行中的模型分析只在标题出现", async () => {
    const activities = [
      { id: "context", label: "读取对话上下文", status: "done", elapsedMs: 20,
        summary: { note: "沿用当前话题", conditions: [{ label: "排名", value: "前 3 名" }] } },
      { id: "mentions", label: "识别问题中的指标", status: "done", elapsedMs: 180, summary: { note: "未提到新指标，沿用当前话题的指标" } },
      { id: "model", label: "理解问题，确定处理方式", status: "running" },
    ]
    const html = await render({ pending: true, tools: [], activities })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain("沿用当前话题")
    expect(html).toContain("前 3 名")
    expect(html).toContain("未提到新指标，沿用当前话题的指标")
    expect(count(html, "理解问题，确定处理方式")).toBe(1)
    expect(html).toContain("正在理解问题，确定处理方式")
    expect(html).not.toContain("20 毫秒")
  })

  it("完成后步骤数包含理解阶段步骤", async () => {
    const html = await render({ pending: false, activities: [{ id: "model", label: "理解问题，确定处理方式", status: "done", elapsedMs: 2100 }] })
    expect(html).toContain("3 个步骤")
  })
})
