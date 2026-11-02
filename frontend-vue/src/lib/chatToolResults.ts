import type { BackendNextClarification } from "@/types/api"
import type { CalculationDetails, MetricAskDetails } from "./agentApi"
import type { AvailabilityDetails } from "./dataAvailability"
import type { CatalogOverviewDetails } from "./replyPresentation"

/** 仅保存服务端交付与展示附件；工具进度、会话和组件生命周期仍由面板管理。 */
export interface ChatToolResultState {
  content: string
  nativeAnswer?: boolean
  answerDelivered?: boolean
  taskIds?: string[]
  metricAskDetails?: MetricAskDetails
  queryResults?: MetricAskDetails[]
  calculations?: CalculationDetails[]
  availability?: AvailabilityDetails[]
  availabilityError?: string
  catalogOverviews?: CatalogOverviewDetails[]
  metricAskClarification?: BackendNextClarification
  metricAskClarificationPrompt?: string
  clarificationTarget?: { task_id: string; version: number; clarification_id: string }
}

function metricAskDetails(value: Record<string, unknown>): MetricAskDetails | undefined {
  const kind = value.kind
  if (typeof value.status !== "string") return undefined
  // 状态回查不等于读取结果，不能把成功状态显示成一次空查询。
  if (
    kind === "metric_read" &&
    !value.result_id &&
    !["error", "failed"].includes(value.status.toLowerCase())
  )
    return undefined
  return kind === "metric_ask" ||
    kind === "metric_query_structured" ||
    kind === "metric_read" ||
    kind === "business_report"
    ? (value as unknown as MetricAskDetails)
    : undefined
}

export function applyChatToolResult<T extends ChatToolResultState>(state: T, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return state
  const receipt = value as Record<string, unknown>
  if (receipt.answer_selected === false) return state
  if (
    ((receipt.kind === "answer_present" && receipt.delivery === "business_answer_v1") ||
      (receipt.kind === "runtime_delivery" &&
        receipt.version === 1 &&
        typeof receipt.operation_id === "string" &&
        Boolean(receipt.operation_id) &&
        ["result", "explanation", "incomplete"].includes(String(receipt.outcome)))) &&
    receipt.status === "delivered" &&
    typeof receipt.public_answer === "string" &&
    receipt.public_answer.trim()
  ) {
    return {
      ...state,
      answerDelivered: true,
      content: receipt.public_answer,
      metricAskClarification: undefined,
      metricAskClarificationPrompt: undefined,
      clarificationTarget: undefined,
    }
  }
  if (receipt.kind === "data_availability") {
    if (receipt.status !== "succeeded")
      return {
        ...state,
        availabilityError:
          "数据覆盖查询未完成，请确认登录和查询条件，或缩小范围后重试；这不代表没有数据。",
      }
    return {
      ...state,
      availabilityError: undefined,
      availability: state.availability?.length
        ? state.availability
        : [value as AvailabilityDetails],
    }
  }
  if (receipt.kind === "catalog_overview")
    return {
      ...state,
      catalogOverviews: [...(state.catalogOverviews ?? []), value as CatalogOverviewDetails],
    }
  if (receipt.kind === "metric_calculate" && typeof receipt.status === "string") {
    const calculation = value as CalculationDetails
    return {
      ...state,
      taskIds: calculation.task_id
        ? [...new Set([...(state.taskIds ?? []), calculation.task_id])]
        : state.taskIds,
      calculations: [
        ...(state.calculations ?? []).filter(
          (previous) => !(calculation.status === "succeeded" && previous.retryable),
        ),
        calculation,
      ],
    }
  }
  const details = metricAskDetails(receipt)
  if (!details) return state
  const taskIds = details.task_id
    ? [...new Set([...(state.taskIds ?? []), details.task_id])]
    : state.taskIds
  if (details.status === "clarification_required" && details.clarification) {
    return {
      ...state,
      taskIds,
      metricAskClarification: details.clarification,
      metricAskClarificationPrompt: details.clarification_prompt,
      clarificationTarget:
        details.task_id && details.clarification.id && details.version !== undefined
          ? {
              task_id: details.task_id,
              version: details.version,
              clarification_id: details.clarification.id,
            }
          : undefined,
    }
  }
  return {
    ...state,
    taskIds,
    metricAskDetails: details,
    content: state.nativeAnswer ? state.content : (details.public_answer ?? state.content),
    ...(details.status === "succeeded"
      ? {
          metricAskClarification: undefined,
          metricAskClarificationPrompt: undefined,
          clarificationTarget: undefined,
        }
      : {}),
    queryResults:
      details.status === "succeeded" && receipt.semantic_task
        ? [
            ...(state.queryResults ?? []).filter(
              (previous) => previous.task_id !== details.task_id,
            ),
            details,
          ]
        : state.queryResults,
  }
}
