<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { Check, ChevronLeft, ChevronRight, CodeXml, Copy, LoaderCircle, X } from "@lucide/vue"
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "reka-ui"
import { computed, ref, useId, watch } from "vue"

import ListPagination from "@/components/ListPagination.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useQuerySqlDetail } from "@/composables/useQuerySqlDetail"
import { ApiError, getQuerySqlDetail } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import {
  getResultCellValue,
  getResultColumnAlignClass,
  getResultColumnLabel,
} from "@/lib/resultColumns"
import type { QuerySqlReference } from "@/types/querySql"

const props = defineProps<{ open: boolean; references: QuerySqlReference[] }>()
const emit = defineEmits<{ "update:open": [value: boolean] }>()
const selectedKey = ref("")
const querySelectId = useId()
const selectedTab = ref("sql")
const copyStatus = ref("")
const copyFallback = ref("")
let returnFocus: HTMLElement | null = null

function referenceKey(reference: QuerySqlReference) {
  return JSON.stringify([reference.task_id, reference.run_id, reference.result_id])
}

const queryOptions = computed(() => props.references.map((reference, index) => ({
  value: referenceKey(reference),
  label: [reference.label || `查询记录 ${index + 1}（名称未记录）`, reference.description].filter(Boolean).join(" · "),
})))
const selectedReference = computed(
  () =>
    props.references.find((reference) => referenceKey(reference) === selectedKey.value) ??
    props.references[0],
)
const currentKey = computed({
  get: () => (selectedReference.value ? referenceKey(selectedReference.value) : ""),
  set: (key: string) => {
    selectedKey.value = key
  },
})
const selectedIndex = computed(() =>
  props.references.findIndex((reference) => referenceKey(reference) === currentKey.value),
)
const { detail, error, loading, loadPage, reload } = useQuerySqlDetail(
  () => props.open,
  () => selectedReference.value,
  getQuerySqlDetail,
)

watch([() => props.open, currentKey], () => {
  selectedTab.value = "sql"
})
watch(detail, () => {
  copyStatus.value = ""
  copyFallback.value = ""
})

const sqlPresentation = ref<{ html?: string; formatted: boolean }>()
watch(
  () => detail.value?.sql_text,
  async (sqlText, _previous, onCleanup) => {
    sqlPresentation.value = undefined
    if (!sqlText) return
    let current = true
    onCleanup(() => {
      current = false
    })
    try {
      // 只延迟加载排版工具；抽屉及原始 SQL 始终可用，关闭不依赖分包加载。
      const { formatSqlForDisplay, highlightSql } = await import("@/lib/sqlPresentation")
      if (!current) return
      const presentation = formatSqlForDisplay(sqlText)
      sqlPresentation.value = {
        html: highlightSql(presentation.text),
        formatted: presentation.formatted,
      }
    } catch {
      if (current) sqlPresentation.value = { formatted: false }
    }
  },
)

const errorMessage = computed(() => {
  if (error.value instanceof ApiError) {
    switch (error.value.status) {
      case 401:
        return "登录状态已失效，请重新登录后查看。"
      case 403:
        return "当前账号无权查看这次查询的执行记录。"
      case 404:
        return "未找到可访问的查询执行记录，历史记录可能已不再保留。"
      case 409:
        return "这条回答的执行来源无法确认，暂时无法展示对应 SQL。"
    }
  }
  return "暂时无法读取执行记录，请稍后重试。"
})
const canRetry = computed(
  () => !(error.value instanceof ApiError && [401, 403].includes(error.value.status)),
)
const queryTitle = computed(() => {
  const label = selectedReference.value?.label
  if (label) return label
  const names = detail.value?.conditions.metrics.map((metric) => metric.name || metric.code) ?? []
  return names.length ? names.join("、") : `查询 ${selectedIndex.value + 1}`
})
const statusLabels: Record<string, string> = {
  succeeded: "查询成功",
  failed: "查询失败",
  running: "查询中",
  pending: "等待查询",
  cancelled: "查询已取消",
  canceled: "查询已取消",
  unsupported: "查询不受支持",
}
const executionStatus = computed(
  () => statusLabels[detail.value?.status.toLowerCase() ?? ""] ?? "状态未记录",
)
const parameters = computed(() => Object.entries(detail.value?.sql_params ?? {}))
const timeConditions = computed(() =>
  Object.entries(detail.value?.conditions.time ?? {}).filter(
    ([, value]) => value !== null && value !== undefined,
  ),
)
const result = computed(() => detail.value?.result)
const resultColumns = computed(() =>
  result.value?.columns.length
    ? result.value.columns
    : [...new Set(result.value?.rows.flatMap((row) => Object.keys(row)) ?? [])],
)
const resultPage = computed(() =>
  result.value ? Math.floor(result.value.offset / result.value.limit) + 1 : 1,
)
const resultTotalPages = computed(() =>
  result.value ? Math.max(1, Math.ceil(result.value.row_count / result.value.limit)) : 1,
)
const timeLabels: Record<string, string> = {
  start: "开始日期",
  end: "结束日期",
  preset: "期间规则",
  target_dates: "指定日期",
  time_windows: "统计区间",
  current_date: "本期日期",
  base_date: "基期日期",
  time_mode: "期间方式",
  start_date: "开始日期",
  end_date: "结束日期",
  label: "期间名称",
}

