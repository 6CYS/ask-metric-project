<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue"
import { BookOpenText, Link, LoaderCircle, Plus, RefreshCw } from "@lucide/vue"

import BusinessKnowledgeEditor from "@/components/knowledge/BusinessKnowledgeEditor.vue"
import ListPagination from "@/components/ListPagination.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import { useKnowledgeManagement } from "@/composables/useKnowledgeManagement"
import type { BusinessKnowledgeItem, MetricItem } from "@/types/api"

const props = defineProps<{ metric: MetricItem; metrics: MetricItem[] }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const {
  items,
  hasLoaded,
  isLoading,
  isRefreshing,
  isMutating,
  loadError,
  actionError,
  actionConflict,
  form,
  formError,
  hasConflict,
  editorOpen,
  editingId,
  load,
  save,
  reloadEditor,
  openCreate,
  openEdit,
  linkMetric,
} = useKnowledgeManagement()
const PAGE_SIZE = 8
const linkedPage = ref(1)
const searchPage = ref(1)
const search = ref("")
const linkingOpen = ref(false)
const linkingId = ref("")
const notice = ref("")
const editingMetric = ref<MetricItem | null>(null)
const linkingMetric = ref<MetricItem | null>(null)
let needsRefresh = false

const linked = computed(() =>
  items.value.filter((item) => item.metric_codes?.includes(props.metric.metric_code)),
)
const linkedPages = computed(() => Math.max(1, Math.ceil(linked.value.length / PAGE_SIZE)))
const linkedItems = computed(() =>
  linked.value.slice((linkedPage.value - 1) * PAGE_SIZE, linkedPage.value * PAGE_SIZE),
)
const candidates = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase()
  return items.value.filter(
    (item) => !keyword || `${item.title} ${item.text}`.toLocaleLowerCase().includes(keyword),
  )
})
const searchPages = computed(() => Math.max(1, Math.ceil(candidates.value.length / PAGE_SIZE)))
const candidateItems = computed(() =>
  candidates.value.slice((searchPage.value - 1) * PAGE_SIZE, searchPage.value * PAGE_SIZE),
)
const metricByCode = computed(() => new Map(props.metrics.map((item) => [item.metric_code, item])))
const editorBusy = computed(() => isMutating.value || isRefreshing.value)
const workspaceBusy = computed(() => linkingOpen.value || editorOpen.value || isMutating.value)

watch(workspaceBusy, (value) => emit("busy", value), { immediate: true })
watch(search, () => {
  searchPage.value = 1
})
watch(linkedPages, (value) => {
  linkedPage.value = Math.min(linkedPage.value, value)
})
watch(searchPages, (value) => {
  searchPage.value = Math.min(searchPage.value, value)
})
watch(
  () => props.metric.metric_code,
  () => {
    linkedPage.value = 1
    notice.value = ""
  },
)

function linkedSummary(item: BusinessKnowledgeItem) {
  const codes = item.metric_codes ?? []
  if (!codes.length) return "尚未关联指标"
  const names = codes
    .slice(0, 2)
    .map((code) => metricByCode.value.get(code)?.metric_name || code)
    .join("、")
  return `已关联：${names}${codes.length > 2 ? `等 ${codes.length} 个指标` : ""}`
}

function create() {
  editingMetric.value = props.metric
  openCreate([props.metric.metric_code])
}

function edit(item: BusinessKnowledgeItem) {
  editingMetric.value = props.metric
  openEdit(item)
}

function openLinks() {
  linkingMetric.value = props.metric
  linkingOpen.value = true
  search.value = ""
  searchPage.value = 1
  notice.value = ""
}

async function link(id: string) {
  const metric = linkingMetric.value
  if (!metric) return
  linkingId.value = id
  try {
    if (await linkMetric(id, metric.metric_code))
      notice.value = `已关联到「${metric.metric_name}」。可继续关联其他知识。`
  } finally {
    linkingId.value = ""
  }
}

async function saveKnowledge() {
  if (await save()) notice.value = "知识已保存。"
}

async function refresh() {
  if (workspaceBusy.value) return false
  return load()
}

defineExpose({ refresh })

onMounted(load)
onDeactivated(() => {
  needsRefresh = true
})
onActivated(async () => {
  if (!needsRefresh) return
  needsRefresh = false
  await load()
})
onBeforeUnmount(() => emit("busy", false))
</script>

