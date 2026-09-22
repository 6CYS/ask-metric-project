<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import { Building2, CheckCircle2, LoaderCircle, Pencil, Plus, Power, PowerOff, RefreshCw, Tags, Trash2 } from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import ListPagination from "@/components/ListPagination.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import { useAuth } from "@/composables/useAuth"
import { useManagementResource } from "@/composables/useManagementResource"
import { createOrg, deleteOrg, listOrgs, updateOrg } from "@/lib/api"
import type { OrgItem, OrgPayload } from "@/types/api"

const auth = useAuth()
// 页面入口和提交共用角色判断；实际写入权限仍由后端校验。
const canManageCatalog = computed(() => auth.user.value?.role_code === "SYSTEM_ADMIN")
const PAGE_SIZE = 15
const resource = useManagementResource<OrgItem>(listOrgs)
const showDisabled = ref(false)
const searchKeyword = ref("")
const page = ref(1)
const isDialogOpen = ref(false)
const editingOrg = ref<OrgItem | null>(null)
const deletingOrg = ref<OrgItem | null>(null)
const togglingOrgCode = ref<string | null>(null)
const form = reactive({ orgCode: "", orgName: "", aliases: "" })

const visibleItems = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  const statusItems = showDisabled.value ? resource.items.value : resource.items.value.filter((item) => item.enabled)
  if (!keyword) return statusItems
  return statusItems.filter((item) => [item.org_code, item.org_name, ...item.aliases].join(" ").toLowerCase().includes(keyword))
})
const totalPages = computed(() => Math.max(1, Math.ceil(visibleItems.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const enabledCount = computed(() => resource.items.value.filter((item) => item.enabled).length)
const aliasCount = computed(() => resource.items.value.filter((item) => item.enabled).reduce((total, item) => total + item.aliases.length, 0))
const hasSearch = computed(() => Boolean(searchKeyword.value.trim()))
const listDescription = computed(() => resource.isLoading.value ? "加载中" : resource.isBlockingError.value ? "加载失败" : hasSearch.value ? `匹配 ${visibleItems.value.length} 个机构 / 共 ${resource.items.value.length} 个` : showDisabled.value ? `显示全部 ${resource.items.value.length} 个机构（含已停用）` : `${visibleItems.value.length} 个启用的机构 / 共 ${resource.items.value.length} 个`)
const emptyTitle = computed(() => hasSearch.value ? "未找到匹配机构" : showDisabled.value ? "暂无任何机构" : "暂无启用的机构")
const emptyDescription = computed(() => !canManageCatalog.value && !hasSearch.value ? "暂无可展示的数据，可调整显示条件或联系管理员维护目录。" : hasSearch.value ? "请调整关键词，或打开「显示已停用」后再试。" : showDisabled.value ? "新增第一条机构后，即可开始沉淀机构标准名和别名。" : "打开「显示已停用」开关可查看已停用项，或直接新增一个机构。")
const stats = computed(() => [
  { label: "机构总数", value: resource.isLoading.value ? "--" : String(resource.items.value.length), detail: "已维护的机构标准名数量。" },
  { label: "已启用", value: resource.isLoading.value ? "--" : String(enabledCount.value), detail: "当前可参与机构目录的机构数量。" },
  { label: "别名", value: resource.isLoading.value ? "--" : String(aliasCount.value), detail: "覆盖简称、旧称和常用输入方式。" },
])

watch(canManageCatalog, (allowed) => {
  if (allowed) return
  isDialogOpen.value = false
  editingOrg.value = null
  deletingOrg.value = null
})

watch(totalPages, (value) => { page.value = Math.min(page.value, value) })

function openCreateDialog() {
  if (!canManageCatalog.value) return
  Object.assign(form, { orgCode: "", orgName: "", aliases: "" })
  editingOrg.value = null
  resource.clearMutationError()
  isDialogOpen.value = true
}

function openEditDialog(org: OrgItem) {
  if (!canManageCatalog.value) return
  Object.assign(form, { orgCode: org.org_code, orgName: org.org_name, aliases: org.aliases.join("，") })
  editingOrg.value = org
  resource.clearMutationError()
  isDialogOpen.value = true
}

function buildPayload(enabled: boolean): OrgPayload {
  return { org_code: form.orgCode.trim(), org_name: form.orgName.trim(), aliases: [...new Set(form.aliases.split(/[,，]/).map((item) => item.trim()).filter(Boolean))], enabled }
}

async function submitForm() {
  if (!canManageCatalog.value) return
  if (!form.orgCode.trim() || !form.orgName.trim()) return
  const current = editingOrg.value
  const ok = await resource.mutate(() => current ? updateOrg(current.org_code, buildPayload(current.enabled)) : createOrg(buildPayload(true)))
  if (ok) { isDialogOpen.value = false; editingOrg.value = null }
}

async function toggleEnabled(org: OrgItem) {
  if (!canManageCatalog.value) return
  togglingOrgCode.value = org.org_code
  await resource.mutate(() => updateOrg(org.org_code, { org_code: org.org_code, org_name: org.org_name, aliases: org.aliases, enabled: !org.enabled }))
  togglingOrgCode.value = null
}

async function confirmDelete() {
  if (!canManageCatalog.value) return
  if (!deletingOrg.value) return
  const ok = await resource.mutate(() => deleteOrg(deletingOrg.value!.org_code))
  if (ok) deletingOrg.value = null
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
}

onMounted(() => resource.load())
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Organization Catalog" title="机构别名" :description="canManageCatalog ? '维护机构编号、标准机构名和常用别名，为后续机构归一和问数消歧提供统一目录。' : '查看机构编号、标准机构名和常用别名；目录由管理员维护。'" :stats="stats">
      <template #actions><BaseButton v-if="canManageCatalog" @click="openCreateDialog"><Plus />新增机构</BaseButton><BaseButton variant="outline" :disabled="resource.isRefreshing.value" @click="resource.load(true)"><RefreshCw :class="resource.isRefreshing.value && 'animate-spin'" />刷新</BaseButton></template>
    </PageHeader>

    <ManagementListPanel
      v-model:show-disabled="showDisabled" v-model:search="searchKeyword" title="机构列表" :description="listDescription" :is-loading="resource.isLoading.value" :is-empty="visibleItems.length === 0"
      :blocking-error="resource.isBlockingError.value ? resource.loadError.value : ''" :refresh-error="resource.isRefreshError.value ? resource.loadError.value : ''"
      error-title="机构列表请求失败" refresh-error-title="机构列表刷新失败" search-label="搜索机构" search-placeholder="搜索机构编号、标准机构名或别名"
      :search-hint="hasSearch ? `当前条件匹配 ${visibleItems.length} 条` : '可按机构编号、标准名和别名模糊查询'" :empty-title="emptyTitle" :empty-description="emptyDescription"
    >
      <template #errorIcon><Building2 /></template><template #refreshIcon><RefreshCw /></template><template #emptyIcon><Tags class="size-5" /></template><template #empty />
      <div class="overflow-hidden rounded-lg border">
        <div class="overflow-x-auto"><table class="w-full min-w-[720px] table-fixed text-sm">
          <thead><tr class="border-b bg-muted/45"><th class="w-36 table-head">机构编号</th><th class="w-48 table-head">标准机构名</th><th class="w-64 table-head">别名</th><th class="w-24 table-head">状态</th><th class="w-40 table-head">更新时间</th><th v-if="canManageCatalog" class="w-32 table-head text-right">操作</th></tr></thead>
          <tbody><tr v-for="org in pageItems" :key="org.org_code" class="border-b last:border-0 hover:bg-muted/35">
            <td class="table-cell font-medium"><span class="line-clamp-2" :title="org.org_code">{{ org.org_code }}</span></td><td class="table-cell"><span class="line-clamp-2" :title="org.org_name">{{ org.org_name }}</span></td><td class="table-cell"><span class="line-clamp-2" :title="org.aliases.join('、')">{{ org.aliases.join('、') || '-' }}</span></td>
            <td class="table-cell"><BaseBadge :variant="org.enabled ? 'default' : 'secondary'"><CheckCircle2 class="mr-1 size-3" />{{ org.enabled ? '启用' : '停用' }}</BaseBadge></td><td class="table-cell text-muted-foreground">{{ formatDateTime(org.updated_at) }}</td>
            <td v-if="canManageCatalog" class="table-cell"><div class="flex justify-end gap-1"><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" aria-label="编辑机构" @click="openEditDialog(org)"><Pencil /></BaseButton><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" :aria-label="org.enabled ? '停用机构' : '启用机构'" @click="toggleEnabled(org)"><LoaderCircle v-if="togglingOrgCode === org.org_code" class="animate-spin" /><PowerOff v-else-if="org.enabled" /><Power v-else /></BaseButton><BaseButton variant="ghost" size="icon" :disabled="resource.isMutating.value" aria-label="删除机构" @click="deletingOrg = org"><Trash2 /></BaseButton></div></td>
          </tr></tbody>
        </table></div><ListPagination :page="page" :page-size="PAGE_SIZE" :total-items="visibleItems.length" :total-pages="totalPages" @change="page = $event" />
      </div>
    </ManagementListPanel>

    <BaseModal v-if="canManageCatalog" v-model:open="isDialogOpen" :busy="resource.isMutating.value" size="lg" :title="editingOrg ? '编辑机构' : '新增机构'" :description="editingOrg ? '修改机构标准名和别名。别名用中文逗号或英文逗号分隔。' : '新增机构标准名和常用别名，后续问数解析会复用这套机构目录。'">
      <form id="org-form" class="grid gap-4" @submit.prevent="submitForm">
        <label class="form-field">机构编号<input v-model="form.orgCode" class="form-control" placeholder="ORG_ZJRCB" :disabled="Boolean(editingOrg) || resource.isMutating.value" /><span v-if="editingOrg" class="field-help">机构编号作为主键不可修改。</span></label>
        <label class="form-field">标准机构名<input v-model="form.orgName" class="form-control" placeholder="紫金农商行" :disabled="resource.isMutating.value" /></label>
        <label class="form-field">别名<input v-model="form.aliases" class="form-control" placeholder="紫金，紫金银行，紫金农商" :disabled="resource.isMutating.value" /><span class="field-help">支持中文逗号或英文逗号分隔，保存时会自动去重。</span></label>
        <p v-if="resource.mutationError.value" class="text-sm text-destructive">保存失败：{{ resource.mutationError.value }}</p>
      </form>
      <template #footer><BaseButton variant="outline" :disabled="resource.isMutating.value" @click="isDialogOpen = false">取消</BaseButton><BaseButton type="submit" form="org-form" :disabled="!form.orgCode.trim() || !form.orgName.trim() || resource.isMutating.value"><LoaderCircle v-if="resource.isMutating.value" class="animate-spin" /><Pencil v-else-if="editingOrg" /><Plus v-else />{{ resource.isMutating.value ? '保存中...' : editingOrg ? '保存修改' : '保存机构' }}</BaseButton></template>
    </BaseModal>

    <ConfirmDialog v-if="canManageCatalog" :open="Boolean(deletingOrg)" title="删除机构" :busy="resource.isMutating.value" @update:open="!$event && (deletingOrg = null)" @confirm="confirmDelete">即将软删除机构 <strong class="font-medium text-foreground">「{{ deletingOrg?.org_name }}」</strong>。删除后该机构会被标记为停用，历史配置数据会保留。</ConfirmDialog>
  </AppShell>
</template>
