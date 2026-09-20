/**
 * 助手回答的固定展示样式：用 markdown 解析器把回答完整解析成结构，
 * 只按白名单块级元素重新渲染——段落、加粗、有序/无序列表、表格。
 * 标题、代码块、链接、图片等其余语法被解析器吃掉并降级为纯文本，
 * 不会以符号形式漏到界面上，也不需要针对新语法逐条补清理规则。
 * HTML 标签被丢弃，输出只经 {{ }} 插值渲染，不进 DOM。
 */
import MarkdownIt, { type Token } from "markdown-it"

/** breaks: true——单个换行即分段，与旧版按行拆段的展示行为一致；
 *  html: true 只为让标签被解析成 html token 便于丢弃，输出永远走 {{ }} 插值，不进 DOM */
const md = new MarkdownIt({ html: true, linkify: false, breaks: true })

export interface AssistantTextSegment {
  text: string
  bold: boolean
}

export type AssistantParagraph = AssistantTextSegment[]

export type AssistantTableAlign = "left" | "center" | "right"

export type AssistantBlock =
  | { type: "paragraph"; segments: AssistantParagraph }
  | { type: "list"; ordered: boolean; items: AssistantParagraph[] }
  | { type: "table"; header: AssistantParagraph[]; rows: AssistantParagraph[][]; aligns: AssistantTableAlign[] }

/** 提示词已禁止 emoji，这里对偶发残留做确定性清除，保证样式固定 */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu

/** 段落首尾去空白，丢弃空段 */
function trimSegments(segments: AssistantParagraph): AssistantParagraph {
  const result = [...segments]
  while (result.length && !result[0]!.text.trim()) result.shift()
  while (result.length && !result[result.length - 1]!.text.trim()) result.pop()
  if (!result.length) return []
  result[0] = { ...result[0]!, text: result[0]!.text.trimStart() }
  const last = result[result.length - 1]!
  result[result.length - 1] = { ...last, text: last.text.trimEnd() }
  return result
}

/** 行内 token 序列 → 段落序列；软/硬换行切分段落 */
function splitInlineSegments(children: Token[] | null): AssistantParagraph[] {
  const paragraphs: AssistantParagraph[] = []
  let current: AssistantParagraph = []
  let bold = false
  const push = (text: string) => {
    const cleaned = text.replace(EMOJI_PATTERN, "")
    if (cleaned) current.push({ text: cleaned, bold })
  }
  const flush = () => {
    const trimmed = trimSegments(current)
    if (trimmed.length) paragraphs.push(trimmed)
    current = []
  }
  const walk = (tokens: Token[] | null) => {
    for (const token of tokens ?? []) {
      if (token.type === "strong_open") bold = true
      else if (token.type === "strong_close") bold = false
      else if (token.type === "softbreak" || token.type === "hardbreak") flush()
      else if (token.type === "html_inline") continue
      else if (token.type === "text" || token.type === "code_inline" || token.type === "image") push(token.content)
      else if (token.children?.length) walk(token.children)
    }
  }
  walk(children)
  flush()
  return paragraphs
}

/** 列表项/表格单元格只允许单段内容：多段与嵌套结构降级拼接为一段 */
function joinedSegments(tokens: Token[]): AssistantParagraph {
  const parts: AssistantParagraph[] = []
  const walk = (list: Token[]) => {
    for (const token of list) {
      if (token.type === "inline") parts.push(...splitInlineSegments(token.children))
      else if (token.children?.length) walk(token.children)
    }
  }
  walk(tokens)
  const merged: AssistantParagraph = []
  parts.forEach((part, index) => {
    if (index) merged.push({ text: " ", bold: false })
    merged.push(...part)
  })
  return trimSegments(merged)
}

function tableAlign(token: Token): AssistantTableAlign {
  const style = String(token.attrGet("style") ?? "")
  if (style.includes("center")) return "center"
  if (style.includes("right")) return "right"
  return "left"
}

function collectBlocks(tokens: Token[], blocks: AssistantBlock[]) {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.type === "inline") {
      for (const segments of splitInlineSegments(token.children)) blocks.push({ type: "paragraph", segments })
    } else if (token.type === "fence" || token.type === "code_block") {
      // 代码块不保留样式，逐行降级为普通段落
      for (const line of token.content.split("\n")) {
        const segments = trimSegments([{ text: line.replace(EMOJI_PATTERN, ""), bold: false }])
        if (segments.length) blocks.push({ type: "paragraph", segments })
      }
    } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const ordered = token.type === "ordered_list_open"
      const closeType = ordered ? "ordered_list_close" : "bullet_list_close"
      const items: AssistantParagraph[] = []
      index++
      while (index < tokens.length && tokens[index]!.type !== closeType) {
        if (tokens[index]!.type === "list_item_open") {
          const itemTokens: Token[] = []
          index++
          while (index < tokens.length && tokens[index]!.type !== "list_item_close") {
            itemTokens.push(tokens[index]!)
            index++
          }
          const segments = joinedSegments(itemTokens)
          if (segments.length) items.push(segments)
        }
        index++
      }
      if (items.length) blocks.push({ type: "list", ordered, items })
    } else if (token.type === "table_open") {
      const header: AssistantParagraph[] = []
      const rows: AssistantParagraph[][] = []
      const aligns: AssistantTableAlign[] = []
      let section: "head" | "body" | null = null
      let currentRow: AssistantParagraph[] | null = null
      index++
      while (index < tokens.length && tokens[index]!.type !== "table_close") {
        const cell = tokens[index]!
        if (cell.type === "thead_open") section = "head"
        else if (cell.type === "tbody_open") section = "body"
        else if (cell.type === "tr_open") currentRow = []
        else if (cell.type === "tr_close" && currentRow) {
          if (section === "head") header.push(...currentRow)
          else if (currentRow.length) rows.push(currentRow)
          currentRow = null
        } else if ((cell.type === "th_open" || cell.type === "td_open") && currentRow) {
          if (section === "head") aligns.push(tableAlign(cell))
          const inline = tokens[index + 1]?.type === "inline" ? tokens[index + 1]! : null
          currentRow.push(inline ? joinedSegments([inline]) : [])
        }
        index++
      }
      if (header.length || rows.length) blocks.push({ type: "table", header, rows, aligns })
    } else if (token.type === "hr" || token.type === "html_block") {
      // 分隔线与 HTML 块直接丢弃
    } else if (token.children?.length) {
      // 引用块等其余容器：不保留容器样式，递归展开其内容
      collectBlocks(token.children, blocks)
    }
    index++
  }
}

export function parseAssistantBlocks(source: string): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  collectBlocks(md.parse(source, {}), blocks)
  return blocks
}

/** 块序列重新拼成纯文本，供复制等纯文本场景使用 */
export function flattenAssistantBlocks(blocks: AssistantBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === "paragraph") parts.push(block.segments.map(segment => segment.text).join(""))
    else if (block.type === "list") block.items.forEach((item, index) => parts.push(`${block.ordered ? `${index + 1}. ` : "- "}${item.map(segment => segment.text).join("")}`))
    else {
      if (block.header.length) parts.push(block.header.map(cell => cell.map(segment => segment.text).join("")).join("\t"))
      for (const row of block.rows) parts.push(row.map(cell => cell.map(segment => segment.text).join("")).join("\t"))
    }
  }
  return parts.join("\n")
}
