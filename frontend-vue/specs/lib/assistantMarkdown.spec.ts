import {describe, expect, it} from "vitest"
import {normalizeAssistantParagraphs, renderAssistantHtml} from "../../src/lib/assistantMarkdown"

describe("回答排版规范化", () => {
  it("重复转义的段落不再吞进标题，数字、日期和重点短语原样保留", () => {
    const html = renderAssistantHtml(String.raw`## 费用与营收变化：方向一致，幅度有别\n\n截至2026年7月末，费用7.40亿元，营收48.81亿元。\n\n值得关注的是，**两者波动幅度不同**。`)
    expect(html).toContain("<h2>费用与营收变化：方向一致，幅度有别</h2>")
    expect(html).toContain("<p>截至2026年7月末，费用7.40亿元，营收48.81亿元。</p>")
    expect(html).toContain("<strong>两者波动幅度不同</strong>")
    expect(html).not.toContain(String.raw`\n`)
    expect(html.match(/<p>/g)).toHaveLength(2)
  })

  it("正常标题、局部强调、列表和表格保持标准 Markdown 行为", () => {
    const html = renderAssistantHtml("## 主要发现\n\n正文只强调**关键分化**。\n\n- 第一个观察\n- 第二个观察\n\n| 指标 | 数值 |\n| --- | --- |\n| 费用 | 7.40亿元 |")
    for (const value of ["<h2>主要发现</h2>", "<strong>关键分化</strong>", "<ul>", "<li>第一个观察</li>", "<table>", "<td>7.40亿元</td>"])
      expect(html).toContain(value)
  })

  it("异常长标题降为正文，文字与重点链接完整保留", () => {
    const body = "一项需要核实的观察。".repeat(15) + "[指标说明](https://example.com/metric)"
    const html = renderAssistantHtml(`## ${body}`)
    expect(html).toMatch(/^<p>/)
    expect(html).not.toMatch(/<h[1-6]>/)
    expect(html).toContain("一项需要核实的观察。".repeat(15))
    expect(html).toContain('href="https://example.com/metric"')
  })

  it.each(["**", "__"])("整段 %s 加粗恢复普通字重，同时保留其它重点短语", marker => {
    const paragraph = "截至日比较显示方向存在分化，具体动因仍需证据验证。".repeat(6)
    const html = renderAssistantHtml(`${marker}${paragraph}${marker}\n\n**值得关注**：下一项观察。`)
    expect(html).toContain(`<p>${paragraph}</p>`)
    expect(html).toContain("<strong>值得关注</strong>")
    expect(html.match(/<strong>/g)).toHaveLength(1)
  })

  it.each([
    String.raw`普通说明：路径 C:\new\notes，正则 \n 和双重转义 \\n\\n 保持原样。`,
    "示例 `" + String.raw`\n\n` + "` 与 ``含 ` 的代码 " + String.raw`\n\n` + "``。",
    "```text\n" + String.raw`## 示例\n\n原样代码` + "\n```",
    "~~~~text\n" + String.raw`代码\n\n仍为字面量` + "\n~~~\n~~~~",
    "```text\n" + String.raw`未闭合代码\n\n仍需原样保留`,
    "普通的真实换行。\r\n\r\n第二段。",
  ])("路径、代码和正常换行不进行全局反转义：%s", source => {
    expect(normalizeAssistantParagraphs(source)).toBe(source)
  })

  it("代码前后的异常段落单独修复，规范化幂等", () => {
    const source = String.raw`正文\n\n` + "`" + String.raw`\n\n` + "`" + String.raw`\n\n结论`
    const normalized = "正文\n\n`" + String.raw`\n\n` + "`\n\n结论"
    expect(normalizeAssistantParagraphs(source)).toBe(normalized)
    expect(normalizeAssistantParagraphs(normalized)).toBe(normalized)
    expect(normalizeAssistantParagraphs(String.raw`正文\r\n\r\n结论`)).toBe("正文\n\n结论")
  })

  it("流式前缀不修改代码，完整回答出现后恢复正确段落和标题", () => {
    const source = String.raw`## 关键发现\n\n普通分析。\n\n**短结论**`
    for (let index = 1; index <= source.length; index++)
      expect(() => renderAssistantHtml(source.slice(0, index))).not.toThrow()
    const html = renderAssistantHtml(source)
    expect(html).toContain("<h2>关键发现</h2>")
    expect(html).toContain("<p>普通分析。</p>")
    expect(html).toContain("<strong>短结论</strong>")
  })

  it("排版保护保持 HTML、危险链接和图片的安全边界", () => {
    const html = renderAssistantHtml('<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![图示](https://example.com/image.png)\n\n[说明](https://example.com)')
    expect(html).not.toContain("<script>")
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })
})
