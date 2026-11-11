import { computed, onScopeDispose, ref, shallowRef } from "vue"
import { evaluationApi, type EvaluationApi } from "../lib/evaluationApi"
import { isActiveRun } from "../lib/evaluation"
import type {
  DatasetInput,
  EvaluationDataset,
  EvaluationReview,
  EvaluationRun,
  EvaluationTurnDetail,
  RunInput,
} from "../types/evaluation"

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。"
}
function cancelled(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

export function useEvaluation(api: EvaluationApi = evaluationApi) {
  const datasets = shallowRef<EvaluationDataset[]>([])
  const runs = shallowRef<EvaluationRun[]>([])
  const selectedRun = shallowRef<EvaluationRun | null>(null)
  const detail = shallowRef<EvaluationTurnDetail | null>(null)
  const selectedRunId = ref("")
  const selectedTurnId = ref("")
  const loading = ref(false)
  const runLoading = ref(false)
  const detailLoading = ref(false)
  const busy = ref(false)
  const hasLoaded = ref(false)
  const loadError = ref("")
  const runError = ref("")
  const detailError = ref("")
  const actionError = ref("")
  const activeRun = computed(() => runs.value.find((run) => isActiveRun(run)) ?? null)
  let active = false
  let lifecycleSequence = 0
  let listSequence = 0
  let runSequence = 0
  let detailSequence = 0
  let listRequest: AbortController | null = null
  let runRequest: AbortController | null = null
  let detailRequest: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function stopPolling() {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  function schedulePolling() {
    stopPolling()
    if (!active || busy.value || !runs.value.some((run) => isActiveRun(run))) return
    timer = setTimeout(() => {
      refresh(true).catch((error) => {
        loadError.value = message(error)
      })
    }, 2_000)
  }
  async function updateSelectedRun(run: EvaluationRun) {
    if (selectedRunId.value !== run.id) return
    const previousTurn =
      detail.value?.turn ??
      selectedRun.value?.turns.find((turn) => turn.id === selectedTurnId.value)
    // 完整批次来自列表或操作回执；采纳后使先前的单批次请求失效。
    ++runSequence
    runRequest?.abort()
    runLoading.value = false
    runError.value = ""
    selectedRun.value = run
    if (run.status === "deleting") {
      clearDetail()
      return
    }
    const nextTurn = run.turns.find((turn) => turn.id === selectedTurnId.value)
    if (previousTurn && nextTurn && previousTurn.status !== nextTurn.status)
      await selectTurn(run.id, nextTurn.id)
  }
  async function updateRun(run: EvaluationRun) {
    runs.value = [run, ...runs.value.filter((item) => item.id !== run.id)].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )
    await updateSelectedRun(run)
    schedulePolling()
  }
  async function refresh(background = false) {
    const sequence = ++listSequence
    listRequest?.abort()
    const request = new AbortController()
    listRequest = request
    if (!background) loading.value = true
    loadError.value = ""
    try {
      const [loadedDatasets, loadedRuns] = await Promise.all([
        api.listDatasets(request.signal),
        api.listRuns(request.signal),
      ])
      if (sequence !== listSequence) return
      datasets.value = loadedDatasets
      runs.value = loadedRuns
      hasLoaded.value = true
      const updated = loadedRuns.find((run) => run.id === selectedRunId.value)
      if (updated) await updateSelectedRun(updated)
      else if (selectedRunId.value) await selectRun("")
    } catch (error) {
      if (sequence === listSequence && !cancelled(error)) loadError.value = message(error)
    } finally {
      if (sequence === listSequence) {
        loading.value = false
        schedulePolling()
      }
    }
  }
  async function selectRun(id: string) {
    const sequence = ++runSequence
    runRequest?.abort()
    clearDetail()
    selectedRunId.value = id
    selectedRun.value = null
    runError.value = ""
    if (!id) {
      runLoading.value = false
      return
    }
    const request = new AbortController()
    runRequest = request
    runLoading.value = true
    try {
      const run = await api.getRun(id, request.signal)
      if (sequence === runSequence) selectedRun.value = run
    } catch (error) {
      if (sequence === runSequence && !cancelled(error)) runError.value = message(error)
    } finally {
      if (sequence === runSequence) runLoading.value = false
    }
  }
  function clearDetail() {
    ++detailSequence
    detailRequest?.abort()
    detail.value = null
    selectedTurnId.value = ""
    detailError.value = ""
    detailLoading.value = false
  }
  async function selectTurn(runId: string, turnId: string) {
    const sequence = ++detailSequence
    detailRequest?.abort()
    const request = new AbortController()
    detailRequest = request
    selectedTurnId.value = turnId
    detail.value = null
    detailError.value = ""
    detailLoading.value = true
    try {
      const loaded = await api.getTurn(runId, turnId, request.signal)
      if (sequence === detailSequence) detail.value = loaded
    } catch (error) {
      if (sequence === detailSequence && !cancelled(error)) detailError.value = message(error)
    } finally {
      if (sequence === detailSequence) detailLoading.value = false
    }
  }
  async function mutate<T>(operation: () => Promise<T>): Promise<T | null> {
    if (busy.value) return null
    busy.value = true
    stopPolling()
    const lifecycle = lifecycleSequence
    actionError.value = ""
    // 保存后的可靠状态不允许被保存前发出的列表请求覆盖。
    ++listSequence
    listRequest?.abort()
    loading.value = false
    try {
      const result = await operation()
      return lifecycle === lifecycleSequence ? result : null
    } catch (error) {
      if (lifecycle === lifecycleSequence) actionError.value = message(error)
      return null
    } finally {
      if (lifecycle === lifecycleSequence) {
        busy.value = false
        schedulePolling()
      }
    }
  }
  async function saveDataset(input: DatasetInput, existing?: EvaluationDataset) {
    const saved = await mutate(() => api.saveDataset(input, existing))
    if (saved) datasets.value = [saved, ...datasets.value.filter((item) => item.id !== saved.id)]
    return saved
  }
  async function createRun(input: RunInput) {
    const created = await mutate(() => api.createRun(input))
    if (created) {
      ++runSequence
      runRequest?.abort()
      clearDetail()
      selectedRunId.value = created.id
      selectedRun.value = created
      runLoading.value = false
      await updateRun(created)
    }
    return created
  }
  async function deleteDataset(dataset: EvaluationDataset) {
    const deleted = await mutate(async () => {
      await api.deleteDataset(dataset)
      return true
    })
    if (deleted) datasets.value = datasets.value.filter((item) => item.id !== dataset.id)
    return deleted === true
  }
  async function deleteRun(run: EvaluationRun) {
    if (busy.value) return false
    const lifecycle = lifecycleSequence
    const deleted = await mutate(async () => {
      // 删除请求可能已生效但回执丢失；确认前使旧依据失效，刷新后以服务端状态为准。
      await updateRun({ ...run, status: "deleting" })
      await api.deleteRun(run.id)
      return true
    })
    if (deleted) {
      runs.value = runs.value.filter((item) => item.id !== run.id)
      if (selectedRunId.value === run.id) await selectRun("")
    } else if (active && lifecycle === lifecycleSequence) {
      // 清理可能已部分完成，重新读取删除状态，不能继续展示缓存的完整结果。
      await refresh(true)
    }
    return deleted === true
  }
  async function cancelRun(run: EvaluationRun) {
    const stopped = await mutate(() => api.cancelRun(run.id))
    if (stopped) await updateRun(stopped)
    return stopped
  }
  async function saveReview(
    runId: string,
    turnId: string,
    review: Pick<EvaluationReview, "verdict" | "note">,
  ) {
    const reviewed = await mutate(() => api.reviewTurn(runId, turnId, review))
    if (reviewed) {
      const run =
        runs.value.find((item) => item.id === runId) ??
        (selectedRun.value?.id === runId ? selectedRun.value : null)
      if (run)
        await updateRun({
          ...run,
          turns: run.turns.map((turn) => (turn.id === turnId ? reviewed : turn)),
        })
      if (detail.value?.turn.id === turnId && selectedRunId.value === runId)
        detail.value = { ...detail.value, turn: reviewed }
    }
    return reviewed
  }
  async function activate() {
    active = true
    await refresh()
  }
  function deactivate() {
    active = false
    ++lifecycleSequence
    stopPolling()
    ++listSequence
    ++runSequence
    ++detailSequence
    listRequest?.abort()
    runRequest?.abort()
    detailRequest?.abort()
    loading.value = false
    runLoading.value = false
    detailLoading.value = false
    busy.value = false
    // KeepAlive 可能跨登录账号复用页面，离开后不保留授权结果或待提交状态。
    datasets.value = []
    runs.value = []
    selectedRun.value = null
    detail.value = null
    selectedRunId.value = ""
    selectedTurnId.value = ""
    hasLoaded.value = false
    loadError.value = ""
    runError.value = ""
    detailError.value = ""
    actionError.value = ""
  }
  onScopeDispose(deactivate)
  return {
    datasets,
    runs,
    selectedRun,
    detail,
    selectedRunId,
    selectedTurnId,
    loading,
    runLoading,
    detailLoading,
    busy,
    hasLoaded,
    loadError,
    runError,
    detailError,
    actionError,
    activeRun,
    refresh,
    selectRun,
    selectTurn,
    clearDetail,
    saveDataset,
    deleteDataset,
    deleteRun,
    createRun,
    cancelRun,
    saveReview,
    activate,
    deactivate,
  }
}
