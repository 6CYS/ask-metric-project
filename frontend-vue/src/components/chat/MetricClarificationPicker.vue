<script setup lang="ts">
import { Check, Search } from "@lucide/vue"
import { computed, ref, watch } from "vue"

import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import {
  filterClarificationOptions,
  formatClarificationOption as formatOption,
  getClarificationOptionKey,
  getClarificationOptionValue,
} from "@/lib/clarificationOptions"
import { listBackendNextMetrics } from "@/lib/api"
import type { ClarificationOption, MetricItem } from "@/types/api"
const formatClarificationOption = (option: ClarificationOption) => formatOption(option, true)

const props = defineProps<{ open: boolean; similarOptions: ClarificationOption[]; disabled?: boolean }>()
const emit = defineEmits<{ "update:open": [value: boolean]; submit: [option: ClarificationOption] }>()
const activeTab = ref<"similar" | "all">("similar")
const similarSearch = ref("")
const allSearch = ref("")
const selectedOption = ref<ClarificationOption | null>(null)
const metrics = ref<MetricItem[]>([])
const isMetricsLoading = ref(false)
const hasLoadedMetrics = ref(false)
const metricsError = ref("")

const allMetricOptions = computed<ClarificationOption[]>(() => metrics.value
  .filter((metric) => metric.enabled)
  .map((metric) => ({ metric_code: metric.metric_code, metric_name: metric.metric_name, unit: metric.unit, synonym: null })))
const filteredSimilarOptions = computed(() => filterClarificationOptions(props.similarOptions, similarSearch.value))
const filteredAllMetricOptions = computed(() => filterClarificationOptions(allMetricOptions.value, allSearch.value))
const allMetricCountLabel = computed(() => metricsError.value
  ? "加载失败"
  : hasLoadedMetrics.value ? String(filteredAllMetricOptions.value.length) : "加载中")

/** 每次打开默认选中最相似的第一项，并懒加载全部指标，关闭后保留缓存避免重复请求。 */
watch(() => props.open, (open) => {
  if (!open) return
  activeTab.value = "similar"
  similarSearch.value = ""
  allSearch.value = ""
  selectedOption.value = props.similarOptions[0] ?? null
  void ensureMetricsLoaded()
})

async function ensureMetricsLoaded() {
  if (metrics.value.length || isMetricsLoading.value) return
  isMetricsLoading.value = true
  metricsError.value = ""
  try {
    metrics.value = (await listBackendNextMetrics()).items
  } catch (error) {
    metricsError.value = error instanceof Error ? error.message : "指标列表加载失败。"
  } finally {
    hasLoadedMetrics.value = true
    isMetricsLoading.value = false
  }
}

function isSelected(option: ClarificationOption) {
  return selectedOption.value !== null && getClarificationOptionValue(option) === getClarificationOptionValue(selectedOption.value)
}

function handleSubmit() {
  if (!selectedOption.value || props.disabled) return
  emit("submit", selectedOption.value)
  emit("update:open", false)
}
</script>

<template>
  <BaseModal
    :open="open"
    title="选择指标"
    description="从相似指标中快速确认，或切换到全部指标列表查找。"
    size="lg"
    @update:open="emit('update:open', $event)"
  >
    <div class="flex min-h-0 flex-col gap-3">
      <div class="inline-flex w-fit rounded-lg bg-muted p-1" role="tablist" aria-label="指标选择范围">
        <BaseButton :variant="activeTab === 'similar' ? 'secondary' : 'ghost'" role="tab" :aria-selected="activeTab === 'similar'" @click="activeTab = 'similar'">
          相似指标 <BaseBadge variant="success">{{ filteredSimilarOptions.length }}</BaseBadge>
        </BaseButton>
        <BaseButton :variant="activeTab === 'all' ? 'secondary' : 'ghost'" role="tab" :aria-selected="activeTab === 'all'" @click="activeTab = 'all'">
          全部指标 <BaseBadge variant="secondary">{{ allMetricCountLabel }}</BaseBadge>
        </BaseButton>
      </div>

      <div v-if="activeTab === 'similar'" role="tabpanel" class="min-h-0">
        <label class="relative mb-2 block"><Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><input v-model="similarSearch" aria-label="搜索相似指标" placeholder="搜索相似指标" class="h-9 w-full rounded-lg border bg-background pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30" /></label>
        <div v-if="filteredSimilarOptions.length" class="max-h-80 overflow-auto rounded-lg border">
          <button v-for="(option, index) in filteredSimilarOptions" :key="getClarificationOptionKey(option, index)" type="button" class="flex w-full items-start gap-3 border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-muted/60" :class="isSelected(option) && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]'" @click="selectedOption = option">
            <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-primary" :class="isSelected(option) && 'border-primary bg-primary text-primary-foreground'"><Check v-if="isSelected(option)" class="size-3" /></span>
            <span class="min-w-0"><span class="block break-words font-medium">{{ formatClarificationOption(option) }}</span></span>
          </button>
        </div>
        <p v-else class="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">暂无相似指标</p>
      </div>
      <div v-else role="tabpanel" class="min-h-0">
        <label class="relative mb-2 block"><Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><input v-model="allSearch" aria-label="搜索全部指标" placeholder="搜索全部指标" class="h-9 w-full rounded-lg border bg-background pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30" /></label>
        <BaseAlert v-if="metricsError" title="指标列表加载失败" variant="destructive">{{ metricsError }}</BaseAlert>
        <LoadingSkeleton v-else-if="isMetricsLoading" :rows="6" />
        <div v-else-if="filteredAllMetricOptions.length" class="max-h-80 overflow-auto rounded-lg border">
          <button v-for="(option, index) in filteredAllMetricOptions" :key="getClarificationOptionKey(option, index)" type="button" class="flex w-full items-start gap-3 border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-muted/60" :class="isSelected(option) && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]'" @click="selectedOption = option">
            <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-primary" :class="isSelected(option) && 'border-primary bg-primary text-primary-foreground'"><Check v-if="isSelected(option)" class="size-3" /></span>
            <span class="min-w-0"><span class="block break-words font-medium">{{ formatClarificationOption(option) }}</span></span>
          </button>
        </div>
        <p v-else class="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">暂无指标</p>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="outline" @click="emit('update:open', false)">取消</BaseButton>
      <BaseButton :disabled="!selectedOption || disabled" @click="handleSubmit">提交</BaseButton>
    </template>
  </BaseModal>
</template>
