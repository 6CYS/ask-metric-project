<script setup lang="ts">
import { Check, LoaderCircle, Search, Send, X } from "@lucide/vue"
import { computed, nextTick, ref, watch } from "vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { listBackendNextMetrics, listOrgs } from "@/lib/api"
import { consumeCatalogCommand, entityKey, insertComposerEntity, updateComposerMentions, type ComposerEntity, type ComposerMention } from "@/lib/composerEntities"
import type { BackendNextClarification } from "@/types/api"

const props = defineProps<{ modelValue: string; contextKey: string; placeholder?: string; isSubmitting?: boolean; clarification?: BackendNextClarification }>()
const emit = defineEmits<{ "update:modelValue": [value: string]; submit: [text: string, entities: ComposerEntity[]] }>()
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
const pickerLabel = computed(() => kind.value === "metric" ? "指标" : "机构")
const length = computed(() => props.modelValue.trim().length)
const canSend = computed(() => !props.isSubmitting && length.value > 0 && length.value <= 1000)
const visibleItems = computed(() => {
  const search = query.value.trim().toLowerCase()
  const candidates: ComposerEntity[] = []
  for (const field of props.clarification?.fields ?? []) {
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

watch(() => props.contextKey, () => { mentions.value = []; closePicker() })
watch(() => props.modelValue, (value) => {
  mentions.value = updateComposerMentions(mentionText, value, mentions.value)
  mentionText = value
})
function closePicker() { kind.value = null; generation += 1; loading.value = false }
async function openPicker(nextKind: ComposerEntity["kind"]) {
  kind.value = nextKind
  query.value = ""
  items.value = []
  error.value = ""
  const current = ++generation
  loading.value = true
  void nextTick(() => searchInput.value?.focus())
  try {
    const result: ComposerEntity[] = nextKind === "metric"
      ? (await listBackendNextMetrics()).items.filter((item) => item.enabled).map((item) => ({ kind: "metric", code: item.metric_code, name: item.metric_name, searchText: item.synonyms.join(" ") }))
      : (await listOrgs()).items.filter((item) => item.enabled).map((item) => ({ kind: "organization", code: item.org_code, name: item.org_name, searchText: item.aliases.join(" ") }))
    if (current === generation) items.value = result
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : "目录加载失败，请重试。"
  } finally {
    if (current === generation) loading.value = false
  }
}
function selected(item: ComposerEntity) { return selections.value.some((selection) => entityKey(selection) === entityKey(item)) }
function choose(item: ComposerEntity) {
  const result = insertComposerEntity(mentionText, insertionCursor, item, mentions.value)
  mentions.value = result.mentions
  mentionText = result.text
  insertionCursor = result.cursor
  emit("update:modelValue", result.text)
}
function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  const command = !(event as InputEvent).isComposing ? consumeCatalogCommand(target.value, target.selectionStart) : null
  const next = command?.value ?? target.value
  mentions.value = updateComposerMentions(mentionText, next, mentions.value)
  mentionText = next
  insertionCursor = command?.cursor ?? target.selectionStart
  emit("update:modelValue", next)
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
  if (event.key !== "Enter" || event.isComposing) return
  event.preventDefault()
  if (visibleItems.value[0]) choose(visibleItems.value[0])
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}
function finishSelection() {
  closePicker()
  void nextTick(() => { input.value?.focus(); input.value?.setSelectionRange(insertionCursor, insertionCursor) })
}
</script>

<template>
  <form class="relative w-full rounded-xl border border-border bg-background focus-within:border-[#AFC2D3]" @submit.prevent="submit">
    <section v-if="kind" class="absolute inset-x-0 bottom-full z-30 mb-2 rounded-xl border border-border bg-background p-3 shadow-lg" :aria-label="`${pickerLabel}搜索面板`" @keydown.esc.stop.prevent="finishSelection">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-sm font-medium">选择{{ pickerLabel }}</span>
        <button type="button" class="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="关闭搜索" @click="finishSelection"><X class="size-4" /></button>
      </div>
      <div class="flex items-center gap-2 rounded-lg bg-muted/40 px-3"><Search class="size-4 text-muted-foreground" /><input ref="searchInput" v-model="query" class="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" :aria-label="`搜索${pickerLabel}`" :placeholder="`搜索${pickerLabel}名称、编号或别名`" :disabled="isSubmitting" @keydown="handleSearchKeydown" /></div>
      <p v-if="loading" class="flex items-center gap-2 py-3 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />正在加载目录…</p>
      <p v-if="error" class="py-2 text-xs text-muted-foreground">{{ error }} <button type="button" class="underline" :disabled="isSubmitting" @click="openPicker(kind!)">重试</button></p>
      <div class="max-h-[min(16rem,40vh)] overflow-auto py-1" role="group" :aria-label="`${pickerLabel}搜索结果`">
        <button v-for="item in visibleItems" :key="entityKey(item)" type="button" class="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/50" :class="selected(item) && 'bg-[#EEF4FA]'" :aria-pressed="selected(item)" :disabled="isSubmitting" @click="choose(item)">
          <Check class="mt-1 size-4 shrink-0" :class="selected(item) ? 'text-[#52789C]' : 'text-transparent'" /><span class="min-w-0"><span class="block break-words text-sm leading-6">{{ item.name }}</span><span class="block break-all text-xs text-muted-foreground">{{ item.code }}</span></span>
        </button>
        <p v-if="!visibleItems.length && !loading && !error" class="py-4 text-center text-sm text-muted-foreground">未找到匹配项，请更换关键词。</p>
      </div>
      <div class="flex items-center justify-between gap-2 pt-2"><span class="text-xs text-muted-foreground">可连续选择多项，已选 {{ selections.filter((item) => item.kind === kind).length }} 项</span><BaseButton variant="ghost" :disabled="isSubmitting" @click="finishSelection">返回输入</BaseButton></div>
    </section>
    <textarea ref="input" :value="modelValue" :placeholder="placeholder || '输入问题，或用 /指标、/机构 搜索添加'" rows="1" aria-label="指标问题" class="block field-sizing-content max-h-36 min-h-14 w-full resize-none bg-transparent py-3 pl-3 text-[15px] leading-6 outline-none placeholder:text-muted-foreground" :class="length > 900 ? 'pr-28' : 'pr-14'" :disabled="isSubmitting" @focus="closePicker" @input="handleInput" @compositionend="handleInput" @keydown="handleKeydown" />
    <div class="absolute right-2 bottom-2 flex items-center justify-end gap-2">
      <div class="flex items-center gap-2"><span v-if="length > 900" class="text-xs" :class="length > 1000 ? 'text-destructive' : 'text-muted-foreground'">{{ length }}/1000</span><BaseButton type="submit" size="icon" :disabled="!canSend" aria-label="发送"><LoaderCircle v-if="isSubmitting" class="animate-spin" /><Send v-else /></BaseButton></div>
    </div>
  </form>
</template>
