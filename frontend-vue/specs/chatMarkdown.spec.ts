import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import ChatMarkdown from "../src/components/chat/ChatMarkdown.vue"

async function render(source: string) {
  const html = await renderToString(createSSRApp(ChatMarkdown as Component, { source }))
  return html.replace(/<!--[\s\S]*?-->/g, "")
}

describe("聊天 Markdown 的统一链接提示", () => {
  it("带说明的链接使用统一提示触发器，保留文字、地址和外链保护", async () => {
    const html = await render('[查看**指标**](https://example.com "来源与口径说明")')

    expect(html).not.toMatch(/\btitle=/)
    expect(html).toMatch(/<a[^>]*data-state="closed"/)
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain("查看<strong>指标</strong>")
  })

  it("保留标题、列表、表格、换行与代码内容", async () => {
    const html = await render(
      "# 统计说明\n\n- 第一项\n- 第二项\n\n| 指标 | 值 |\n| --- | ---: |\n| 余额 | 1.20 |\n\n第一行\n第二行\n\n```sql\nselect '<记录>';\n```",
    )

    expect(html).toContain("<h1>统计说明</h1>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>第一项</li>")
    expect(html).toContain("<table>")
    expect(html).toMatch(/style="text-align:\s*right;?"/)
    expect(html).toMatch(/第一行<br>\s*第二行/)
    expect(html).toContain('class="language-sql"')
    expect(html).toContain("&lt;记录&gt;")
  })

  it("原始 HTML 和说明保持转义，危险链接和外链图片仍被阻止", async () => {
    const html = await render(
      "<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![图片说明](https://example.com/a.png)\n\n[正常](https://example.com '<img src=x onerror=alert(1)>')",
    )

    expect(html).not.toContain("<script>")
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain("<img")
    expect(html).not.toMatch(/\btitle=/)
    expect(html).toContain("图片说明")
    expect(html).toContain("&lt;script&gt;")
  })
})
