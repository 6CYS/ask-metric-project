/**
 * 助手回答的固定展示样式：用 markdown 解析器把模型输出完整解析成结构，
 * 只按“纯文本段落 + 加粗”重新渲染——标题、列表、表格、代码块、链接等
 * 任何 markdown 语法都被解析器吃掉并降级为纯文本，不会以符号形式漏到界面上，
 * 也不需要针对新语法逐条补清理规则。HTML 标签被丢弃，输出只经 {{ }} 插值渲染。
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

/** 提示词已禁止 emoji，这里对偶发残留做确定性清除，保证样式固定 */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu

export function parseAssistantText(source: string): AssistantParagraph[] {
  const paragraphs: AssistantParagraph[] = []
  let current: AssistantParagraph = []
  let bold = false

  const pushText = (text: string) => {
    const cleaned = text.replace(EMOJI_PATTERN, "")
    if (cleaned) current.push({ text: cleaned, bold })
  }
  const flush = () => {
    // 段落首尾去空白，丢弃空段
    while (current.length && !current[0]!.text.trim()) current.shift()
    while (current.length && !current[current.length - 1]!.text.trim()) current.pop()
    if (!current.length) return
    current[0] = { ...current[0]!, text: current[0]!.text.trimStart() }
    const last = current[current.length - 1]!
    current[current.length - 1] = { ...last, text: last.text.trimEnd() }
    paragraphs.push(current)
    current = []
  }

  const walkInline = (tokens: Token[] | null) => {
    for (const token of tokens ?? []) {
      if (token.type === "strong_open") bold = true
      else if (token.type === "strong_close") bold = false
      else if (token.type === "softbreak" || token.type === "hardbreak") flush()
      else if (token.type === "html_inline") continue
      else if (token.type === "text" || token.type === "code_inline" || token.type === "image") pushText(token.content)
      else if (token.children?.length) walkInline(token.children)
    }
  }
  const walkBlocks = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "inline") {
        walkInline(token.children)
        flush()
      } else if (token.type === "fence" || token.type === "code_block") {
        for (const line of token.content.split("\n")) {
          pushText(line)
          flush()
        }
      } else if (token.type === "hr" || token.type === "html_block") {
        continue
      } else if (token.children?.length) {
        walkBlocks(token.children)
      }
    }
  }

  walkBlocks(md.parse(source, {}))
  flush()
  return paragraphs
}

/** 段落重新拼成带空行的片段序列，供保留换行（whitespace-pre-wrap）的单元素渲染使用 */
export function flattenAssistantSegments(source: string): AssistantTextSegment[] {
  const segments: AssistantTextSegment[] = []
  parseAssistantText(source).forEach((paragraph, index) => {
    if (index > 0) segments.push({ text: "\n\n", bold: false })
    segments.push(...paragraph)
  })
  return segments
}
