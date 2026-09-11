<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { Activity, Bug, Clock3, FileClock, RefreshCw, RotateCcw } from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import BackendNextDebugPanel from "@/components/chat/BackendNextDebugPanel.vue"
import ListPagination from "@/components/ListPagination.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import { getQueryRunDetail, listQueryRuns } from "@/lib/api"
import type { QueryRunItem } from "@/types/api"

const PAGE_SIZE = 10
const items = ref<QueryRunItem[]>([])
const page = ref(1)
const isLoading = ref(true)
const isRefreshing = ref(false)
const hasLoaded = ref(false)
const errorMessage = ref("")
const debugRun = ref<QueryRunItem | null>(null)
const loadingDebugTaskId = ref("")

const totalPages = computed(() => Math.max(1, Math.ceil(items.value.length / PAGE_SIZE)))
const pageItems = computed(() => items.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const successCount = computed(() => items.value.filter((run) => run.status === "success").length)
const retryCount = computed(() => items.value.reduce((total, run) => total + run.retry_count, 0))
const isBlockingError = computed(() => Boolean(errorMessage.value) && !hasLoaded.value)
const stats = computed(() => [
  { label: "运行记录", value: isLoading.value ? "--" : String(items.value.length), detail: "已落库的问数调用记录。" },
  { label: "成功", value: isLoading.value ? "--" : String(successCount.value), detail: "状态为 success 的执行结果。" },
  { label: "重试次数", value: isLoading.value ? "--" : String(retryCount.value), detail: "SQL 或链路失败后的累计重试。" },
])

/** 刷新失败时保留上次成功数据，避免短暂网络问题让日志表突然清空。 */
async function loadRuns(refresh = false) {
  if (refresh) isRefreshing.value = true
  else isLoading.value = true
  errorMessage.value = ""

  try {
    const data = await listQueryRuns()
    items.value = data.items
    hasLoaded.value = true
    page.value = Math.min(page.value, Math.max(1, Math.ceil(data.items.length / PAGE_SIZE)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "请求失败，请稍后重试。"
  } finally {
    isLoading.value = false
    isRefreshing.value = false
  }
}

function formatCreatedAt(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
}

function formatOrgMatchType(value: string) {
  return ({ standard_name: "标准名", alias: "别名", auto_short_name: "自动短名" } as Record<string, string>)[value] ?? value
}

function formatFailedNode(value?: string | null) {
  return ({
    planning: "查询规划",
    execution: "SQL 执行",
    query_planning: "查询规划",
    sql_execution: "SQL 执行",
    semantic_analysis: "语义分析",
    SLOT_EXTRACTION: "槽位提取",
    ENTITY_RESOLUTION: "实体解析",
    VALIDATION: "语义校验",
    INTENT_ROUTING: "意图路由",
    CLARIFICATION: "等待澄清",
    LOGICAL_DSL: "Logical DSL",
    PLANNING: "查询规划",
    EXECUTION: "SQL 执行",
    RESULT_FORMATTING: "结果整理",
  } as Record<string, string>)[value ?? ""] ?? value ?? "未知阶段"
}

async function openRunDebug(run: QueryRunItem) {
  if (!run.task_id) return
  loadingDebugTaskId.value = run.task_id
  try {
    debugRun.value = await getQueryRunDetail(run.task_id)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "加载详细流程失败。"
  } finally {
    loadingDebugTaskId.value = ""
  }
}

onMounted(() => loadRuns())
</script>

<template>
  <AppShell>
    <PageHeader
      eyebrow="Query Observability"
      title="问数日志"
      description="查看每次问数的用户问题、识别意图、查询类型、运行状态和重试次数，用于定位链路质量问题。"
      :stats="stats"
    >
      <template #actions>
        <BaseButton variant="outline" :disabled="isRefreshing" @click="loadRuns(true)">
          <RefreshCw :class="isRefreshing && 'animate-spin'" />刷新
        </BaseButton>
      </template>
    </PageHeader>

    <section class="rounded-lg border bg-card shadow-sm">
      <header class="grid grid-cols-[1fr_auto] gap-2 p-6">
        <div>
          <h2 class="font-semibold">运行记录</h2>
          <p class="mt-1 text-sm text-muted-foreground">{{ isLoading ? "加载中" : isBlockingError ? "加载失败" : `${items.length} 条记录` }}</p>
        </div>
        <BaseBadge variant="secondary">Trace</BaseBadge>
      </header>
      <div class="px-6 pb-6">
        <BaseAlert v-if="isBlockingError" title="运行记录请求失败" variant="destructive">
          <template #icon><Activity /></template>{{ errorMessage }}
        </BaseAlert>
        <div v-else class="flex flex-col gap-3">
          <BaseAlert v-if="errorMessage" title="运行记录刷新失败" variant="destructive">
            <template #icon><RefreshCw /></template>{{ errorMessage }}
          </BaseAlert>
          <LoadingSkeleton v-if="isLoading" :rows="8" />
          <div v-else-if="!items.length" class="flex min-h-96 flex-col items-center justify-center rounded-lg border px-6 text-center">
            <span class="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted"><FileClock class="size-5" /></span>
            <h3 class="text-sm font-semibold">暂无问数日志</h3>
            <p class="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">提交一次问数后，这里会展示运行状态和排查线索。</p>
          </div>
          <div v-else class="overflow-hidden rounded-lg border">
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead><tr class="border-b bg-muted/45">
                  <th v-for="heading in ['问题', '意图', '查询类型', '机构匹配', '状态', '当前节点', '错误详情', '详细流程', '重试', '时间']" :key="heading" class="h-10 px-3 text-left font-medium whitespace-nowrap">{{ heading }}</th>
                </tr></thead>
                <tbody>
                  <tr v-for="run in pageItems" :key="run.id" class="border-b last:border-0 hover:bg-muted/35">
                    <td class="max-w-[28rem] p-3 whitespace-normal">
                      <div class="min-w-52 space-y-1">
                        <span class="line-clamp-2 font-medium">{{ run.resolved_question || run.user_message }}</span>
                        <span v-if="run.resolved_question && run.resolved_question !== run.user_message" class="line-clamp-2 text-xs text-muted-foreground">原始问题：{{ run.user_message }}</span>
                        <BaseBadge v-if="run.clarification_answers?.length" variant="outline">澄清 {{ run.clarification_answers.length }} 次</BaseBadge>
                      </div>
                    </td>
                    <td class="p-3 whitespace-nowrap">{{ run.intent }}</td>
                    <td class="p-3 whitespace-nowrap">{{ run.query_shape || '-' }}</td>
                    <td class="p-3">
                      <span v-if="!(run.raw_org_text || run.matched_text || run.matched_org_name)" class="text-muted-foreground">-</span>
                      <div v-else class="flex min-w-40 flex-col gap-1">
                        <div class="flex items-center gap-1.5"><span class="max-w-28 truncate font-medium">{{ run.raw_org_text || run.matched_text || '-' }}</span><template v-if="run.matched_org_name"><span class="text-xs text-muted-foreground">→</span><span class="max-w-32 truncate">{{ run.matched_org_name }}</span></template></div>
                        <BaseBadge v-if="run.org_match_type" variant="outline" class="w-fit">{{ formatOrgMatchType(run.org_match_type) }}</BaseBadge>
                      </div>
                    </td>
                    <td class="p-3"><BaseBadge :variant="run.status === 'success' ? 'default' : 'outline'">{{ run.status }}</BaseBadge></td>
                    <td class="p-3 whitespace-nowrap">{{ formatFailedNode(run.current_stage) }}</td>
                    <td class="max-w-72 p-3">
                      <span v-if="!run.error_message" class="text-muted-foreground">-</span>
                      <div v-else class="flex flex-col gap-1">
                        <span class="font-medium">{{ formatFailedNode(run.failed_node) }}</span>
                        <span v-if="run.error_code || run.error_type" class="font-mono text-xs text-muted-foreground">{{ [run.error_code, run.error_type].filter(Boolean).join(' · ') }}</span>
                        <span class="line-clamp-3 text-xs leading-5 text-destructive" :title="run.error_message">{{ run.error_message }}</span>
                      </div>
                    </td>
                    <td class="p-3"><BaseButton variant="ghost" size="sm" :disabled="loadingDebugTaskId === run.task_id" @click="openRunDebug(run)"><Bug :class="['size-3.5', loadingDebugTaskId === run.task_id && 'animate-spin']" />查看</BaseButton></td>
                    <td class="p-3"><span class="inline-flex items-center gap-1"><RotateCcw class="size-3.5 text-muted-foreground" />{{ run.retry_count }}</span></td>
                    <td class="p-3 whitespace-nowrap"><span class="inline-flex items-center gap-1 text-muted-foreground"><Clock3 class="size-3.5" />{{ formatCreatedAt(run.created_at) }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ListPagination :page="page" :page-size="PAGE_SIZE" :total-items="items.length" :total-pages="totalPages" @change="page = $event" />
          </div>
        </div>
      </div>
    </section>
    <BackendNextDebugPanel
      v-if="debugRun"
      :question="debugRun.user_message"
      :task-id="debugRun.task_id"
      :status="debugRun.task_status || debugRun.status"
      :stage="debugRun.current_stage"
      :timings="debugRun.timings_ms"
      :debug="debugRun.debug"
      @close="debugRun = null"
    />
  </AppShell>
</template>