<template>
  <section class="space-y-3" aria-label="当前指标的相关业务知识">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="font-medium">
        相关业务知识
        <span v-if="linked.length" class="ml-1 text-sm font-normal text-muted-foreground">{{
          linked.length
        }}</span>
      </h3>
      <div class="flex gap-2">
        <BaseButton
          size="sm"
          variant="outline"
          :disabled="!hasLoaded || editorBusy || editorOpen"
          @click="openLinks"
          ><Link />关联已有</BaseButton
        >
        <BaseButton
          size="sm"
          variant="outline"
          :disabled="!hasLoaded || editorBusy || linkingOpen"
          @click="create"
          ><Plus />新建知识</BaseButton
        >
      </div>
    </div>
    <p v-if="isLoading" class="py-4 text-sm text-muted-foreground" role="status">
      正在读取相关知识…
    </p>
    <BaseAlert v-if="loadError" title="知识读取失败" variant="destructive">
      {{ loadError
      }}<BaseButton class="mt-2" size="sm" variant="outline" :disabled="editorBusy" @click="load"
        ><RefreshCw />重新读取</BaseButton
      >
    </BaseAlert>
    <p v-if="notice && !linkingOpen" class="text-sm text-muted-foreground" role="status">
      {{ notice }}
    </p>
    <p v-if="hasLoaded && !linked.length" class="py-4 text-sm text-muted-foreground">
      尚未关联知识。可以选择已有知识，或为这个指标新建一条。
    </p>
    <div
      v-for="item in linkedItems"
      :key="item.id"
      class="flex items-start justify-between gap-4 border-b py-3 last:border-0"
    >
      <div class="min-w-0">
        <p class="break-words text-sm font-medium">
          {{ item.title
          }}<BaseBadge v-if="!item.enabled" variant="secondary" class="ml-2">已停用</BaseBadge>
        </p>
        <p class="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
          {{ item.text }}
        </p>
      </div>
      <BaseButton
        size="sm"
        variant="ghost"
        class="shrink-0"
        :disabled="editorBusy || linkingOpen"
        @click="edit(item)"
        ><BookOpenText />查看与编辑</BaseButton
      >
    </div>
    <ListPagination
      v-if="linked.length > PAGE_SIZE"
      :page="linkedPage"
      :page-size="PAGE_SIZE"
      :total-items="linked.length"
      :total-pages="linkedPages"
      @change="linkedPage = $event"
    />

    <BaseModal
      v-model:open="linkingOpen"
      :busy="isMutating"
      size="lg"
      title="关联已有知识"
      description="选择一条知识即可关联，已有内容和其他指标的关联保持不变。"
    >
      <div class="space-y-4">
        <div class="rounded-md bg-muted/40 px-3 py-2 text-sm">
          <span class="text-muted-foreground">当前指标</span>
          <p class="mt-1 break-words font-medium">{{ linkingMetric?.metric_name }}</p>
        </div>
        <label class="form-field"
          >查找知识<input
            v-model="search"
            class="form-control"
            placeholder="输入知识标题或内容"
            :disabled="isMutating"
        /></label>
        <BaseAlert v-if="actionError || loadError" title="关联未完成" variant="destructive">
          {{ actionError || loadError
          }}<BaseButton
            v-if="actionConflict || loadError"
            class="mt-2"
            size="sm"
            variant="outline"
            :disabled="editorBusy"
            @click="load"
            ><RefreshCw />重新读取</BaseButton
          >
        </BaseAlert>
        <p v-if="notice" class="text-sm text-muted-foreground" role="status">{{ notice }}</p>
        <p v-if="!candidateItems.length" class="py-6 text-center text-sm text-muted-foreground">
          未找到知识，可以调整关键词，或关闭后新建。
        </p>
        <div
          v-for="item in candidateItems"
          :key="item.id"
          class="flex items-start gap-4 border-b py-3 last:border-0"
        >
          <div class="min-w-0 flex-1">
            <p class="break-words text-sm font-medium">
              {{ item.title
              }}<BaseBadge v-if="!item.enabled" variant="secondary" class="ml-2">已停用</BaseBadge>
            </p>
            <p class="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
              {{ item.text }}
            </p>
            <p class="mt-2 break-words text-xs text-muted-foreground">{{ linkedSummary(item) }}</p>
          </div>
          <span
            v-if="linkingMetric && item.metric_codes?.includes(linkingMetric.metric_code)"
            class="shrink-0 py-2 text-sm text-muted-foreground"
            >已关联</span
          >
          <BaseButton
            v-else
            size="sm"
            variant="outline"
            class="shrink-0"
            :disabled="editorBusy || actionConflict"
            :aria-label="`关联知识：${item.title}`"
            @click="link(item.id)"
            ><LoaderCircle v-if="linkingId === item.id" class="animate-spin" />关联</BaseButton
          >
        </div>
        <ListPagination
          v-if="candidates.length > PAGE_SIZE"
          :page="searchPage"
          :page-size="PAGE_SIZE"
          :total-items="candidates.length"
          :total-pages="searchPages"
          @change="searchPage = $event"
        />
      </div>
      <template #footer
        ><BaseButton variant="outline" :disabled="isMutating" @click="linkingOpen = false"
          >完成</BaseButton
        ></template
      >
    </BaseModal>
    <BusinessKnowledgeEditor
      v-model:open="editorOpen"
      v-model="form"
      :metrics="metrics"
      :current-metric="editingMetric ?? undefined"
      :editing="Boolean(editingId)"
      :busy="editorBusy"
      :conflict="hasConflict"
      :error="formError"
      @save="saveKnowledge"
      @reload="reloadEditor"
    />
  </section>
</template>
