import { effectScope, type EffectScope } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  useEvaluationComparisonDetails,
  type ComparisonSide,
  type ComparisonTarget,
} from "../src/composables/useEvaluationComparisonDetails"
import { evaluationApi } from "../src/lib/evaluationApi"
import type { EvaluationTurn, EvaluationTurnDetail } from "../src/types/evaluation"
import { runFixture } from "./evaluationFixtures"

const beforeTarget: ComparisonTarget = {
  runId: "run-before",
  turn: detailFixture("turn-before").turn,
}
const afterTarget: ComparisonTarget = {
  runId: "run-after",
  turn: detailFixture("turn-after").turn,
}
const emptyState = { detail: null, loading: false, error: "" }
const scopes: EffectScope[] = []

function detailFixture(id: string, overrides: Partial<EvaluationTurn> = {}): EvaluationTurnDetail {
  const turn = runFixture().turns[0]
  if (!turn) throw new Error("隔离样本缺少题目")
  return {
    turn: { ...turn, id, ...overrides },
    messages: [{ role: "assistant", text: `隔离记录 ${id}`, timestamp: null }],
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("尚未初始化")
  }
  let reject: (reason: Error) => void = () => {
    throw new Error("尚未初始化")
  }
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup() {
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(useEvaluationComparisonDetails)
  if (!state) throw new Error("无法创建比较详情状态")
  return { state, scope }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.restoreAllMocks()
})

