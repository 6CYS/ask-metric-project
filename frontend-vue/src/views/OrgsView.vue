<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue"
import {
  Building2,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Tags,
  Trash2,
} from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import BaseTextPreview from "@/components/ui/BaseTextPreview.vue"
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import { useManagementResource } from "@/composables/useManagementResource"
import { createOrg, deleteOrg, listOrgs, updateOrg } from "@/lib/api"
import { organizationTreeRows, type OrganizationTreeRow } from "@/lib/organizationTree"
import { organizationConflicts, organizationParentOptions } from "@/lib/organizationForm"
import type { OrganizationLevels, OrgItem, OrgPayload } from "@/types/api"

const hierarchyLevels = ref<OrganizationLevels | null>(null)
const resource = useManagementResource<OrgItem>(async () => {
  const result = await listOrgs()
  hierarchyLevels.value = result.hierarchy_levels
  return result
})
const showDisabled = ref(false)
const searchKeyword = ref("")
const expanded = ref(new Map<string, boolean>())
const isDialogOpen = ref(false)
const editingOrg = ref<OrgItem | null>(null)
const deletingOrg = ref<OrgItem | null>(null)
const togglingOrgCode = ref<string | null>(null)
const form = reactive({ orgCode: "", orgName: "", aliases: "", parentCode: "", level: "" })
const parentOptions = computed(() =>
  organizationParentOptions(
    resource.items.value,
    editingOrg.value?.org_code,
    editingOrg.value?.parent_org_code ?? undefined,
  ),
)
const parentSelectOptions = computed(() => [
  { value: "", label: "无上级（根机构）" },
  ...parentOptions.value.map(({ org, depth }) => ({
    value: org.org_code,
    label: `${"—".repeat(depth)}${org.org_name}（${org.org_code}）${org.enabled ? "" : " · 已停用"}`,
    disabled: !org.enabled,
  })),
])
const levelSelectOptions = computed(() => [
  { value: "", label: "请选择机构类型", disabled: true },
  ...(hierarchyLevels.value
    ? [
        { value: hierarchyLevels.value.root, label: "省级汇总" },
        { value: hierarchyLevels.value.legal_entity, label: "法人机构" },
        { value: hierarchyLevels.value.branch, label: "分支机构" },
      ]
    : []),
])
const conflicts = computed(() =>
  organizationConflicts(resource.items.value, buildPayload(true), editingOrg.value?.org_code),
)
const canSubmit = computed(() =>
  Boolean(
    form.orgCode.trim() &&
    form.orgName.trim() &&
    (form.level || (editingOrg.value && !hierarchyChanged.value)) &&
    !conflicts.value.duplicateCode &&
    !resource.isMutating.value,
  ),
)
const hierarchyChanged = computed(() =>
  Boolean(
    editingOrg.value &&
    (form.parentCode !== (editingOrg.value.parent_org_code ?? "") ||
      form.level !== (editingOrg.value.hierarchy_level ?? "")),
  ),
)

