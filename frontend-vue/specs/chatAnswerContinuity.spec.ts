import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import ChatResultContent from "../src/components/chat/ChatResultContent.vue"
import type { ChatResponse } from "../src/types/api"

// 仅验证展示切换契约，不作为真实业务数据或浏览器节点复用验收。
const response: ChatResponse = {
  message_id: "answer-continuity",
  intent: "business_report",
  answer: "正式核验正文。",
  result: { type: "metric_query", table: { columns: ["metric_value"], rows: [{ metric_value: "12.3400" }] } },
  metric_definition: null,
  clarification: null,
  debug: null,
  analysis_report: {
    summary: "正式核验正文。", sections: [], scope: "样例范围 · 2026-08-27",
    source_notices: [], limitations: [], gaps: [], partial: false, body_mode: "narrative",
  },
}

function render(props: Record<string, unknown>) {
  return renderToString(createSSRApp(ChatResultContent as Component, props))
}

describe("预览与正式正文的连续展示", () => {
  it("等待中只显示本轮预览，已收到的正式附件不提前重复正文", async () => {
    const html = await render({ response, pending: true, provisionalText: "已到达的**第一段**。" })
    expect(html).toContain("已到达的<strong>第一段</strong>。")
    expect(html).toContain("data-provisional-answer")
    expect(html).not.toContain("正式核验正文")
    expect(html).not.toContain("样例范围")
    expect(html).not.toContain("数据明细")
    expect(html).not.toContain("复制回答")
  })

  it("尚无结果时显示实际预览，不补造查询结果", async () => {
    const html = await render({ pending: true, provisionalText: "正在输出的正文。" })
    expect(html).toContain("正在输出的正文。")
    expect(html).not.toContain("查询完成")
    expect(html).not.toContain("数据明细")
  })

  it("无结构化结果的停止或错误仍显示原始说明", async () => {
    const html = await render({ fallbackText: "本次查询未完成，请稍后重试。" })
    expect(html).toContain("本次查询未完成，请稍后重试。")
    expect(html).not.toContain("data-provisional-answer")
    expect(html).not.toContain("复制回答")
  })

  it("正式自然报告只展示一次正文，并保留范围和数据操作", async () => {
    const html = await render({ response })
    expect(html.match(/正式核验正文。/g)).toHaveLength(1)
    expect(html).toContain("样例范围 · 2026-08-27")
    expect(html).toContain("查看 1 条数据明细")
    expect(html).toContain("复制回答")
    expect(html).not.toContain("data-provisional-answer")
  })

  it("旧结构化报告保留摘要标题和独立分析区块", async () => {
    const html = await render({ response: { ...response, analysis_report: {
      ...response.analysis_report, body_mode: undefined,
      sections: [{ title: "已核验分析", text: "分析区块正文。" }],
    } } })
    expect(html).toContain("主要结论")
    expect(html).toContain("已核验分析")
    expect(html).toContain("分析区块正文。")
    expect(html).toContain("数据明细")
  })
})
