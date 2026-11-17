<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { CheckCircle2, Circle, CircleAlert, X } from "@lucide/vue"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import { getQuerySqlDetail } from "@/lib/api"
import { logDuration, logStatusText } from "@/lib/queryLogPresentation"
import type { LogRound } from "@/types/queryLogs"
import type { QuerySqlDetail } from "@/types/querySql"

const props = defineProps<{ sessionId: string; round: LogRound; tab: string }>()
const emit = defineEmits<{ close: []; "update:tab": [value: string] }>()
const tab = computed({ get: () => props.tab, set: (value) => emit("update:tab", value) })
const sqlOpen = ref(false)
const queries = ref<Array<{ taskId: string; detail?: QuerySqlDetail; error?: string }>>([])
const loading = ref(false)
const formattedSql = ref<Record<string, string>>({})
watch([sqlOpen, queries], async ([open], _previous, onCleanup) => {
  formattedSql.value = {}
  if (!open || !queries.value.some((query) => query.detail?.sql_text)) return
  let current = true
  onCleanup(() => {
    current = false
  })
  try {
    // 排版工具沿用延迟分包；加载失败仍可核对接口返回的原始 SQL。
    const { formatSqlForDisplay } = await import("@/lib/sqlPresentation")
    if (current)
      formattedSql.value = Object.fromEntries(
        queries.value.flatMap((query) =>
          query.detail?.sql_text
            ? [[query.taskId, formatSqlForDisplay(query.detail.sql_text).text]]
            : [],
        ),
      )
  } catch {
    // 原始 SQL 由模板直接展示，排版不影响读取和关闭详情。
  }
})
let generation = 0
onBeforeUnmount(() => {
  generation += 1
})
watch(
  () => props.round.id,
  () => {
    sqlOpen.value = false
  },
  { immediate: true },
)
watch(
  () => [props.round.id, props.round.task_ids] as const,
  async () => {
    const request = ++generation
    queries.value = []
    loading.value = true
    try {
      const records: typeof queries.value = []
      for (let offset = 0; offset < props.round.task_ids.length; offset += 4) {
        const batch = await Promise.all(
          props.round.task_ids.slice(offset, offset + 4).map(async (taskId) => {
            try {
              return { taskId, detail: await getQuerySqlDetail({ task_id: taskId }, 0, 1) }
            } catch (error) {
              return { taskId, error: error instanceof Error ? error.message : "查询详情加载失败" }
            }
          }),
        )
        if (request !== generation) return
        records.push(...batch)
      }
      queries.value = records
    } finally {
      if (request === generation) loading.value = false
    }
  },
  { immediate: true },
)
const context = computed(() => {
  const available = queries.value.flatMap((query) => (query.detail ? [query.detail] : []))
  const dates = available.flatMap((query) => {
    const time = query.conditions.time
    const start = typeof time.start === "string" ? time.start : null
    const end = typeof time.end === "string" ? time.end : null
    if (start && end) return [start === end ? start : `${start} 至 ${end}`]
    if (typeof time.date === "string") return [time.date]
    return [start, end].filter((value): value is string => Boolean(value))
  })
  return {
    organizations: [
      ...new Set(
        available.length
          ? available.flatMap((query) => query.conditions.orgs.map((org) => org.name ?? org.code))
          : props.round.context.organizations,
      ),
    ],
    metrics: [
      ...new Set(
        available.length
          ? available.flatMap((query) =>
              query.conditions.metrics.map((metric) => metric.name ?? metric.code),
            )
          : props.round.context.metrics,
      ),
    ],
    dates: [...new Set(dates.length ? dates : props.round.context.dates)],
  }
})
const summary = computed(() =>
  props.round.access_restricted
    ? "本轮结果当前不可访问"
    : props.round.status === "failed"
      ? props.round.answers[props.round.answers.length - 1] || "本轮执行失败"
      : logStatusText[props.round.status],
)
function pretty(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "未记录"
}
</script>

