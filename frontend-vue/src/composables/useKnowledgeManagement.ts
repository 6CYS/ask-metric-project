import { ref } from "vue"

import { ApiError, createBusinessKnowledge, listBusinessKnowledge, setBusinessKnowledgeEnabled, updateBusinessKnowledge } from "@/lib/api"
import { knowledgePayload, type BusinessKnowledgeForm } from "@/lib/businessKnowledge"
import type { BusinessKnowledgeItem, BusinessKnowledgeList, BusinessKnowledgePayload, BusinessKnowledgeWriteResult } from "@/types/api"

type KnowledgeApi = {
  list: () => Promise<BusinessKnowledgeList>
  create: (payload: BusinessKnowledgePayload) => Promise<BusinessKnowledgeWriteResult>
  update: (id: string, payload: BusinessKnowledgePayload) => Promise<BusinessKnowledgeWriteResult>
  setEnabled: (id: string, payload: { enabled: boolean; revision: string }) => Promise<BusinessKnowledgeWriteResult>
}
const defaultApi: KnowledgeApi = { list: listBusinessKnowledge, create: createBusinessKnowledge, update: updateBusinessKnowledge, setEnabled: setBusinessKnowledgeEnabled }
const emptyForm = (): BusinessKnowledgeForm => ({ title: "", text: "", enabled: true })
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。"

export function useKnowledgeManagement(api: KnowledgeApi = defaultApi) {
  const items = ref<BusinessKnowledgeItem[]>([])
  const revision = ref("")
  const hasLoaded = ref(false)
  const isLoading = ref(true)
  const isRefreshing = ref(false)
  const isMutating = ref(false)
  const loadError = ref("")
  const actionError = ref("")
  const formError = ref("")
  const editorOpen = ref(false)
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

  function openEditor(item?: BusinessKnowledgeItem) {
    if (!hasLoaded.value || isMutating.value) return
    editingId.value = item?.id ?? null
    form.value = item ? {
      title: item.title, text: item.text, enabled: item.enabled,
    } : emptyForm()
    // 编辑期间列表可以刷新，但不能用新版本静默覆盖他人的修改。
    formRevision = revision.value
    formError.value = ""
    hasConflict.value = false
    editorOpen.value = true
  }

  function beginMutation() {
    isMutating.value = true
    ++loadSequence
    isLoading.value = false
    isRefreshing.value = false
  }

  function applyWrite(result: BusinessKnowledgeWriteResult) {
    const index = items.value.findIndex(item => item.id === result.item.id)
    if (index < 0) items.value = [...items.value, result.item]
    else items.value = items.value.map(item => item.id === result.item.id ? result.item : item)
    revision.value = result.revision
    loadError.value = ""
    actionError.value = ""
  }

  async function save() {
    if (isMutating.value || hasConflict.value || !editorOpen.value) return false
    formError.value = ""
    let payload: BusinessKnowledgePayload
    try { payload = knowledgePayload(form.value, formRevision) } catch (error) {
      formError.value = errorMessage(error)
      return false
    }
    beginMutation()
    try {
      const result = editingId.value ? await api.update(editingId.value, payload) : await api.create(payload)
      applyWrite(result)
      editorOpen.value = false
      return true
    } catch (error) {
      hasConflict.value = error instanceof ApiError && error.status === 409
      formError.value = hasConflict.value ? "业务知识已被其他人修改。本次输入已保留，请重新读取最新内容后再编辑。" : errorMessage(error)
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
    const item = editingId.value ? items.value.find(item => item.id === editingId.value) : undefined
    if (editingId.value && !item) {
      formError.value = "这条知识已不存在，请关闭表单后重新选择。"
      return false
    }
    openEditor(item)
    return true
  }

  async function toggle(item: BusinessKnowledgeItem) {
    if (isMutating.value || !revision.value) return false
    const current = items.value.find(entry => entry.id === item.id)
    if (!current) return false
    beginMutation()
    actionError.value = ""
    try {
      applyWrite(await api.setEnabled(current.id, { enabled: !current.enabled, revision: revision.value }))
      return true
    } catch (error) {
      actionError.value = error instanceof ApiError && error.status === 409
        ? "业务知识已被其他人修改，请重新读取列表后再操作。" : errorMessage(error)
      return false
    } finally {
      isMutating.value = false
    }
  }

  return {
    items, revision, hasLoaded, isLoading, isRefreshing, isMutating, loadError, actionError,
    formError, editorOpen, editingId, form, hasConflict, load, save, reloadEditor, toggle,
    openCreate: () => openEditor(), openEdit: (item: BusinessKnowledgeItem) => openEditor(item),
  }
}
