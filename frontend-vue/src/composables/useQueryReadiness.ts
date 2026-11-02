import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue"
import { getBackendNextQueryReadiness } from "@/lib/api"
import type { QueryReadiness } from "@/types/api"

export function useQueryReadiness() {
  // ref 保存可响应的状态；computed 根据状态自动计算是否允许提问。
  const state = ref<QueryReadiness>({ status: "initializing", message: "正在检查问数系统初始化状态…", completed: 0, total: 0 })
  const ready = computed(() => state.value.status === "ready")
  let active = false
  // 每次启停递增代号，旧请求即使晚到，也不能覆盖重新进入页面后的新状态。
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
      // 箭头函数是定时器稍后调用的回调；void 表示这里不使用返回的 Promise。
      // 请求结束后再安排下一次，避免慢请求叠加；失败由 refresh 自己捕获并展示。
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
  // 普通挂载/卸载和 KeepAlive 激活/停用都要处理，离开页面时释放定时器和请求。
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onBeforeUnmount(stop)
  return { state, ready }
}
