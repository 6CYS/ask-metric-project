<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import {
  ArrowLeft,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Search,
  UserRound,
} from "@lucide/vue"
import AppShell from "@/components/AppShell.vue"
import QueryLogInspector from "@/components/query-logs/QueryLogInspector.vue"
import ChatMarkdown from "@/components/chat/ChatMarkdown.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseCheckbox from "@/components/ui/BaseCheckbox.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import { getQueryLogSession, listQueryLogSessions } from "@/lib/agentApi"
import { logDate, logDuration, logStatusText, nextFailedRound } from "@/lib/queryLogPresentation"
import type { LogFilters, LogRound, LogSession, LogSessionList } from "@/types/queryLogs"
import "@/styles/queryLogs.css"

const route = useRoute(),
  router = useRouter()
const queryText = (key: string) => (typeof route.query[key] === "string" ? route.query[key] : "")
const filters = computed<LogFilters>(() => ({
  search: queryText("q"),
  range: queryText("range") === "all" ? "all" : queryText("range") === "today" ? "today" : "7d",
  errors_only: queryText("errors") === "true",
  page: Math.max(1, Number(queryText("page")) || 1),
  page_size: 10,
}))
const search = ref(filters.value.search)
const selectedId = computed(() => queryText("session"))
const list = ref<LogSessionList | null>(null),
  session = ref<LogSession | null>(null)
const loading = ref(false),
  detailLoading = ref(false),
  refreshing = ref(false)
const listError = ref(""),
  detailError = ref("")
const inspectorId = computed(() => queryText("round") || null)
const inspectorTab = computed({
  get: () => (queryText("tab") === "request" ? "request" : "process"),
  set: (value: string) => {
    router
      .replace({ query: { ...route.query, tab: value === "request" ? value : undefined } })
      .catch(navigationError)
  },
})
const collapsed = ref(new Set<string>())
const inspector = computed(() =>
  session.value?.rounds.find((round) => round.id === inspectorId.value),
)
const failures = computed(
  () => session.value?.rounds.filter((round) => round.status === "failed").length ?? 0,
)
const allCollapsed = computed(
  () =>
    Boolean(session.value?.rounds.length) &&
    session.value?.rounds.every((round) => collapsed.value.has(round.id)),
)
const totalPages = computed(() => Math.max(1, Math.ceil((list.value?.total ?? 0) / 10)))
let listVersion = 0,
  detailVersion = 0,
  searchTimer: ReturnType<typeof setTimeout> | undefined
let listAbort: AbortController | undefined, detailAbort: AbortController | undefined
const dateOptions = [
  { value: "today" as const, label: "今天" },
  { value: "7d" as const, label: "近 7 天" },
  { value: "all" as const, label: "全部时间" },
]
function updateFilter(change: Record<string, string | undefined>) {
  router.replace({ query: { ...route.query, page: undefined, ...change } }).catch(navigationError)
}
function navigationError() {
  listError.value = "页面切换未完成，请重试。"
}
watch(search, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (value !== filters.value.search) updateFilter({ q: value || undefined })
  }, 300)
})
watch(
  () => filters.value.search,
  (value) => {
    search.value = value
  },
)
watch(
  () => JSON.stringify(filters.value),
  () => {
    return loadList()
  },
  { immediate: true },
)
watch(
  selectedId,
  () => {
    collapsed.value = new Set()
    session.value = null
    return loadDetail()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  listAbort?.abort()
  detailAbort?.abort()
  ++listVersion
  ++detailVersion
})
async function loadList() {
  const version = ++listVersion
  listAbort?.abort()
  listAbort = new AbortController()
  loading.value = true
  listError.value = ""
  try {
    const result = await listQueryLogSessions(filters.value, listAbort.signal)
    if (version === listVersion) list.value = result
  } catch (error) {
    if (version === listVersion)
      listError.value = error instanceof Error ? error.message : "日志加载失败，请重试。"
  } finally {
    if (version === listVersion) loading.value = false
  }
}
async function loadDetail() {
  const version = ++detailVersion,
    id = selectedId.value
  detailAbort?.abort()
  detailError.value = ""
  if (!id) {
    detailLoading.value = false
    return
  }
  detailAbort = new AbortController()
  detailLoading.value = true
  try {
    const result = await getQueryLogSession(id, detailAbort.signal)
    if (version === detailVersion) {
      session.value = result
    }
  } catch (error) {
    if (version === detailVersion)
      detailError.value = error instanceof Error ? error.message : "会话加载失败，请重试。"
  } finally {
    if (version === detailVersion) detailLoading.value = false
  }
}
async function refresh() {
  refreshing.value = true
  try {
    await Promise.all([loadList(), selectedId.value ? loadDetail() : Promise.resolve()])
  } finally {
    refreshing.value = false
  }
}
function openSession(id: string) {
  router
    .push({ query: { ...route.query, session: id, round: undefined, tab: undefined } })
    .catch(navigationError)
}
function back() {
  router
    .push({ query: { ...route.query, session: undefined, round: undefined, tab: undefined } })
    .catch(navigationError)
}
function changePage(page: number) {
  router.replace({ query: { ...route.query, page: String(page) } }).catch(navigationError)
}
function toggleRound(id: string) {
  const updated = new Set(collapsed.value)
  if (updated.has(id)) updated.delete(id)
  else updated.add(id)
  collapsed.value = updated
}
function toggleAll() {
  collapsed.value = allCollapsed.value
    ? new Set()
    : new Set(session.value?.rounds.map((round) => round.id))
}
function openInspector(round: LogRound) {
  router
    .replace({ query: { ...route.query, round: round.id, tab: undefined } })
    .catch(navigationError)
}
async function closeInspector() {
  const id = inspectorId.value
  await router
    .replace({ query: { ...route.query, round: undefined, tab: undefined } })
    .catch(navigationError)
  await nextTick()
  document.getElementById(`inspect-${id}`)?.focus()
}
async function locateFailure() {
  const round = nextFailedRound(session.value?.rounds ?? [], inspectorId.value)
  if (!round) return
  collapsed.value = new Set([...collapsed.value].filter((id) => id !== round.id))
  await router
    .replace({ query: { ...route.query, round: round.id, tab: undefined } })
    .catch(navigationError)
  await nextTick()
  document.getElementById(`round-${round.id}`)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    block: "start",
  })
  document.getElementById(`inspect-${round.id}`)?.focus({ preventScroll: true })
}
</script>

