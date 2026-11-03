<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { computed, ref, useId, watch } from "vue"
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search, X } from "@lucide/vue"

import BaseButton from "@/components/ui/BaseButton.vue"
import BaseCheckbox from "@/components/ui/BaseCheckbox.vue"
import type { MetricItem } from "@/types/api"

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    items: MetricItem[]
    disabled?: boolean
    loading?: boolean
    error?: string
    label?: string
    maxSelections?: number
  }>(),
  { disabled: false, loading: false, error: "", label: "选择指标" },
)
const emit = defineEmits<{ "update:modelValue": [value: string[]]; retry: [] }>()
const search = ref("")
const page = ref(1)
const pageSize = 20
const searchId = useId()
const byCode = computed(() => new Map(props.items.map((item) => [item.metric_code, item])))
const selected = computed(() => new Set(props.modelValue))
const searchEntries = computed(() =>
  props.items
    .filter((item) => item.enabled)
    .map((item) => ({
      item,
      text: [item.metric_code, item.metric_name, ...item.synonyms].join(" ").toLocaleLowerCase(),
    })),
)
const candidates = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase()
  return searchEntries.value
    .filter((entry) => !keyword || entry.text.includes(keyword))
    .map((entry) => entry.item)
})
const totalPages = computed(() => Math.max(1, Math.ceil(candidates.value.length / pageSize)))
// 翻页和搜索不清空已选项，避免维护长关系时丢失先前选择。
const visibleCandidates = computed(() =>
  candidates.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)
watch(
  search,
  () => {
    page.value = 1
  },
  { flush: "sync" },
)
watch(totalPages, (total) => {
  page.value = Math.min(page.value, total)
})

function toggle(code: string) {
  if (props.disabled) return
  if (selected.value.has(code)) {
    emit(
      "update:modelValue",
      props.modelValue.filter((item) => item !== code),
    )
  } else if (props.maxSelections === 1) {
    emit("update:modelValue", [code])
  } else if (!props.maxSelections || props.modelValue.length < props.maxSelections) {
    emit("update:modelValue", [...props.modelValue, code])
  }
}
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="modelValue.length"
      class="flex max-h-40 flex-wrap gap-2 overflow-y-auto"
      aria-label="已选指标"
    >
      <span
        v-for="code in modelValue"
        :key="code"
        class="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-2 text-xs"
      >
        <BaseTooltip :content="code"><span tabindex="0" class="min-w-0 break-all">
          {{ byCode.get(code)?.metric_name || code
          }}<span v-if="byCode.get(code)?.enabled === false" class="text-muted-foreground"
            >（已停用）</span
          >
        </span></BaseTooltip>
        <button
          type="button"
          class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          :disabled="disabled"
          :aria-label="`移除 ${byCode.get(code)?.metric_name || code}`"
          @click="toggle(code)"
        >
          <X class="size-3.5" />
        </button>
      </span>
    </div>
    <label :for="searchId" class="form-field">
      {{ label }}
      <span class="relative block">
        <Search class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <input
          :id="searchId"
          v-model="search"
          class="form-control pl-9!"
          placeholder="搜索指标名称、编号或同义词"
          :disabled="disabled || loading"
        />
      </span>
    </label>
    <div v-if="error" class="rounded-md border border-destructive/30 p-3 text-sm" role="alert">
      <p class="text-destructive">{{ error }}</p>
      <BaseButton
        class="mt-2"
        size="sm"
        variant="outline"
        :disabled="disabled || loading"
        @click="emit('retry')"
        ><RefreshCw />重新加载指标</BaseButton
      >
    </div>
    <p
      v-else-if="loading"
      class="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <LoaderCircle class="size-4 animate-spin" />正在加载指标目录
    </p>
    <fieldset v-else class="max-h-56 overflow-y-auto rounded-md border" :disabled="disabled">
      <legend class="sr-only">{{ label }}候选</legend>
      <label
        v-for="item in visibleCandidates"
        :key="item.metric_code"
        class="flex cursor-pointer items-start gap-2 border-b p-3 text-sm last:border-0 hover:bg-muted/35"
        :class="disabled && 'cursor-default opacity-60'"
      >
        <BaseCheckbox
          class="mt-1"
          :model-value="selected.has(item.metric_code)"
          :aria-label="item.metric_name"
          :disabled="
            disabled || Boolean(
              maxSelections &&
              maxSelections > 1 &&
              modelValue.length >= maxSelections &&
              !selected.has(item.metric_code),
            )
          "
          @update:model-value="toggle(item.metric_code)"
        />
        <span class="min-w-0"
          ><span class="block break-words">{{ item.metric_name }}</span
          ><span class="mt-0.5 block break-all text-xs text-muted-foreground"
            >{{ item.metric_code }}<span v-if="item.unit"> · {{ item.unit }}</span></span
          ></span
        >
      </label>
      <p v-if="!visibleCandidates.length" class="p-4 text-sm text-muted-foreground">
        {{ search.trim() ? "没有匹配的启用指标，请调整关键词。" : "暂无启用指标。" }}
      </p>
    </fieldset>
    <div
      v-if="!loading && !error && candidates.length > pageSize"
      class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
    >
      <span
        >共 {{ candidates.length }} 个，第 {{ page }} / {{ totalPages }} 页。可搜索缩小范围。</span
      >
      <div class="flex gap-1">
        <BaseButton
          size="icon"
          variant="outline"
          :disabled="disabled || page <= 1"
          :aria-label="label + '上一页'"
          @click="page--"
          ><ChevronLeft
        /></BaseButton>
        <BaseButton
          size="icon"
          variant="outline"
          :disabled="disabled || page >= totalPages"
          :aria-label="label + '下一页'"
          @click="page++"
          ><ChevronRight
        /></BaseButton>
      </div>
    </div>
    <p
      v-if="maxSelections && maxSelections > 1 && modelValue.length >= maxSelections"
      class="text-xs text-muted-foreground"
    >
      最多选择 {{ maxSelections }} 个指标，如需更换请先移除已选项。
    </p>
  </div>
</template>
