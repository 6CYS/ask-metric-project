/**
 * 助手回答的渲染入口：保留标准 Markdown，仅规范异常段落换行和过长的标题、加粗。
 * 安全边界固定为：html:false（原始 HTML 转义为文本）、禁用图片、外链强制新窗口 + noopener；
 * markdown-it 自带链接协议校验（javascript: 等不会生成链接）。
 * 数据正确性由后端证据链与回答核验负责，渲染层不改写事实或补写结论。
 */
import MarkdownIt from "markdown-it"
import type { AssistantBlock, AssistantParagraph, AssistantTableAlign } from "./assistantText"

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// 历史消息也可能包含重复转义的段落；保护代码，避免全局反转义破坏路径和示例。
export function normalizeAssistantParagraphs(source: string): string {
  const normalize = (text: string) => text.replace(/(?<!\\)(?:\\r\\n|\\n){2,}/gu,
    value => "\n".repeat(value.match(/\\r\\n|\\n/gu)!.length))
  const markers = /`+|^ {0,3}~{3,}/gmu
  let result = "", cursor = 0, marker: RegExpExecArray | null
  while ((marker = markers.exec(source))) {
    const delimiter = marker[0].trimStart()
    const lineStart = source.lastIndexOf("\n", marker.index - 1) + 1
    const fenced = delimiter.length >= 3 && /^ {0,3}$/u.test(source.slice(lineStart, marker.index))
    const closing = fenced
      ? new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*\\r?$`, "gmu")
      : /`+/gu
    const nextLine = source.indexOf("\n", markers.lastIndex)
    closing.lastIndex = fenced ? nextLine < 0 ? source.length : nextLine + 1 : markers.lastIndex
    let end = source.length, match: RegExpExecArray | null
    while ((match = closing.exec(source))) {
      if (fenced || match[0].length === delimiter.length) {
        end = match.index + match[0].length
        break
      }
    }
    result += normalize(source.slice(cursor, marker.index)) + source.slice(marker.index, end)
    cursor = end
    markers.lastIndex = end
  }
  return result + normalize(source.slice(cursor))
}

// 只降级异常格式标记；词句、数字、链接、列表和表格仍由原 Markdown 管线渲染。
md.core.ruler.after("inline", "assistant_readability", state => {
  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index]!
    if (token.type === "heading_open") {
      const inline = state.tokens[index + 1], close = state.tokens[index + 2]
      if (inline?.type === "inline" && close?.type === "heading_close" && [...inline.content].length > 100) {
        token.type = "paragraph_open"
        token.tag = "p"
        close.type = "paragraph_close"
        close.tag = "p"
      }
    }
    if (token.type !== "inline" || !token.children) continue
    const stack: number[] = []
    token.children.forEach((child, childIndex, children) => {
      if (child.type === "strong_open") stack.push(childIndex)
      if (child.type !== "strong_close") return
      const start = stack.pop()
      if (start === undefined) return
      const length = children.slice(start + 1, childIndex).reduce((sum, item) => sum + [...item.content].length, 0)
      if (length <= 80) return
      for (const boundary of [children[start]!, child]) {
        boundary.type = "text"
        boundary.tag = ""
        boundary.nesting = 0
        boundary.content = ""
      }
    })
  }
})

// 图片不加载外链资源：输出 alt 文本占位，避免泄露请求或撑破版式
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index]?.content ?? "")

const defaultLinkOpen = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!
  token.attrSet("target", "_blank")
  token.attrSet("rel", "noopener noreferrer nofollow")
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

// 旧版追问回答会在末尾追加“已保存条件”段落；条件已随结构化回执展示，
// 这里只隐藏该历史后缀，不影响模型正文或其它段落。
const LEGACY_SAVED_CONDITIONS = /(?:\r?\n){2,}已保存条件：[^\r\n]*(?=\r?\n|$)/u

export function stripLegacySavedConditions(source: string): string {
  return source.replace(LEGACY_SAVED_CONDITIONS, "")
}

export function renderAssistantHtml(source: string): string {
  return md.render(stripLegacySavedConditions(normalizeAssistantParagraphs(source)))
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
