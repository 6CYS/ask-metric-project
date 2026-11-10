import { computed, ref, type Ref } from "vue"

import { AgentSessionNotFoundError, deleteAgentSession, renameAgentSession } from "@/lib/agentApi"

export interface ManagedConversation {
  id: string
  serverId: string | null
  title: string
  running: boolean
  legacy?: boolean
  createdAt?: string | null
}

export interface ConversationDeleteFailure {
  id: string
  title: string
  message: string
}

interface Options<T extends ManagedConversation> {
  conversations: Ref<T[]>
  history: Readonly<Ref<T[]>>
  visible: Readonly<Ref<T[]>>
  sending: Ref<Set<string>>
  actorId: Readonly<Ref<string | null>>
  onRenamed: (conversation: T, title: string) => void
  onRemoved: (ids: Set<string>) => Promise<void>
}

/** 会话管理只修改名称及归属会话的存储，不参与问数条件和结果计算。 */
export function useConversationManagement<T extends ManagedConversation>(options: Options<T>) {
  const managing = ref(false)
  const selectedIds = ref(new Set<string>())
  const renameTargetId = ref("")
  const renameSource = ref<"list" | "header">("list")
  const renameBusy = ref(false)
  const renameError = ref("")
  const notice = ref("")
  const deleteOpen = ref(false)
  const deleteTargets = ref<ManagedConversation[]>([])
  const deleting = ref(false)
  const deleteFinished = ref(false)
  const processed = ref(0)
  const failures = ref<ConversationDeleteFailure[]>([])
  let generation = 0

  const canDelete = (conversation: ManagedConversation) =>
    !conversation.legacy && !conversation.running && !options.sending.value.has(conversation.id)
  const eligible = computed(() => options.history.value.filter(canDelete))
  const visibleEligible = computed(() => options.visible.value.filter(canDelete))
  const selected = computed(() => eligible.value.filter((item) => selectedIds.value.has(item.id)))
  const allVisibleSelected = computed(
    () =>
      visibleEligible.value.length > 0 &&
      visibleEligible.value.every((item) => selectedIds.value.has(item.id)),
  )
  const someVisibleSelected = computed(() =>
    visibleEligible.value.some((item) => selectedIds.value.has(item.id)),
  )
  const allSelected = computed(
    () => eligible.value.length > 0 && selected.value.length === eligible.value.length,
  )

  function setManaging(value: boolean) {
    if (deleting.value || renameBusy.value) return
    managing.value = value
    selectedIds.value = new Set()
    renameTargetId.value = ""
    notice.value = ""
  }

  function toggleSelected(conversation: ManagedConversation, checked: boolean) {
    if (!canDelete(conversation) || deleting.value) return
    const next = new Set(selectedIds.value)
    if (checked) next.add(conversation.id)
    else next.delete(conversation.id)
    selectedIds.value = next
  }

  function selectVisible(checked: boolean) {
    if (deleting.value) return
    selectedIds.value = checked ? new Set(visibleEligible.value.map((item) => item.id)) : new Set()
  }

  function selectAll() {
    if (deleting.value) return
    selectedIds.value = allSelected.value
      ? new Set()
      : new Set(eligible.value.map((item) => item.id))
  }

  function openRename(conversation: T, source: "list" | "header" = "list") {
    if (conversation.legacy || deleting.value || renameBusy.value) return
    managing.value = false
    selectedIds.value = new Set()
    renameTargetId.value = conversation.id
    renameSource.value = source
    renameError.value = ""
    notice.value = ""
  }

  function cancelRename() {
    if (!renameBusy.value) renameTargetId.value = ""
  }

  async function saveRename(value: string) {
    const title = value.trim()
    if (!title || title.length > 255) {
      renameError.value = "名称不能为空，且不能超过255个字符。"
      return
    }
    const target = options.conversations.value.find((item) => item.id === renameTargetId.value)
    if (!target || target.legacy || renameBusy.value) return
    const currentGeneration = generation
    renameBusy.value = true
    renameError.value = ""
    try {
      const saved = target.serverId
        ? (await renameAgentSession(target.serverId, title)).title
        : title
      if (currentGeneration !== generation) return
      options.onRenamed(target, saved)
      renameTargetId.value = ""
      notice.value = "会话名称已更新"
    } catch (error) {
      if (currentGeneration === generation)
        renameError.value = error instanceof Error ? error.message : "名称保存失败，请重试。"
    } finally {
      if (currentGeneration === generation) renameBusy.value = false
    }
  }

  function openDelete(targets: ManagedConversation[]) {
    if (deleting.value) return
    deleteTargets.value = targets.filter(canDelete).map((item) => ({ ...item }))
    if (!deleteTargets.value.length) return
    failures.value = []
    processed.value = 0
    deleteFinished.value = false
    deleteOpen.value = true
    notice.value = ""
  }

  function closeDelete() {
    if (!deleting.value) deleteOpen.value = false
  }

  async function confirmDelete(retry = false) {
    if (deleting.value || !deleteOpen.value || (deleteFinished.value && !retry)) return
    if (retry) {
      const failedIds = new Set(failures.value.map((item) => item.id))
      deleteTargets.value = deleteTargets.value.filter((item) => failedIds.has(item.id))
    }
    const targets = [...deleteTargets.value]
    const currentGeneration = generation,
      actor = options.actorId.value
    const isCurrent = () => generation === currentGeneration && options.actorId.value === actor
    failures.value = []
    processed.value = 0
    deleteFinished.value = false
    deleting.value = true
    const removed = new Set<string>()
    let cursor = 0
    // 有界并发复用已有逐条归属校验；部分失败不重做成功项，不在循环中切换当前会话。
    async function worker() {
      while (isCurrent()) {
        const target = targets[cursor++]
        if (!target) return
        try {
          const latest = options.conversations.value.find((item) => item.id === target.id)
          if (latest && !canDelete(latest))
            throw new Error("会话状态已变化，请先停止分析后再删除。")
          if (target.serverId) await deleteAgentSession(target.serverId)
          if (isCurrent()) removed.add(target.id)
        } catch (error) {
          if (!isCurrent()) return
          if (error instanceof AgentSessionNotFoundError) removed.add(target.id)
          else
            failures.value.push({
              id: target.id,
              title: target.title,
              message: error instanceof Error ? error.message : "删除失败，请重试。",
            })
        } finally {
          if (isCurrent()) processed.value += 1
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
      if (!isCurrent()) return
      selectedIds.value = new Set(failures.value.map((item) => item.id))
      await options.onRemoved(removed)
      if (!isCurrent()) return
      deleteFinished.value = true
      notice.value = `已删除 ${removed.size} 个会话${failures.value.length ? `，${failures.value.length} 个未删除` : ""}`
      if (targets.length === 1 && !failures.value.length) deleteOpen.value = false
    } finally {
      if (isCurrent()) deleting.value = false
    }
  }

  function reset() {
    generation += 1
    managing.value = false
    selectedIds.value = new Set()
    renameTargetId.value = ""
    renameBusy.value = false
    renameError.value = ""
    deleteOpen.value = false
    deleting.value = false
    deleteFinished.value = false
    deleteTargets.value = []
    failures.value = []
    processed.value = 0
    notice.value = ""
  }

  return {
    managing,
    selectedIds,
    selected,
    eligible,
    visibleEligible,
    allVisibleSelected,
    someVisibleSelected,
    allSelected,
    renameTargetId,
    renameSource,
    renameBusy,
    renameError,
    notice,
    deleteOpen,
    deleteTargets,
    deleting,
    deleteFinished,
    processed,
    failures,
    canDelete,
    setManaging,
    toggleSelected,
    selectVisible,
    selectAll,
    openRename,
    cancelRename,
    saveRename,
    openDelete,
    closeDelete,
    confirmDelete,
    reset,
  }
}