describe("测评比较详情只读加载", () => {
  it("空目标不读取，清空后的重试也不读取", async () => {
    const getTurn = vi.spyOn(evaluationApi, "getTurn").mockResolvedValue(detailFixture("unused"))
    const { state } = setup()
    await state.load(null, null)
    await state.retry("before")
    await state.retry("after")
    expect(getTurn).not.toHaveBeenCalled()
    expect(state.before.value).toEqual(emptyState)
    expect(state.after.value).toEqual(emptyState)
  })

  it.each<ComparisonSide>(["before", "after"])(
    "%s 侧成功立即可见，另一侧失败不清除成功记录",
    async (successSide) => {
      const previous = deferred<EvaluationTurnDetail>()
      const current = deferred<EvaluationTurnDetail>()
      const getTurn = vi
        .spyOn(evaluationApi, "getTurn")
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise)
      const { state } = setup()
      const loading = state.load(beforeTarget, afterTarget)
      expect(getTurn.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ["run-before", "turn-before"],
        ["run-after", "turn-after"],
      ])
      expect(state.before.value).toEqual({ ...emptyState, loading: true })
      expect(state.after.value).toEqual({ ...emptyState, loading: true })
      const success = successSide === "before" ? previous : current
      const failure = successSide === "before" ? current : previous
      const failureSide = successSide === "before" ? "after" : "before"
      const detail = detailFixture(successSide)
      success.resolve(detail)
      await settle()
      expect(state[successSide].value).toEqual({ detail, loading: false, error: "" })
      expect(state[failureSide].value).toEqual({ ...emptyState, loading: true })
      failure.reject(new Error("无法读取保存记录"))
      await loading
      expect(state[failureSide].value).toEqual({
        detail: null,
        loading: false,
        error: "无法读取保存记录",
      })
      expect(state[successSide].value.detail).toBe(detail)
    },
  )

  it("只重试失败侧，另一侧的成功记录不变", async () => {
    const after = detailFixture("after")
    const retry = deferred<EvaluationTurnDetail>()
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockRejectedValueOnce(new Error("暂时无法读取"))
      .mockResolvedValueOnce(after)
      .mockReturnValueOnce(retry.promise)
    const { state } = setup()
    await state.load(beforeTarget, afterTarget)
    const retrying = state.retry("before")
    expect(getTurn).toHaveBeenCalledTimes(3)
    expect(getTurn.mock.calls[2]?.slice(0, 2)).toEqual(["run-before", "turn-before"])
    expect(state.before.value).toEqual({ ...emptyState, loading: true })
    expect(state.after.value.detail).toBe(after)
    retry.resolve(detailFixture("before"))
    await retrying
    expect(state.before.value.detail?.turn.id).toBe("before")
    expect(state.before.value.error).toBe("")
    expect(state.after.value.detail).toBe(after)
  })

  it("单侧目标只读取对应记录，切换时立即清除旧内容和错误", async () => {
    const current = deferred<EvaluationTurnDetail>()
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockResolvedValueOnce(detailFixture("before"))
      .mockRejectedValueOnce(new Error("旧记录读取失败"))
      .mockReturnValueOnce(current.promise)
    const { state } = setup()
    await state.load(beforeTarget, afterTarget)
    const loading = state.load(null, {
      runId: "run-new",
      turn: detailFixture("turn-new").turn,
    })
    expect(getTurn).toHaveBeenCalledTimes(3)
    expect(getTurn.mock.calls[2]?.slice(0, 2)).toEqual(["run-new", "turn-new"])
    expect(state.before.value).toEqual(emptyState)
    expect(state.after.value).toEqual({ ...emptyState, loading: true })
    current.resolve(detailFixture("new"))
    await loading
    expect(state.after.value.detail?.turn.id).toBe("new")
  })

  it("切换目标取消两侧旧请求，旧成功和失败均不能写入新加载状态", async () => {
    const oldBefore = deferred<EvaluationTurnDetail>()
    const oldAfter = deferred<EvaluationTurnDetail>()
    const newBefore = deferred<EvaluationTurnDetail>()
    const newAfter = deferred<EvaluationTurnDetail>()
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockReturnValueOnce(oldBefore.promise)
      .mockReturnValueOnce(oldAfter.promise)
      .mockReturnValueOnce(newBefore.promise)
      .mockReturnValueOnce(newAfter.promise)
    const { state } = setup()
    const oldLoading = state.load(beforeTarget, afterTarget)
    const newLoading = state.load(
      { runId: "run-new-before", turn: detailFixture("turn-new-before").turn },
      { runId: "run-new-after", turn: detailFixture("turn-new-after").turn },
    )
    expect(getTurn.mock.calls[0]?.[2]?.aborted).toBe(true)
    expect(getTurn.mock.calls[1]?.[2]?.aborted).toBe(true)
    oldBefore.resolve(detailFixture("old-before"))
    oldAfter.reject(new Error("旧请求失败"))
    await oldLoading
    expect(state.before.value).toEqual({ ...emptyState, loading: true })
    expect(state.after.value).toEqual({ ...emptyState, loading: true })
    newBefore.resolve(detailFixture("new-before"))
    newAfter.resolve(detailFixture("new-after"))
    await newLoading
    expect(state.before.value.detail?.turn.id).toBe("new-before")
    expect(state.after.value.detail?.turn.id).toBe("new-after")
  })

  it("重试中的旧响应不覆盖重试结果，也不中止另一侧请求", async () => {
    const oldBefore = deferred<EvaluationTurnDetail>()
    const after = deferred<EvaluationTurnDetail>()
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockReturnValueOnce(oldBefore.promise)
      .mockReturnValueOnce(after.promise)
      .mockResolvedValueOnce(detailFixture("retried-before"))
    const { state } = setup()
    const loading = state.load(beforeTarget, afterTarget)
    await state.retry("before")
    expect(getTurn.mock.calls[0]?.[2]?.aborted).toBe(true)
    expect(getTurn.mock.calls[1]?.[2]?.aborted).toBe(false)
    expect(state.after.value).toEqual({ ...emptyState, loading: true })
    oldBefore.resolve(detailFixture("old-before"))
    after.resolve(detailFixture("after"))
    await loading
    expect(state.before.value.detail?.turn.id).toBe("retried-before")
    expect(state.after.value.detail?.turn.id).toBe("after")
  })

  it.each(["clear", "dispose"] as const)(
    "%s 取消全部请求并清空，迟到的成功和失败不能恢复内容",
    async (action) => {
      const previous = deferred<EvaluationTurnDetail>()
      const current = deferred<EvaluationTurnDetail>()
      const getTurn = vi
        .spyOn(evaluationApi, "getTurn")
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise)
      const { state, scope } = setup()
      const loading = state.load(beforeTarget, afterTarget)
      if (action === "clear") state.clear()
      else scope.stop()
      expect(getTurn.mock.calls[0]?.[2]?.aborted).toBe(true)
      expect(getTurn.mock.calls[1]?.[2]?.aborted).toBe(true)
      expect(state.before.value).toEqual(emptyState)
      expect(state.after.value).toEqual(emptyState)
      previous.resolve(detailFixture("before"))
      current.reject(new Error("迟到的失败"))
      await loading
      await state.retry("before")
      await state.retry("after")
      expect(getTurn).toHaveBeenCalledTimes(2)
      expect(state.before.value).toEqual(emptyState)
      expect(state.after.value).toEqual(emptyState)
    },
  )

  it("轮询只重读由 running 变为 completed 的一侧", async () => {
    const running = detailFixture("turn-before", { status: "running" })
    const completed = detailFixture("turn-before", {
      finished_at: "2026-11-03T01:00:00Z",
    })
    const after = detailFixture("turn-after")
    const refreshed = deferred<EvaluationTurnDetail>()
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(after)
      .mockReturnValueOnce(refreshed.promise)
    const { state } = setup()
    await state.load({ runId: "run-before", turn: running.turn }, afterTarget)
    const refreshing = state.syncRuns([
      runFixture({ id: "run-before", turns: [completed.turn] }),
      runFixture({ id: "run-after", turns: [after.turn] }),
    ])
    expect(getTurn).toHaveBeenCalledTimes(3)
    expect(getTurn.mock.calls[2]?.slice(0, 2)).toEqual(["run-before", "turn-before"])
    expect(state.before.value).toEqual({ ...emptyState, loading: true })
    expect(state.after.value.detail).toBe(after)
    refreshed.resolve(completed)
    await refreshing
    expect(state.before.value.detail).toBe(completed)
    expect(state.before.value.detail?.turn.status).toBe("completed")
    expect(state.after.value.detail).toBe(after)
  })

  it("轮询终态早于首次详情返回时取消旧请求，迟到的 running 不覆盖终态", async () => {
    const running = detailFixture("turn-before", { status: "running" })
    const completed = detailFixture("turn-before")
    const after = detailFixture("turn-after")
    const previous = deferred<EvaluationTurnDetail>()
    const refreshed = deferred<EvaluationTurnDetail>()
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(after)
      .mockReturnValueOnce(refreshed.promise)
    const { state } = setup()
    const loading = state.load({ runId: "run-before", turn: running.turn }, afterTarget)
    const runs = [
      runFixture({ id: "run-before", turns: [completed.turn] }),
      runFixture({ id: "run-after", turns: [after.turn] }),
    ]
    const refreshing = state.syncRuns(runs)
    expect(getTurn.mock.calls[0]?.[2]?.aborted).toBe(true)
    await state.syncRuns(runs)
    expect(getTurn).toHaveBeenCalledTimes(3)
    refreshed.resolve(completed)
    await refreshing
    previous.resolve(running)
    await loading
    expect(state.before.value.detail).toBe(completed)
    expect(state.before.value.loading).toBe(false)
    expect(state.after.value.detail).toBe(after)
  })

  it("轮询目标轮次不变时不请求，其他批次或题目变化不影响当前详情", async () => {
    const before = detailFixture("turn-before")
    const after = detailFixture("turn-after")
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)
    const { state } = setup()
    await state.load(beforeTarget, afterTarget)
    await state.syncRuns([
      runFixture({
        id: "run-before",
        name: "批次显示名称变化",
        turns: [{ ...before.turn }, detailFixture("other-turn", { status: "running" }).turn],
      }),
      runFixture({ id: "run-after", turns: [{ ...after.turn }] }),
      runFixture({ id: "other-run", status: "running" }),
    ])
    await state.syncRuns([])
    expect(getTurn).toHaveBeenCalledTimes(2)
    expect(state.before.value.detail).toBe(before)
    expect(state.after.value.detail).toBe(after)
  })

  it("轮询重读失败后相同快照不自动重复请求", async () => {
    const running = detailFixture("turn-before", { status: "running" })
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error("保存记录暂不可用"))
    const { state } = setup()
    await state.load({ runId: "run-before", turn: running.turn }, null)
    const runs = [runFixture({ id: "run-before", turns: [beforeTarget.turn] })]
    await state.syncRuns(runs)
    await state.syncRuns(runs)
    expect(getTurn).toHaveBeenCalledTimes(2)
    expect(state.before.value).toEqual({
      detail: null,
      loading: false,
      error: "保存记录暂不可用",
    })
  })

  it("轮询在清空后不读取旧目标", async () => {
    const getTurn = vi
      .spyOn(evaluationApi, "getTurn")
      .mockResolvedValueOnce(detailFixture("turn-before"))
    const { state } = setup()
    await state.load(beforeTarget, null)
    state.clear()
    await state.syncRuns([
      runFixture({
        id: "run-before",
        turns: [detailFixture("turn-before", { status: "failed" }).turn],
      }),
    ])
    expect(getTurn).toHaveBeenCalledTimes(1)
    expect(state.before.value).toEqual(emptyState)
    expect(state.after.value).toEqual(emptyState)
  })
})
