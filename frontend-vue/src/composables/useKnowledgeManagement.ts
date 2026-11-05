import { ref } from "vue"

import {
  ApiError,
  createBusinessKnowledge,
  listBusinessKnowledge,
  setBusinessKnowledgeEnabled,
  updateBusinessKnowledge,
} from "@/lib/api"
import { knowledgePayload, type BusinessKnowledgeForm } from "@/lib/businessKnowledge"
import type {
  BusinessKnowledgeItem,
  BusinessKnowledgeList,
  BusinessKnowledgePayload,
  BusinessKnowledgeWriteResult,
} from "@/types/api"

type KnowledgeApi = {
  list: () => Promise<BusinessKnowledgeList>
  create: (payload: BusinessKnowledgePayload) => Promise<BusinessKnowledgeWriteResult>
  update: (id: string, payload: BusinessKnowledgePayload) => Promise<BusinessKnowledgeWriteResult>
  setEnabled: (
    id: string,
    payload: { enabled: boolean; revision: string },
  ) => Promise<BusinessKnowledgeWriteResult>
}
type KnowledgeNotice = {
  item: BusinessKnowledgeItem
  action: "saved" | "enabled" | "disabled"
}
const defaultApi: KnowledgeApi = {
  list: listBusinessKnowledge,
  create: createBusinessKnowledge,
  update: updateBusinessKnowledge,
  setEnabled: setBusinessKnowledgeEnabled,
}
const emptyForm = (): BusinessKnowledgeForm => ({
  title: "",
  text: "",
  enabled: true,
  metric_codes: [],
})
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请稍后重试。"

