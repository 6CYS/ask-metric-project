import MarkdownIt from "markdown-it"
import type { MetricAskDetails } from "./agentApi"

// 仅解析格式并提取文字，最终由 Vue 文本插值展示，不执行 HTML 或加载图片。
const markdown = new MarkdownIt({ html: false, linkify: false })
export interface CatalogOverviewDetails {
  kind: "catalog_overview"
  status: "succeeded"
  catalog: "metrics" | "organizations"
  total: number
  examples: Array<{ name: string; unit?: string | null }>
}

export function catalogOverviewReply(overview: CatalogOverviewDetails): string {
  const subject = overview.catalog === "metrics" ? "启用指标" : "当前账号可查询的机构"
  const examples = overview.examples.map(item => item.name).join("、")
  return `目录中有 ${overview.total} 个${subject}。`
    + (examples ? `\n部分示例：${examples}。` : "")
    + "\n目录存在不代表指定机构和日期有数据，具体情况需查询确认。"
    + (overview.catalog === "metrics" ? "你可以输入指标名称检索，或描述查询需求。" : "你可以输入机构名称进一步检索。")
}
export function replyText(value: string): string {
  const lines: string[] = []
  for (const token of markdown.parse(value, {})) {
    if (token.type === "inline") {
      lines.push((token.children ?? []).map(child => {
        if (child.type === "softbreak" || child.type === "hardbreak") return "\n"
        if (child.type === "text" || child.type === "code_inline" || child.type === "image") return child.content
        return ""
      }).join(""))
    } else if (token.type === "fence" || token.type === "code_block") lines.push(token.content.trimEnd())
  }
  return lines.join("\n").trim()
}

/** 固定结果状态不使用模型解释；成功有数据时才保留模型整理。 */
export function governedReply(details: MetricAskDetails | undefined): string | undefined {
  if (!details) return undefined
  if (details.status === "clarification_required") return details.clarification_prompt ?? details.clarification?.prompt
  if (details.status === "unsupported") return "当前能力暂不支持该查询，请调整查询条件。"
  if (details.status === "failed" || details.status === "error") {
    if (details.error_code === "AUTH_REQUIRED") return "登录状态已失效，请重新登录后查询。"
    if (details.error_code === "PERMISSION_DENIED") return "当前账号无权执行该查询，请核对查询范围或联系管理员。"
    return "本次查询未成功，请检查查询条件或稍后重试。"
  }
  if (details.status === "succeeded" && (details.row_count ?? details.rows?.length ?? 0) === 0) {
    return details.message?.trim() || "本次查询条件下暂无数据记录。"
  }
  return undefined
}
