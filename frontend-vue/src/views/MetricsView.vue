<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import { BookOpenText, CheckCircle2, LoaderCircle, Pencil, Plus, Power, PowerOff, RefreshCw, Tags, Trash2 } from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import ListPagination from "@/components/ListPagination.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import { useManagementResource } from "@/composables/useManagementResource"
import { createMetric, deleteMetric, listMetrics, updateMetric } from "@/lib/api"
import type { MetricItem, MetricPayload } from "@/types/api"

const PAGE_SIZE = 15
const resource = useManagementResource<MetricItem>(listMetrics)
const showDisabled = ref(false)
const searchKeyword = ref("")
const page = ref(1)
const isDialogOpen = ref(false)
const editingMetric = ref<MetricItem | null>(null)
const deletingMetric = ref<MetricItem | null>(null)
const togglingMetricCode = ref<string | null>(null)
const form = reactive({ metricCode: "", metricName: "", unit: "", metricExplanation: "", description: "", synonyms: "" })

const visibleItems = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  const statusItems = showDisabled.value ? resource.items.value : resource.items.value.filter((item) => item.enabled)
  if (!keyword) return statusItems
  return statusItems.filter((item) => [item.metric_code, item.metric_name, item.unit ?? "", item.metric_explanation, item.description, ...item.synonyms].join(" ").toLowerCase().includes(keyword))
})
const totalPages = computed(() => Math.max(1, Math.ceil(visibleItems.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const enabledCount = computed(() => resource.items.value.filter((item) => item.enabled).length)
const synonymCount = computed(() => resource.items.value.filter((item) => item.enabled).reduce((total, item) => total + item.synonyms.length, 0))
const hasSearch = computed(() => Boolean(searchKeyword.value.trim()))
const listDescription = computed(() => resource.isLoading.value ? "加载中" : resource.isBlockingError.value ? "加载失败" : hasSearch.value ? `匹配 ${visibleItems.value.length} 个指标 / 共 ${resource.items.value.length} 个` : showDisabled.value ? `显示全部 ${resource.items.value.length} 个指标（含已停用）` : `${visibleItems.value.length} 个启用的指标 / 共 ${resource.items.value.length} 个`)
const emptyTitle = computed(() => hasSearch.value ? "未找到匹配指标" : showDisabled.value ? "暂无任何指标" : "暂无启用的指标")
const emptyDescription = computed(() => hasSearch.value ? "请调整关键词，或打开「显示已停用」后再试。" : showDisabled.value ? "新增第一条指标后，问数链路即可开始匹配业务术语。" : "打开「显示已停用」开关可查看已停用项，或直接新增一个指标。")
const stats = computed(() => [
  { label: "指标总数", value: resource.isLoading.value ? "--" : String(resource.items.value.length), detail: "可被问数链路匹配的指标定义。" },
  { label: "已启用", value: resource.isLoading.value ? "--" : String(enabledCount.value), detail: "当前参与语义匹配的指标数量。" },
  { label: "同义词", value: resource.isLoading.value ? "--" : String(synonymCount.value), detail: "覆盖自然语言表达的别名规模。" },
])

watch([visibleItems, showDisabled, searchKeyword], () => { page.value = Math.min(page.value, totalPages.value) })

function resetForm() {
  Object.assign(form, { metricCode: "", metricName: "", unit: "", metricExplanation: "", description: "", synonyms: "" })
}

function openCreateDialog() {
  resetForm()
  editingMetric.value = null
  resource.clearMutationError()
  isDialogOpen.value = true
}

function openEditDialog(metric: MetricItem) {
  Object.assign(form, { metricCode: metric.metric_code, metricName: metric.metric_name, unit: metric.unit ?? "", metricExplanation: metric.metric_explanation, description: metric.description, synonyms: metric.synonyms.join("，") })
  editingMetric.value = metric
  resource.clearMutationError()
  isDialogOpen.value = true
}

function buildPayload(enabled: boolean): MetricPayload {
  return {
    metric_code: form.metricCode.trim(),
    metric_name: form.metricName.trim(),
    unit: form.unit.trim() || undefined,
    metric_explanation: form.metricExplanation.trim(),
    description: form.description.trim(),
    // 同时兼容中英文逗号并在提交前去除重复项，保持输入顺序稳定。
    synonyms: [...new Set(form.synonyms.split(/[,，]/).map((item) => item.trim()).filter(Boolean))],
    enabled,
  }
}

async function submitForm() {
  if (!form.metricCode.trim() || !form.metricName.trim()) return
  const current = editingMetric.value
  const ok = await resource.mutate(() => current ? updateMetric(current.metric_code, buildPayload(current.enabled)) : createMetric(buildPayload(true)))
  if (ok) { isDialogOpen.value = false; editingMetric.value = null }
}

async function toggleEnabled(metric: MetricItem) {
  togglingMetricCode.value = metric.metric_code
  const payload: MetricPayload = { metric_code: metric.metric_code, metric_name: metric.metric_name, unit: metric.unit ?? undefined, metric_explanation: metric.metric_explanation, description: metric.description, synonyms: metric.synonyms, enabled: !metric.enabled }
  await resource.mutate(() => updateMetric(metric.metric_code, payload))
  togglingMetricCode.value = null
}

async function confirmDelete() {
  if (!deletingMetric.value) return
  const ok = await resource.mutate(() => deleteMetric(deletingMetric.value!.metric_code))
  if (ok) deletingMetric.value = null
}

onMounted(() => resource.load())
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Semantic Catalog" title="指标术语" description="集中维护业务指标、单位、口径说明和同义词，保证问数理解与 SQL 生成使用同一套语义资产。" :stats="stats">
      <template #actions><BaseButton @click="openCreateDialog"><Plus />新增指标</BaseButton><BaseButton variant="outline" :disabled="resource.isRefreshing.value" @click="resource.load(true)"><RefreshCw :class="resource.isRefreshing.value && 'animate-spin'" />刷新</BaseButton></template>
    </PageHeader>

    <ManagementListPanel
      v-model:show-disabled="showDisabled" v-model:search="searchKeyword" title="指标列表" :description="listDescription" :is-loading="resource.isLoading.value" :is-empty="visibleItems.length === 0"
      :blocking-error="resource.isBlockingError.value ? resource.loadError.value : ''" :refresh-error="resource.isRefreshError.value ? resource.loadError.value : ''"
      error-title="指标列表请求失败" refresh-error-title="指标列表刷新失败" search-label="搜索指标" search-placeholder="搜索指标编号、名称、单位、说明、口径或同义词"
      :search-hint="hasSearch ? `当前条件匹配 ${visibleItems.length} 条` : '可按指标资产任意字段模糊查询'" :empty-title="emptyTitle" :empty-description="emptyDescription"
    >
      <template #errorIcon><BookOpenText /></template><template #refreshIcon><RefreshCw /></template><template #emptyIcon><Tags class="size-5" /></template><template #empty />
      <div class="overflow-hidden rounded-lg border">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[1440px] table-fixed text-sm">
            <thead><tr class="border-b bg-muted/45"><th class="w-56 table-head">指标编号</th><th class="w-44 table-head">指标名称</th><th class="w-20 table-head">单位</th><th class="w-72 table-head">指标说明</th><th class="w-80 table-head">指标口径</th><th class="w-72 table-head">同义词</th><th class="w-24 table-head">状态</th><th class="w-32 table-head text-right">操作</th></tr></thead>
            <tbody><tr v-for="metric in pageItems" :key="metric.metric_code" class="border-b last:border-0 hover:bg-muted/35">
              <td class="table-cell font-medium"><span class="line-clamp-2" :title="metric.metric_code">{{ metric.metric_code }}</span></td><td class="table-cell"><span class="line-clamp-2" :title="metric.metric_name">{{ metric.metric_name }}</span></td><td class="table-cell">{{ metric.unit || '-' }}</td>
              <td class="table-cell text-muted-foreground"><span class="line-clamp-2" :title="metric.metric_explanation">{{ metric.metric_explanation || '-' }}</span></td><td class="table-cell text-muted-foreground"><span class="line-clamp-2" :title="metric.description">{{ metric.description || '-' }}</span></td><td class="table-cell"><span class="line-clamp-2" :title="metric.synonyms.join('、')">{{ metric.synonyms.join('、') || '-' }}</span></td>
              <td class="table-cell"><BaseBadge :variant="metric.enabled ? 'default' : 'secondary'"><CheckCircle2 class="mr-1 size-3" />{{ metric.enabled ? '启用' : '停用' }}</BaseBadge></td>
              <td class="table-cell"><div class="flex justify-end gap-1"><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" aria-label="编辑指标" @click="openEditDialog(metric)"><Pencil /></BaseButton><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" :aria-label="metric.enabled ? '停用指标' : '启用指标'" @click="toggleEnabled(metric)"><LoaderCircle v-if="togglingMetricCode === metric.metric_code" class="animate-spin" /><PowerOff v-else-if="metric.enabled" /><Power v-else /></BaseButton><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" aria-label="删除指标" @click="deletingMetric = metric"><Trash2 /></BaseButton></div></td>
            </tr></tbody>
          </table>
        </div><ListPagination :page="page" :page-size="PAGE_SIZE" :total-items="visibleItems.length" :total-pages="totalPages" @change="page = $event" />
      </div>
    </ManagementListPanel>

    <BaseModal v-model:open="isDialogOpen" :busy="resource.isMutating.value" size="lg" :title="editingMetric ? '编辑指标' : '新增指标'" :description="editingMetric ? '修改指标后，问数链路会立即使用最新的语义资产。同义词用中文逗号或英文逗号分隔。' : '新增第一条指标后，问数链路即可开始匹配业务术语。同义词用中文逗号或英文逗号分隔。'">
      <form id="metric-form" class="grid gap-4" @submit.prevent="submitForm">
        <label class="form-field">指标编号<input v-model="form.metricCode" class="form-control" placeholder="gmv" :disabled="Boolean(editingMetric) || resource.isMutating.value" /><span v-if="editingMetric" class="field-help">指标编号作为主键不可修改。</span></label>
        <label class="form-field">指标名称<input v-model="form.metricName" class="form-control" placeholder="成交额" :disabled="resource.isMutating.value" /></label>
        <label class="form-field">单位<input v-model="form.unit" class="form-control" placeholder="元" :disabled="resource.isMutating.value" /></label>
        <label class="form-field">同义词<input v-model="form.synonyms" class="form-control" placeholder="交易额，销售额" :disabled="resource.isMutating.value" /><span class="field-help">用于提升用户自然语言命中的稳定性。</span></label>
        <label class="form-field">指标说明<textarea v-model="form.metricExplanation" class="form-control min-h-20 resize-y py-2" placeholder="用于衡量交易规模的核心业务指标。" :disabled="resource.isMutating.value" /></label>
        <label class="form-field">指标口径<textarea v-model="form.description" class="form-control min-h-28 resize-y py-2" placeholder="统计已成交订单的金额合计。" :disabled="resource.isMutating.value" /></label>
        <p v-if="resource.mutationError.value" class="text-sm text-destructive">保存失败：{{ resource.mutationError.value }}</p>
      </form>
      <template #footer><BaseButton variant="outline" :disabled="resource.isMutating.value" @click="isDialogOpen = false">取消</BaseButton><BaseButton type="submit" form="metric-form" :disabled="!form.metricCode.trim() || !form.metricName.trim() || resource.isMutating.value"><LoaderCircle v-if="resource.isMutating.value" class="animate-spin" /><Pencil v-else-if="editingMetric" /><Plus v-else />{{ resource.isMutating.value ? '保存中...' : editingMetric ? '保存修改' : '保存指标' }}</BaseButton></template>
    </BaseModal>

    <ConfirmDialog :open="Boolean(deletingMetric)" title="删除指标" :busy="resource.isMutating.value" @update:open="!$event && (deletingMetric = null)" @confirm="confirmDelete">即将软删除指标 <strong class="font-medium text-foreground">「{{ deletingMetric?.metric_name }}」</strong>。删除后该指标会从问数链路的候选列表中移除，关联的事实数据会保留。</ConfirmDialog>
  </AppShell>
</template>
