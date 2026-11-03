import type { ChatResponse } from "../types/api"
import { businessReportPresentation } from "./businessReportPresentation"
import type {
  DatasetInput,
  EvaluationRun,
  EvaluationTurn,
  RunStatus,
  TurnStatus,
} from "../types/evaluation"

export const runStatusLabels: Record<RunStatus, string> = {
  running: "执行中",
  cancelling: "停止中",
  completed: "执行结束",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "已中断",
}
export const turnStatusLabels: Record<TurnStatus, string> = {
  pending: "待执行",
  running: "执行中",
  completed: "执行完成",
  failed: "执行失败",
  cancelled: "已停止",
  skipped: "已跳过",
}
export function isActiveRun(run: EvaluationRun | null) {
  return run?.status === "running" || run?.status === "cancelling"
}
export function cancellationUnconfirmed(run: EvaluationRun) {
  return (
    run.status === "cancelling" &&
    run.turns.some((turn) => turn.result?.error_code === "EVALUATION_CANCEL_UNCONFIRMED")
  )
}
export function reviewLabel(turn?: EvaluationTurn | null) {
  if (!turn) return "—"
  if (turn.status !== "completed") return "未形成可复核结果"
  return turn.review?.verdict === "passed"
    ? "业务通过"
    : turn.review?.verdict === "failed"
      ? "业务未通过"
      : "待复核"
}
export function evaluationSummary(run: EvaluationRun) {
  const completed = run.turns.filter((turn) => turn.status === "completed")
  return {
    total: run.turns.length,
    completed: completed.length,
    passed: completed.filter((turn) => turn.review?.verdict === "passed").length,
    failed: completed.filter((turn) => turn.review?.verdict === "failed").length,
    pendingReview: completed.filter(
      (turn) => !turn.review || turn.review.verdict === "needs_review",
    ).length,
    executionFailed: run.turns.filter((turn) => turn.status === "failed").length,
  }
}
export function evaluationDate(value: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false })
}
export function turnDuration(turn?: EvaluationTurn | null) {
  if (!turn?.started_at || !turn.finished_at) return "—"
  const elapsed = Date.parse(turn.finished_at) - Date.parse(turn.started_at)
  return Number.isFinite(elapsed) && elapsed >= 0 ? `${(elapsed / 1000).toFixed(1)} 秒` : "—"
}
// 行内 HTTP 和既有浏览器目标也能使用 getRandomValues，题目身份不依赖安全上下文的 randomUUID。
export function createEvaluationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function datasetTurnCount(input: DatasetInput) {
  return input.groups.reduce((count, group) => count + group.turns.length, 0)
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function text(value: unknown, field: string, required = false, maxLength?: number): string {
  if (typeof value !== "string" || (required && !value.trim()))
    throw new Error(`${field}不能为空或格式不正确`)
  if (maxLength !== undefined && value.length > maxLength)
    throw new Error(`${field}不能超过 ${maxLength} 字。`)
  return value
}
export function parseDatasetInput(source: unknown): DatasetInput {
  let value: unknown = source
  if (typeof source === "string") {
    try {
      value = JSON.parse(source)
    } catch {
      throw new Error("JSON 格式不正确，请检查后再导入。")
    }
  }
  if (!isRecord(value) || !Array.isArray(value.groups) || !value.groups.length)
    throw new Error("问题集至少需要一个会话分组。")
  const name = text(value.name, "问题集名称", true)
  const description = text(value.description ?? "", "说明", false, 2000)
  const groupIds = new Set<string>()
  const turnIds = new Set<string>()
  const groups = value.groups.map((group: unknown) => {
    if (!isRecord(group) || !Array.isArray(group.turns) || !group.turns.length)
      throw new Error("每个分组至少需要一轮问题。")
    const id = text(group.id, "分组 ID", true)
    if (groupIds.has(id)) throw new Error(`分组 ID 重复：${id}`)
    groupIds.add(id)
    return {
      id,
      name: text(group.name, "分组名称", true),
      turns: group.turns.map((turn: unknown) => {
        if (!isRecord(turn)) throw new Error("问题格式不正确。")
        const turnId = text(turn.id, "轮次 ID", true)
        if (turnIds.has(turnId)) throw new Error(`轮次 ID 重复：${turnId}`)
        turnIds.add(turnId)
        return {
          id: turnId,
          question: text(turn.question, "问题", true),
          expected: text(turn.expected ?? "", "人工期望"),
        }
      }),
    }
  })
  const input = {
    name,
    description,
    groups,
  }
  if (datasetTurnCount(input) > 100) throw new Error("每个问题集最多支持 100 轮问题。")
  return input
}

export interface EvaluationComparisonRow {
  id: string
  before: EvaluationTurn | null
  after: EvaluationTurn | null
  comparable: boolean
  changes: string[]
}
export function compareEvaluationRuns(before: EvaluationRun, after: EvaluationRun) {
  const contextDifferences: string[] = []
  if (before.dataset.id !== after.dataset.id) contextDifferences.push("问题集不同")
  if (
    before.dataset_hash !== after.dataset_hash ||
    before.dataset.version !== after.dataset.version
  )
    contextDifferences.push("问题集版本或内容不同")
  if (before.model !== after.model) contextDifferences.push("模型不同")
  if (before.config_hash !== after.config_hash) contextDifferences.push("运行配置不同")
  if (before.data_label !== after.data_label) contextDifferences.push("人工登记的数据条件不同")
  const previous = new Map(before.turns.map((turn) => [turn.id, turn]))
  const next = new Map(after.turns.map((turn) => [turn.id, turn]))
  const rows: EvaluationComparisonRow[] = [...new Set([...previous.keys(), ...next.keys()])].map(
    (id) => {
      const left = previous.get(id) ?? null
      const right = next.get(id) ?? null
      const changes: string[] = []
      if (!left) changes.push("仅对比批次")
      else if (!right) changes.push("仅基准批次")
      else {
        if (left.group_id !== right.group_id) changes.push("会话分组变化")
        if (left.question !== right.question) changes.push("问题变化")
        if (left.expected !== right.expected) changes.push("人工期望变化")
        // 同一题仍可能依赖不同前文，前序轮次变化时不将追问伪称为可比。
        const prefix = (run: EvaluationRun, turn: EvaluationTurn) => {
          const group = run.dataset.groups.find((item) => item.id === turn.group_id)
          const index = group?.turns.findIndex((item) => item.id === turn.id) ?? -1
          return group && index >= 0 ? JSON.stringify(group.turns.slice(0, index)) : ""
        }
        if (prefix(before, left) !== prefix(after, right)) changes.push("前序会话变化")
      }
      return { id, before: left, after: right, comparable: changes.length === 0, changes }
    },
  )
  return { contextDifferences, rows }
}

export function downloadDataset(input: DatasetInput) {
  const portable = { name: input.name, description: input.description, groups: input.groups }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(portable, null, 2)], { type: "application/json" }),
  )
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `evaluation-dataset-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 正式回执沿用聊天的展示契约；不从正文重建图表或补造来源。 */
export function evaluationEvidenceResponse(
  details: unknown,
  messageId: string,
): ChatResponse | null {
  if (!isRecord(details)) return null
  // 回执的报告结构与图表由公共转换器统一校验，避免测评维护另一套展示规则。
  const report =
    details.kind === "business_report" &&
    typeof details.status === "string" &&
    isRecord(details.report)
      ? businessReportPresentation({ ...details, kind: "business_report", status: details.status })
      : undefined
  const table =
    Array.isArray(details.columns) &&
    details.columns.every((column): column is string => typeof column === "string") &&
    Array.isArray(details.rows) &&
    details.rows.every(isRecord)
      ? { columns: details.columns, rows: details.rows }
      : null
  if (!table && !report) return null
  return {
    message_id: messageId,
    intent: report ? "business_report" : "metric_query",
    answer: "",
    result: table ? { type: "metric_query", table } : null,
    metric_definition: null,
    clarification: null,
    debug: {},
    ...(report ? { analysis_report: report } : {}),
  }
}
