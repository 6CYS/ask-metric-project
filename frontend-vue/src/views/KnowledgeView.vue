<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { computed, onActivated, onDeactivated, ref, watch } from "vue"
import { Library, LoaderCircle, Pencil, Plus, Power, PowerOff, RefreshCw } from "@lucide/vue"
import { useRoute, useRouter } from "vue-router"

import AppShell from "@/components/AppShell.vue"
import ListPagination from "@/components/ListPagination.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BusinessKnowledgeEditor from "@/components/knowledge/BusinessKnowledgeEditor.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import { useKnowledgeManagement } from "@/composables/useKnowledgeManagement"
import { listMetrics } from "@/lib/api"
import type { BusinessKnowledgeItem, MetricItem } from "@/types/api"

const PAGE_SIZE = 15
const route = useRoute()
const router = useRouter()
const {
  items, hasLoaded, isLoading, isRefreshing, isMutating, loadError, actionError,
  formError, editorOpen, editingId, form, hasConflict, load, save, reloadEditor, toggle, openCreate, openEdit,
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
const metricSearch = ref("")
const metricPage = ref(1)
const relatedMetric = computed(() => typeof route.query.metric === "string" ? route.query.metric : "")
const metricByCode = computed(() => new Map(metrics.value.map(item => [item.metric_code, item])))
const relatedMetricName = computed(() => metricByCode.value.get(relatedMetric.value)?.metric_name || relatedMetric.value)
const viewedMetricCodes = computed(() => {
  const keyword = metricSearch.value.trim().toLocaleLowerCase()
  return (viewingMetrics.value?.metric_codes ?? []).filter(code => !keyword
    || `${code} ${metricByCode.value.get(code)?.metric_name ?? ""}`.toLocaleLowerCase().includes(keyword))
})
const viewedMetricPages = computed(() => Math.max(1, Math.ceil(viewedMetricCodes.value.length / PAGE_SIZE)))
const viewedMetricItems = computed(() => viewedMetricCodes.value.slice((metricPage.value - 1) * PAGE_SIZE, metricPage.value * PAGE_SIZE))
const visibleItems = computed(() => {
  const keyword = searchKeyword.value.trim().toLocaleLowerCase()
  return items.value.filter(item => (showDisabled.value || item.enabled)
    && (!relatedMetric.value || item.metric_codes?.includes(relatedMetric.value))
    && (!keyword || [item.title, item.text].join(" ").toLocaleLowerCase().includes(keyword)))
})
const totalPages = computed(() => Math.max(1, Math.ceil(visibleItems.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const hasSearch = computed(() => Boolean(searchKeyword.value.trim()))
const editorBusy = computed(() => isMutating.value || isRefreshing.value)
const listDescription = computed(() => isLoading.value ? "加载中" : !hasLoaded.value ? "加载失败" : `当前显示 ${visibleItems.value.length} 条 / 共 ${items.value.length} 条`)

watch([showDisabled, searchKeyword, relatedMetric], () => { page.value = 1 })
watch(totalPages, value => { page.value = Math.min(page.value, value) })
watch([viewingMetrics, metricSearch], () => { metricPage.value = 1 })

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
  const item = items.value.find(entry => entry.id === id)
  if (item) openEdit(item)
  else navigationError.value = "这条知识已不存在，请在列表中重新选择。"
}

async function clearMetricFilter() {
  try {
    const query = { ...route.query }
    delete query.metric
    delete query.edit
    await router.replace({ query })
  } catch {
    navigationError.value = "暂时无法切换列表，请重试。"
  }
}

function createKnowledge() {
  openCreate(relatedMetric.value ? [relatedMetric.value] : [])
}

function showMetricLinks(item: BusinessKnowledgeItem) {
  viewingMetrics.value = item
  metricSearch.value = ""
}

watch(() => route.fullPath, async () => {
  applyRouteSelection()
  if (route.name === "knowledge" && relatedMetric.value && !metricsLoaded.value) await loadMetrics()
})

async function toggleEnabled(item: BusinessKnowledgeItem) {
  togglingId.value = item.id
  try { await toggle(item) } finally { togglingId.value = null }
}

// KeepAlive 首次展示也会触发 onActivated，不再叠加 onMounted 请求。
onActivated(async () => {
  if (await load()) applyRouteSelection()
  if (!metricsLoaded.value) await loadMetrics()
})
onDeactivated(() => { metricsLoaded.value = false })
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Business Knowledge" title="业务知识" description="维护问数和分析使用的业务知识。">
      <template #actions>
        <BaseButton :disabled="!hasLoaded || isMutating || isRefreshing" @click="createKnowledge">
          <Plus />新增知识
        </BaseButton>
        <BaseButton variant="outline" :disabled="isLoading || isRefreshing || isMutating" @click="load">
          <RefreshCw :class="isRefreshing && 'animate-spin'" />刷新
        </BaseButton>
      </template>
    </PageHeader>

    <BaseAlert v-if="actionError" title="操作未完成" variant="destructive">{{ actionError }}</BaseAlert>
    <BaseAlert v-if="navigationError" title="未能打开知识" variant="destructive">{{ navigationError }}</BaseAlert>
    <BaseAlert v-if="metricsError" title="关联指标名称暂不可用" variant="destructive">
      {{ metricsError }} 已有关联仍保留，可继续维护知识内容。
      <BaseButton class="mt-2" variant="outline" size="sm" :disabled="metricsLoading" @click="loadMetrics"><RefreshCw />重新读取指标</BaseButton>
    </BaseAlert>
    <div v-if="relatedMetric" class="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <span class="min-w-0 break-all">与「{{ relatedMetricName }}」关联的知识</span>
      <BaseButton class="shrink-0" variant="outline" size="sm" @click="clearMetricFilter">查看全部知识</BaseButton>
    </div>

    <ManagementListPanel
      v-model:show-disabled="showDisabled"
      v-model:search="searchKeyword"
      title="知识列表"
      badge="业务知识"
      :description="listDescription"
      :is-loading="isLoading"
      :is-empty="visibleItems.length === 0"
      :blocking-error="!hasLoaded ? loadError : ''"
      :refresh-error="hasLoaded ? loadError : ''"
      error-title="业务知识加载失败"
      refresh-error-title="业务知识刷新失败"
      search-label="搜索业务知识"
      search-placeholder="搜索标题或知识内容"
      :search-hint="`当前条件匹配 ${visibleItems.length} 条`"
      :empty-title="hasSearch ? '未找到匹配知识' : '暂无可显示的知识'"
      :empty-description="hasSearch ? '请调整关键词，或打开「显示已停用」后再试。' : '可新增业务知识，或打开「显示已停用」查看已有内容。'"
    >
      <template #errorIcon><Library /></template>
      <template #refreshIcon><RefreshCw /></template>
      <template #emptyIcon><Library class="size-5" /></template>
      <div class="overflow-hidden rounded-lg border">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[720px] table-fixed text-sm">
            <thead>
              <tr class="border-b bg-muted/45">
                <th class="table-head w-64">标题</th>
                <th class="table-head">知识内容</th>
                <th class="table-head w-56">关联指标</th>
                <th class="table-head w-24">状态</th>
                <th class="table-head w-24 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in pageItems" :key="item.id" class="border-b last:border-0 hover:bg-muted/35">
                <td class="table-cell font-medium">
                  <BaseTooltip :content="item.title"><span tabindex="0" class="line-clamp-2 break-words">{{ item.title }}</span></BaseTooltip>
                  <BaseBadge v-if="item.batch_query_enabled" variant="secondary" class="mt-1">支持批量取数</BaseBadge>
                </td>
                <td class="table-cell">
                  <span class="line-clamp-2 break-words">{{ item.text }}</span>
                </td>
                <td class="table-cell">
                  <div v-if="item.metric_codes?.length" class="space-y-1">
                    <BaseTooltip v-for="code in item.metric_codes.slice(0, 3)" :key="code" :content="metricByCode.get(code)?.metric_name || code"><RouterLink :to="{ name: 'metrics', query: { metric: code } }"
                      class="block line-clamp-1 break-all text-sm hover:underline">
                      {{ metricByCode.get(code)?.metric_name || code }}
                    </RouterLink></BaseTooltip>
                    <button v-if="item.metric_codes.length > 3" type="button" class="text-xs text-muted-foreground hover:underline"
                      @click="showMetricLinks(item)">查看全部 {{ item.metric_codes.length }} 个指标</button>
                  </div>
                  <span v-else class="text-muted-foreground">—</span>
                </td>
                <td class="table-cell">
                  <BaseBadge :variant="item.enabled ? 'default' : 'secondary'">{{ item.enabled ? '启用' : '停用' }}</BaseBadge>
                </td>
                <td class="table-cell">
                  <div class="flex justify-end gap-1">
                    <BaseButton
                      variant="ghost" size="icon" :disabled="isMutating || isRefreshing"
                      :aria-label="`编辑知识：${item.title}`" @click="openEdit(item)"
                    >
                      <Pencil />
                    </BaseButton>
                    <BaseButton
                      variant="ghost" size="icon" :disabled="isMutating || isRefreshing"
                      :aria-label="`${item.enabled ? '停用' : '启用'}知识：${item.title}`" @click="toggleEnabled(item)"
                    >
                      <LoaderCircle v-if="togglingId === item.id" class="animate-spin" />
                      <PowerOff v-else-if="item.enabled" />
                      <Power v-else />
                    </BaseButton>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ListPagination :page="page" :page-size="PAGE_SIZE" :total-items="visibleItems.length" :total-pages="totalPages" @change="page = $event" />
      </div>
    </ManagementListPanel>

    <BusinessKnowledgeEditor v-model:open="editorOpen" v-model="form" :metrics="metrics" :metrics-loading="metricsLoading" :metrics-error="metricsError"
      :editing="Boolean(editingId)" :busy="editorBusy" :conflict="hasConflict" :error="formError"
      @save="save" @reload="reloadEditor" @load-metrics="ensureMetrics" />
    <BaseModal :open="Boolean(viewingMetrics)" title="关联指标" :description="viewingMetrics?.title" @update:open="!$event && (viewingMetrics = null)">
      <div class="space-y-3">
        <label class="form-field">查找关联指标<input v-model="metricSearch" class="form-control" placeholder="输入指标名称或编号" /></label>
        <RouterLink v-for="code in viewedMetricItems" :key="code" :to="{ name: 'metrics', query: { metric: code } }"
          class="block rounded-md border px-3 py-2 hover:bg-muted/35" @click="viewingMetrics = null">
          <span class="block break-words text-sm">{{ metricByCode.get(code)?.metric_name || code }}</span>
          <span class="mt-1 block break-all text-xs text-muted-foreground">{{ code }}</span>
        </RouterLink>
        <p v-if="!viewedMetricItems.length" class="py-4 text-center text-sm text-muted-foreground">没有匹配的关联指标。</p>
        <ListPagination v-if="viewedMetricCodes.length > PAGE_SIZE" :page="metricPage" :page-size="PAGE_SIZE" :total-items="viewedMetricCodes.length" :total-pages="viewedMetricPages" @change="metricPage = $event" />
      </div>
    </BaseModal>
  </AppShell>
</template>
