import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import ChatResultContent from "../src/components/chat/ChatResultContent.vue"
import { businessReportPresentation } from "../src/lib/businessReportPresentation"
import type { MetricAskDetails } from "../src/lib/agentApi"
import { layoutReportCharts } from "../src/lib/reportChartLayout"
import type { ChatResponse } from "../src/types/api"

// 隔离图文位置契约，不作为业务数据或真实问数验收。
function chart(title: string, placement?: unknown) {
  return {
    type: "bar",
    title,
    dates: ["2026-08-27"],
    unit: "元",
    source_refs: [`${title}.a`, `${title}.b`],
    points: [
      { name: "甲机构", value: "12", display: "12元" },
      { name: "乙机构", value: "8", display: "8元" },
    ],
    ...(placement === undefined ? {} : { placement }),
  }
}

function details(
  summary: string,
  charts: unknown[],
  sections: Array<{ title: string; text: string }> = [],
): MetricAskDetails {
  return {
    kind: "business_report",
    status: "succeeded",
    public_answer: summary,
    report: {
      summary,
      sections,
      plans: [],
      charts,
      presentation: {
        version: 1,
        body_mode: "narrative",
        scope: "隔离样例",
        source_notices: [],
        limitations: [],
      },
    },
  } as MetricAskDetails
}

function response(input: MetricAskDetails): ChatResponse {
  return {
    message_id: "chart-layout",
    intent: "business_report",
    answer: input.public_answer,
    analysis_report: businessReportPresentation(input),
    metric_definition: null,
    clarification: null,
    debug: null,
  } as ChatResponse
}

async function render(input: MetricAskDetails, props: Record<string, unknown> = {}) {
  return renderToString(
    createSSRApp(ChatResultContent as Component, { response: response(input), ...props }),
  )
}

function expectOrder(html: string, ...parts: string[]) {
  let previous = -1
  for (const part of parts) {
    const position = html.indexOf(part)
    expect(position, `缺少或顺序错误：${part}`).toBeGreaterThan(previous)
    previous = position
  }
}

