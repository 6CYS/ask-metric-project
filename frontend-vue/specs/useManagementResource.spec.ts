import { describe, expect, it, vi } from "vitest"

import { useManagementResource } from "../src/composables/useManagementResource"

type Organization = { org_code: string; enabled: boolean }
type OrganizationList = { items: Organization[] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("管理列表请求顺序", () => {
  it("修改后刷新已取得新状态，较早的刷新晚到不能恢复旧状态", async () => {
    const previous = deferred<OrganizationList>()
    const current = deferred<OrganizationList>()
    const resource = useManagementResource(
      vi
        .fn<() => Promise<OrganizationList>>()
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise),
    )
    const refresh = resource.load(true)
    const mutation = resource.mutate(() => Promise.resolve())
    current.resolve({ items: [{ org_code: "bank", enabled: false }] })
    expect(await mutation).toBe(true)
    previous.resolve({ items: [{ org_code: "bank", enabled: true }] })
    expect(await refresh).toBe(true)
    expect(resource.items.value).toEqual([{ org_code: "bank", enabled: false }])
    expect(resource.isMutating.value).toBe(false)
  })

  it("较早请求失败不污染已成功的最新列表和错误提示", async () => {
    const previous = deferred<OrganizationList>()
    const current = deferred<OrganizationList>()
    const resource = useManagementResource(
      vi
        .fn<() => Promise<OrganizationList>>()
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise),
    )
    const first = resource.load()
    const latest = resource.load(true)
    current.resolve({ items: [{ org_code: "bank", enabled: false }] })
    expect(await latest).toBe(true)
    previous.reject(new Error("旧请求超时"))
    expect(await first).toBe(false)
    expect(resource.loadError.value).toBe("")
    expect(resource.isBlockingError.value).toBe(false)
    expect(resource.isRefreshError.value).toBe(false)
    expect(resource.items.value).toEqual([{ org_code: "bank", enabled: false }])
  })

  it("旧请求先结束不能关闭最新请求的加载状态", async () => {
    const previous = deferred<OrganizationList>()
    const current = deferred<OrganizationList>()
    const resource = useManagementResource(
      vi
        .fn<() => Promise<OrganizationList>>()
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise),
    )
    const first = resource.load()
    const latest = resource.load(true)
    previous.resolve({ items: [{ org_code: "bank", enabled: true }] })
    await first
    expect(resource.isLoading.value).toBe(true)
    expect(resource.isRefreshing.value).toBe(true)
    expect(resource.items.value).toEqual([])
    current.resolve({ items: [{ org_code: "bank", enabled: false }] })
    await latest
    expect(resource.isLoading.value).toBe(false)
    expect(resource.isRefreshing.value).toBe(false)
  })

  it("最新刷新失败保留上次可靠数据，旧请求不能清除错误或替换数据", async () => {
    const previous = deferred<OrganizationList>()
    const current = deferred<OrganizationList>()
    const resource = useManagementResource(
      vi
        .fn<() => Promise<OrganizationList>>()
        .mockResolvedValueOnce({ items: [{ org_code: "known", enabled: true }] })
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise),
    )
    await resource.load()
    const first = resource.load(true)
    const latest = resource.load(true)
    current.reject(new Error("本次刷新失败"))
    expect(await latest).toBe(false)
    previous.resolve({ items: [{ org_code: "stale", enabled: true }] })
    await first
    expect(resource.items.value).toEqual([{ org_code: "known", enabled: true }])
    expect(resource.loadError.value).toBe("本次刷新失败")
    expect(resource.isRefreshError.value).toBe(true)
    expect(resource.isRefreshing.value).toBe(false)
  })
})
