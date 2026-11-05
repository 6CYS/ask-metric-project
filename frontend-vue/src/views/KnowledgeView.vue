<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { computed, onActivated, onDeactivated, ref, watch } from "vue"
import {
  Check,
  Library,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  X,
} from "@lucide/vue"
import { useRoute, useRouter } from "vue-router"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"

import AppShell from "@/components/AppShell.vue"
import ListPagination from "@/components/ListPagination.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BusinessKnowledgeEditor from "@/components/knowledge/BusinessKnowledgeEditor.vue"
import BusinessKnowledgeDetails from "@/components/knowledge/BusinessKnowledgeDetails.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseTextPreview from "@/components/ui/BaseTextPreview.vue"
import { useKnowledgeManagement } from "@/composables/useKnowledgeManagement"
import { listMetrics } from "@/lib/api"
import type { BusinessKnowledgeItem, MetricItem } from "@/types/api"

const PAGE_SIZE = 15
const route = useRoute()
const router = useRouter()
const {
  items,
  hasLoaded,
  isLoading,
  isRefreshing,
  isMutating,
  loadError,
  actionError,
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
  openCreate,
  openEdit,
} = useKnowledgeManagement()
const showDisabled = ref(false)
const searchKeyword = ref("")
const page = ref(1)
const togglingId = ref<string | null>(null)
const metrics = ref<MetricItem[]>([])
const metricsLoaded = ref(false)
const metricsLoading = ref(false)
const metricsError = ref("")
const navigationError = ref("")
const viewingMetrics = ref<BusinessKnowledgeItem | null>(null)
const viewingItem = ref<BusinessKnowledgeItem | null>(null)
const metricSearch = ref("")
const metricPage = ref(1)
const relatedMetric = computed(() =>
  typeof route.query.metric === "string" ? route.query.metric : "",
)
const activeTab = computed(() => {
  const selected = items.value.find((item) => item.id === route.query.edit)
  if (selected) return selected.batch_query_enabled === true ? "plans" : "knowledge"
  return route.query.tab === "plans" ? "plans" : "knowledge"
})
const isPlanTab = computed(() => activeTab.value === "plans")
const entryName = computed(() => (isPlanTab.value ? "方案" : "知识"))
const sectionName = computed(() => (isPlanTab.value ? "查询方案" : "业务知识"))
const sectionDescription = computed(() =>
  isPlanTab.value
    ? "维护常用查询的适用场景和指标组合，机构与期间以用户的问题为准。"
    : "维护业务口径、分析方法和使用边界，为问数提供参考。",
)
const tabItems = computed(() =>
  items.value.filter((item) => (item.batch_query_enabled === true) === isPlanTab.value),
)
const metricByCode = computed(() => new Map(metrics.value.map((item) => [item.metric_code, item])))
const relatedMetricName = computed(
  () => metricByCode.value.get(relatedMetric.value)?.metric_name || relatedMetric.value,
)
const viewedMetricCodes = computed(() => {
  const keyword = metricSearch.value.trim().toLocaleLowerCase()
  return (viewingMetrics.value?.metric_codes ?? []).filter(
    (code) =>
      !keyword ||
      `${code} ${metricByCode.value.get(code)?.metric_name ?? ""}`
        .toLocaleLowerCase()
        .includes(keyword),
  )
})
const viewedMetricPages = computed(() =>
  Math.max(1, Math.ceil(viewedMetricCodes.value.length / PAGE_SIZE)),
)
const viewedMetricItems = computed(() =>
  viewedMetricCodes.value.slice((metricPage.value - 1) * PAGE_SIZE, metricPage.value * PAGE_SIZE),
)
const visibleItems = computed(() => {
  const keyword = searchKeyword.value.trim().toLocaleLowerCase()
  return tabItems.value.filter(
    (item) =>
      (showDisabled.value || item.enabled) &&
      (!relatedMetric.value || item.metric_codes?.includes(relatedMetric.value)) &&
      (!keyword || [item.title, item.text].join(" ").toLocaleLowerCase().includes(keyword)),
  )
})
const totalPages = computed(() => Math.max(1, Math.ceil(visibleItems.value.length / PAGE_SIZE)))
const pageItems = computed(() =>
  visibleItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)
