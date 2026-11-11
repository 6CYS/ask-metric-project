import type { AgentStreamEvent } from "./agentApi"
import type { BusinessReportChart } from "@/types/api"
import { isBusinessReportChart } from "./businessReportChart"

export interface ProvisionalAnswer {
  provisionalContent?: string
  provisionalCallSeq?: number
  provisionalCharts?: BusinessReportChart[]
}

/** 临时正文仅供 pending 气泡显示；累计覆盖，旧调用的撤回不能清掉新调用。 */
export function applyProvisionalAnswer<T extends { status?: string }>(
  message: T & ProvisionalAnswer,
  event: Extract<AgentStreamEvent, { type: "answer_delta" | "answer_reset" }>,
): T & ProvisionalAnswer {
  if (
    message.status !== "pending" ||
    !Number.isSafeInteger(event.call_seq) ||
    event.call_seq < 1 ||
    event.call_seq < (message.provisionalCallSeq ?? 0)
  )
    return message
  if (event.type === "answer_delta") {
    if (typeof event.text !== "string") return message
    const sameCall = message.provisionalCallSeq === event.call_seq
    let charts = sameCall ? message.provisionalCharts : undefined
    if (event.charts !== undefined) {
      const previous = new Map(charts?.map((chart) => [JSON.stringify(chart), chart]))
      // 图表格式仅在展示边界过滤；同一图值不变时保留对象，正文追加不触发图表重绘。
      const next = Array.isArray(event.charts)
        ? event.charts
            .filter(isBusinessReportChart)
            .map((chart) => previous.get(JSON.stringify(chart)) ?? chart)
        : []
      if (
        !charts ||
        next.length !== charts.length ||
        next.some((chart, index) => chart !== charts?.[index])
      )
        charts = next
    }
    if (
      sameCall &&
      message.provisionalContent === event.text &&
      charts === message.provisionalCharts
    )
      return message
    return {
      ...message,
      provisionalContent: event.text,
      provisionalCallSeq: event.call_seq,
      provisionalCharts: charts,
    }
  }
  return {
    ...message,
    provisionalContent: "",
    provisionalCallSeq: event.call_seq,
    provisionalCharts: undefined,
  }
}

export function clearProvisionalAnswer<T extends ProvisionalAnswer>(message: T): T {
  const finalized = { ...message }
  delete finalized.provisionalContent
  delete finalized.provisionalCallSeq
  delete finalized.provisionalCharts
  return finalized
}