function rawValue(value: unknown): string {
  if (value === undefined) return "—"
  if (value === null) return "NULL"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object") return JSON.stringify(value)
  return "—"
}

function conditionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(conditionValue).join("、") || "未记录"
  if (value && typeof value === "object") {
    return (
      Object.entries(value)
        .map(([key, item]) => `${timeLabels[key] ?? key}：${conditionValue(item)}`)
        .join("；") || "未记录"
    )
  }
  return rawValue(value)
}

function captureFocus() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
}

async function copySql() {
  const record = detail.value
  if (!record?.sql_text) return
  const text =
    record.sql_text +
    (record.sql_params === null
      ? ""
      : `\n\n-- 绑定参数\n${JSON.stringify(record.sql_params, null, 2)}`)
  try {
    await copyText(text)
    if (props.open && detail.value === record) copyStatus.value = "已复制 SQL 和已保存的绑定参数"
  } catch {
    if (props.open && detail.value === record) {
      copyStatus.value = "自动复制未成功，可选中下方内容手动复制。"
      copyFallback.value = text
    }
  }
}

async function changePage(page: number) {
  if (result.value) await loadPage((page - 1) * result.value.limit)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-slate-900/15" />
      <DialogContent
        class="sql-drawer fixed inset-y-0 right-0 z-50 flex w-[820px] max-w-full flex-col border-l border-slate-200 bg-white text-slate-800 shadow-xl outline-none"
        @open-auto-focus="captureFocus"
        @close-auto-focus="restoreFocus"
      >
        <header class="shrink-0 border-b border-slate-200 px-6 py-5">
          <div class="flex items-center gap-2.5">
            <CodeXml class="size-5 text-blue-600" aria-hidden="true" />
            <DialogTitle class="text-base font-semibold">执行 SQL</DialogTitle>
            <BaseButton
              variant="ghost"
              size="icon"
              class="ml-auto text-slate-500"
              aria-label="关闭执行 SQL"
              @click="emit('update:open', false)"
              ><X
            /></BaseButton>
          </div>
          <DialogDescription class="mt-1.5 text-xs text-slate-500"
            >本条回答关联的查询 · 共 {{ references.length }} 条</DialogDescription
          >
        </header>

        <div v-if="references.length > 1" class="shrink-0 px-6 pt-5">
          <div class="mb-2 flex items-center justify-between text-xs text-slate-500">
            <label :for="querySelectId">选择查询</label>
            <span>{{ selectedIndex + 1 }} / {{ references.length }}</span>
          </div>
          <BaseSelect
            :id="querySelectId"
            v-model="currentKey"
            :options="queryOptions"
            class="h-10 w-full min-w-0 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-200"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5" :aria-busy="loading">
          <div v-if="!selectedReference" class="sql-empty" role="status">
            这条回答没有可查看的查询执行记录。
          </div>
          <div
            v-else-if="loading"
            class="sql-empty flex items-center justify-center gap-2"
            role="status"
          >
            <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />正在读取执行记录…
          </div>
          <div v-else-if="error" class="sql-empty" role="alert">
            <p>{{ errorMessage }}</p>
            <BaseButton v-if="canRetry" variant="outline" size="sm" class="mt-3" @click="reload"
              >重新读取</BaseButton
            >
          </div>
          <template v-else-if="detail">
            <div class="mb-4 flex flex-wrap items-start gap-2">
              <h3 class="min-w-0 flex-1 text-sm font-semibold break-words">{{ queryTitle }}</h3>
              <div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                <span
                  :class="{ 'text-emerald-700': detail.status.toLowerCase() === 'succeeded' }"
                  >{{ executionStatus }}</span
                >
                <template v-if="detail.row_count !== null"
                  ><span aria-hidden="true">·</span
                  ><span>返回 {{ detail.row_count }} 行</span></template
                >
                <template v-if="detail.latency_ms !== null"
                  ><span aria-hidden="true">·</span
                  ><span>{{ detail.latency_ms }} 毫秒</span></template
                >
              </div>
            </div>
            <dl class="sql-conditions">
              <dt>查询机构</dt>
              <dd>
                {{
                  detail.conditions.orgs.map((org) => org.name || org.code).join("、") || "未记录"
                }}
              </dd>
              <dt>统计期间</dt>
              <dd v-if="timeConditions.length" class="space-y-1">
                <p v-for="[key, value] in timeConditions" :key="key">
                  <span class="text-slate-500">{{ timeLabels[key] ?? key }}：</span
                  >{{ conditionValue(value) }}
                </p>
              </dd>
              <dd v-else>未记录</dd>
              <dt>查询指标</dt>
              <dd>
                {{
                  detail.conditions.metrics
                    .map(
                      (metric) =>
                        `${metric.name || metric.code}${metric.unit ? `（${metric.unit}）` : ""}`,
                    )
                    .join("、") || "未记录"
                }}
              </dd>
            </dl>

            <TabsRoot v-model="selectedTab">
              <TabsList class="mb-4 flex gap-6 border-b border-slate-200" aria-label="查询详情">
                <TabsTrigger value="sql" class="sql-tab">SQL 与参数</TabsTrigger>
                <TabsTrigger value="result" class="sql-tab">查询结果</TabsTrigger>
              </TabsList>
              <TabsContent
                value="sql"
                class="outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <template v-if="detail.sql_availability === 'available' && detail.sql_text">
                  <div class="sql-code-frame">
                    <BaseTooltip content="复制原始 SQL 和参数"><BaseButton
                      variant="ghost"
                      size="icon"
                      class="absolute top-2 right-2 bg-slate-50 text-slate-500 hover:text-blue-600"
                      aria-label="复制原始 SQL 和参数"
                      @click="copySql"
                    ><Check v-if="copyStatus.startsWith('已复制')" /><Copy v-else
                    /></BaseButton></BaseTooltip>
                    <!-- 高亮器先转义 SQL 原文，只输出自身生成的着色标签。 -->
                    <pre
                      class="sql-code"
                      tabindex="0"
                      aria-label="SQL 语句"
                    ><code v-if="sqlPresentation?.html" v-html="sqlPresentation.html" /><code v-else>{{ detail.sql_text }}</code></pre>
                  </div>
                  <p
                    v-if="sqlPresentation?.formatted === false"
                    class="mt-2 text-xs text-slate-500"
                  >
                    暂无法完成排版，已显示原始 SQL。
                  </p>
                </template>
                <p v-else class="sql-empty">
                  {{ detail.notice || "此执行记录未保存 SQL，无法还原当时的执行语句。" }}
                </p>
                <BaseDisclosure class="mt-4 text-xs" default-open trigger-class="font-medium focus-visible:ring-blue-200">
                  <template #trigger>
                    绑定参数
                    <span v-if="detail.sql_params !== null" class="font-normal text-slate-500"
                      >· {{ parameters.length }} 项</span
                    >
                  </template>
                  <table v-if="parameters.length" class="sql-parameters" aria-label="SQL 绑定参数">
                    <tbody>
                      <tr v-for="[key, value] in parameters" :key="key">
                        <th scope="row">{{ key }}</th>
                        <td>
                          <code>{{ rawValue(value) }}</code>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-else class="mt-3 text-slate-500">
                    {{
                      detail.sql_params === null
                        ? "此执行记录未保存绑定参数。"
                        : "此查询没有绑定参数。"
                    }}
                  </p>
                </BaseDisclosure>
                <p class="mt-3 min-h-4 text-xs text-blue-700" role="status" aria-live="polite">
                  {{ copyStatus }}
                </p>
                <textarea
                  v-if="copyFallback"
                  :value="copyFallback"
                  readonly
                  aria-label="待复制的 SQL 和参数"
                  class="sql-code mt-2 min-h-32 w-full"
                  @focus="($event.target as HTMLTextAreaElement).select()"
                />
              </TabsContent>
              <TabsContent
                value="result"
                class="outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <template v-if="result">
                  <p
                    v-if="result.truncated"
                    class="mb-3 rounded-md bg-amber-50 p-3 text-xs leading-5 text-amber-800"
                  >
                    仅保存了部分查询结果，以下为已保存的明细。
                  </p>
                  <div
                    v-if="result.rows.length"
                    class="overflow-x-auto rounded-md border border-slate-200"
                  >
                    <table class="sql-results" aria-label="保存的查询结果">
                      <thead>
                        <tr>
                          <BaseTooltip v-for="column in resultColumns" :key="column" :content="column"><th tabindex="0"
                            :class="getResultColumnAlignClass(column)"
                            scope="col"
                          >
                            {{ getResultColumnLabel(column) }}
                          </th></BaseTooltip>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(row, index) in result.rows" :key="result.offset + index">
                          <td
                            v-for="column in resultColumns"
                            :key="column"
                            :class="getResultColumnAlignClass(column)"
                          >
                            {{ rawValue(getResultCellValue(row, column)) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p v-else class="sql-empty">
                    {{
                      result.row_count === 0
                        ? "查询已完成，未返回数据（0 行）。"
                        : "当前页没有已保存的结果。"
                    }}
                  </p>
                  <p class="my-3 text-xs leading-5 text-slate-500">
                    按查询单位展示原始数值，未进行金额单位换算。
                  </p>
                  <ListPagination
                    v-if="!result.truncated && result.row_count > result.limit"
                    :page="resultPage"
                    :page-size="result.limit"
                    :total-items="result.row_count"
                    :total-pages="resultTotalPages"
                    @change="changePage"
                  />
                  <div
                    v-else-if="result.truncated && (result.offset > 0 || result.has_more)"
                    class="flex items-center justify-between border-t border-slate-200 py-3 text-xs text-slate-500"
                  >
                    <span
                      >已保存明细 · 第 {{ result.offset + 1 }}–{{
                        result.offset + result.rows.length
                      }}
                      行</span
                    >
                    <div class="flex gap-2">
                      <BaseButton
                        variant="outline"
                        size="icon"
                        :disabled="result.offset === 0"
                        aria-label="上一页"
                        @click="changePage(resultPage - 1)"
                        ><ChevronLeft
                      /></BaseButton>
                      <BaseButton
                        variant="outline"
                        size="icon"
                        :disabled="!result.has_more || result.next_offset === null"
                        aria-label="下一页"
                        @click="loadPage(result.next_offset ?? 0)"
                        ><ChevronRight
                      /></BaseButton>
                    </div>
                  </div>
                </template>
                <p v-else class="sql-empty">
                  {{
                    detail.result_unavailable_reason === "different_run"
                      ? "保存的结果属于其他执行，本次执行的结果明细不可用。"
                      : "此执行记录未保存结果明细。"
                  }}
                </p>
              </TabsContent>
            </TabsRoot>
          </template>
        </div>
        <footer
          class="shrink-0 border-t border-slate-200 bg-slate-50 px-6 py-3 text-[11px] leading-5 text-slate-500"
        >
          展示已保存的执行记录，读取与翻页不会重新执行查询。
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.sql-drawer {
  font-family: "Microsoft YaHei", sans-serif;
}
.sql-tab:focus-visible {
  outline: 2px solid #93c5fd;
  outline-offset: 2px;
}
.sql-conditions {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 9px 12px;
  margin-bottom: 23px;
  font-size: 12px;
  line-height: 1.7;
}
.sql-conditions dt {
  color: #64748b;
}
.sql-conditions dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.sql-tab {
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  padding-bottom: 10px;
  color: #64748b;
  font-size: 13px;
}
.sql-tab[data-state="active"] {
  border-bottom-color: #2563eb;
  color: #2563eb;
  font-weight: 500;
}
.sql-code {
  margin: 0;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 15px;
  background: #f8fafc;
  max-height: 60vh;
  overflow: auto;
  white-space: pre;
  font:
    13px/1.8 "SFMono-Regular",
    Consolas,
    monospace;
  tab-size: 2;
}
.sql-code:focus-visible {
  outline: 2px solid #93c5fd;
  outline-offset: 2px;
}
.sql-code-frame {
  position: relative;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}
.sql-code-frame .sql-code {
  border: 0;
  padding-top: 44px;
}
.sql-code :deep(.hljs-keyword),
.sql-code :deep(.hljs-type) {
  color: #1d4ed8;
}
.sql-code :deep(.hljs-string) {
  color: #047857;
}
.sql-code :deep(.hljs-number) {
  color: #b45309;
}
.sql-code :deep(.hljs-built_in) {
  color: #6d28d9;
}
.sql-code :deep(.hljs-comment) {
  color: #64748b;
}
.sql-parameters {
  margin-top: 10px;
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 11px;
}
.sql-parameters th,
.sql-parameters td {
  border-bottom: 1px solid #e2e8f0;
  padding: 9px 0;
  vertical-align: top;
  overflow-wrap: anywhere;
  text-align: left;
}
.sql-parameters th {
  width: 125px;
  padding-right: 12px;
  color: #64748b;
  font-weight: 400;
}
.sql-parameters code {
  white-space: pre-wrap;
}
.sql-results {
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.sql-results th,
.sql-results td {
  border-bottom: 1px solid #e2e8f0;
  padding: 11px 12px;
  white-space: nowrap;
  min-width: 110px;
  max-width: 320px;
  vertical-align: top;
}
.sql-results th {
  background: #f8fafc;
  color: #64748b;
  font-weight: 400;
}
.sql-results tr:last-child td {
  border-bottom: 0;
}
.sql-empty {
  border-radius: 8px;
  background: #f8fafc;
  padding: 24px 16px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.8;
}
</style>
