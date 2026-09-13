import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue"
import { getBackendNextQueryReadiness } from "@/lib/api"
import type { QueryReadiness } from "@/types/api"

export function useQueryReadiness() {
  const state = ref<QueryReadiness>({ status: "initializing", message: "正在检查问数系统初始化状态…", completed: 0, total: 0 })
  const ready = computed(() => state.value.status === "ready")
  let active = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  async function refresh(current: number) {
    const request = new AbortController()
    controller = request
    const timeout = setTimeout(() => request.abort(), 10000)
    try {
      const result = await getBackendNextQueryReadiness(request.signal)
      if (!["initializing", "ready", "failed"].includes(result.status)) throw new Error("Invalid readiness status")
      if (active && current === generation) state.value = result
    } catch {
      if (active && current === generation) state.value = {
        status: "failed", message: "暂时无法确认问数系统状态，正在重新连接，请稍后提问。", completed: 0, total: 0,
      }
    } finally {
      clearTimeout(timeout)
      if (controller === request) controller = undefined
      if (active && current === generation) timer = setTimeout(() => void refresh(current), ready.value ? 10000 : 2000)
    }
  }

  function start() {
    if (active) return
    active = true
    state.value = { status: "initializing", message: "正在检查问数系统初始化状态…", completed: 0, total: 0 }
    void refresh(++generation)
  }
  function stop() {
    active = false
    generation += 1
    clearTimeout(timer)
    controller?.abort()
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onBeforeUnmount(stop)
  return { state, ready }
}
