import { onScopeDispose, ref, shallowRef, watch } from "vue"

import type { QuerySqlDetail, QuerySqlReference } from "@/types/querySql"

type DetailLoader = (
  reference: QuerySqlReference,
  offset: number,
  limit: number,
  signal: AbortSignal,
) => Promise<QuerySqlDetail>

/** 只读取保存的执行记录；查询切换与关窗由同一请求生命周期管理。 */
export function useQuerySqlDetail(
  isOpen: () => boolean,
  selectedReference: () => QuerySqlReference | undefined,
  loader: DetailLoader,
) {
  const detail = shallowRef<QuerySqlDetail | null>(null)
  const error = shallowRef<unknown>(null)
  const loading = ref(false)
  let controller: AbortController | undefined
  let currentOffset = 0
  let loadedReference: QuerySqlReference | undefined

  function clear() {
    controller?.abort()
    detail.value = null
    error.value = null
    loading.value = false
  }

  async function loadPage(offset = 0) {
    const reference = loadedReference ?? selectedReference()
    if (!isOpen() || !reference) return
    controller?.abort()
    const request = new AbortController()
    controller = request
    currentOffset = offset
    detail.value = null
    error.value = null
    loading.value = true
    try {
      const response = await loader(reference, offset, 20, request.signal)
      // 即使传输层未及时取消，也不能让离开的查询写回当前抽屉。
      if (request.signal.aborted) return
      detail.value = response
      loadedReference = {
        task_id: response.task_id,
        run_id: response.run_id,
        ...(response.result_id ? { result_id: response.result_id } : {}),
      }
    } catch (reason) {
      if (!request.signal.aborted) error.value = reason
    } finally {
      if (!request.signal.aborted) loading.value = false
    }
  }

  watch(
    [
      isOpen,
      () => selectedReference()?.task_id,
      () => selectedReference()?.run_id,
      () => selectedReference()?.result_id,
    ],
    async () => {
      clear()
      currentOffset = 0
      loadedReference = undefined
      if (isOpen()) await loadPage()
    },
    { immediate: true, flush: "sync" },
  )
  onScopeDispose(clear)

  return { detail, error, loading, loadPage, reload: () => loadPage(currentOffset) }
}
