import { effectScope, ref } from "vue"
import { describe, expect, it, vi } from "vitest"

import { useQuerySqlDetail } from "../src/composables/useQuerySqlDetail"
import type { QuerySqlDetail, QuerySqlReference } from "../src/types/querySql"

function detail(taskId: string, runId = 1): QuerySqlDetail {
  return {
    task_id: taskId,
    run_id: runId,
    result_id: null,
    status: "SUCCEEDED",
    sql_text: "SELECT value FROM metrics",
    sql_params: {},
    sql_availability: "available",
    row_count: 0,
    latency_ms: 8,
    conditions: { orgs: [], metrics: [], time: {} },
    result: {
      columns: ["value"],
      rows: [],
      row_count: 0,
      truncated: false,
      offset: 0,
      limit: 20,
      next_offset: null,
      has_more: false,
    },
    result_unavailable_reason: null,
    notice: null,
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

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function setup(loader: Parameters<typeof useQuerySqlDetail>[2], initialOpen = true) {
  const open = ref(initialOpen)
  const reference = ref<QuerySqlReference>({ task_id: "first" })
  const scope = effectScope()
  const resource = scope.run(() =>
    useQuerySqlDetail(
      () => open.value,
      () => reference.value,
      loader,
    ),
  )
  if (!resource) throw new Error("无法创建查询状态")
  return { open, reference, scope, resource }
}

describe("执行 SQL 只读加载", () => {
  it("关闭时不读取，打开后只读取当前查询", async () => {
    const loader = vi.fn(() => Promise.resolve(detail("first")))
    const state = setup(loader, false)
    expect(loader).not.toHaveBeenCalled()
    state.open.value = true
    await settle()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(state.resource.detail.value?.task_id).toBe("first")
    state.scope.stop()
  })

  it("切换查询后旧响应晚到不能覆盖新查询或提前结束加载", async () => {
    const previous = deferred<QuerySqlDetail>()
    const current = deferred<QuerySqlDetail>()
    const loader = vi
      .fn<Parameters<typeof useQuerySqlDetail>[2]>()
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise)
    const state = setup(loader)
    state.reference.value = { task_id: "second" }
    expect(loader.mock.calls[0]?.[3]?.aborted).toBe(true)
    previous.resolve(detail("first"))
    await settle()
    expect(state.resource.detail.value).toBeNull()
    expect(state.resource.loading.value).toBe(true)
    current.resolve(detail("second"))
    await settle()
    expect(state.resource.detail.value?.task_id).toBe("second")
    expect(state.resource.loading.value).toBe(false)
    state.scope.stop()
  })

  it("关闭与卸载中止请求，迟到的成功或失败不恢复内容", async () => {
    const previous = deferred<QuerySqlDetail>()
    const current = deferred<QuerySqlDetail>()
    const loader = vi
      .fn<Parameters<typeof useQuerySqlDetail>[2]>()
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise)
    const state = setup(loader)
    state.open.value = false
    expect(loader.mock.calls[0]?.[3]?.aborted).toBe(true)
    previous.resolve(detail("first"))
    await settle()
    expect(state.resource.detail.value).toBeNull()
    state.open.value = true
    state.scope.stop()
    expect(loader.mock.calls[1]?.[3]?.aborted).toBe(true)
    current.reject(new Error("旧请求超时"))
    await settle()
    expect(state.resource.error.value).toBeNull()
    expect(state.resource.loading.value).toBe(false)
  })

  it("旧请求失败不污染新结果，单次重试仍只读取当前查询", async () => {
    const previous = deferred<QuerySqlDetail>()
    const loader = vi
      .fn<Parameters<typeof useQuerySqlDetail>[2]>()
      .mockReturnValueOnce(previous.promise)
      .mockRejectedValueOnce(new Error("暂时无法读取"))
      .mockResolvedValueOnce(detail("second"))
    const state = setup(loader)
    state.reference.value = { task_id: "second" }
    await settle()
    expect(state.resource.error.value).toBeInstanceOf(Error)
    await state.resource.reload()
    previous.reject(new Error("旧查询失败"))
    await settle()
    expect(state.resource.error.value).toBeNull()
    expect(state.resource.detail.value?.task_id).toBe("second")
    expect(loader).toHaveBeenCalledTimes(3)
    state.scope.stop()
  })

  it("结果翻页固定已加载的执行，不重新指向任务的最新执行", async () => {
    const first = detail("first", 17)
    first.result_id = "saved-result"
    const loader = vi
      .fn<Parameters<typeof useQuerySqlDetail>[2]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...first, result: null })
    const state = setup(loader)
    await settle()
    await state.resource.loadPage(20)
    expect(loader.mock.calls[1]?.slice(0, 3)).toEqual([
      { task_id: "first", run_id: 17, result_id: "saved-result" },
      20,
      20,
    ])
    state.scope.stop()
  })
})
