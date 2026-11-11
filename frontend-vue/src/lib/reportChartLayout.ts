import type { Token } from "markdown-it"

import type { AnalysisReportView, BusinessReportChart } from "@/types/api"
import {
  normalizeAssistantParagraphs,
  parseAssistantMarkdown,
  stripLegacySavedConditions,
} from "./assistantMarkdown"

type ReportPart =
  | { kind: "markdown"; key: string; block: string; tokens: Token[] }
  | { kind: "chart"; key: string; chart: BusinessReportChart }
type MarkdownBlock = { tag: string; startLine: number; startToken: number; endToken: number }

export function reportChartKey(chart: BusinessReportChart): string {
  return `chart:${JSON.stringify([chart.type, [...chart.source_refs].sort()])}`
}

function paragraphEndLines(source: string): number[] {
  const lines: number[] = []
  let start = 0
  const record = (end: number) => {
    const paragraph = source.slice(start, end).trimEnd()
    if (!paragraph.trim()) return
    const prefix = stripLegacySavedConditions(
      normalizeAssistantParagraphs(source.slice(0, start + paragraph.length)),
    )
    lines.push(prefix.split("\n").length)
  }
  for (const separator of source.matchAll(/\n\s*\n/g)) {
    record(separator.index)
    start = separator.index + separator[0].length
  }
  record(source.length)
  return lines
}

function prepareText(source: string) {
  const normalized = source.replace(/\r\n?/g, "\n")
  const tokens = parseAssistantMarkdown(normalized)
  const blocks: MarkdownBlock[] = []
  tokens.forEach((token, index) => {
    if (token.level !== 0 || token.nesting === -1 || !token.map) return
    const previous = blocks[blocks.length - 1]
    if (previous) previous.endToken = index
    blocks.push({
      tag: token.type === "fence" || token.type === "code_block" ? "pre" : token.tag,
      startLine: token.map[0],
      startToken: index,
      endToken: tokens.length,
    })
  })
  return {
    tokens,
    blocks,
    paragraphEnds: paragraphEndLines(normalized),
    charts: new Map<number, BusinessReportChart[]>(),
  }
}

function contentParts(text: ReturnType<typeof prepareText>, section: string): ReportPart[] {
  const parts: ReportPart[] = []
  for (const block of text.blocks) {
    parts.push({
      kind: "markdown",
      key: `${section}:block:${block.startLine}`,
      block: block.tag,
      tokens: text.tokens.slice(block.startToken, block.endToken),
    })
    for (const chart of text.charts.get(block.endToken) ?? [])
      parts.push({ kind: "chart", key: reportChartKey(chart), chart })
  }
  return parts
}

/** 全文只解析一次，按安全顶层块插图，保留跨段引用链接、列表和代码块。 */
export function layoutReportCharts(
  report: Pick<AnalysisReportView, "summary" | "sections" | "charts">,
) {
  const summary = prepareText(report.summary)
  const sections = report.sections.map((section) => prepareText(section.text))
  const trailingCharts: BusinessReportChart[] = []
  const seen = new Set<string>()
  for (const chart of report.charts ?? []) {
    const key = reportChartKey(chart)
    if (seen.has(key)) continue
    seen.add(key)
    const placement: unknown = chart.placement
    if (
      !placement ||
      typeof placement !== "object" ||
      Array.isArray(placement) ||
      !("after_paragraph" in placement) ||
      typeof placement.after_paragraph !== "number" ||
      !Number.isInteger(placement.after_paragraph) ||
      placement.after_paragraph < 1
    ) {
      trailingCharts.push(chart)
      continue
    }
    const sectionIndex = "section_index" in placement ? placement.section_index : undefined
    const text =
      sectionIndex === undefined
        ? summary
        : typeof sectionIndex === "number" && Number.isInteger(sectionIndex) && sectionIndex >= 0
          ? sections[sectionIndex]
          : undefined
    const endLine = text?.paragraphEnds[placement.after_paragraph - 1]
    // 空行可能位于列表或代码块内部，锚点须推迟到包含该段落的整个块结束。
    let block: MarkdownBlock | undefined
    if (endLine !== undefined) {
      for (const candidate of text?.blocks ?? []) {
        if (candidate.startLine >= endLine) break
        block = candidate
      }
    }
    if (!text || !block) {
      trailingCharts.push(chart)
      continue
    }
    const charts = text.charts.get(block.endToken) ?? []
    charts.push(chart)
    text.charts.set(block.endToken, charts)
  }
  return {
    summary: contentParts(summary, "summary"),
    sections: sections.map((text, index) => contentParts(text, `section:${index}`)),
    trailingCharts,
  }
}
