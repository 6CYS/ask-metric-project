<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { computed, nextTick, onActivated, onMounted, reactive, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  X,
} from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import MetricKnowledgePanel from "@/components/metrics/MetricKnowledgePanel.vue"
import MetricRelationsPanel from "@/components/metrics/MetricRelationsPanel.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import { useAuth } from "@/composables/useAuth"
import { useManagementResource } from "@/composables/useManagementResource"
import { useMetricDirectory } from "@/composables/useMetricDirectory"
import { createMetric, deleteMetric, listMetrics, updateMetric } from "@/lib/api"
import type { MetricItem, MetricPayload } from "@/types/api"
import type { MetricRelationList } from "@/types/metricRelationships"

const route = useRoute()
const router = useRouter()
const resource = useManagementResource<MetricItem>(listMetrics)
const {
  search,
  showDisabled,
  page,
  pageSize,
  selectedCode,
  selectedMetric,
  previousMetric,
  filteredItems,
  totalPages,
  pageItems,
  select,
  inspect,
  returnToPrevious,
} = useMetricDirectory(resource.items)
const directoryScope = computed<"enabled" | "all">({
  get: () => (showDisabled.value ? "all" : "enabled"),
  set: (value) => {
    showDisabled.value = value === "all"
  },
})
const auth = useAuth()
const canManage = computed(() => auth.user.value?.role_code === "SYSTEM_ADMIN")
type RefreshablePanel = { refresh(): Promise<unknown> }
const relationsPanel = ref<RefreshablePanel | null>(null)
const knowledgePanel = ref<RefreshablePanel | null>(null)
const relationsBusy = ref(false)
const knowledgeBusy = ref(false)
const directoryList = ref<HTMLUListElement | null>(null)
const activeTab = ref("info")
const configurationOpen = ref(false)
const relationshipResult = ref<MetricRelationList | null>(null)
const configurationIssues = computed(
  () =>
    relationshipResult.value?.issues ??
    (relationshipResult.value?.warnings ?? []).map((message, index) => ({
      id: `legacy-${index}`,
      title: "预置关系待核对",
      message,
      metric_codes: [],
    })),
)
const metricHasDetails = computed(() => {
  const metric = selectedMetric.value
  return Boolean(
    metric && (metric.synonyms.length || metric.metric_explanation || metric.description),
  )
})
const routeError = ref("")
const isDialogOpen = ref(false)
const formError = ref("")
const editingMetric = ref<MetricItem | null>(null)
const deletingMetric = ref<MetricItem | null>(null)
const togglingMetricCode = ref<string | null>(null)
const refreshingWorkspace = ref(false)
const form = reactive({
  metricCode: "",
  metricName: "",
  unit: "",
  metricExplanation: "",
  description: "",
  synonyms: "",
})
const workspaceBusy = computed(
  () =>
    relationsBusy.value ||
    knowledgeBusy.value ||
    isDialogOpen.value ||
    Boolean(deletingMetric.value) ||
    resource.isMutating.value ||
    resource.isRefreshing.value ||
    refreshingWorkspace.value,
)

async function updateMetricRoute(code: string) {
  routeError.value = ""
  try {
    await router.replace({ path: "/metrics", query: { ...route.query, metric: code } })
  } catch {
    routeError.value = "当前指标已选中，但页面地址未更新。请稍后重试。"
  }
}

async function selectMetric(code: string) {
  if (workspaceBusy.value || !select(code)) return
  await revealDirectorySelection()
  await updateMetricRoute(code)
}

async function inspectMetric(code: string) {
  if (workspaceBusy.value || !inspect(code)) return
  await updateMetricRoute(code)
}

async function returnToMetric() {
  if (workspaceBusy.value || !returnToPrevious()) return
  await updateMetricRoute(selectedCode.value)
}