const hasSearch = computed(() => Boolean(searchKeyword.value.trim()))
const editorBusy = computed(() => isMutating.value || isRefreshing.value)
const listDescription = computed(() =>
  isLoading.value
    ? "加载中"
    : !hasLoaded.value
      ? "加载失败"
      : `当前显示 ${visibleItems.value.length} 条 / 共 ${tabItems.value.length} 条`,
)
const noticeItem = computed(() => items.value.find((item) => item.id === notice.value?.item.id))
const noticeText = computed(() => {
  if (!notice.value) return ""
  const { item, action } = notice.value
  const name = item.batch_query_enabled ? "查询方案" : "业务知识"
  const verb = { saved: "已保存", enabled: "已启用", disabled: "已停用" }[action]
  return `${name}「${item.title}」${verb}。`
})
const noticeHint = computed(() => {
  if (!notice.value) return ""
  const item = noticeItem.value
  if (!item) return "该内容已不在当前列表中，请刷新确认。"
  if (!item.enabled && !showDisabled.value)
    return "当前未显示已停用内容，可直接查看详情，或打开“显示已停用”。"
  if (relatedMetric.value && !item.metric_codes?.includes(relatedMetric.value))
    return "该内容未关联当前筛选指标，已从列表隐藏。"
  if (!visibleItems.value.some((entry) => entry.id === item.id))
    return "该内容不符合当前搜索条件，已从列表隐藏。"
  const itemPage =
    Math.floor(visibleItems.value.findIndex((entry) => entry.id === item.id) / PAGE_SIZE) + 1
  return itemPage !== page.value ? `该内容位于第 ${itemPage} 页，可直接查看详情。` : ""
})

watch([showDisabled, searchKeyword, relatedMetric, activeTab], () => {
  page.value = 1
})
watch(totalPages, (value) => {
  page.value = Math.min(page.value, value)
})
watch([viewingMetrics, metricSearch], () => {
  metricPage.value = 1
})

async function loadMetrics() {
  if (metricsLoading.value) return
  metricsLoading.value = true
  metricsError.value = ""
  try {
    metrics.value = (await listMetrics()).items
    metricsLoaded.value = true
  } catch (error) {
    metricsError.value = error instanceof Error ? error.message : "指标目录加载失败，请重试。"
  } finally {
    metricsLoading.value = false
  }
}

async function ensureMetrics() {
  if (!metricsLoaded.value) await loadMetrics()
}

function applyRouteSelection() {
  if (route.name !== "knowledge" || !hasLoaded.value) return
  navigationError.value = ""
  const id = typeof route.query.edit === "string" ? route.query.edit : ""
  if (!id) return
  const item = items.value.find((entry) => entry.id === id)
  if (item) {
    // 刷新或路由同步不重开同一条目，避免覆盖未保存的输入。
    if (!editorOpen.value || editingId.value !== item.id) openEdit(item)
  } else navigationError.value = "这条内容已不存在，请在列表中重新选择。"
}

async function changeTab(value: string | number) {
  if ((value !== "knowledge" && value !== "plans") || editorOpen.value || editorBusy.value) return
  if (value === activeTab.value) return
  try {
    const query = { ...route.query }
    query.tab = value
    delete query.edit
    await router.replace({ query })
    searchKeyword.value = ""
    page.value = 1
    navigationError.value = ""
    notice.value = null
  } catch {
    navigationError.value = "暂时无法切换列表，请重试。"
  }
}

async function clearMetricFilter() {
  try {
    const query = { ...route.query }
    query.tab = activeTab.value
    delete query.metric
    delete query.edit
    await router.replace({ query })
  } catch {
    navigationError.value = "暂时无法切换列表，请重试。"
  }
}