const tree = computed(() =>
  organizationTreeRows(resource.items.value, {
    keyword: searchKeyword.value,
    showDisabled: showDisabled.value,
    expanded: expanded.value,
  }),
)
const enabledCount = computed(() => resource.items.value.filter((item) => item.enabled).length)
const aliasCount = computed(() =>
  resource.items.value
    .filter((item) => item.enabled)
    .reduce((total, item) => total + item.aliases.length, 0),
)
const hasSearch = computed(() => Boolean(searchKeyword.value.trim()))
const listDescription = computed(() =>
  resource.isLoading.value
    ? "加载中"
    : resource.isBlockingError.value
      ? "加载失败"
      : hasSearch.value
        ? `匹配 ${tree.value.matchedCount} 个机构 / 共 ${resource.items.value.length} 个`
        : showDisabled.value
          ? `显示全部 ${resource.items.value.length} 个机构（含已停用）`
          : `${tree.value.matchedCount} 个启用的机构 / 共 ${resource.items.value.length} 个`,
)
const emptyTitle = computed(() =>
  hasSearch.value ? "未找到匹配机构" : showDisabled.value ? "暂无任何机构" : "暂无启用的机构",
)
const emptyDescription = computed(() =>
  hasSearch.value
    ? "请调整关键词，或打开「显示已停用」后再试。"
    : showDisabled.value
      ? "新增第一条机构后，即可开始沉淀机构标准名和别名。"
      : "打开「显示已停用」开关可查看已停用项，或直接新增一个机构。",
)
const stats = computed(() => [
  {
    label: "机构总数",
    value: resource.isLoading.value ? "--" : String(resource.items.value.length),
    detail: "已维护的机构标准名数量。",
  },
  {
    label: "已启用",
    value: resource.isLoading.value ? "--" : String(enabledCount.value),
    detail: "当前可参与机构目录的机构数量。",
  },
  {
    label: "别名",
    value: resource.isLoading.value ? "--" : String(aliasCount.value),
    detail: "覆盖简称、旧称和常用输入方式。",
  },
])

function toggleExpanded(row: OrganizationTreeRow) {
  const next = new Map(expanded.value)
  next.set(row.org.org_code, !row.expanded)
  expanded.value = next
}

function openCreateDialog(parent?: OrgItem) {
  const root = resource.items.value.find(
    (org) =>
      org.enabled && !org.parent_org_code && org.hierarchy_level === hierarchyLevels.value?.root,
  )
  const selected = parent ?? root
  Object.assign(form, {
    orgCode: "",
    orgName: "",
    aliases: "",
    parentCode: selected?.org_code ?? "",
    level: "",
  })
  editingOrg.value = null
  setNewOrganizationLevel()
  resource.clearMutationError()
  isDialogOpen.value = true
}

function setNewOrganizationLevel() {
  if (editingOrg.value || !hierarchyLevels.value) return
  const parent = resource.items.value.find((org) => org.org_code === form.parentCode)
  form.level = !parent
    ? hierarchyLevels.value.root
    : parent.hierarchy_level === hierarchyLevels.value.root
      ? hierarchyLevels.value.legal_entity
      : hierarchyLevels.value.branch
}

function openEditDialog(org: OrgItem) {
  Object.assign(form, {
    orgCode: org.org_code,
    orgName: org.org_name,
    aliases: org.aliases.join("，"),
    parentCode: org.parent_org_code ?? "",
    level: org.hierarchy_level ?? "",
  })
  editingOrg.value = org
  resource.clearMutationError()
  isDialogOpen.value = true
}

function buildPayload(enabled: boolean): OrgPayload {
  return {
    org_code: form.orgCode.trim(),
    org_name: form.orgName.trim(),
    aliases: [
      ...new Set(
        form.aliases
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ],
    enabled,
    parent_org_code: form.parentCode || null,
    hierarchy_level: form.level || null,
  }
}

async function submitForm() {
  if (!canSubmit.value) return
  const current = editingOrg.value
  const payload = buildPayload(current?.enabled ?? true)
  const ok = await resource.mutate(() =>
    current ? updateOrg(current.org_code, payload) : createOrg(payload),
  )
  if (!ok) return
  const next = new Map(expanded.value)
  const byCode = new Map(resource.items.value.map((org) => [org.org_code, org]))
  const seen = new Set<string>()
  let parent = payload.parent_org_code
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    next.set(parent, true)
    parent = byCode.get(parent)?.parent_org_code
  }
  expanded.value = next
  searchKeyword.value = ""
  isDialogOpen.value = false
  editingOrg.value = null
}

function openDeleteDialog(org: OrgItem) {
  resource.clearMutationError()
  deletingOrg.value = org
}

async function toggleEnabled(org: OrgItem) {
  togglingOrgCode.value = org.org_code
  await resource.mutate(() =>
    updateOrg(org.org_code, {
      org_code: org.org_code,
      org_name: org.org_name,
      aliases: org.aliases,
      enabled: !org.enabled,
    }),
  )
  togglingOrgCode.value = null
}

