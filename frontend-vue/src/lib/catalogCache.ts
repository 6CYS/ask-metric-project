import type { MetricItem, OrgItem } from "@/types/api"

const TTL_MS = 5 * 60 * 1000

function createCatalogCache<T>() {
  let entry: { promise: Promise<T>; expiresAt: number } | undefined
  return {
    clear() { entry = undefined },
    read(load: () => Promise<T>): Promise<T> {
      if (entry && Date.now() < entry.expiresAt) return entry.promise
      const pending: { promise: Promise<T>; expiresAt: number } = {
        expiresAt: Infinity,
        promise: load().then((value) => {
          // 会话或目录失效后，旧请求不能重新填充缓存或返回旧目录。
          if (entry !== pending) throw new Error("登录状态或目录已变化，请重新打开目录。")
          pending.expiresAt = Date.now() + TTL_MS
          return value
        }).catch((error: unknown) => {
          if (entry === pending) entry = undefined
          throw error
        }),
      }
      entry = pending
      return pending.promise
    },
  }
}

// 只保存在当前页面内存中，不写入 Web Storage 或磁盘。
export const metricCatalogCache = createCatalogCache<{ items: MetricItem[] }>()
export const organizationCatalogCache = createCatalogCache<{ items: OrgItem[] }>()

export function clearCatalogCaches() {
  metricCatalogCache.clear()
  organizationCatalogCache.clear()
}
