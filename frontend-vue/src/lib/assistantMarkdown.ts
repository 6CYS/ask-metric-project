/**
 * 助手回答的渲染入口：模型写标准 markdown，前端原样渲染，不再做白名单裁剪。
 * 安全边界固定为：html:false（原始 HTML 转义为文本）、禁用图片、外链强制新窗口 + noopener；
 * markdown-it 自带链接协议校验（javascript: 等不会生成链接）。
 * 数据正确性由后端证据链与回答核验负责，渲染层不改写内容。
 */
import MarkdownIt from "markdown-it"
import type { AssistantBlock, AssistantParagraph, AssistantTableAlign } from "./assistantText"

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// 图片不加载外链资源：输出 alt 文本占位，避免泄露请求或撑破版式
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index]?.content ?? "")

const defaultLinkOpen = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!
  token.attrSet("target", "_blank")
  token.attrSet("rel", "noopener noreferrer nofollow")
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

export function renderAssistantHtml(source: string): string {
  return md.render(source)
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|")
}

function segmentsToMarkdown(segments: AssistantParagraph, { inTable = false } = {}): string {
  const text = segments
    .map((segment) => (segment.bold ? `**${segment.text}**` : segment.text))
    .join("")
  return inTable ? escapeTableCell(text) : text
}

const ALIGN_MARKER: Record<AssistantTableAlign, string> = {
  left: "---",
  center: ":---:",
  right: "---:",
}

/** 服务端结构化块 → markdown 文本，与模型原生回答走同一渲染管线 */
export function blocksToMarkdown(blocks: AssistantBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const text = segmentsToMarkdown(block.segments).trim()
      if (text) parts.push(text)
    } else if (block.type === "list") {
      const items = block.items.map((item, index) =>
        `${block.ordered ? `${index + 1}.` : "-"} ${segmentsToMarkdown(item).trim()}`)
      if (items.length) parts.push(items.join("\n"))
    } else {
      const header = block.header.map((cell) => segmentsToMarkdown(cell, { inTable: true }).trim())
      const rows = block.rows.map((row) => row.map((cell) => segmentsToMarkdown(cell, { inTable: true }).trim()))
      const aligns = header.map((_, index) => ALIGN_MARKER[block.aligns[index] ?? "left"])
      const lines = [
        `| ${header.join(" | ")} |`,
        `| ${aligns.join(" | ")} |`,
        ...rows.map((row) => `| ${row.join(" | ")} |`),
      ]
      if (header.length || rows.length) parts.push(lines.join("\n"))
    }
  }
  return parts.join("\n\n")
}
