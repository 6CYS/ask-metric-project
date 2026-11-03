<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from "vue"
import { GitFork, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from "@lucide/vue"
import ListPagination from "@/components/ListPagination.vue"
import MetricRelationEditor from "@/components/metrics/MetricRelationEditor.vue"
import MetricRelationshipGraph from "@/components/metrics/MetricRelationshipGraph.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSwitch from "@/components/ui/BaseSwitch.vue"
import { ApiError, deleteMetricRelationship, listMetricRelationships } from "@/lib/api"
import { metricNeighborhood, relationLabels } from "@/lib/metricRelationships"
import type { MetricItem } from "@/types/api"
import type {
  MetricRelation,
  MetricRelationList,
  MetricRelationshipIssue,
  MetricRelationWriteResult,
} from "@/types/metricRelationships"

const props = defineProps<{ metrics: MetricItem[]; selectedCode: string }>()
const emit = defineEmits<{
  select: [code: string]
  busy: [busy: boolean]
  loaded: [result: MetricRelationList]
}>()
const items = ref<MetricRelation[]>([])
const revision = ref("")
const issues = ref<MetricRelationshipIssue[]>([])
const loading = ref(false)
const error = ref("")
const showRetired = ref(false)
const showGraph = ref(true)
const editing = ref<MetricRelation | null>(null)
const editorOpen = ref(false)
const editorBusy = ref(false)
const deleting = ref<MetricRelation | null>(null)
const deletingBusy = ref(false)
const deleteError = ref("")
const deleteConflict = ref(false)
const page = ref(1)
const pageSize = 8
let loadSequence = 0
let needsRefresh = false
let active = true
const byCode = computed(() => new Map(props.metrics.map((metric) => [metric.metric_code, metric])))
const selected = computed(() => byCode.value.get(props.selectedCode))
const neighborhood = computed(() =>
  metricNeighborhood(props.selectedCode, items.value, showRetired.value),
)
const hasRetired = computed(() =>
  items.value.some(
    (item) =>
      item.status === "retired" &&
      (item.parent === props.selectedCode || item.children.includes(props.selectedCode)),
  ),
)
const pages = computed(() => Math.max(1, Math.ceil(neighborhood.value.relations.length / pageSize)))
const visibleRelations = computed(() =>
  neighborhood.value.relations.slice((page.value - 1) * pageSize, page.value * pageSize),
)
const selectedIssues = computed(() =>
  issues.value.filter((issue) => issue.metric_codes.includes(props.selectedCode)),
)
const busy = computed(
  () => editorOpen.value || editorBusy.value || Boolean(deleting.value) || deletingBusy.value,
)
const name = (code: string) => byCode.value.get(code)?.metric_name || code
function members(item: MetricRelation) {
  if (item.kind === "ratio")
    return `占比计算：${name(item.children[0] ?? "")} ÷ ${name(item.children[1] ?? "")} × 100%`
  const label = item.kind === "composition" ? "组成分项" : "分类包含"
  return `${label}：${item.children.map(name).join("、")}`
}

function choose(code: string) {
  if (!busy.value) emit("select", code)
}
async function refresh() {
  if (!active || busy.value) return
  const sequence = ++loadSequence
  loading.value = true
  error.value = ""
  try {
    const result = await listMetricRelationships()
    if (sequence !== loadSequence) return
    items.value = result.items
    revision.value = result.revision
    issues.value = result.issues ?? []
    emit("loaded", result)
  } catch (cause) {
    if (sequence === loadSequence)
      error.value = cause instanceof Error ? cause.message : "指标关系读取失败。"
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function openEditor(item: MetricRelation | null) {
  if (busy.value || loading.value || !revision.value || (item && !item.editable)) return
  editing.value = item
  editorOpen.value = true
}
function confirmDelete(item: MetricRelation) {
  if (busy.value || loading.value || !item.editable) return
  deleting.value = item
  deleteError.value = ""
  deleteConflict.value = false
}
async function saved(result: MetricRelationWriteResult) {
  ++loadSequence
  loading.value = false
  items.value = [...items.value.filter((item) => item.id !== result.item.id), result.item]
  revision.value = result.revision
  // 编辑器关闭并解除保存锁后，统一重读关系和待核对项。
  await nextTick()
  await refresh()
}

async function remove() {
  const item = deleting.value
  if (!item || deletingBusy.value || deleteConflict.value) return
  deletingBusy.value = true
  deleteError.value = ""
  let removed = false
  try {
    const result = await deleteMetricRelationship(item.id, revision.value)
    if (!active) return
    ++loadSequence
    loading.value = false
    revision.value = result.revision
    items.value = items.value.filter((entry) => entry.id !== item.id)
    deleting.value = null
    removed = true
  } catch (cause) {
    if (!active) return
    deleteConflict.value = cause instanceof ApiError && cause.status === 409
    deleteError.value = deleteConflict.value
      ? "关系已被其他人修改，请关闭并刷新后确认要删除的内容。"
      : cause instanceof Error
        ? cause.message
        : "删除失败，请稍后重试。"
  } finally {
    deletingBusy.value = false
  }
  if (removed) await refresh()
}

async function refreshAfterDeleteConflict() {
  deleting.value = null
  await refresh()
}

watch(busy, (value) => emit("busy", value), { immediate: true, flush: "sync" })
watch(
  () => props.selectedCode,
  () => {
    page.value = 1
  },
)
watch(pages, (total) => {
  page.value = Math.min(page.value, total)
})
onMounted(refresh)
onDeactivated(() => {
  needsRefresh = true
})
onActivated(async () => {
  if (!needsRefresh) return
  needsRefresh = false
  await refresh()
})
onBeforeUnmount(() => {
  active = false
  ++loadSequence
  emit("busy", false)
})
defineExpose({ refresh })
</script>

<template>
  <section class="min-w-0 space-y-3" aria-label="当前指标关系">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">
        关联指标
        <span
          v-if="revision && neighborhood.relations.length"
          class="ml-1 font-normal text-muted-foreground"
        >
          {{ neighborhood.relations.length }} 条关系
        </span>
      </h3>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton
          v-if="selected && neighborhood.relations.length"
          size="sm"
          variant="ghost"
          :aria-pressed="showGraph"
          :disabled="busy"
          @click="showGraph = !showGraph"
        >
          <GitFork />{{ showGraph ? "收起关系图" : "查看关系图" }}
        </BaseButton>
        <BaseButton
          size="sm"
          variant="outline"
          :disabled="!selected?.enabled || !revision || loading || busy"
          @click="openEditor(null)"
        >
          <Plus />添加关系
        </BaseButton>
      </div>
    </div>
    <BaseAlert
      v-if="error"
      :title="revision ? '关系刷新失败，保留当前内容' : '关系读取失败'"
      variant="destructive"
    >
      {{ error }}
      <BaseButton
        class="mt-3"
        size="sm"
        variant="outline"
        :disabled="loading || busy"
        @click="refresh"
      >
        <RefreshCw :class="loading && 'animate-spin'" />重试
      </BaseButton>
    </BaseAlert>
    <p
      v-if="loading && !revision"
      class="py-8 text-center text-sm text-muted-foreground"
      role="status"
    >
      正在读取指标关系…
    </p>
    <template v-else-if="selected && revision">
      <div v-if="hasRetired" class="flex justify-end">
        <BaseSwitch v-model="showRetired" label="显示已停用" :disabled="busy" />
      </div>
      <div
        v-if="showGraph && neighborhood.relations.length"
        class="space-y-2 rounded-lg border p-3"
      >
        <MetricRelationshipGraph
          :selected="selectedCode"
          :metrics="metrics"
          :relations="items"
          :show-retired="showRetired"
          @select="choose"
        />
        <p class="text-xs text-muted-foreground">点击关联指标可继续查看。</p>
      </div>
      <h4 v-if="neighborhood.relations.length" class="pt-2 text-sm font-medium">关系说明与维护</h4>
      <ul v-if="neighborhood.relations.length" class="divide-y">
        <li
          v-for="item in visibleRelations"
          :key="item.id"
          class="flex items-start justify-between gap-3 py-3 text-sm"
        >
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="break-words text-left hover:underline"
                :disabled="busy"
                @click="choose(item.parent)"
              >
                {{ name(item.parent) }}
              </button>
              <BaseBadge variant="secondary">{{ relationLabels[item.kind] }}</BaseBadge>
              <span v-if="!item.editable" class="text-xs text-muted-foreground">预置 · 只读</span>
              <span v-else-if="item.status !== 'approved'" class="text-xs text-muted-foreground">
                {{ item.status === "retired" ? "已停用" : "未启用" }}
              </span>
            </div>
            <p class="break-words leading-6">{{ members(item) }}</p>
            <BaseDisclosure v-if="item.source" class="break-words text-xs leading-5 text-muted-foreground">
              <template #trigger>查看关系说明</template>
              <p class="mt-2 whitespace-pre-line">{{ item.source }}</p>
            </BaseDisclosure>
          </div>
          <div v-if="item.editable" class="flex shrink-0">
            <BaseButton
              size="icon"
              variant="ghost"
              :disabled="loading || busy"
              :aria-label="`编辑${name(item.parent)}的${relationLabels[item.kind]}关系`"
              @click="openEditor(item)"
              ><Pencil
            /></BaseButton>
            <BaseButton
              size="icon"
              variant="ghost"
              :disabled="loading || busy"
              :aria-label="`删除${name(item.parent)}的${relationLabels[item.kind]}关系`"
              @click="confirmDelete(item)"
              ><Trash2
            /></BaseButton>
          </div>
        </li>
      </ul>
      <p v-else class="py-8 text-center text-sm text-muted-foreground">
        暂无关联指标，可通过“添加关系”补充。
      </p>
      <ListPagination
        v-if="pages > 1"
        :page="page"
        :page-size="pageSize"
        :total-items="neighborhood.relations.length"
        :total-pages="pages"
        @change="page = $event"
      />
      <BaseDisclosure v-if="selectedIssues.length" class="border-t pt-3 text-xs text-muted-foreground">
        <template #trigger>
          当前指标有 {{ selectedIssues.length }} 项关联待完善
        </template>
        <ul class="mt-3 space-y-3">
          <li
            v-for="issue in selectedIssues"
            :key="issue.id"
            class="space-y-1 break-words leading-5"
          >
            <p class="font-medium text-foreground">{{ issue.title }}</p>
            <p>{{ issue.message }}</p>
          </li>
        </ul>
      </BaseDisclosure>
    </template>
    <p v-else-if="!selected && !loading" class="py-8 text-center text-sm text-muted-foreground">
      请先从目录选择一个指标。
    </p>
    <MetricRelationEditor
      v-model:open="editorOpen"
      :relation="editing"
      :parent="selectedCode"
      :revision="revision"
      :metrics="metrics"
      @saved="saved"
      @refresh="refresh"
      @busy="editorBusy = $event"
    />
    <BaseModal
      :open="Boolean(deleting)"
      title="删除指标关系"
      size="sm"
      :busy="deletingBusy"
      @update:open="!$event && (deleting = null)"
    >
      <p class="text-sm leading-6 text-muted-foreground">
        删除「{{ deleting ? name(deleting.parent) : "" }}」的这条关系？指标定义和事实数据会保留。
      </p>
      <p v-if="deleteError" class="mt-3 text-destructive">{{ deleteError }}</p>
      <BaseButton
        v-if="deleteConflict"
        class="mt-3"
        variant="outline"
        @click="refreshAfterDeleteConflict"
        ><RefreshCw />关闭并刷新关系</BaseButton
      >
      <template #footer>
        <BaseButton variant="outline" :disabled="deletingBusy" @click="deleting = null"
          >取消</BaseButton
        >
        <BaseButton
          variant="destructive"
          :disabled="deletingBusy || deleteConflict"
          @click="remove"
        >
          <LoaderCircle v-if="deletingBusy" class="animate-spin" /><Trash2 v-else />{{
            deletingBusy ? "删除中…" : "确认删除"
          }}
        </BaseButton>
      </template>
    </BaseModal>
  </section>
</template>