<template>
  <AppShell full-bleed :content-padding="false" :compact-navigation="Boolean(inspector)">
    <div class="query-log-page" @keydown.esc="inspector && closeInspector()">
      <div class="am-topbar">
        <div class="am-topbar-left">
          <span>{{ selectedId ? "问数日志" : "工作台" }}</span
          ><ChevronRight /><span>{{ selectedId ? "会话详情" : "问数日志" }}</span>
        </div>
      </div>
      <div class="am-body">
        <template v-if="!selectedId">
          <div class="am-page-heading">
            <div>
              <h1>问数日志</h1>
              <p class="am-description">以会话回看完整问答，定位每一轮的执行问题。</p>
            </div>
            <BaseButton
              variant="outline"
              class="am-btn"
              :disabled="loading || refreshing"
              @click="refresh"
              ><RefreshCw :class="{ 'animate-spin': refreshing }" />刷新</BaseButton
            >
          </div>
          <div class="am-stats" aria-label="当前筛选结果统计">
            <div class="am-stat">
              <p class="am-stat-label">会话数</p>
              <p class="am-stat-number">{{ list?.stats.sessions ?? "—" }}</p>
            </div>
            <div class="am-stat">
              <p class="am-stat-label">问答轮数</p>
              <p class="am-stat-number">{{ list?.stats.rounds ?? "—" }}</p>
            </div>
            <div class="am-stat">
              <p class="am-stat-label">失败轮数</p>
              <p class="am-stat-number">{{ list?.stats.failed_rounds ?? "—" }}</p>
            </div>
            <div class="am-stat">
              <p class="am-stat-label">平均响应耗时</p>
              <p class="am-stat-number">
                {{
                  list?.stats.average_duration_ms == null
                    ? "—"
                    : (list.stats.average_duration_ms / 1000).toFixed(1)
                }}<span class="am-unit">秒</span>
              </p>
            </div>
          </div>
          <div class="am-toolbar">
            <label class="am-search"
              ><Search /><input
                v-model="search"
                type="search"
                aria-label="搜索会话或对话内容"
                placeholder="搜索会话或对话内容" /></label
            ><BaseSelect
              class="am-date-select"
              aria-label="时间范围"
              :model-value="filters.range"
              :options="dateOptions"
              @update:model-value="updateFilter({ range: $event })"
            /><label class="am-check"
              ><BaseCheckbox
                :model-value="filters.errors_only"
                @update:model-value="updateFilter({ errors: $event ? 'true' : undefined })"
              />仅看异常会话</label
            >
          </div>
          <BaseAlert v-if="listError" title="日志加载失败" variant="destructive" role="alert"
            >{{ listError }}<BaseButton variant="link" @click="refresh">重试</BaseButton></BaseAlert
          >
          <div class="am-section-label">
            <span
              >会话记录 <span class="am-muted">· {{ list?.total ?? 0 }} 个</span></span
            ><span class="am-muted">最近活动优先</span>
          </div>
          <LoadingSkeleton v-if="loading && !list" variant="table" />
          <div v-else :aria-busy="loading">
            <table class="am-table">
              <colgroup>
                <col />
                <col class="am-round-col" style="width: 9%" />
                <col style="width: 18%" />
                <col class="am-date-col" style="width: 17%" />
                <col style="width: 30px" />
              </colgroup>
              <thead>
                <tr>
                  <th>会话主题 / 最近问题</th>
                  <th class="am-round-col">轮数</th>
                  <th>会话概况</th>
                  <th class="am-date-col">最近活动</th>
                  <th><span class="sr-only">查看会话</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in list?.items" :key="item.session_id">
                  <td>
                    <button
                      class="am-session-name"
                      type="button"
                      @click="openSession(item.session_id)"
                    >
                      <MessageSquareText /><span class="am-name-wrap"
                        ><span class="am-name-text">{{ item.title }}</span
                        ><span class="am-last-question">{{
                          filters.search && item.matched_text
                            ? `匹配对话：${item.matched_text}`
                            : item.last_question
                        }}</span></span
                      ></button
                    ><span class="am-mobile-time"
                      >{{ logDate(item.last_active_at) }} · {{ item.round_count }} 轮</span
                    >
                  </td>
                  <td class="am-round-col am-num">{{ item.round_count }}</td>
                  <td>
                    <span
                      class="am-badge"
                      :class="item.failed_count ? 'is-error' : `is-${item.status}`"
                      ><CircleAlert v-if="item.failed_count" />{{
                        item.failed_count
                          ? `含 ${item.failed_count} 轮失败`
                          : logStatusText[item.status]
                      }}</span
                    >
                  </td>
                  <td class="am-date-col am-muted am-num">{{ logDate(item.last_active_at) }}</td>
                  <td>
                    <BaseButton
                      variant="ghost"
                      size="icon"
                      class="am-btn am-icon am-quiet"
                      :aria-label="`查看会话：${item.title}`"
                      @click="openSession(item.session_id)"
                      ><ChevronRight
                    /></BaseButton>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!list?.items.length && !loading" class="am-empty">
              {{ listError ? "日志暂未加载，请重试。" : "暂无符合条件的会话" }}
            </p>
          </div>
          <div v-if="list" class="am-list-footer">
            <span
              >共 {{ list.stats.sessions }} 个会话 · {{ list.stats.rounds }} 轮对话<span
                class="am-footer-hint"
                >统计覆盖当前筛选结果</span
              ></span
            >
            <div v-if="totalPages > 1" class="am-pagination">
              <BaseButton
                variant="ghost"
                size="icon"
                class="am-btn am-icon"
                :disabled="list.page <= 1 || loading"
                aria-label="上一页"
                @click="changePage(list.page - 1)"
                ><ChevronLeft /></BaseButton
              ><span>{{ list.page }} / {{ totalPages }}</span
              ><BaseButton
                variant="ghost"
                size="icon"
                class="am-btn am-icon"
                :disabled="list.page >= totalPages || loading"
                aria-label="下一页"
                @click="changePage(list.page + 1)"
                ><ChevronRight
              /></BaseButton>
            </div>
          </div>
        </template>
        <template v-else>
          <BaseButton variant="ghost" class="am-btn am-quiet am-back" @click="back"
            ><ArrowLeft />返回会话列表</BaseButton
          >
          <BaseAlert v-if="detailError" title="会话加载失败" variant="destructive" role="alert"
            >{{ detailError
            }}<BaseButton variant="link" @click="loadDetail">重试</BaseButton></BaseAlert
          >
          <LoadingSkeleton v-if="detailLoading && !session" variant="table" />
          <template v-if="session">
            <div class="am-detail-heading">
              <div>
                <h2>{{ session.title }}</h2>
                <div class="am-session-meta">
                  <span>{{ logDate(session.created_at) }}</span
                  ><span>·</span><span>{{ session.rounds.length }} 轮对话</span><span>·</span
                  ><span
                    >{{ logDate(session.rounds[0]?.started_at ?? null, true) }} —
                    {{ logDate(session.last_active_at, true) }}</span
                  ><span v-if="failures" class="am-badge is-error">{{ failures }} 轮失败</span>
                </div>
              </div>
              <div class="am-detail-controls-actions">
                <BaseButton v-if="failures" variant="outline" class="am-btn" @click="locateFailure"
                  ><CircleAlert />定位异常（{{ failures }}）</BaseButton
                ><BaseButton
                  variant="ghost"
                  size="icon"
                  class="am-btn am-icon am-quiet"
                  aria-label="刷新会话"
                  :disabled="detailLoading"
                  @click="refresh"
                  ><RefreshCw :class="{ 'animate-spin': detailLoading }"
                /></BaseButton>
              </div>
            </div>
            <div class="am-detail-controls">
              <span
                >对话记录 <span class="am-muted">· {{ session.rounds.length }} 轮</span></span
              >
              <div class="am-detail-controls-actions">
                <span class="am-muted">按发生顺序</span
                ><BaseButton variant="ghost" class="am-btn am-quiet" @click="toggleAll">{{
                  allCollapsed ? "展开全部" : "收起全部"
                }}</BaseButton>
              </div>
            </div>
            <div class="am-inspect-grid" :class="{ 'has-inspector': inspector }">
              <div class="am-turn-list">
                <article
                  v-for="round in session.rounds"
                  :id="`round-${round.id}`"
                  :key="round.id"
                  class="am-turn"
                  :class="{
                    'is-error': round.status === 'failed',
                    'is-focused': inspectorId === round.id,
                  }"
                >
                  <div class="am-turn-head">
                    <div class="am-turn-title">
                      <span class="am-turn-dot" /><button
                        type="button"
                        class="am-turn-toggle"
                        :aria-expanded="!collapsed.has(round.id)"
                        :aria-controls="`round-content-${round.id}`"
                        @click="toggleRound(round.id)"
                      >
                        <ChevronRight :class="{ 'am-rotated': !collapsed.has(round.id) }" />第
                        {{ round.number }} 轮</button
                      ><span class="am-muted am-num">{{ logDate(round.started_at, true) }}</span>
                    </div>
                    <div class="am-turn-head-right">
                      <span class="am-badge" :class="`is-${round.status}`">{{
                        logStatusText[round.status]
                      }}</span
                      ><span class="am-num">{{ logDuration(round.duration_ms) }}</span
                      ><span v-if="round.retry_count">重试 {{ round.retry_count }} 次</span
                      ><BaseButton
                        :id="`inspect-${round.id}`"
                        variant="ghost"
                        class="am-btn am-quiet"
                        :aria-expanded="inspectorId === round.id"
                        :aria-controls="inspectorId === round.id ? 'query-log-inspector' : undefined"
                        @click="openInspector(round)"
                        >{{ inspectorId === round.id ? "正在查看" : "执行详情" }}<ChevronRight
                      /></BaseButton>
                    </div>
                  </div>
                  <p v-if="collapsed.has(round.id)" class="am-collapsed-question">
                    {{ round.question }}
                  </p>
                  <div v-show="!collapsed.has(round.id)" :id="`round-content-${round.id}`">
                    <div class="am-message">
                      <span class="am-avatar"><UserRound /></span>
                      <div>
                        <p class="am-message-label">用户提问</p>
                        <p class="am-question">{{ round.question }}</p>
                      </div>
                    </div>
                    <div class="am-message">
                      <span class="am-avatar"><Bot /></span>
                      <div>
                        <p class="am-message-label">系统回答</p>
                        <div :class="{ 'am-error-answer': round.status === 'failed' }">
                          <ChatMarkdown
                            v-for="(answer, index) in round.answers"
                            :key="index"
                            :source="answer"
                          />
                          <p v-if="!round.answers.length" class="am-muted">
                            {{
                              round.status === "running"
                                ? "本轮尚未完成回答。"
                                : "本轮未记录系统回答。"
                            }}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
                <p v-if="!session.rounds.length" class="am-empty">此会话暂无对话记录</p>
                <p class="am-record-end">
                  <LockKeyhole />会话日志只读 · 共 {{ session.rounds.length }} 轮对话
                </p>
              </div>
              <QueryLogInspector
                v-if="inspector"
                v-model:tab="inspectorTab"
                :session-id="session.session_id"
                :round="inspector"
                @close="closeInspector"
              />
            </div>
          </template>
        </template>
      </div>
    </div>
  </AppShell>
</template>
