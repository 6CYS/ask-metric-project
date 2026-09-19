<script setup lang="ts">
import { Check, CircleStop, LoaderCircle, Plus, Search, Send, X } from "@lucide/vue"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { getCachedMetricCatalog, getCachedOrganizationCatalog } from "@/lib/api"
import { clarificationCatalogKinds, consumeCatalogCommand, entityKey, toggleComposerEntity, updateComposerMentions, type ComposerEntity, type ComposerMention } from "@/lib/composerEntities"
import type { BackendNextClarification } from "@/types/api"

const props = defineProps<{ modelValue: string; contextKey: string; placeholder?: string; isSubmitting?: boolean; disabled?: boolean; clarification?: BackendNextClarification; autoOpenClarificationId?: string }>()
const emit = defineEmits<{ "update:modelValue": [value: string]; submit: [text: string, entities: ComposerEntity[]]; stop: [] }>()
const input = ref<HTMLTextAreaElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const kind = ref<ComposerEntity["kind"] | null>(null)
const mentions = ref<ComposerMention[]>([])
const selections = computed(() => mentions.value.map((mention) => mention.entity))
let mentionText = props.modelValue
let insertionCursor = props.modelValue.length
const query = ref("")
const items = ref<ComposerEntity[]>([])
const loading = ref(false)
const error = ref("")
let generation = 0
const mounted = ref(false)
let autoOpenedContext: string | null = null
const catalogKinds = [{ kind: "metric" as const, label: "指标" }, { kind: "organization" as const, label: "机构" }]
const pickerLabel = computed(() => kind.value === "metric" ? "指标" : "机构")
const length = computed(() => props.modelValue.trim().length)
const isDisabled = computed(() => Boolean(props.disabled || props.isSubmitting))
const canSend = computed(() => !isDisabled.value && length.value > 0 && length.value <= 1000)
const visibleItems = computed(() => {
  const search = query.value.trim().toLowerCase()
  const candidates: ComposerEntity[] = []
  const fields = props.clarification?.fields?.length ? props.clarification.fields
    : [{ type: clarificationCatalogKinds(props.clarification)[0], options: props.clarification?.options ?? [] }]
  for (const field of fields) {
    if (field.type !== kind.value) continue
    for (const option of field.options) {
      if (typeof option === "string") continue
      const code = option.metric_code ?? option.org_code ?? option.code
      const name = option.metric_name ?? option.org_name ?? option.name
      if (code && name && kind.value) candidates.push({ kind: kind.value, code, name })
    }
  }
  return [...new Map([...candidates, ...items.value].map((item) => [entityKey(item), item])).values()]
    .filter((item) => !search || `${item.name} ${item.code} ${item.searchText ?? ""}`.toLowerCase().includes(search)).slice(0, 30)
})

watch(() => props.contextKey, () => {
  mentions.value = []
  mentionText = props.modelValue
  insertionCursor = props.modelValue.length
  autoOpenedContext = null
  closePicker()
})
watch(() => props.modelValue, (value) => {
  mentions.value = updateComposerMentions(mentionText, value, mentions.value)
  mentionText = value
})
watch(() => props.modelValue, () => resizeInput(), { flush: "post" })
watch([() => props.contextKey, () => props.clarification, () => props.autoOpenClarificationId, isDisabled, mounted], () => {
  if (!props.clarification) { autoOpenedContext = null; closePicker(); return }
  if (props.autoOpenClarificationId !== props.clarification.id) return
  const context = `${props.contextKey}:${props.clarification.id}`
  if (!mounted.value || isDisabled.value || autoOpenedContext === context) return
  const nextKind = clarificationCatalogKinds(props.clarification)[0]
  autoOpenedContext = context
  if (nextKind) void openPicker(nextKind)
}, { flush: "post" })
onMounted(() => { mounted.value = true; resizeInput() })
watch([mounted, isDisabled], ([ready, disabled]) => {
  // 可提问后预加载；弹窗复用同一请求，失败后允许重新打开重试。
  if (ready && !disabled) void Promise.allSettled([getCachedMetricCatalog(), getCachedOrganizationCatalog()])
}, { immediate: true })
onBeforeUnmount(closePicker)
function resizeInput() {
  if (!input.value) return
  input.value.style.height = "auto"
  input.value.style.height = `${Math.max(32, Math.min(input.value.scrollHeight, 144))}px`
}
function rememberCursor() {
  if (input.value) insertionCursor = input.value.selectionStart
}
function closePicker() { kind.value = null; generation += 1; loading.value = false }
function togglePicker() {
  if (kind.value) finishSelection()
  else void openPicker(clarificationCatalogKinds(props.clarification)[0] ?? "metric")
}
async function openPicker(nextKind: ComposerEntity["kind"]) {
  if (isDisabled.value) return
  kind.value = nextKind
  query.value = ""
  items.value = []
  error.value = ""
  const current = ++generation
  loading.value = true
  void nextTick(() => { if (current === generation) searchInput.value?.focus({ preventScroll: true }) })
  try {
    const result: ComposerEntity[] = nextKind === "metric"
      ? (await getCachedMetricCatalog()).items.filter((item) => item.enabled).map((item) => ({ kind: "metric", code: item.metric_code, name: item.metric_name, searchText: item.synonyms.join(" ") }))
      : (await getCachedOrganizationCatalog()).items.filter((item) => item.enabled).map((item) => ({ kind: "organization", code: item.org_code, name: item.org_name, searchText: item.aliases.join(" ") }))
    if (current === generation) items.value = result
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : "目录加载失败，请重试。"
  } finally {
    if (current === generation) loading.value = false
  }
}
function selected(item: ComposerEntity) { return selections.value.some((selection) => entityKey(selection) === entityKey(item)) }
function choose(item: ComposerEntity) {
  if (isDisabled.value) return
  const result = toggleComposerEntity(mentionText, insertionCursor, item, mentions.value)
  mentions.value = result.mentions
  mentionText = result.text
  insertionCursor = result.cursor
  emit("update:modelValue", result.text)
}
function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  const command = !(event as InputEvent).isComposing ? consumeCatalogCommand(target.value, target.selectionStart) : null
  const value = command?.value ?? target.value
  const next = (value.trim() || (event as InputEvent).isComposing) ? value : ""
  if (!next) target.value = ""
  mentions.value = updateComposerMentions(mentionText, next, mentions.value)
  mentionText = next
  insertionCursor = command?.cursor ?? target.selectionStart
  emit("update:modelValue", next)
  resizeInput()
  if (command) {
    void openPicker(command.kind)
    void nextTick(() => input.value?.setSelectionRange(command.cursor, command.cursor))
  }
}
function submit() {
  if (!canSend.value) return
  closePicker()
  emit("submit", props.modelValue.trim(), [...selections.value])
}
function handleSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (event.repeat) return
  if (visibleItems.value[0]) choose(visibleItems.value[0])
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
  if (event.shiftKey && props.modelValue.trim()) return
  event.preventDefault()
  if (event.repeat) return
  submit()
}
function finishSelection() {
  closePicker()
  void nextTick(() => { input.value?.focus({ preventScroll: true }); input.value?.setSelectionRange(insertionCursor, insertionCursor) })
}
</script>

