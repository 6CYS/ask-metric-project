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
  // 兼容旧工具快照中曾被模型复述的内部展示提示，不改动业务结论。
  return lines.join("\n")
    .replace(/(?:具体)?明细数据已在用户界面以结果表展示[，,]\s*回答正文(?:不要|不)逐条罗列数值[，,]\s*简洁概括即可[。.]?/g, "")
    .trim()
}

/** 失败原因使用工具的公开回执；不展示内部异常，也不以通用文案覆盖业务原因。 */
export function governedReply(details: MetricAskDetails | undefined): string | undefined {
  if (!details) return undefined
  const status = details.status.toLowerCase()
  if (status === "clarification_required") return details.clarification_prompt ?? details.clarification?.prompt
  if (status === "unsupported") return details.public_answer?.trim() || "当前能力暂不支持该查询，请调整查询条件。"
  if (status === "failed" || status === "error") {
    if (details.error_code === "AUTH_REQUIRED") return "登录状态已失效，请重新登录后查询。"
    if (details.error_code === "PERMISSION_DENIED") return "当前账号无权执行该查询，请核对查询范围或联系管理员。"
    return details.public_answer?.trim() || "本次查询未成功，请检查查询条件或稍后重试。"
  }
  if (status === "succeeded" && (details.row_count ?? details.rows?.length ?? 0) === 0) {
    return details.message?.trim() || "本次查询条件下暂无数据记录。"
  }
  return undefined
}