async function applyRouteSelection() {
  if (
    route.path !== "/metrics" ||
    resource.isLoading.value ||
    resource.isBlockingError.value ||
    workspaceBusy.value
  )
    return
  const requested = typeof route.query.metric === "string" ? route.query.metric : ""
  if (requested) {
    if (selectedCode.value !== requested) {
      if (!select(requested)) {
        selectedCode.value = ""
        routeError.value = "未找到链接中的指标，可能已被删除。请从目录重新选择。"
        return
      }
      await revealDirectorySelection()
    }
    routeError.value = ""
  } else {
    routeError.value = ""
    if (!selectedMetric.value) {
      const first = filteredItems.value[0]
      if (first) {
        select(first.metric_code)
        await revealDirectorySelection()
      }
    }
  }
}

watch(
  [() => route.query.metric, () => route.path, resource.items, workspaceBusy],
  applyRouteSelection,
  { flush: "post" },
)

async function revealDirectorySelection() {
  await nextTick()
  const list = directoryList.value
  if (!list) return
  const current = list.querySelector<HTMLButtonElement>('[aria-current="true"]')
  if (!current) {
    list.scrollTop = 0
    return
  }
  // 目录定位只滚动列表；沿关系浏览时不触发定位。
  const top = current.offsetTop
  const bottom = top + current.offsetHeight
  if (top < list.scrollTop) list.scrollTop = top
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
}

watch([search, showDisabled, page], revealDirectorySelection)

async function refreshWorkspace() {
  if (workspaceBusy.value) return
  refreshingWorkspace.value = true
  try {
    await resource.load(true)
    await Promise.all([relationsPanel.value?.refresh(), knowledgePanel.value?.refresh()])
  } finally {
    refreshingWorkspace.value = false
  }
}

function openCreateDialog() {
  if (!canManage.value || workspaceBusy.value) return
  formError.value = ""
  Object.assign(form, {
    metricCode: "",
    metricName: "",
    unit: "",
    metricExplanation: "",
    description: "",
    synonyms: "",
  })
  editingMetric.value = null
  resource.clearMutationError()
  isDialogOpen.value = true
}

function openEditDialog(metric: MetricItem) {
  if (!canManage.value || workspaceBusy.value) return
  formError.value = ""
  Object.assign(form, {
    metricCode: metric.metric_code,
    metricName: metric.metric_name,
    unit: metric.unit ?? "",
    metricExplanation: metric.metric_explanation,
    description: metric.description,
    synonyms: metric.synonyms.join("，"),
  })
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
    synonyms: [
      ...new Set(
        form.synonyms
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ],
    enabled,
  }
}

async function submitForm() {
  if (!canManage.value) return
  formError.value = ""
  if (!form.metricCode.trim() || !form.metricName.trim()) {
    formError.value = "请填写指标编号和指标名称。"
    return
  }
  const current = editingMetric.value
  const payload = buildPayload(current?.enabled ?? true)
  const ok = await resource.mutate(() =>
    current ? updateMetric(current.metric_code, payload) : createMetric(payload),
  )
  if (!ok) return
  isDialogOpen.value = false
  editingMetric.value = null
  if (selectedCode.value !== payload.metric_code) await selectMetric(payload.metric_code)
  await relationsPanel.value?.refresh()
}

async function toggleEnabled(metric: MetricItem) {
  if (!canManage.value || workspaceBusy.value) return
  togglingMetricCode.value = metric.metric_code
  const payload: MetricPayload = {
    metric_code: metric.metric_code,
    metric_name: metric.metric_name,
    unit: metric.unit ?? undefined,
    metric_explanation: metric.metric_explanation,
    description: metric.description,
    synonyms: metric.synonyms,
    enabled: !metric.enabled,
  }
  try {
    const ok = await resource.mutate(() => updateMetric(metric.metric_code, payload))
    if (ok) await relationsPanel.value?.refresh()
  } finally {
    togglingMetricCode.value = null
  }
}

function openDeleteDialog(metric: MetricItem) {
  if (!canManage.value || workspaceBusy.value) return
  resource.clearMutationError()
  deletingMetric.value = metric
}