export function useKnowledgeManagement(api: KnowledgeApi = defaultApi) {
  const items = ref<BusinessKnowledgeItem[]>([])
  const revision = ref("")
  const hasLoaded = ref(false)
  const isLoading = ref(true)
  const isRefreshing = ref(false)
  const isMutating = ref(false)
  const loadError = ref("")
  const actionError = ref("")
  const actionConflict = ref(false)
  const formError = ref("")
  const editorOpen = ref(false)
  const editorVersion = ref(0)
  const notice = ref<KnowledgeNotice | null>(null)
  const editingId = ref<string | null>(null)
  const form = ref<BusinessKnowledgeForm>(emptyForm())
  const hasConflict = ref(false)
  let formRevision = ""
  let loadSequence = 0

  async function load() {
    if (isMutating.value) return false
    const sequence = ++loadSequence
    isLoading.value = !hasLoaded.value
    isRefreshing.value = hasLoaded.value
    loadError.value = ""
    try {
      const result = await api.list()
      if (sequence !== loadSequence) return false
      items.value = result.items
      revision.value = result.revision
      hasLoaded.value = true
      actionError.value = ""
      actionConflict.value = false
      return true
    } catch (error) {
      if (sequence === loadSequence) loadError.value = errorMessage(error)
      return false
    } finally {
      if (sequence === loadSequence) {
        isLoading.value = false
        isRefreshing.value = false
      }
    }
  }

  function openEditor(
    item?: BusinessKnowledgeItem,
    metricCodes: string[] = [],
    kind: "knowledge" | "plan" = "knowledge",
  ) {
    if (!hasLoaded.value || isMutating.value) return
    editingId.value = item?.id ?? null
    form.value = item
      ? {
          title: item.title,
          text: item.text,
          enabled: item.enabled,
          metric_codes: [...(item.metric_codes ?? [])],
          ...(item.batch_query_enabled !== undefined
            ? { batch_query_enabled: item.batch_query_enabled }
            : {}),
        }
      : {
          ...emptyForm(),
          metric_codes: [...metricCodes],
          ...(kind === "plan" ? { batch_query_enabled: true } : {}),
        }
    // 编辑期间列表可以刷新，但不能用新版本静默覆盖他人的修改。
    formRevision = revision.value
    formError.value = ""
    hasConflict.value = false
    editorVersion.value += 1
    notice.value = null
    editorOpen.value = true
  }

  function beginMutation() {
    notice.value = null
    isMutating.value = true
    ++loadSequence
    isLoading.value = false
    isRefreshing.value = false
  }

  function applyWrite(result: BusinessKnowledgeWriteResult) {
    const index = items.value.findIndex((item) => item.id === result.item.id)
    if (index < 0) items.value = [...items.value, result.item]
    else items.value = items.value.map((item) => (item.id === result.item.id ? result.item : item))
    revision.value = result.revision
    loadError.value = ""
    actionError.value = ""
    actionConflict.value = false
  }

  async function save() {
    if (isMutating.value || hasConflict.value || !editorOpen.value) return false
    formError.value = ""
    let payload: BusinessKnowledgePayload
    try {
      payload = knowledgePayload(form.value, formRevision)
    } catch (error) {
      formError.value = errorMessage(error)
      return false
    }
    beginMutation()
    try {
      const result = editingId.value
        ? await api.update(editingId.value, payload)
        : await api.create(payload)
      applyWrite(result)
      notice.value = { item: result.item, action: "saved" }
      editorOpen.value = false
      return true
    } catch (error) {
      hasConflict.value = error instanceof ApiError && error.status === 409
      const name = form.value.batch_query_enabled ? "查询方案" : "业务知识"
      formError.value = hasConflict.value
        ? editingId.value
          ? `${name}已被其他人修改。本次输入已保留，请重新读取最新内容后再编辑。`
          : `${name}列表已被其他人修改。本次输入已保留，请重新读取版本后再保存。`
        : errorMessage(error)
      return false
    } finally {
      isMutating.value = false
    }
  }

  async function reloadEditor() {
    if (!(await load())) {
      formError.value = loadError.value || "重新读取失败，请稍后重试。"
      return false
    }
    if (!editingId.value) {
      // 新建草稿没有可重读的服务端正文，只更新写入版本，保留用户当前的关联选择。
      formRevision = revision.value
      formError.value = ""
      hasConflict.value = false
      return true
    }
    const item = items.value.find((item) => item.id === editingId.value)
    if (!item) {
      formError.value = `${form.value.batch_query_enabled ? "这个方案" : "这条知识"}已不存在，请关闭表单后重新选择。`
      return false
    }
    openEditor(item)
    return true
  }

  async function toggle(item: BusinessKnowledgeItem) {
    if (isMutating.value || !revision.value) return false
    const current = items.value.find((entry) => entry.id === item.id)
    if (!current) return false
    beginMutation()
    actionError.value = ""
    try {
      const result = await api.setEnabled(current.id, {
        enabled: !current.enabled,
        revision: revision.value,
      })
      applyWrite(result)
      notice.value = { item: result.item, action: result.item.enabled ? "enabled" : "disabled" }
      return true
    } catch (error) {
      actionError.value =
        error instanceof ApiError && error.status === 409
          ? `${current.batch_query_enabled ? "查询方案" : "业务知识"}已被其他人修改，请重新读取列表后再操作。`
          : errorMessage(error)
      return false
    } finally {
      isMutating.value = false
    }
  }

  async function linkMetric(id: string, metricCode: string) {
    if (!hasLoaded.value || !revision.value || isMutating.value || actionConflict.value)
      return false
    const current = items.value.find((entry) => entry.id === id)
    if (!current || !metricCode.trim()) {
      actionError.value = "内容或指标已不存在，请重新读取后选择。"
      return false
    }
    if (current.metric_codes?.includes(metricCode)) return true
    beginMutation()
    actionError.value = ""
    try {
      // 关联只追加当前指标，不重写正文，也不覆盖其他指标的关联。
      applyWrite(
        await api.update(id, {
          title: current.title,
          text: current.text,
          enabled: current.enabled,
          metric_codes: [...(current.metric_codes ?? []), metricCode],
          revision: revision.value,
        }),
      )
      return true
    } catch (error) {
      actionConflict.value = error instanceof ApiError && error.status === 409
      actionError.value = actionConflict.value
        ? `${current.batch_query_enabled ? "查询方案" : "业务知识"}已被其他人修改，请重新读取后再关联。之前成功的关联已保留。`
        : errorMessage(error)
      return false
    } finally {
      isMutating.value = false
    }
  }

  return {
    items,
    revision,
    hasLoaded,
    isLoading,
    isRefreshing,
    isMutating,
    loadError,
    actionError,
    actionConflict,
    formError,
    editorOpen,
    editorVersion,
    editingId,
    form,
    hasConflict,
    notice,
    load,
    save,
    reloadEditor,
    toggle,
    linkMetric,
    openCreate: (metricCodes: string[] = [], kind: "knowledge" | "plan" = "knowledge") =>
      openEditor(undefined, metricCodes, kind),
    openEdit: (item: BusinessKnowledgeItem) => openEditor(item),
  }
}