function createKnowledge() {
  openCreate(
    relatedMetric.value ? [relatedMetric.value] : [],
    isPlanTab.value ? "plan" : "knowledge",
  )
}

function showMetricLinks(item: BusinessKnowledgeItem) {
  viewingMetrics.value = item
  metricSearch.value = ""
}

function showDetails(item: BusinessKnowledgeItem) {
  viewingItem.value = items.value.find((entry) => entry.id === item.id) ?? null
  if (!viewingItem.value) navigationError.value = "这条内容已不存在，请刷新后重新选择。"
}

function showNoticeDetails() {
  if (notice.value) showDetails(notice.value.item)
}

function editDetails(item: BusinessKnowledgeItem) {
  openEdit(item)
  if (editorOpen.value) viewingItem.value = null
}

watch(
  () => route.fullPath,
  async () => {
    applyRouteSelection()
    if (route.name === "knowledge" && relatedMetric.value && !metricsLoaded.value)
      await loadMetrics()
  },
)

async function toggleEnabled(item: BusinessKnowledgeItem) {
  togglingId.value = item.id
  try {
    await toggle(item)
  } finally {
    togglingId.value = null
  }
}

// KeepAlive 首次展示也会触发 onActivated，不再叠加 onMounted 请求。
onActivated(async () => {
  if (await load()) applyRouteSelection()
  if (!metricsLoaded.value) await loadMetrics()
})
onDeactivated(() => {
  metricsLoaded.value = false
})
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Business Knowledge" title="业务知识" :description="sectionDescription">
      <template #actions>
        <BaseButton :disabled="!hasLoaded || isMutating || isRefreshing" @click="createKnowledge">
          <Plus />新增{{ entryName }}
        </BaseButton>
        <BaseButton
          variant="outline"
          :disabled="isLoading || isRefreshing || isMutating"
          @click="load"
        >
          <RefreshCw :class="isRefreshing && 'animate-spin'" />刷新
        </BaseButton>
      </template>
    </PageHeader>

    <TabsRoot :model-value="activeTab" @update:model-value="changeTab">
      <TabsList class="mb-5 flex gap-6 border-b" aria-label="知识与查询方案管理">
        <TabsTrigger class="knowledge-tab" value="knowledge" :disabled="editorOpen || editorBusy"
          >业务知识</TabsTrigger
        >
        <TabsTrigger class="knowledge-tab" value="plans" :disabled="editorOpen || editorBusy"
          >查询方案</TabsTrigger
        >
      </TabsList>
      <TabsContent
        :key="activeTab"
        :value="activeTab"
        class="space-y-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BaseAlert v-if="actionError" title="操作未完成" variant="destructive">{{
          actionError
        }}</BaseAlert>
        <div
          v-if="notice"
          class="flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
        >
          <Check class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div class="min-w-0 flex-1" role="status">
            <p class="break-words">{{ noticeText }}</p>
            <p v-if="noticeHint" class="mt-1 text-muted-foreground">{{ noticeHint }}</p>
          </div>
          <BaseButton
            v-if="noticeItem"
            variant="outline"
            size="sm"
            class="shrink-0"
            @click="showNoticeDetails"
            >查看详情</BaseButton
          >
          <BaseTooltip content="关闭提示"
            ><BaseButton
              variant="ghost"
              size="icon"
              class="shrink-0"
              aria-label="关闭提示"
              @click="notice = null"
              ><X /></BaseButton
          ></BaseTooltip>
        </div>
        <BaseAlert v-if="navigationError" title="未能切换或打开内容" variant="destructive">{{
          navigationError
        }}</BaseAlert>
        <BaseAlert v-if="metricsError" title="关联指标名称暂不可用" variant="destructive">
          {{ metricsError }} 已有关联仍保留，可继续维护{{ entryName }}内容。
          <BaseButton
            class="mt-2"
            variant="outline"
            size="sm"
            :disabled="metricsLoading"
            @click="loadMetrics"
            ><RefreshCw />重新读取指标</BaseButton
          >
        </BaseAlert>
        <div
          v-if="relatedMetric"
          class="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
        >
          <span class="min-w-0 break-all">与「{{ relatedMetricName }}」关联的{{ entryName }}</span>
          <BaseButton class="shrink-0" variant="outline" size="sm" @click="clearMetricFilter"
            >查看全部{{ entryName }}</BaseButton
          >
        </div>

        <ManagementListPanel
          v-model:show-disabled="showDisabled"
          v-model:search="searchKeyword"
          :title="`${entryName}列表`"
          :badge="sectionName"
          :description="listDescription"
          :is-loading="isLoading"
          :is-empty="visibleItems.length === 0"
          :blocking-error="!hasLoaded ? loadError : ''"
          :refresh-error="hasLoaded ? loadError : ''"
          :error-title="`${sectionName}加载失败`"
          :refresh-error-title="`${sectionName}刷新失败`"
          :search-label="`搜索${sectionName}`"
          :search-placeholder="isPlanTab ? '搜索方案名称或适用场景' : '搜索标题或知识内容'"
          :search-hint="`当前条件匹配 ${visibleItems.length} 条`"
          :empty-title="hasSearch ? `未找到匹配${entryName}` : `暂无可显示的${entryName}`"
          :empty-description="
            hasSearch
              ? '请调整关键词，或打开「显示已停用」后再试。'
              : `可新增${sectionName}，或打开「显示已停用」查看已有内容。`
          "
        >
          <template #errorIcon><Library /></template>
          <template #refreshIcon><RefreshCw /></template>
          <template #emptyIcon><Library class="size-5" /></template>
          <div class="overflow-hidden rounded-lg border">
            <div class="overflow-x-auto">
              <table class="w-full min-w-[720px] table-fixed text-sm">
                <thead>
                  <tr class="border-b bg-muted/45">
                    <th class="table-head w-64">{{ isPlanTab ? "方案名称" : "标题" }}</th>
                    <th class="table-head">{{ isPlanTab ? "适用场景与查询说明" : "知识内容" }}</th>
                    <th class="table-head w-56">{{ isPlanTab ? "查询指标" : "关联指标" }}</th>
                    <th class="table-head w-24">状态</th>
                    <th class="table-head w-24 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in pageItems"
                    :key="item.id"
                    class="border-b last:border-0 hover:bg-muted/35"
                  >
                    <td class="table-cell font-medium">
                      <BaseTooltip :content="item.title"
                        ><button
                          type="button"
                          class="line-clamp-2 cursor-pointer rounded-sm text-left break-words hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          :aria-label="`查看${entryName}：${item.title}`"
                          @click="showDetails(item)"
                        >
                          {{ item.title }}
                        </button></BaseTooltip
                      >
                    </td>
                    <td class="table-cell">
                      <BaseTextPreview
                        :label="isPlanTab ? '适用场景与查询说明' : '知识内容'"
                        :text="item.text"
                      />
                    </td>
                    <td class="table-cell">
                      <div v-if="item.metric_codes?.length" class="space-y-1">
                        <BaseTooltip
                          v-for="code in item.metric_codes.slice(0, 3)"
                          :key="code"
                          :content="metricByCode.get(code)?.metric_name || code"
                          ><RouterLink
                            :to="{ name: 'metrics', query: { metric: code } }"
                            class="block line-clamp-1 break-all text-sm hover:underline"
                          >
                            {{ metricByCode.get(code)?.metric_name || code }}
                          </RouterLink></BaseTooltip
                        >
                        <button
                          v-if="item.metric_codes.length > 3"
                          type="button"
                          class="text-xs text-muted-foreground hover:underline"
                          @click="showMetricLinks(item)"
                        >
                          查看全部 {{ item.metric_codes.length }} 个指标
                        </button>
                      </div>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>
                    <td class="table-cell">
                      <BaseBadge :variant="item.enabled ? 'default' : 'secondary'">{{
                        item.enabled ? "启用" : "停用"
                      }}</BaseBadge>
                    </td>
                    <td class="table-cell">
                      <div class="flex justify-end gap-1">
                        <BaseTooltip :content="`编辑${entryName}`"
                          ><BaseButton
                            variant="ghost"
                            size="icon"
                            :disabled="isMutating || isRefreshing"
                            :aria-label="`编辑${entryName}：${item.title}`"
                            @click="openEdit(item)"
                          >
                            <Pencil /> </BaseButton
                        ></BaseTooltip>
                        <BaseTooltip :content="`${item.enabled ? '停用' : '启用'}${entryName}`"
                          ><BaseButton
                            variant="ghost"
                            size="icon"
                            :disabled="isMutating || isRefreshing"
                            :aria-label="`${item.enabled ? '停用' : '启用'}${entryName}：${item.title}`"
                            @click="toggleEnabled(item)"
                          >
                            <LoaderCircle v-if="togglingId === item.id" class="animate-spin" />
                            <PowerOff v-else-if="item.enabled" />
                            <Power v-else /> </BaseButton
                        ></BaseTooltip>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ListPagination
              :page="page"
              :page-size="PAGE_SIZE"
              :total-items="visibleItems.length"
              :total-pages="totalPages"
              @change="page = $event"
            />
          </div>
        </ManagementListPanel>
      </TabsContent>
    </TabsRoot>

    <BusinessKnowledgeEditor
      v-model:open="editorOpen"
      v-model="form"
      :metrics="metrics"
      :metrics-loading="metricsLoading"
      :metrics-error="metricsError"
      :editing="Boolean(editingId)"
      :reset-key="editorVersion"
      :busy="editorBusy"
      :conflict="hasConflict"
      :error="formError"
      @save="save"
      @reload="reloadEditor"
      @load-metrics="ensureMetrics"
    />
    <BusinessKnowledgeDetails
      :item="viewingItem"
      :metrics="metrics"
      :busy="editorBusy"
      @close="viewingItem = null"
      @edit="editDetails"
    />
    <BaseModal
      :open="Boolean(viewingMetrics)"
      :title="viewingMetrics?.batch_query_enabled ? '查询指标' : '关联指标'"
      :description="viewingMetrics?.title"
      @update:open="!$event && (viewingMetrics = null)"
    >
      <div class="space-y-3">
        <label class="form-field"
          >查找关联指标<input
            v-model="metricSearch"
            class="form-control"
            placeholder="输入指标名称或编号"
        /></label>
        <RouterLink
          v-for="code in viewedMetricItems"
          :key="code"
          :to="{ name: 'metrics', query: { metric: code } }"
          class="block rounded-md border px-3 py-2 hover:bg-muted/35"
          @click="viewingMetrics = null"
        >
          <span class="block break-words text-sm">{{
            metricByCode.get(code)?.metric_name || code
          }}</span>
          <span class="mt-1 block break-all text-xs text-muted-foreground">{{ code }}</span>
        </RouterLink>
        <p v-if="!viewedMetricItems.length" class="py-4 text-center text-sm text-muted-foreground">
          没有匹配的关联指标。
        </p>
        <ListPagination
          v-if="viewedMetricCodes.length > PAGE_SIZE"
          :page="metricPage"
          :page-size="PAGE_SIZE"
          :total-items="viewedMetricCodes.length"
          :total-pages="viewedMetricPages"
          @change="metricPage = $event"
        />
      </div>
    </BaseModal>
  </AppShell>
</template>

<style scoped>
.knowledge-tab {
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  padding: 0.5rem 0 0.75rem;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.knowledge-tab[data-state="active"] {
  border-bottom-color: var(--foreground);
  color: var(--foreground);
  font-weight: 600;
}
.knowledge-tab:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 3px;
}
.knowledge-tab:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
