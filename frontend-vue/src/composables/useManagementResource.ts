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
  let loadSequence = 0

  const isBlockingError = computed(() => Boolean(loadError.value) && !hasLoaded.value)
  const isRefreshError = computed(() => Boolean(loadError.value) && hasLoaded.value)

  async function load(refresh = false) {
    const sequence = ++loadSequence
    if (refresh) isRefreshing.value = true
    else isLoading.value = true
    loadError.value = ""
    try {
      const result = await loader()
      // 手动刷新与保存后刷新可能交叠，只有最近请求更新展示状态。
      if (sequence === loadSequence) {
        items.value = result.items
        hasLoaded.value = true
      }
      return true
    } catch (error) {
      if (sequence === loadSequence)
        loadError.value = error instanceof Error ? error.message : "请求失败，请稍后重试。"
      return false
    } finally {
      if (sequence === loadSequence) {
        isLoading.value = false
        isRefreshing.value = false
      }
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
