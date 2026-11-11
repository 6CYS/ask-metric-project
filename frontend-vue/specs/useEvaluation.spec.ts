import { afterEach, describe, expect, it, vi } from "vitest"
import { effectScope } from "vue"
import { evaluationApi } from "../src/lib/evaluationApi"
import { useEvaluation } from "../src/composables/useEvaluation"
import type { EvaluationRun, EvaluationTurnDetail, EvaluationTurn } from "../src/types/evaluation"
import { runFixture } from "./evaluationFixtures"

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const baseApi = () => ({
  ...evaluationApi,
  listDatasets: () => Promise.resolve([]),
  listRuns: () => Promise.resolve([]),
})
afterEach(() => vi.useRealTimers())

describe("测评页面请求生命周期", () => {
  it.each([false, true])(
    "删除回执丢失后刷新失败=%s，不再展示旧的完整结果",
    async (refreshFails) => {
      const run = runFixture()
      let attempted = false
      const api = {
        ...baseApi(),
        listRuns: () =>
          attempted
            ? refreshFails
              ? Promise.reject(new Error("刷新失败"))
              : Promise.resolve([])
            : Promise.resolve([run]),
        getRun: () => Promise.resolve(run),
        getTurn: () =>
          Promise.resolve({
            turn: run.turns[0]!,
            messages: [{ role: "assistant", text: "原正文", timestamp: null }],
          }),
        deleteRun: () => {
          attempted = true
          return Promise.reject(new Error("删除回执未收到"))
        },
      }
      const scope = effectScope()
      const state = scope.run(() => useEvaluation(api))!
      try {
        await state.activate()
        await state.selectRun(run.id)
        await state.selectTurn(run.id, "turn-a")
        expect(await state.deleteRun(run)).toBe(false)
        expect(state.detail.value).toBeNull()
        expect(state.actionError.value).toBe("删除回执未收到")
        if (refreshFails) {
          expect(state.selectedRun.value?.status).toBe("deleting")
          expect(state.runs.value[0]?.status).toBe("deleting")
        } else {
          expect(state.selectedRun.value).toBeNull()
          expect(state.selectedRunId.value).toBe("")
          expect(state.runs.value).toEqual([])
        }
      } finally {
        scope.stop()
      }
    },
  )
  it("删除题集后更新列表，历史批次仍可查看", async () => {
    const run = runFixture()
    const api = {
      ...baseApi(),
      listDatasets: () => Promise.resolve([run.dataset]),
      listRuns: () => Promise.resolve([run]),
      deleteDataset: () => Promise.resolve(),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      expect(await state.deleteDataset(run.dataset)).toBe(true)
      expect(state.datasets.value).toEqual([])
      expect(state.runs.value).toEqual([run])
    } finally {
      scope.stop()
    }
  })

  it("删除所选批次清除详情，迟到的列表、批次和正文都不能恢复已删内容", async () => {
    const run = runFixture()
    const lateList = deferred<EvaluationRun[]>()
    const lateRun = deferred<EvaluationRun>()
    const lateDetail = deferred<EvaluationTurnDetail>()
    let lists = 0
    const api = {
      ...baseApi(),
      listRuns: () => (++lists === 1 ? Promise.resolve([run]) : lateList.promise),
      getRun: () => lateRun.promise,
      getTurn: () => lateDetail.promise,
      deleteRun: () => Promise.resolve(),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      const readingRun = state.selectRun(run.id)
      const readingDetail = state.selectTurn(run.id, "turn-a")
      const refreshing = state.refresh()
      expect(await state.deleteRun(run)).toBe(true)
      lateList.resolve([run])
      lateRun.resolve(run)
      lateDetail.resolve({ turn: run.turns[0]!, messages: [] })
      await Promise.all([readingRun, readingDetail, refreshing])
      expect(state.runs.value).toEqual([])
      expect(state.selectedRunId.value).toBe("")
      expect(state.selectedRun.value).toBeNull()
      expect(state.detail.value).toBeNull()
    } finally {
      scope.stop()
    }
  })

  it("删除失败保留批次并刷新服务端状态，不把部分清理当作删除成功", async () => {
    const run = runFixture()
    const deleting = runFixture({ status: "deleting" })
    let current = run
    const api = {
      ...baseApi(),
      listRuns: () => Promise.resolve([current]),
      getRun: () => Promise.resolve(current),
      deleteRun: () => {
        current = deleting
        return Promise.reject(new Error("会话清理未完成"))
      },
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      await state.selectRun(run.id)
      expect(await state.deleteRun(run)).toBe(false)
      expect(state.runs.value[0]?.status).toBe("deleting")
      expect(state.selectedRun.value?.status).toBe("deleting")
      expect(state.actionError.value).toBe("会话清理未完成")
    } finally {
      scope.stop()
    }
  })

  it("快速切换批次时，较早请求晚到不能覆盖新批次", async () => {
    const earlier = deferred<EvaluationRun>()
    const api = {
      ...baseApi(),
      getRun: (id: string) =>
        id === "a" ? earlier.promise : Promise.resolve(runFixture({ id: "b" })),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    const first = state.selectRun("a")
    await state.selectRun("b")
    earlier.resolve(runFixture({ id: "a" }))
    await first
    expect(state.selectedRun.value?.id).toBe("b")
    scope.stop()
  })
  it("快速切换轮次时立即清除旧正文，旧结果不能覆盖当前详情", async () => {
    const earlier = deferred<EvaluationTurnDetail>()
    const run = runFixture()
    const current = {
      turn: { ...run.turns[0]!, id: "b" },
      messages: [{ role: "assistant", text: "当前答案", timestamp: null }],
    }
    const api = {
      ...baseApi(),
      getTurn: (_run: string, id: string) =>
        id === "a" ? earlier.promise : Promise.resolve(current),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    const first = state.selectTurn("run-a", "a")
    await state.selectTurn("run-a", "b")
    earlier.resolve({ turn: run.turns[0]!, messages: [] })
    await first
    expect(state.detail.value?.turn.id).toBe("b")
    scope.stop()
  })
  it("终态列表先到时重新读取所选详情，迟到的执行中响应不能覆盖最终正文", async () => {
    vi.useFakeTimers()
    const completed = runFixture()
    const running = runFixture({
      status: "running",
      turns: [{ ...completed.turns[0]!, status: "running" }],
    })
    const earlier = deferred<EvaluationTurnDetail>()
    let latest = running
    let reads = 0
    const finalDetail = {
      turn: completed.turns[0]!,
      messages: [{ role: "assistant", text: "正式最终正文", timestamp: null }],
    }
    const api = {
      ...baseApi(),
      listRuns: () => {
        reads += 1
        return Promise.resolve([latest])
      },
      getRun: () => Promise.resolve(running),
      getTurn: vi
        .fn()
        .mockImplementationOnce(() => earlier.promise)
        .mockResolvedValue(finalDetail),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      await state.selectRun(running.id)
      const first = state.selectTurn(running.id, "turn-a")
      latest = completed
      await state.refresh(true)
      earlier.resolve({ turn: running.turns[0]!, messages: [] })
      await first
      expect(state.selectedRun.value?.status).toBe("completed")
      expect(state.detail.value).toEqual(finalDetail)
      expect(state.detailLoading.value).toBe(false)
      expect(state.activeRun.value).toBeNull()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reads).toBe(2)
    } finally {
      scope.stop()
    }
  })
  it("批次读取未完成时也接纳终态列表，迟到的批次响应不能恢复执行中状态", async () => {
    const completed = runFixture()
    const running = runFixture({
      status: "running",
      turns: [{ ...completed.turns[0]!, status: "running" }],
    })
    const earlier = deferred<EvaluationRun>()
    let latest = running
    const api = {
      ...baseApi(),
      listRuns: () => Promise.resolve([latest]),
      getRun: () => earlier.promise,
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      const first = state.selectRun(running.id)
      latest = completed
      await state.refresh(true)
      earlier.resolve(running)
      await first
      expect(state.selectedRun.value?.status).toBe("completed")
      expect(state.selectedRun.value?.turns[0]?.status).toBe("completed")
      expect(state.runLoading.value).toBe(false)
      expect(state.runError.value).toBe("")
    } finally {
      scope.stop()
    }
  })
  it("取消确认直接返回终态时同步刷新所选详情，不依赖已停止的轮询", async () => {
    const cancelling = runFixture({ status: "cancelling" })
    cancelling.turns[0]!.status = "failed"
    const stopped = runFixture({ status: "cancelled" })
    stopped.turns[0]!.status = "cancelled"
    const api = {
      ...baseApi(),
      listRuns: () => Promise.resolve([cancelling]),
      getRun: () => Promise.resolve(cancelling),
      getTurn: vi
        .fn()
        .mockResolvedValueOnce({ turn: cancelling.turns[0]!, messages: [] })
        .mockResolvedValue({ turn: stopped.turns[0]!, messages: [] }),
      cancelRun: () => Promise.resolve(stopped),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      await state.selectRun(cancelling.id)
      await state.selectTurn(cancelling.id, "turn-a")
      await state.cancelRun(cancelling)
      expect(state.selectedRun.value?.status).toBe("cancelled")
      expect(state.detail.value?.turn.status).toBe("cancelled")
      expect(state.activeRun.value).toBeNull()
    } finally {
      scope.stop()
    }
  })
  it("执行中继续轮询，终态详情读取失败后保留错误并允许手动重试", async () => {
    vi.useFakeTimers()
    const completed = runFixture()
    const running = runFixture({
      status: "running",
      turns: [{ ...completed.turns[0]!, status: "running" }],
    })
    let latest = running
    let reads = 0
    const api = {
      ...baseApi(),
      listRuns: () => {
        reads += 1
        return Promise.resolve([latest])
      },
      getRun: () => Promise.resolve(running),
      getTurn: vi
        .fn()
        .mockResolvedValueOnce({ turn: running.turns[0]!, messages: [] })
        .mockRejectedValueOnce(new Error("正式会话暂时不可用"))
        .mockResolvedValue({ turn: completed.turns[0]!, messages: [] }),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      await state.selectRun(running.id)
      await state.selectTurn(running.id, "turn-a")
      await vi.advanceTimersByTimeAsync(2_000)
      expect(reads).toBe(2)
      expect(state.detail.value?.turn.status).toBe("running")
      latest = completed
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state.selectedRun.value?.status).toBe("completed")
      expect(state.detail.value).toBeNull()
      expect(state.detailError.value).toBe("正式会话暂时不可用")
      expect(state.detailLoading.value).toBe(false)
      await state.selectTurn(completed.id, "turn-a")
      expect(state.detail.value?.turn.status).toBe("completed")
      expect(state.detailError.value).toBe("")
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reads).toBe(3)
    } finally {
      scope.stop()
    }
  })
  it("终态详情重新读取期间离开页面，迟到结果不能恢复上一账号的数据", async () => {
    const completed = runFixture()
    const running = runFixture({
      status: "running",
      turns: [{ ...completed.turns[0]!, status: "running" }],
    })
    const finalRequest = deferred<void>()
    const finalDetail = deferred<EvaluationTurnDetail>()
    let latest = running
    const api = {
      ...baseApi(),
      listRuns: () => Promise.resolve([latest]),
      getRun: () => Promise.resolve(running),
      getTurn: vi
        .fn()
        .mockResolvedValueOnce({ turn: running.turns[0]!, messages: [] })
        .mockImplementation(() => {
          finalRequest.resolve()
          return finalDetail.promise
        }),
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    try {
      await state.activate()
      await state.selectRun(running.id)
      await state.selectTurn(running.id, "turn-a")
      latest = completed
      const refreshing = state.refresh(true)
      await finalRequest.promise
      state.deactivate()
      finalDetail.resolve({ turn: completed.turns[0]!, messages: [] })
      await refreshing
      expect(state.runs.value).toEqual([])
      expect(state.selectedRun.value).toBeNull()
      expect(state.detail.value).toBeNull()
      expect(state.selectedTurnId.value).toBe("")
      expect(state.detailError.value).toBe("")
      expect(state.detailLoading.value).toBe(false)
    } finally {
      scope.stop()
    }
  })
  it("离开缓存页面后停止轮询，返回只刷新不重新执行", async () => {
    vi.useFakeTimers()
    let reads = 0
    const run = runFixture({ status: "running" })
    const api = {
      ...baseApi(),
      listRuns: () => {
        reads += 1
        return Promise.resolve([run])
      },
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    await state.activate()
    expect(reads).toBe(1)
    state.deactivate()
    expect(state.runs.value).toEqual([])
    expect(state.selectedRun.value).toBeNull()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads).toBe(1)
    await state.activate()
    expect(reads).toBe(2)
    scope.stop()
  })
  it("保存A批次复核期间切换B，A列表和比较数据仍更新，B保持选中", async () => {
    const a = runFixture()
    const b = runFixture({ id: "run-b" })
    const pending = deferred<EvaluationTurn>()
    const api = {
      ...baseApi(),
      listRuns: () => Promise.resolve([a, b]),
      getRun: (id: string) => Promise.resolve(id === a.id ? a : b),
      reviewTurn: () => pending.promise,
    }
    const scope = effectScope()
    const state = scope.run(() => useEvaluation(api))!
    await state.activate()
    await state.selectRun(a.id)
    const saving = state.saveReview(a.id, "turn-a", { verdict: "passed", note: "已核对" })
    await state.selectRun(b.id)
    pending.resolve({
      ...a.turns[0]!,
      review: {
        verdict: "passed",
        note: "已核对",
        updated_at: "2026-11-02T01:00:00Z",
        reviewer: "测试复核人",
      },
    })
    await saving
    expect(state.runs.value.find((run) => run.id === a.id)?.turns[0]?.review?.verdict).toBe(
      "passed",
    )
    expect(state.selectedRun.value?.id).toBe(b.id)
    expect(state.selectedRun.value?.turns[0]?.review).toBeNull()
    scope.stop()
  })
})
