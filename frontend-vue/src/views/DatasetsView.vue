<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import { CheckCircle2, Database, LoaderCircle, Pencil, Plus, Power, PowerOff, RefreshCw, Table2, Trash2 } from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import ListPagination from "@/components/ListPagination.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import { useManagementResource } from "@/composables/useManagementResource"
import { createDataset, deleteDataset, listDatasets, updateDataset } from "@/lib/api"
import type { DatasetItem, DatasetPayload } from "@/types/api"

const PAGE_SIZE = 15
const resource = useManagementResource<DatasetItem>(listDatasets)
const showDisabled = ref(false)
const page = ref(1)
const isDialogOpen = ref(false)
const editingDataset = ref<DatasetItem | null>(null)
const deletingDataset = ref<DatasetItem | null>(null)
const togglingDatasetId = ref<number | null>(null)
const form = reactive({ name: "", schemaName: "public", tableName: "metric_values" })

const visibleItems = computed(() => showDisabled.value ? resource.items.value : resource.items.value.filter((item) => item.enabled))
const totalPages = computed(() => Math.max(1, Math.ceil(visibleItems.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const enabledCount = computed(() => resource.items.value.filter((item) => item.enabled).length)
const mysqlCount = computed(() => resource.items.value.filter((item) => item.datasource_type === "mysql").length)
const listDescription = computed(() => resource.isLoading.value ? "加载中" : resource.isBlockingError.value ? "加载失败" : showDisabled.value ? `显示全部 ${resource.items.value.length} 个数据集（含已停用）` : `${visibleItems.value.length} 个启用的数据集 / 共 ${resource.items.value.length} 个`)
const stats = computed(() => [
  { label: "数据集总数", value: resource.isLoading.value ? "--" : String(resource.items.value.length), detail: "已接入的可查询数据资产。" },
  { label: "已启用", value: resource.isLoading.value ? "--" : String(enabledCount.value), detail: "当前参与查询计划的数据集。" },
  { label: "GoldenDB/MySQL", value: resource.isLoading.value ? "--" : String(mysqlCount.value), detail: "当前项目唯一支持的查询方言。" },
])

watch(totalPages, (value) => { page.value = Math.min(page.value, value) })

function openCreateDialog() {
  Object.assign(form, { name: "", schemaName: "public", tableName: "metric_values" })
  editingDataset.value = null
  resource.clearMutationError()
  isDialogOpen.value = true
}

function openEditDialog(dataset: DatasetItem) {
  if (dataset.id == null) return
  Object.assign(form, { name: dataset.name, schemaName: dataset.schema_name, tableName: dataset.table_name })
  editingDataset.value = dataset
  resource.clearMutationError()
  isDialogOpen.value = true
}

function buildPayload(enabled: boolean): DatasetPayload {
  // 当前后端仅支持 GoldenDB/MySQL，类型和方言不在表单中暴露。
  return { name: form.name.trim(), datasource_type: "mysql", schema_name: form.schemaName.trim(), table_name: form.tableName.trim(), dialect: "mysql", enabled }
}

async function submitForm() {
  if (!form.name.trim() || !form.schemaName.trim() || !form.tableName.trim()) return
  const current = editingDataset.value
  const ok = await resource.mutate(() => current?.id != null ? updateDataset(current.id, buildPayload(current.enabled)) : createDataset(buildPayload(true)))
  if (ok) { isDialogOpen.value = false; editingDataset.value = null }
}

async function toggleEnabled(dataset: DatasetItem) {
  if (dataset.id == null) return
  togglingDatasetId.value = dataset.id
  const payload: DatasetPayload = { name: dataset.name, datasource_type: dataset.datasource_type, schema_name: dataset.schema_name, table_name: dataset.table_name, dialect: dataset.dialect, enabled: !dataset.enabled }
  await resource.mutate(() => updateDataset(dataset.id!, payload))
  togglingDatasetId.value = null
}

async function confirmDelete() {
  const id = deletingDataset.value?.id
  if (id == null) return
  const ok = await resource.mutate(() => deleteDataset(id))
  if (ok) deletingDataset.value = null
}

onMounted(() => resource.load())
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Data Foundation" title="数据集" description="维护问数系统可查询的数据来源、Schema 和事实表位置，让指标语义与真实数据结构稳定对齐。" :stats="stats">
      <template #actions><BaseButton @click="openCreateDialog"><Plus />新增数据集</BaseButton><BaseButton variant="outline" :disabled="resource.isRefreshing.value" @click="resource.load(true)"><RefreshCw :class="resource.isRefreshing.value && 'animate-spin'" />刷新</BaseButton></template>
    </PageHeader>

    <ManagementListPanel
      v-model:show-disabled="showDisabled" title="数据集列表" badge="GoldenDB/MySQL" :description="listDescription" :is-loading="resource.isLoading.value" :is-empty="visibleItems.length === 0"
      :blocking-error="resource.isBlockingError.value ? resource.loadError.value : ''" :refresh-error="resource.isRefreshError.value ? resource.loadError.value : ''"
      error-title="数据集列表请求失败" refresh-error-title="数据集列表刷新失败" :empty-title="showDisabled ? '暂无任何数据集' : '暂无启用的数据集'" :empty-description="showDisabled ? '新增数据集后，问数系统才能把指标映射到真实表。' : '打开「显示已停用」开关可查看已停用项，或直接新增一个数据集。'"
    >
      <template #errorIcon><Database /></template><template #refreshIcon><RefreshCw /></template><template #emptyIcon><Table2 class="size-5" /></template><template #empty />
      <div class="overflow-hidden rounded-lg border">
        <div class="overflow-x-auto"><table class="w-full min-w-[820px] text-sm">
          <thead><tr class="border-b bg-muted/45"><th class="table-head">名称</th><th class="table-head">类型</th><th class="table-head">Schema</th><th class="table-head">表名</th><th class="table-head">Dialect</th><th class="table-head">状态</th><th class="w-32 table-head text-right">操作</th></tr></thead>
          <tbody><tr v-for="dataset in pageItems" :key="dataset.id ?? `default-${dataset.name}`" class="border-b last:border-0 hover:bg-muted/35">
            <td class="table-cell font-medium">{{ dataset.name }}</td><td class="table-cell">{{ dataset.datasource_type }}</td><td class="table-cell">{{ dataset.schema_name || '-' }}</td><td class="table-cell">{{ dataset.table_name }}</td><td class="table-cell">{{ dataset.dialect }}</td>
            <td class="table-cell"><BaseBadge :variant="dataset.enabled ? 'default' : 'secondary'"><CheckCircle2 class="mr-1 size-3" />{{ dataset.enabled ? '启用' : '停用' }}</BaseBadge></td>
            <td class="table-cell"><div v-if="dataset.id == null" class="flex justify-end"><BaseBadge variant="outline">默认</BaseBadge></div><div v-else class="flex justify-end gap-1"><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" aria-label="编辑数据集" @click="openEditDialog(dataset)"><Pencil /></BaseButton><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" :aria-label="dataset.enabled ? '停用数据集' : '启用数据集'" @click="toggleEnabled(dataset)"><LoaderCircle v-if="togglingDatasetId === dataset.id" class="animate-spin" /><PowerOff v-else-if="dataset.enabled" /><Power v-else /></BaseButton><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" aria-label="删除数据集" @click="deletingDataset = dataset"><Trash2 /></BaseButton></div></td>
          </tr></tbody>
        </table></div><ListPagination :page="page" :page-size="PAGE_SIZE" :total-items="visibleItems.length" :total-pages="totalPages" @change="page = $event" />
      </div>
    </ManagementListPanel>

    <BaseModal v-model:open="isDialogOpen" :busy="resource.isMutating.value" :title="editingDataset ? '编辑数据集' : '新增数据集'" :description="editingDataset ? '修改后，问数链路会引用最新的数据资产配置。' : '使用 GoldenDB/MySQL 指标事实表。'">
      <form id="dataset-form" class="grid gap-4" @submit.prevent="submitForm">
        <label class="form-field">数据集名称<input v-model="form.name" class="form-control" placeholder="交易指标事实表" :disabled="resource.isMutating.value" /><span class="field-help">建议使用业务能识别的资产名称。</span></label>
        <label class="form-field">Schema<input v-model="form.schemaName" class="form-control" placeholder="public" :disabled="resource.isMutating.value" /></label>
        <label class="form-field">表名<input v-model="form.tableName" class="form-control" placeholder="metric_values" :disabled="resource.isMutating.value" /></label>
        <p v-if="resource.mutationError.value" class="text-sm text-destructive">保存失败：{{ resource.mutationError.value }}</p>
      </form>
      <template #footer><BaseButton variant="outline" :disabled="resource.isMutating.value" @click="isDialogOpen = false">取消</BaseButton><BaseButton type="submit" form="dataset-form" :disabled="!form.name.trim() || !form.schemaName.trim() || !form.tableName.trim() || resource.isMutating.value"><LoaderCircle v-if="resource.isMutating.value" class="animate-spin" /><Pencil v-else-if="editingDataset" /><Plus v-else />{{ resource.isMutating.value ? '保存中...' : editingDataset ? '保存修改' : '保存数据集' }}</BaseButton></template>
    </BaseModal>

    <ConfirmDialog :open="Boolean(deletingDataset?.id != null)" title="停用数据集" :busy="resource.isMutating.value" @update:open="!$event && (deletingDataset = null)" @confirm="confirmDelete">即将停用数据集 <strong class="font-medium text-foreground">「{{ deletingDataset?.name }}」</strong>。停用后该数据集不会参与后续查询，可通过“显示已停用”重新查看并启用。</ConfirmDialog>
  </AppShell>
</template>
