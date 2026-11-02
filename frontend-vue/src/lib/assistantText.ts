/**
 * 助手回答的结构化块契约：与服务端 answer_blocks 的 JSON 形状一一对应。
 * 渲染一律走 assistantMarkdown（blocksToMarkdown → markdown-it），
 * 这里只保留类型定义和复制场景用的纯文本拍平。
 */

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