<template>
  <form class="relative w-full" @submit.prevent="submit">
    <section v-if="kind" class="absolute inset-x-0 bottom-full z-30 mb-2 rounded-xl border border-border bg-background p-3 shadow-lg" :aria-label="`${pickerLabel}搜索面板`" @keydown.esc.stop.prevent="finishSelection">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="flex items-center gap-1" aria-label="选择目录类型"><button v-for="catalog in catalogKinds" :key="catalog.kind" type="button" class="rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2" :class="kind === catalog.kind ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'" :aria-pressed="kind === catalog.kind" :disabled="isDisabled" @click="openPicker(catalog.kind)">{{ catalog.label }}</button></div>
        <button type="button" class="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="关闭搜索" @click="finishSelection"><X class="size-4" /></button>
      </div>
      <div class="flex items-center gap-2 rounded-lg bg-muted/40 px-3"><Search class="size-4 text-muted-foreground" /><input ref="searchInput" v-model="query" class="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" :aria-label="`搜索${pickerLabel}`" :placeholder="`搜索${pickerLabel}名称、编号或别名`" :disabled="isDisabled" @keydown="handleSearchKeydown" /></div>
      <p v-if="loading" class="flex items-center gap-2 py-3 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />正在加载目录…</p>
      <p v-if="error" class="py-2 text-xs text-muted-foreground">{{ error }} <button type="button" class="underline" :disabled="isDisabled" @click="openPicker(kind!)">重试</button></p>
      <div class="max-h-[min(16rem,40vh)] overflow-auto py-1" role="group" :aria-label="`${pickerLabel}搜索结果`">
        <button v-for="item in visibleItems" :key="entityKey(item)" type="button" class="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/50" :class="selected(item) && 'bg-[#EEF4FA]'" :aria-pressed="selected(item)" :disabled="isDisabled" @click="choose(item)">
          <Check class="mt-1 size-4 shrink-0" :class="selected(item) ? 'text-foreground' : 'text-transparent'" /><span class="min-w-0"><span class="block break-words text-sm leading-6">{{ item.name }}</span><span class="block break-all text-xs text-muted-foreground">{{ item.code }}</span></span>
        </button>
        <p v-if="!visibleItems.length && !loading && !error" class="py-4 text-center text-sm text-muted-foreground">未找到匹配项，请更换关键词。</p>
      </div>
      <div class="flex items-center justify-between gap-2 pt-2"><span class="text-xs text-muted-foreground">点击添加，再次点击取消选择</span><BaseButton variant="ghost" :disabled="isDisabled" @click="finishSelection">继续输入</BaseButton></div>
    </section>
    <div class="flex items-center gap-3 rounded-xl border border-border bg-background p-3 focus-within:border-ring">
      <BaseButton variant="ghost" size="icon" class="text-muted-foreground" :disabled="isDisabled" aria-label="添加指标或机构" :aria-expanded="Boolean(kind)" title="添加指标或机构（也可输入 /指标、/机构）" @click="togglePicker"><Plus /></BaseButton>
      <textarea ref="input" :value="modelValue" :placeholder="placeholder || '输入问题，或选择指标、机构'" rows="1" aria-label="指标问题" class="block max-h-36 min-h-8 min-w-0 flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent py-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground" :disabled="isDisabled" @focus="closePicker" @blur="rememberCursor" @click="rememberCursor" @keyup="rememberCursor" @select="rememberCursor" @input="handleInput" @compositionend="handleInput" @keydown="handleKeydown" />
      <span v-if="length > 900" class="shrink-0 text-xs" :class="length > 1000 ? 'text-destructive' : 'text-muted-foreground'">{{ length }}/1000</span>
      <BaseButton v-if="isSubmitting" size="icon" aria-label="停止生成" title="停止生成" @click="emit('stop')"><CircleStop /></BaseButton>
      <BaseButton v-else type="submit" size="icon" :disabled="!canSend" aria-label="发送" title="Enter 发送 · Shift+Enter 换行"><Send /></BaseButton>
    </div>
  </form>
</template>
