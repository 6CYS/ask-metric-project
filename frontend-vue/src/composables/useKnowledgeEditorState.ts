import { ref, watch } from "vue"
import type { BusinessKnowledgeForm } from "@/lib/businessKnowledge"

type EditorState = {
  open: boolean
  busy: boolean
  editing: boolean
  resetKey?: number
  modelValue: BusinessKnowledgeForm
}

export function useKnowledgeEditorState(
  props: EditorState,
  close: () => void,
  loadMetrics: () => void,
) {
  const expanded = ref(false)
  const discardOpen = ref(false)
  const snapshot = () =>
    JSON.stringify([
      props.modelValue.title,
      props.modelValue.text,
      props.modelValue.enabled,
      props.modelValue.batch_query_enabled === true,
      props.modelValue.metric_codes,
    ])
  let baseline = ""

  watch(
    () => [props.open, props.resetKey] as const,
    ([open]) => {
      discardOpen.value = false
      if (!open) return
      baseline = snapshot()
      expanded.value = props.modelValue.batch_query_enabled === true && !props.editing
      if (expanded.value) loadMetrics()
    },
    { immediate: true },
  )

  function requestClose(open: boolean) {
    if (open || !props.open || props.busy) return
    if (snapshot() !== baseline) discardOpen.value = true
    else close()
  }
  function discard() {
    if (props.busy) return
    discardOpen.value = false
    close()
  }
  function toggleMetrics(open: boolean) {
    expanded.value = open
    if (open) loadMetrics()
  }
  return { expanded, discardOpen, requestClose, discard, toggleMetrics }
}