async function confirmDelete() {
  const metric = deletingMetric.value
  if (!canManage.value || !metric) return
  const ok = await resource.mutate(() => deleteMetric(metric.metric_code))
  if (!ok) return
  deletingMetric.value = null
  if (selectedMetric.value?.metric_code === metric.metric_code) return
  try {
    const query = { ...route.query }
    delete query.metric
    await router.replace({ path: "/metrics", query })
  } catch {
    routeError.value = "指标已删除，但页面地址未更新。请从目录重新选择。"
  }
}

onMounted(() => resource.load())
onActivated(async () => {
  if (resource.isLoading.value || workspaceBusy.value) return
  await resource.load(true)
  // 从其他页面打开指标链接时重新定位；本页的关系浏览不经过激活周期。
  const requested = typeof route.query.metric === "string" ? route.query.metric : ""
  if (requested && !workspaceBusy.value && select(requested)) await revealDirectorySelection()
})
</script>

<template>
  <AppShell>
    <PageHeader title="指标管理" description="查找指标，维护它的业务定义、关系和知识。">
      <template #actions>
        <BaseButton
          v-if="canManage && configurationIssues.length"
          variant="ghost"
          size="sm"
          :disabled="workspaceBusy"
          @click="configurationOpen = true"
          >配置待核对 {{ configurationIssues.length }}</BaseButton
        >
        <BaseButton
          variant="outline"
          :disabled="workspaceBusy || resource.isLoading.value"
          @click="refreshWorkspace"
        >
          <RefreshCw
            :class="(resource.isRefreshing.value || refreshingWorkspace) && 'animate-spin'"
          />刷新
        </BaseButton>
      </template>
    </PageHeader>

    <BaseAlert
      v-if="resource.loadError.value"
      :title="resource.isBlockingError.value ? '指标目录读取失败' : '刷新失败，保留上次读取的指标'"
      variant="destructive"
    >
      {{ resource.loadError.value }}
      <BaseButton
        class="mt-2"
        size="sm"
        variant="outline"
        :disabled="workspaceBusy"
        @click="resource.load(true)"
        ><RefreshCw />重新读取</BaseButton
      >
    </BaseAlert>
    <BaseAlert v-if="routeError" title="指标定位提示">{{ routeError }}</BaseAlert>
    <BaseAlert
      v-if="resource.mutationError.value && !isDialogOpen"
      title="操作未完成"
      variant="destructive"
      >{{ resource.mutationError.value }}</BaseAlert
    >

    <div class="grid min-w-0 items-start gap-5 min-[1100px]:grid-cols-[18rem_minmax(0,1fr)]">
      <aside
        class="min-w-0 overflow-hidden rounded-xl border bg-card min-[1100px]:sticky min-[1100px]:top-5"
        aria-label="指标目录"
      >
        <div class="space-y-3 border-b p-4">
          <div class="flex items-center justify-between gap-2">
            <h2 class="sr-only">指标目录</h2>
            <BaseSelect
              v-model="directoryScope"
              :options="[
                { value: 'enabled', label: '已启用指标' },
                { value: 'all', label: '全部指标（含停用）' },
              ]"
              class="min-h-8! w-44! max-w-full border-transparent! bg-transparent! px-1! hover:bg-muted/50!"
              :disabled="workspaceBusy"
              aria-label="指标显示范围"
            />
            <BaseButton
              v-if="canManage"
              size="sm"
              variant="ghost"
              :disabled="
                workspaceBusy || resource.isLoading.value || resource.isBlockingError.value
              "
              @click="openCreateDialog"
              ><Plus />新增</BaseButton
            >
          </div>
          <label class="relative block">
            <span class="sr-only">搜索指标</span>
            <Search
              class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            />
            <input
              v-model="search"
              class="form-control pr-8! pl-9!"
              placeholder="名称、编号或同义词"
              :disabled="workspaceBusy || resource.isLoading.value"
            />
            <button
              v-if="search"
              type="button"
              class="absolute top-2 right-2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              :disabled="workspaceBusy"
              aria-label="清空搜索"
              @click="search = ''"
            >
              <X class="size-4" />
            </button>
          </label>
        </div>
        <p
          v-if="resource.isLoading.value"
          class="flex items-center gap-2 p-5 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle class="size-4 animate-spin" />正在读取指标…
        </p>
        <p v-else-if="resource.isBlockingError.value" class="p-5 text-sm text-muted-foreground">
          请重新读取指标目录。
        </p>
        <p v-else-if="!filteredItems.length" class="p-5 text-sm leading-6 text-muted-foreground">
          {{
            search
              ? "未找到匹配指标，请调整关键词或包含已停用指标。"
              : "暂无指标，可以新增指标或包含已停用指标查看。"
          }}
        </p>
        <ul
          v-else
          ref="directoryList"
          class="relative max-h-[32rem] overflow-y-auto p-2"
          aria-label="指标搜索结果"
        >
          <li v-for="metric in pageItems" :key="metric.metric_code">
            <BaseTooltip :content="`${metric.metric_name}（${metric.metric_code}）`"
              ><span
                class="block w-full rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
                :tabindex="workspaceBusy ? 0 : undefined"
                :aria-disabled="workspaceBusy || undefined"
                :aria-label="metric.metric_name"
                ><button
                  type="button"
                  class="w-full rounded-lg px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                  :class="
                    selectedCode === metric.metric_code
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted/50'
                  "
                  :disabled="workspaceBusy"
                  :aria-current="selectedCode === metric.metric_code ? 'true' : undefined"
                  @click="selectMetric(metric.metric_code)"
                >
                  <span class="flex items-start justify-between gap-2"
                    ><span class="min-w-0 break-words text-sm">{{ metric.metric_name }}</span
                    ><span
                      v-if="!metric.enabled"
                      class="shrink-0 pt-0.5 text-xs text-muted-foreground"
                      >停用</span
                    ></span
                  >
                </button></span
              ></BaseTooltip
            >
          </li>
        </ul>
        <div
          v-if="!resource.isLoading.value && !resource.isBlockingError.value"
          class="space-y-2 border-t px-4 py-3"
        >
          <p class="text-xs text-muted-foreground" role="status">
            {{ search ? "匹配 " : "共 " }}{{ filteredItems.length }} 个 · 每页 {{ pageSize }} 个
          </p>
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">第 {{ page }} / {{ totalPages }} 页</span>
            <div class="flex gap-1">
              <BaseButton
                size="icon"
                variant="outline"
                :disabled="page <= 1 || workspaceBusy"
                aria-label="上一页指标"
                @click="page--"
                ><ChevronLeft
              /></BaseButton>
              <BaseButton
                size="icon"
                variant="outline"
                :disabled="page >= totalPages || workspaceBusy"
                aria-label="下一页指标"
                @click="page++"
                ><ChevronRight
              /></BaseButton>
            </div>
          </div>
        </div>
      </aside>

      <article
        v-if="selectedMetric"
        class="min-w-0 rounded-xl border bg-card p-5"
        aria-label="当前指标工作区"
      >
        <BaseButton
          v-if="previousMetric"
          variant="ghost"
          size="sm"
          class="mb-3 max-w-full justify-start whitespace-normal text-left text-muted-foreground"
          :disabled="workspaceBusy"
          @click="returnToMetric"
        >
          <ArrowLeft class="shrink-0" />返回 {{ previousMetric.metric_name }}
        </BaseButton>
        <header class="flex flex-wrap items-start justify-between gap-3 pb-5">
          <div class="min-w-0 flex-1">
            <h2 class="break-words text-lg font-semibold">{{ selectedMetric.metric_name }}</h2>
            <div class="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>原始单位：{{ selectedMetric.unit || "未维护" }}</span>
              <BaseBadge variant="secondary">{{
                selectedMetric.enabled ? "已启用" : "已停用"
              }}</BaseBadge>
            </div>
          </div>
          <BaseButton
            v-if="canManage"
            variant="outline"
            size="sm"
            :disabled="workspaceBusy"
            @click="openEditDialog(selectedMetric)"
            ><Pencil />编辑指标</BaseButton
          >
        </header>

        <TabsRoot v-model="activeTab" :unmount-on-hide="false">
          <TabsList class="mb-5 flex gap-6 border-b" aria-label="指标维护内容">
            <TabsTrigger class="metric-tab" value="info" :disabled="workspaceBusy"
              >指标信息</TabsTrigger
            >
            <TabsTrigger
              v-if="canManage"
              class="metric-tab"
              value="relations"
              :disabled="workspaceBusy"
              >指标关系</TabsTrigger
            >
            <TabsTrigger
              v-if="canManage"
              class="metric-tab"
              value="knowledge"
              :disabled="workspaceBusy"
              >业务知识</TabsTrigger
            >
          </TabsList>
          <TabsContent
            value="info"
            class="space-y-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <dl v-if="metricHasDetails" class="space-y-5 text-sm">
              <div v-if="selectedMetric.synonyms.length">
                <dt class="font-medium">同义词</dt>
                <dd class="mt-2 flex flex-wrap gap-2">
                  <span
                    v-for="synonym in selectedMetric.synonyms"
                    :key="synonym"
                    class="max-w-full break-words rounded-md bg-muted px-2 py-1"
                    >{{ synonym }}</span
                  >
                </dd>
              </div>
              <div v-if="selectedMetric.metric_explanation">
                <dt class="font-medium">指标说明</dt>
                <dd class="mt-2 whitespace-pre-wrap break-words leading-7 text-muted-foreground">
                  {{ selectedMetric.metric_explanation }}
                </dd>
              </div>
              <div v-if="selectedMetric.description">
                <dt class="font-medium">指标口径</dt>
                <dd class="mt-2 whitespace-pre-wrap break-words leading-7 text-muted-foreground">
                  {{ selectedMetric.description }}
                </dd>
              </div>
            </dl>
            <p v-else class="py-6 text-sm leading-6 text-muted-foreground">
              尚未补充业务说明、口径和同义词。<template v-if="canManage"
                >点击“编辑指标”即可维护。</template
              >
            </p>
            <dl class="border-t pt-4 text-xs text-muted-foreground">
              <dt>指标编号</dt>
              <dd class="mt-1 break-all select-all">{{ selectedMetric.metric_code }}</dd>
            </dl>
            <footer
              v-if="canManage"
              class="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
            >
              <p class="text-xs text-muted-foreground">
                {{
                  selectedMetric.enabled
                    ? "不再使用的指标可先停用，保留已有定义。"
                    : "此指标已停用，可重新启用或继续维护。"
                }}
              </p>
              <div class="flex gap-1">
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :disabled="workspaceBusy"
                  @click="toggleEnabled(selectedMetric)"
                >
                  <LoaderCircle
                    v-if="togglingMetricCode === selectedCode"
                    class="animate-spin"
                  /><PowerOff v-else-if="selectedMetric.enabled" /><Power v-else />{{
                    selectedMetric.enabled ? "停用" : "启用"
                  }}
                </BaseButton>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  class="text-destructive"
                  :disabled="workspaceBusy"
                  @click="openDeleteDialog(selectedMetric)"
                  ><Trash2 />删除</BaseButton
                >
              </div>
            </footer>
          </TabsContent>
          <TabsContent
            v-if="canManage"
            value="relations"
            class="outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MetricRelationsPanel
              ref="relationsPanel"
              :metrics="resource.items.value"
              :selected-code="selectedCode"
              @select="inspectMetric"
              @busy="relationsBusy = $event"
              @loaded="relationshipResult = $event"
            />
          </TabsContent>
          <TabsContent
            v-if="canManage"
            value="knowledge"
            class="outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MetricKnowledgePanel
              ref="knowledgePanel"
              :metric="selectedMetric"
              :metrics="resource.items.value"
              @busy="knowledgeBusy = $event"
            />
          </TabsContent>
        </TabsRoot>
      </article>
      <div
        v-else
        class="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground"
      >
        <Tags class="size-6" />
        <p>
          {{
            resource.isLoading.value
              ? "正在准备指标工作区…"
              : "从左侧选择一个指标，查看和维护它的资料。"
          }}
        </p>
      </div>
    </div>

    <BaseModal
      v-model:open="configurationOpen"
      title="关系配置待核对"
      description="以下关系需要核对指标关联或定义；其他已配置关系仍可正常查看。"
      size="lg"
    >
      <ul class="divide-y">
        <li v-for="issue in configurationIssues" :key="issue.id" class="py-3 first:pt-0 last:pb-0">
          <p class="text-sm font-medium">{{ issue.title }}</p>
          <p class="mt-1 text-sm leading-6 text-muted-foreground">{{ issue.message }}</p>
        </li>
      </ul>
    </BaseModal>

    <BaseModal
      v-model:open="isDialogOpen"
      :busy="resource.isMutating.value"
      size="lg"
      :title="editingMetric ? '编辑指标' : '新增指标'"
      description="维护指标定义和常用叫法。同义词可使用中文或英文逗号分隔。"
    >
      <form id="metric-form" class="grid gap-4" novalidate @submit.prevent="submitForm">
        <label class="form-field"
          >指标编号<input
            v-model="form.metricCode"
            class="form-control"
            placeholder="填写正式指标编号"
            required
            :disabled="Boolean(editingMetric) || resource.isMutating.value"
          /><span v-if="editingMetric" class="field-help">指标编号不可修改。</span></label
        >
        <label class="form-field"
          >指标名称<input
            v-model="form.metricName"
            class="form-control"
            placeholder="填写业务使用的指标名称"
            required
            :disabled="resource.isMutating.value"
        /></label>
        <label class="form-field"
          >原始单位<input
            v-model="form.unit"
            class="form-control"
            placeholder="例如：元、户、%"
            :disabled="resource.isMutating.value"
          /><span class="field-help">填写源数据单位；展示为万元、亿元时由系统换算。</span></label
        >
        <label class="form-field"
          >同义词<input
            v-model="form.synonyms"
            class="form-control"
            placeholder="填写业务中常用的其他叫法"
            :disabled="resource.isMutating.value"
        /></label>
        <label class="form-field"
          >指标说明<textarea
            v-model="form.metricExplanation"
            class="form-control min-h-20 resize-y py-2"
            placeholder="这个指标反映什么业务情况"
            :disabled="resource.isMutating.value"
          />
        </label>
        <label class="form-field"
          >指标口径<textarea
            v-model="form.description"
            class="form-control min-h-28 resize-y py-2"
            placeholder="说明统计范围、计算方式及包含或排除的项目"
            :disabled="resource.isMutating.value"
          />
        </label>
        <p v-if="formError" class="text-sm text-destructive" role="alert">{{ formError }}</p>
        <p v-if="resource.mutationError.value" class="text-sm text-destructive" role="alert">
          保存失败：{{ resource.mutationError.value }}
        </p>
      </form>
      <template #footer>
        <BaseButton
          variant="outline"
          :disabled="resource.isMutating.value"
          @click="isDialogOpen = false"
          >取消</BaseButton
        >
        <BaseButton
          type="submit"
          form="metric-form"
          :disabled="
            !form.metricCode.trim() || !form.metricName.trim() || resource.isMutating.value
          "
          ><LoaderCircle v-if="resource.isMutating.value" class="animate-spin" />{{
            resource.isMutating.value ? "保存中…" : "保存指标"
          }}</BaseButton
        >
      </template>
    </BaseModal>
    <ConfirmDialog
      :open="Boolean(deletingMetric)"
      title="删除指标"
      :busy="resource.isMutating.value"
      @update:open="!$event && (deletingMetric = null)"
      @confirm="confirmDelete"
      >删除「{{
        deletingMetric?.metric_name
      }}」后，它将从可用指标中移除，已有业务数据保留。若只是暂时不用，建议取消并选择停用。
      <p v-if="resource.mutationError.value" class="mt-3 text-destructive" role="alert">
        {{ resource.mutationError.value }}
      </p></ConfirmDialog
    >
  </AppShell>
</template>

<style scoped>
.metric-tab {
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  padding: 0.5rem 0 0.75rem;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.metric-tab[data-state="active"] {
  border-bottom-color: var(--foreground);
  color: var(--foreground);
  font-weight: 600;
}
.metric-tab:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 3px;
}
.metric-tab:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
