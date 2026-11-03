import { onScopeDispose, shallowRef } from "vue"

import { evaluationApi } from "../lib/evaluationApi"
import type { EvaluationRun, EvaluationTurn, EvaluationTurnDetail } from "../types/evaluation"

export type ComparisonSide = "before" | "after"

export interface ComparisonTarget {
  runId: string
  turn: EvaluationTurn
}

export interface ComparisonDetailState {
  detail: EvaluationTurnDetail | null
  loading: boolean
  error: string
}

function emptyState(): ComparisonDetailState {
  return { detail: null, loading: false, error: "" }
}

export function useEvaluationComparisonDetails() {
  const before = shallowRef<ComparisonDetailState>(emptyState())
  const after = shallowRef<ComparisonDetailState>(emptyState())
  const states = { before, after }
  const targets: Record<ComparisonSide, ComparisonTarget | null> = {
    before: null,
    after: null,
  }
  const requests: Record<ComparisonSide, AbortController | null> = {
    before: null,
    after: null,
  }
  const turnSnapshots: Record<ComparisonSide, string | null> = {
    before: null,
    after: null,
  }

  function clear() {
    for (const side of ["before", "after"] as const) {
      requests[side]?.abort()
      requests[side] = null
      targets[side] = null
      turnSnapshots[side] = null
      states[side].value = emptyState()
    }
  }

  async function retry(side: ComparisonSide): Promise<void> {
    const target = targets[side]
    if (!target) return
    requests[side]?.abort()
    const request = new AbortController()
    requests[side] = request
    states[side].value = { ...emptyState(), loading: true }
    try {
      const detail = await evaluationApi.getTurn(target.runId, target.turn.id, request.signal)
      // 取消即失效；即便传输层仍返回，也不能将旧记录写回当前比较。
      if (!request.signal.aborted) {
        states[side].value = { detail, loading: false, error: "" }
      }
    } catch (error) {
      if (!request.signal.aborted) {
        states[side].value = {
          detail: null,
          loading: false,
          error: error instanceof Error ? error.message : "无法读取保存记录，请稍后重试。",
        }
      }
    } finally {
      if (requests[side] === request) requests[side] = null
    }
  }

  async function load(
    beforeTarget: ComparisonTarget | null,
    afterTarget: ComparisonTarget | null,
  ): Promise<void> {
    clear()
    targets.before = beforeTarget ? { ...beforeTarget } : null
    targets.after = afterTarget ? { ...afterTarget } : null
    // 在详情返回前保存列表快照，避免先到的轮询终态被首次请求漏掉。
    turnSnapshots.before = beforeTarget ? JSON.stringify(beforeTarget.turn) : null
    turnSnapshots.after = afterTarget ? JSON.stringify(afterTarget.turn) : null
    await Promise.all([retry("before"), retry("after")])
  }

  async function syncRuns(runs: EvaluationRun[]): Promise<void> {
    const refreshing: Promise<void>[] = []
    for (const side of ["before", "after"] as const) {
      const target = targets[side]
      if (!target) continue
      const turn = runs
        .find((run) => run.id === target.runId)
        ?.turns.find((item) => item.id === target.turn.id)
      if (!turn) continue
      const snapshot = JSON.stringify(turn)
      if (snapshot === turnSnapshots[side]) continue
      turnSnapshots[side] = snapshot
      targets[side] = { runId: target.runId, turn }
      refreshing.push(retry(side))
    }
    await Promise.all(refreshing)
  }

  onScopeDispose(clear)

  return { before, after, load, retry, clear, syncRuns }
}