describe("报告图表随对应正文展示", () => {
  it("多图分别进入对应段落，实时终态和历史重放正文均只出现一次", async () => {
    const input = details("首段规模。\n\n次段利润。\n\n末段建议。", [
      chart("利润比较图", { after_paragraph: 2 }),
      chart("规模比较图", { after_paragraph: 1 }),
    ])
    for (const record of [input, JSON.parse(JSON.stringify(input)) as MetricAskDetails]) {
      const html = await render(record)
      expectOrder(html, "首段规模。", "规模比较图", "次段利润。", "利润比较图", "末段建议。")
      for (const paragraph of ["首段规模。", "次段利润。", "末段建议。"])
        expect(html.split(paragraph)).toHaveLength(2)
      expect(html.match(/role="img"/g)).toHaveLength(2)
    }
  })

  it("section_index从零计数，摘要与各节的锚点互不串位", async () => {
    const html = await render(
      details(
        "摘要甲。\n\n摘要乙。",
        [
          chart("摘要图", { after_paragraph: 1 }),
          chart("第一节图", { section_index: 0, after_paragraph: 1 }),
          chart("第二节图", { section_index: 1, after_paragraph: 2 }),
        ],
        [
          { title: "章节一", text: "一节首段。\n\n一节末段。" },
          { title: "章节二", text: "二节首段。\n\n二节次段。\n\n二节末段。" },
        ],
      ),
    )
    expectOrder(
      html,
      "摘要甲。",
      "摘要图",
      "摘要乙。",
      "一节首段。",
      "第一节图",
      "一节末段。",
      "二节次段。",
      "第二节图",
      "二节末段。",
    )
  })

  it("旧图和非法锚点回到整份报告末尾，保留原图顺序", async () => {
    const invalid = [
      undefined,
      null,
      { after_paragraph: 0 },
      { after_paragraph: 1.5 },
      { after_paragraph: "1" },
      { after_paragraph: 99 },
      { after_paragraph: 1, section_index: -1 },
      { after_paragraph: 1, section_index: 1 },
      { after_paragraph: 1, section_index: null },
    ]
    const titles = invalid.map((_, index) => `尾部图${index}`)
    const html = await render(
      details(
        "摘要正文。",
        invalid.map((placement, index) => chart(titles[index]!, placement)),
        [{ title: "末节", text: "最后一节正文。" }],
      ),
    )
    expectOrder(html, "摘要正文。", "最后一节正文。", ...titles)
    expect(html.match(/role="img"/g)).toHaveLength(invalid.length)
  })

  it("段落锚点落在列表或代码内时推迟到顶层块末，表格保持完整", async () => {
    const summary =
      "起始段。\n\n- 列表甲。\n\n- 列表乙。\n\n列表之后。\n\n| 指标 | 值 |\n| --- | --- |\n| 余额 | 12 |\n\n```text\n代码甲\n\n代码乙\n```\n\n结束段。"
    const html = await render(
      details(summary, [
        chart("列表图", { after_paragraph: 2 }),
        chart("表格图", { after_paragraph: 5 }),
        chart("代码图", { after_paragraph: 6 }),
      ]),
    )
    expectOrder(
      html,
      "列表甲。",
      "列表乙。",
      "</ul>",
      "列表图",
      "列表之后。",
      "</table>",
      "表格图",
      "代码甲",
      "代码乙",
      "</pre>",
      "代码图",
      "结束段。",
    )
    expect(html.match(/<ul>/g)).toHaveLength(1)
    expect(html.match(/<table>/g)).toHaveLength(1)
    expect(html.match(/<pre>/g)).toHaveLength(1)
    expect(html).toContain("<td>余额</td><td>12</td>")
    for (const block of ["p", "ul", "table", "pre", "chart"])
      expect(html).toContain(`data-report-block="${block}"`)
  })

  it("分段渲染仍保留全文的引用链接与安全转义", async () => {
    const html = await render(
      details(
        "[来源][source]。\n\n下一段。\n\n[source]: https://example.com/report\n\n<script>危险内容</script>",
        [chart("来源图", { after_paragraph: 1 })],
      ),
    )
    expectOrder(html, 'href="https://example.com/report"', "来源图", "下一段。")
    expect(html).toContain("&lt;script&gt;危险内容&lt;/script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("转换层移除无效图后有效图的段落位置不按数组索引漂移", async () => {
    const input = details("有效首段。\n\n有效末段。", [
      { ...chart("无效图", { after_paragraph: 2 }), points: [] },
      chart("保留图", { after_paragraph: 1 }),
    ])
    const html = await render(input)
    expect(html).not.toContain("无效图")
    expectOrder(html, "有效首段。", "保留图", "有效末段。")
  })

  it("未完成流式正文仍走原路径，正式终态不重复预览和报告正文", async () => {
    const input = details("正式首段。\n\n正式末段。", [chart("正式图", { after_paragraph: 1 })])
    const pending = await render(input, { pending: true, provisionalText: "收到的**流式正文**。" })
    expect(pending).toContain("收到的<strong>流式正文</strong>。")
    expect(pending).not.toContain("正式首段")
    expect(pending).not.toContain("正式图")
    const final = await render(input, { pending: false, provisionalText: "收到的**流式正文**。" })
    expectOrder(final, "正式首段。", "正式图", "正式末段。")
    expect(final).not.toContain("流式正文")
    expect(final.match(/正式首段。/g)).toHaveLength(1)
  })
})

// 图集只来自已核验事件；测试不构造运行时业务数据。
describe("流式前缀图表", () => {
  it("尚未收到终态时图已随安全段落显示，正式报告随后覆盖且不重复", async () => {
    const provisional = chart("预览图", { after_paragraph: 2 })
    const input = details("最终正文。", [chart("正式图", { after_paragraph: 1 })])
    const html = await render(input, {
      pending: true,
      provisionalText: "前缀。\n\n- 项目甲。\n\n- 项目乙。\n\n后续段。",
      provisionalCharts: [provisional],
    })
    expectOrder(html, "项目甲。", "项目乙。", "</ul>", "预览图", "后续段。")
    expect(html).not.toContain("正式图")
    expect(html.match(/role="img"/g)).toHaveLength(1)
    const final = await render(input, {
      pending: false,
      provisionalText: "旧前缀。",
      provisionalCharts: [provisional],
    })
    expectOrder(final, "最终正文。", "正式图")
    expect(final).not.toContain("预览图")
    expect(final.match(/role="img"/g)).toHaveLength(1)
  })

  it("后续段落与前序图追加不改变既有图和正文块的组件身份", () => {
    const charts = [chart("次段图", { after_paragraph: 2 })]
    const initial = businessReportPresentation(details("首段。\n\n次段。", charts))!
    const later = businessReportPresentation(
      details("首段。\n\n次段。\n\n后续段。", [chart("首段图", { after_paragraph: 1 }), ...charts]),
    )!
    const before = layoutReportCharts(initial).summary
    const after = layoutReportCharts(later).summary
    const previousChart = before.find((part) => part.kind === "chart")!
    const nextChart = after.find((part) => part.kind === "chart" && part.chart.title === "次段图")!
    expect(previousChart.key).toBeTruthy()
    expect(nextChart.key).toBe(previousChart.key)
    const previousText = before.filter((part) => part.kind === "markdown").map((part) => part.key)
    expect(previousText).toHaveLength(2)
    expect(
      after
        .filter((part) => part.kind === "markdown")
        .map((part) => part.key)
        .slice(0, 2),
    ).toEqual(previousText)
  })
})
