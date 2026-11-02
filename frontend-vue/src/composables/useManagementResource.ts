import { computed, ref } from "vue"

/**
 * 管理列表的公共异步状态。
 * 刷新失败时保留上次成功数据；变更操作成功后重新读取服务端，保证软删除和默认记录等规则以服务端为准。
 */
export function useManagementResource<T>(loader: () => Promise<{ items: T[] }>) {
  const items = ref<T[]>([])
  const hasLoaded = ref(false)
  const isLoading = ref(true)
  const isRefreshing = ref(false)
  const isMutating = ref(false)
  const loadError = ref("")
  const mutationError = ref("")

  const isBlockingError = computed(() => Boolean(loadError.value) && !hasLoaded.value)
  const isRefreshError = computed(() => Boolean(loadError.value) && hasLoaded.value)

  async function load(refresh = false) {
    if (refresh) isRefreshing.value = true
    else isLoading.value = true
    loadError.value = ""
    try {
      items.value = (await loader()).items
      hasLoaded.value = true
      return true
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : "请求失败，请稍后重试。"
      return false
    } finally {
      isLoading.value = false
      isRefreshing.value = false
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    if (isMutating.value) return false
    isMutating.value = true
    mutationError.value = ""
    try {
      await action()
      await load(true)
      return true
    } catch (error) {
      mutationError.value = error instanceof Error ? error.message : "请求失败，请稍后重试。"
      return false
    } finally {
      isMutating.value = false
    }
  }

  function clearMutationError() {
    mutationError.value = ""
  }

  return { items, isLoading, isRefreshing, isMutating, loadError, mutationError, isBlockingError, isRefreshError, load, mutate, clearMutationError }
}
