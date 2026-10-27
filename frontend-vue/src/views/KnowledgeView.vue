<script setup lang="ts">
import { computed, onActivated, ref, watch } from "vue"
import { Library, LoaderCircle, Pencil, Plus, Power, PowerOff, RefreshCw } from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import ListPagination from "@/components/ListPagination.vue"
import ManagementListPanel from "@/components/ManagementListPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSwitch from "@/components/ui/BaseSwitch.vue"
import { useKnowledgeManagement } from "@/composables/useKnowledgeManagement"
import type { BusinessKnowledgeItem } from "@/types/api"

const PAGE_SIZE = 15
const {
  items, hasLoaded, isLoading, isRefreshing, isMutating, loadError, actionError,
  formError, editorOpen, editingId, form, hasConflict, load, save, reloadEditor, toggle, openCreate, openEdit,
} = useKnowledgeManagement()
const showDisabled = ref(false)
const searchKeyword = ref("")
const page = ref(1)
const togglingId = ref<string | null>(null)
const visibleItems = computed(() => {
  const keyword = searchKeyword.value.trim().toLocaleLowerCase()
  return items.value.filter(item => (showDisabled.value || item.enabled)
    && (!keyword || [item.title, item.text].join(" ").toLocaleLowerCase().includes(keyword)))
})
const totalPages = computed(() => Math.max(1, Math.ceil(visibleItems.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const hasSearch = computed(() => Boolean(searchKeyword.value.trim()))
const editorBusy = computed(() => isMutating.value || isRefreshing.value)
const listDescription = computed(() => isLoading.value ? "加载中" : !hasLoaded.value ? "加载失败" : `当前显示 ${visibleItems.value.length} 条 / 共 ${items.value.length} 条`)

watch([showDisabled, searchKeyword], () => { page.value = 1 })
watch(totalPages, value => { page.value = Math.min(page.value, value) })

async function toggleEnabled(item: BusinessKnowledgeItem) {
  togglingId.value = item.id
  try { await toggle(item) } finally { togglingId.value = null }
}

// KeepAlive 首次展示也会触发 onActivated，不再叠加 onMounted 请求。
onActivated(() => { void load() })
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Business Knowledge" title="业务知识" description="维护问数和分析使用的业务知识。">
      <template #actions>
        <BaseButton :disabled="!hasLoaded || isMutating || isRefreshing" @click="openCreate">
          <Plus />新增知识
        </BaseButton>
        <BaseButton variant="outline" :disabled="isLoading || isRefreshing || isMutating" @click="load">
          <RefreshCw :class="isRefreshing && 'animate-spin'" />刷新
        </BaseButton>
      </template>
    </PageHeader>

    <BaseAlert v-if="actionError" title="操作未完成" variant="destructive">{{ actionError }}</BaseAlert>

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
                <th class="table-head w-24">状态</th>
                <th class="table-head w-24 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in pageItems" :key="item.id" class="border-b last:border-0 hover:bg-muted/35">
                <td class="table-cell font-medium">
                  <span class="line-clamp-2 break-words" :title="item.title">{{ item.title }}</span>
                </td>
                <td class="table-cell">
                  <span class="line-clamp-2 break-words">{{ item.text }}</span>
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

    <BaseModal
      v-model:open="editorOpen" :busy="editorBusy" size="lg"
      :title="editingId ? '编辑业务知识' : '新增业务知识'"
      description="填写标题和知识内容，适用范围与使用限制可直接写在正文中。"
    >
      <form id="knowledge-form" class="grid gap-4" @submit.prevent="save">
        <label class="form-field">
          标题 <span class="sr-only">必填</span>
          <input v-model="form.title" class="form-control" required maxlength="200" :disabled="editorBusy" />
        </label>
        <label class="form-field">
          知识内容 <span class="sr-only">必填</span>
          <textarea v-model="form.text" class="form-control min-h-40 resize-y" rows="6" required maxlength="8000" :disabled="editorBusy" />
        </label>
        <BaseSwitch v-model="form.enabled" label="启用这条知识" :disabled="editorBusy" />
        <BaseAlert v-if="formError" title="保存未完成" variant="destructive">
          {{ formError }}
          <BaseButton v-if="hasConflict" class="mt-3" variant="outline" :disabled="editorBusy" @click="reloadEditor">
            <RefreshCw />放弃本次修改并重新读取
          </BaseButton>
        </BaseAlert>
      </form>
      <template #footer>
        <BaseButton variant="outline" :disabled="editorBusy" @click="editorOpen = false">取消</BaseButton>
        <BaseButton type="submit" form="knowledge-form" :disabled="editorBusy || hasConflict || !form.title.trim() || !form.text.trim()">
          <LoaderCircle v-if="isMutating" class="animate-spin" />{{ isMutating ? '保存中...' : '保存知识' }}
        </BaseButton>
      </template>
    </BaseModal>
  </AppShell>
</template>