<template>
  <aside
    id="query-log-inspector"
    class="am-inspector"
    aria-label="本轮执行详情"
    @keydown.esc.stop="$emit('close')"
  >
    <div class="am-inspector-head">
      <h3>第 {{ round.number }} 轮 · 执行详情</h3>
      <BaseButton
        variant="ghost"
        size="icon"
        class="am-btn am-icon am-quiet"
        aria-label="关闭执行详情"
        @click="$emit('close')"
        ><X
      /></BaseButton>
    </div>
    <div class="am-inspector-summary" :class="{ 'is-error': round.status === 'failed' }">
      <p>{{ summary }}</p>
      <small>总耗时 {{ logDuration(round.duration_ms) }} · 重试 {{ round.retry_count }} 次</small>
    </div>
    <TabsRoot v-model="tab">
      <TabsList class="am-detail-tabs" aria-label="执行详情视图"
        ><TabsTrigger class="am-detail-tab" value="process">执行过程</TabsTrigger
        ><TabsTrigger class="am-detail-tab" value="request">请求信息</TabsTrigger></TabsList
      >
      <TabsContent value="process" class="outline-none">
        <ol class="am-steps">
          <li
            v-for="step in round.steps"
            :key="step.id"
            class="am-step"
            :class="{ 'is-error': step.status === 'failed' }"
          >
            <span class="am-step-icon"
              ><CircleAlert v-if="step.status === 'failed'" /><CheckCircle2
                v-else-if="step.status === 'success'" /><Circle v-else
            /></span>
            <div class="am-step-line">
              <span>{{ step.name }}</span
              ><span class="am-muted am-num">{{ logDuration(step.duration_ms) }}</span>
            </div>
            <p class="am-step-note">{{ step.note }}</p>
          </li>
        </ol>
        <p v-if="!round.query_started" class="am-not-started">本轮没有查询执行记录。</p>
        <p v-if="round.access_restricted" class="am-not-started">
          本轮结果当前不可访问，查询详情已隐藏。
        </p>
        <BaseDisclosure
          v-else-if="round.task_ids.length"
          v-model:open="sqlOpen"
          class="am-sql-details"
          content-class="am-sql-content"
          ><template #trigger
            >查看 SQL 与参数<span v-if="round.task_ids.length > 1"
              >（{{ round.task_ids.length }} 个查询任务）</span
            ></template
          >
          <p v-if="loading" role="status" class="am-muted">正在加载查询详情…</p>
          <div v-for="query in queries" :key="query.taskId" class="am-query">
            <p class="am-muted">任务 {{ query.taskId }}</p>
            <p v-if="query.error" role="alert" class="am-inline-error">{{ query.error }}</p>
            <template v-else-if="query.detail">
              <pre v-if="query.detail.sql_text">{{
                formattedSql[query.taskId] || query.detail.sql_text
              }}</pre>
              <p v-else class="am-muted">SQL 未记录</p>
              <pre v-if="query.detail.sql_params">{{ pretty(query.detail.sql_params) }}</pre>
              <p class="am-muted">
                {{
                  query.detail.row_count === null ? "行数未记录" : `${query.detail.row_count} 行`
                }}
                · {{ logDuration(query.detail.latency_ms) }}
              </p></template
            >
          </div>
        </BaseDisclosure>
      </TabsContent>
      <TabsContent value="request" class="outline-none"
        ><dl class="am-kv">
          <dt>会话 ID</dt>
          <dd>{{ sessionId }}</dd>
          <dt>操作 ID</dt>
          <dd>{{ round.operation_id || "未记录" }}</dd>
          <dt>请求 ID</dt>
          <dd>{{ round.request_id || "未记录" }}</dd>
          <dt>机构</dt>
          <dd>{{ context.organizations.join("、") || "未记录" }}</dd>
          <dt>统计日期</dt>
          <dd>{{ context.dates.join("、") || "未记录" }}</dd>
          <dt>指标</dt>
          <dd>{{ context.metrics.join("、") || "未记录" }}</dd>
          <dt>模型</dt>
          <dd>{{ round.model || "未记录" }}</dd>
          <dt>最终状态</dt>
          <dd>{{ logStatusText[round.status] }}</dd>
          <dt>错误码</dt>
          <dd>{{ round.error_code || "—" }}</dd>
        </dl>
        <p v-if="queries.some((query) => query.error)" class="am-muted">
          部分查询条件未能加载，可在执行过程中查看原因。
        </p></TabsContent
      >
    </TabsRoot>
    <p class="am-context-note">执行记录归属本轮，对话上下文保留在左侧。</p>
  </aside>
</template>