async function confirmDelete() {
  const org = deletingOrg.value
  if (!org) return
  const ok = await resource.mutate(() => deleteOrg(org.org_code))
  if (ok) deletingOrg.value = null
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

onMounted(() => resource.load())
</script>

<template>
  <AppShell>
    <PageHeader
      eyebrow="Organization Catalog"
      title="机构别名"
      description="按上下级关系查看机构，维护机构编号、标准机构名和常用别名。"
      :stats="stats"
    >
      <template #actions
        ><BaseButton
          @click="openCreateDialog()"
          :disabled="!hierarchyLevels || resource.isLoading.value || resource.isMutating.value"
          ><Plus />新增机构</BaseButton
        ><BaseButton
          variant="outline"
          :disabled="resource.isRefreshing.value || resource.isMutating.value"
          @click="resource.load(true)"
          ><RefreshCw :class="resource.isRefreshing.value && 'animate-spin'" />刷新</BaseButton
        ></template
      >
    </PageHeader>

    <BaseAlert
      v-if="resource.mutationError.value && !isDialogOpen && !deletingOrg"
      title="操作未完成"
      variant="destructive"
      >{{ resource.mutationError.value }}</BaseAlert
    >

    <ManagementListPanel
      v-model:show-disabled="showDisabled"
      v-model:search="searchKeyword"
      title="机构目录"
      badge="层级目录"
      :description="listDescription"
      :is-loading="resource.isLoading.value"
      :is-empty="tree.rows.length === 0"
      :blocking-error="resource.isBlockingError.value ? resource.loadError.value : ''"
      :refresh-error="resource.isRefreshError.value ? resource.loadError.value : ''"
      error-title="机构列表请求失败"
      refresh-error-title="机构列表刷新失败"
      search-label="搜索机构"
      search-placeholder="搜索机构编号、标准机构名或别名"
      :search-hint="
        hasSearch
          ? `匹配 ${tree.matchedCount} 个机构，保留上级路径`
          : '点击机构前的箭头展开或收起下级'
      "
      :empty-title="emptyTitle"
      :empty-description="emptyDescription"
    >
      <template #errorIcon><Building2 /></template><template #refreshIcon><RefreshCw /></template
      ><template #emptyIcon><Tags class="size-5" /></template><template #empty />
      <div class="overflow-hidden rounded-lg border">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[900px] table-fixed text-sm">
            <thead>
              <tr class="border-b bg-muted/45">
                <th class="w-[27%] table-head">标准机构名</th>
                <th class="w-[12%] table-head">机构编号</th>
                <th class="w-[16%] table-head">别名</th>
                <th class="w-[9%] table-head">状态</th>
                <th class="w-[17%] table-head">更新时间</th>
                <th class="w-[19%] table-head text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in tree.rows"
                :key="row.org.org_code"
                :data-org-code="row.org.org_code"
                class="border-b last:border-0 hover:bg-muted/35"
                :class="row.hasChildren && 'bg-muted/15'"
              >
                <td class="table-cell">
                  <div
                    class="flex items-start gap-1"
                    :style="{ paddingLeft: `${row.depth * 20}px` }"
                  >
                    <BaseTooltip
                      v-if="row.hasChildren"
                      :content="hasSearch ? '搜索时自动展开上级路径' : undefined"
                    >
                      <span
                        class="inline-flex"
                        :tabindex="hasSearch ? 0 : undefined"
                        :aria-label="hasSearch ? '搜索时自动展开上级路径' : undefined"
                      >
                        <BaseButton
                          variant="ghost"
                          size="icon"
                          class="size-6"
                          :aria-expanded="row.expanded"
                          :aria-label="`${row.expanded ? '收起' : '展开'}${row.org.org_name}的下级机构`"
                          :disabled="hasSearch"
                          @click="toggleExpanded(row)"
                        >
                          <ChevronRight :class="row.expanded && 'rotate-90'" />
                        </BaseButton>
                      </span>
                    </BaseTooltip>
                    <span v-else class="size-6 shrink-0" aria-hidden="true" />
                    <div class="min-w-0 pt-0.5">
                      <BaseTooltip :content="row.org.org_name">
                        <span class="line-clamp-2 font-medium" tabindex="0">{{
                          row.org.org_name
                        }}</span>
                      </BaseTooltip>
                      <span v-if="row.issue" class="text-xs text-muted-foreground">{{
                        row.issue
                      }}</span>
                      <span v-else-if="row.isContext" class="text-xs text-muted-foreground"
                        >上级路径</span
                      >
                    </div>
                  </div>
                </td>
                <td class="table-cell">
                  <BaseTooltip :content="row.org.org_code">
                    <span class="line-clamp-2" tabindex="0">{{ row.org.org_code }}</span>
                  </BaseTooltip>
                </td>
                <td class="table-cell">
                  <BaseTextPreview
                    :label="`${row.org.org_name}的别名`"
                    :text="row.org.aliases.join('、') || '-'"
                  />
                </td>
                <td class="table-cell">
                  <BaseBadge :variant="row.org.enabled ? 'default' : 'secondary'"
                    ><CheckCircle2 class="mr-1 size-3" />{{
                      row.org.enabled ? "启用" : "停用"
                    }}</BaseBadge
                  >
                </td>
                <td class="table-cell text-muted-foreground">
                  {{ formatDateTime(row.org.updated_at) }}
                </td>
                <td class="table-cell">
                  <div class="flex justify-end gap-1">
                    <BaseTooltip content="新增下级">
                      <span
                        class="inline-flex"
                        :tabindex="resource.isMutating.value || !row.org.enabled || !hierarchyLevels ? 0 : undefined"
                        :aria-label="resource.isMutating.value || !row.org.enabled || !hierarchyLevels ? '新增下级' : undefined"
                      >
                        <BaseButton
                          variant="ghost"
                          size="icon"
                          :disabled="resource.isMutating.value || !row.org.enabled || !hierarchyLevels"
                          aria-label="新增下级"
                          @click="openCreateDialog(row.org)"
                          ><Plus
                        /></BaseButton>
                      </span>
                    </BaseTooltip>
                    <BaseButton
                      variant="ghost"
                      size="icon"
                      :disabled="resource.isMutating.value"
                      aria-label="编辑机构"
                      @click="openEditDialog(row.org)"
                      ><Pencil
                    /></BaseButton>
                    <BaseButton
                      variant="ghost"
                      size="icon"
                      :disabled="resource.isMutating.value"
                      :aria-label="row.org.enabled ? '停用机构' : '启用机构'"
                      @click="toggleEnabled(row.org)"
                      ><LoaderCircle
                        v-if="togglingOrgCode === row.org.org_code"
                        class="animate-spin" /><PowerOff v-else-if="row.org.enabled" /><Power
                        v-else
                    /></BaseButton>
                    <BaseButton
                      variant="ghost"
                      size="icon"
                      :disabled="resource.isMutating.value"
                      aria-label="删除机构"
                      @click="openDeleteDialog(row.org)"
                      ><Trash2
                    /></BaseButton>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </ManagementListPanel>

    <BaseModal
      v-model:open="isDialogOpen"
      :busy="resource.isMutating.value"
      size="lg"
      :title="editingOrg ? '编辑机构' : '新增机构'"
      :description="
        editingOrg
          ? '维护机构名称、所属上级和常用别名。'
          : '机构编号需与指标数据对应，新增目录不会自动产生指标数据。'
      "
    >
      <form id="org-form" class="grid gap-4" @submit.prevent="submitForm">
        <label class="form-field"
          >机构编号<input
            v-model="form.orgCode"
            class="form-control"
            placeholder="填写正式机构编号"
            maxlength="128"
            :disabled="Boolean(editingOrg) || resource.isMutating.value"
          /><span v-if="editingOrg" class="field-help">机构编号作为主键不可修改。</span></label
        >
        <p v-if="conflicts.duplicateCode" role="alert" class="text-sm text-destructive">
          编号已被「{{ conflicts.duplicateCode.org_name }}」使用。{{
            conflicts.duplicateCode.enabled
              ? "请编辑已有机构。"
              : "该机构已停用，请在列表中显示已停用机构后恢复。"
          }}
        </p>
        <label class="form-field"
          >上级机构
          <BaseSelect
            v-model="form.parentCode"
            :options="parentSelectOptions"
            :disabled="resource.isMutating.value"
            @update:model-value="setNewOrganizationLevel"
          />
        </label>
        <label class="form-field"
          >机构类型
          <BaseSelect
            v-model="form.level"
            :options="levelSelectOptions"
            :disabled="resource.isMutating.value || !hierarchyLevels"
          />
        </label>
        <p v-if="hierarchyChanged" role="status" class="field-help">
          修改所属层级会影响上下级机构的查询范围和数据权限。
        </p>
        <label class="form-field"
          >标准机构名<input
            v-model="form.orgName"
            class="form-control"
            placeholder="紫金农商行"
            maxlength="255"
            :disabled="resource.isMutating.value"
        /></label>
        <label class="form-field"
          >别名<input
            v-model="form.aliases"
            class="form-control"
            placeholder="紫金，紫金银行，紫金农商"
            :disabled="resource.isMutating.value"
          /><span class="field-help">支持中文逗号或英文逗号分隔，保存时会自动去重。</span></label
        >
        <div
          v-if="conflicts.nameConflicts.length || conflicts.aliasConflicts.length"
          role="status"
          class="rounded-lg border bg-muted/30 p-3 text-sm"
        >
          <p class="font-medium">以下名称或别名已被使用，请核对是否为不同机构</p>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li v-for="org in conflicts.nameConflicts" :key="`name-${org.org_code}`">
              同名机构：{{ org.org_name }}（{{ org.org_code }}）
            </li>
            <li v-for="entry in conflicts.aliasConflicts" :key="`alias-${entry.org.org_code}`">
              「{{ entry.terms.join("、") }}」也指向 {{ entry.org.org_name }}（{{
                entry.org.org_code
              }}）
            </li>
          </ul>
        </div>
        <p class="field-help">此处修改不会回写数仓；后续源表同步仍以源表为准。</p>
        <p v-if="resource.mutationError.value" class="text-sm text-destructive">
          保存失败：{{ resource.mutationError.value }}
        </p>
      </form>
      <template #footer
        ><BaseButton
          variant="outline"
          :disabled="resource.isMutating.value"
          @click="isDialogOpen = false"
          >取消</BaseButton
        ><BaseButton type="submit" form="org-form" :disabled="!canSubmit"
          ><LoaderCircle v-if="resource.isMutating.value" class="animate-spin" /><Pencil
            v-else-if="editingOrg"
          /><Plus v-else />{{
            resource.isMutating.value ? "保存中..." : editingOrg ? "保存修改" : "保存机构"
          }}</BaseButton
        ></template
      >
    </BaseModal>

    <ConfirmDialog
      :open="Boolean(deletingOrg)"
      title="删除机构"
      :busy="resource.isMutating.value"
      @update:open="!$event && (deletingOrg = null)"
      @confirm="confirmDelete"
      >即将软删除机构
      <strong class="font-medium text-foreground">「{{ deletingOrg?.org_name }}」</strong
      >。删除后该机构会被标记为停用，历史配置数据会保留。
      <p v-if="resource.mutationError.value" role="alert" class="mt-3 text-destructive">
        {{ resource.mutationError.value }}
      </p></ConfirmDialog
    >
  </AppShell>
</template>
