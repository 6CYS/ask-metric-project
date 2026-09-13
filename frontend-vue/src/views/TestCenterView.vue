<script setup lang="ts">
import {
  CheckCircle2,
  Download,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "@lucide/vue"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

import AppShell from "@/components/AppShell.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import { useQueryReadiness } from "@/composables/useQueryReadiness"
import {
  createAccuracySuite,
  confirmAccuracyImport,
  deleteAccuracySuite,
  downloadAccuracyImportTemplate,
  getAccuracyRun,
  listAccuracyRuns,
  listAccuracySuites,
  previewAccuracyImport,
  startAccuracyRun,
  updateAccuracySuite,
} from "@/lib/api"
import type { AccuracyImportPreview, AccuracyRun, AccuracySuite } from "@/types/api"

type Tab = "overview" | "accuracy" | "datasets" | "runs"

const activeTab = ref<Tab>("overview")
const { state: queryReadiness, ready: queryReady } = useQueryReadiness()
const suites = ref<AccuracySuite[]>([])
const runs = ref<AccuracyRun[]>([])
const selectedSuiteId = ref("")
const selectedRunId = ref("")
const draftSuite = ref<AccuracySuite | null>(null)
const loading = ref(true)
const saving = ref(false)
const starting = ref(false)
const importing = ref(false)
const confirmingImport = ref(false)
const importMode = ref<"append" | "replace">("append")
const importPreview = ref<AccuracyImportPreview | null>(null)
const importNotice = ref("")
const importInput = ref<HTMLInputElement | null>(null)
const error = ref("")
let pollTimer: number | undefined

const selectedSuite = computed(() => suites.value.find((item) => item.id === selectedSuiteId.value) ?? null)
const selectedRun = computed(() => runs.value.find((item) => item.id === selectedRunId.value) ?? runs.value[0] ?? null)
const activeRun = computed(() => runs.value.find((item) => ["queued", "running"].includes(item.status)) ?? null)
const latestCompletedRun = computed(() => runs.value.find((item) => item.status === "completed") ?? null)
const latestPassRate = computed(() => {
  const run = latestCompletedRun.value
  const total = (run?.passed ?? 0) + (run?.failed ?? 0)
  return run && total ? Math.round((run.passed / total) * 100) : 0
})
const latestSemanticRate = computed(() => {
  const results = latestCompletedRun.value?.results.filter((item) => item.assertions.some((assertion) => ["查询类型", "指标识别", "指标名称", "机构识别", "机构名称", "待澄清字段"].includes(assertion.name))) ?? []
  return results.length ? Math.round((results.filter((item) => item.semantic_passed).length / results.length) * 100) : 0
})
const latestResultRate = computed(() => {
  const results = latestCompletedRun.value?.results.filter((item) => item.assertions.some((assertion) => ["执行状态", "结果行数", "结果值"].includes(assertion.name))) ?? []
  return results.length ? Math.round((results.filter((item) => item.result_passed).length / results.length) * 100) : 0
})
const progress = computed(() => activeRun.value?.total ? Math.round((activeRun.value.completed / activeRun.value.total) * 100) : 0)

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "测试总览" },
  { id: "accuracy", label: "准确率测试" },
  { id: "datasets", label: "测试集管理" },
  { id: "runs", label: "运行记录" },
]

function cloneSuite(suite: AccuracySuite) {
  return JSON.parse(JSON.stringify(suite)) as AccuracySuite
}

function formatDate(value?: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—"
}

function runStatusLabel(status: AccuracyRun["status"]) {
  return { queued: "等待执行", running: "执行中", completed: "已完成", failed: "执行失败" }[status]
}

function verdictLabel(value: string) {
  return { passed: "通过", failed: "未通过", needs_review: "待补充预期" }[value] ?? value
}

async function loadAll() {
  loading.value = true
  error.value = ""
  try {
    const [suiteItems, runItems] = await Promise.all([listAccuracySuites(), listAccuracyRuns()])
    suites.value = suiteItems
    runs.value = runItems
    selectedSuiteId.value ||= suiteItems[0]?.id ?? ""
    selectedRunId.value ||= runItems[0]?.id ?? ""
    if (selectedSuite.value) draftSuite.value = cloneSuite(selectedSuite.value)
    schedulePoll()
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "测试中心加载失败。"
    error.value = /404|not found/i.test(message)
      ? "后端尚未加载测试中心接口，请重启或重新部署 backend-next 后再试。"
      : /failed to fetch|network/i.test(message)
        ? "无法连接 backend-next，测试任务暂时不能执行。请确认后端服务已启动。"
        : message
  } finally {
    loading.value = false
  }
}

function schedulePoll() {
  if (pollTimer) window.clearTimeout(pollTimer)
  if (!activeRun.value) return
  pollTimer = window.setTimeout(async () => {
    try {
      const updated = await getAccuracyRun(activeRun.value!.id)
      runs.value = runs.value.map((item) => item.id === updated.id ? updated : item)
      selectedRunId.value = updated.id
      if (!["queued", "running"].includes(updated.status)) runs.value = await listAccuracyRuns()
    } finally {
      schedulePoll()
    }
  }, 1500)
}

async function runSuite() {
  if (!queryReady.value || !selectedSuite.value || starting.value) return
  starting.value = true
  error.value = ""
  try {
    const run = await startAccuracyRun(selectedSuite.value.id)
    runs.value = [run, ...runs.value]
    selectedRunId.value = run.id
    activeTab.value = "accuracy"
    schedulePoll()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "测试启动失败。"
  } finally {
    starting.value = false
  }
}

function selectSuite(id: string) {
  selectedSuiteId.value = id
  const suite = suites.value.find((item) => item.id === id)
  draftSuite.value = suite ? cloneSuite(suite) : null
  resetImport()
}

function resetImport() {
  importPreview.value = null
  importNotice.value = ""
  if (importInput.value) importInput.value.value = ""
}

function openImport() {
  resetImport()
  importInput.value?.click()
}

async function downloadTemplate() {
  error.value = ""
  try {
    await downloadAccuracyImportTemplate()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模板下载失败。"
  }
}

async function selectImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !draftSuite.value?.id) return
  error.value = ""
  importNotice.value = ""
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    error.value = "仅支持 .xlsx 格式的Excel文件。"
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    error.value = "Excel文件不能超过5MB。"
    return
  }
  importing.value = true
  try {
    importPreview.value = await previewAccuracyImport(
      draftSuite.value.id,
      file,
      importMode.value,
    )
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Excel解析失败。"
  } finally {
    importing.value = false
  }
}

async function confirmImport() {
  const preview = importPreview.value
  if (!draftSuite.value?.id || !preview?.can_import) return
  if (importMode.value === "replace" && !window.confirm("覆盖导入将替换当前全部用例，确认继续？")) {
    return
  }
  confirmingImport.value = true
  error.value = ""
  try {
    const result = await confirmAccuracyImport(draftSuite.value.id, {
      mode: preview.mode,
      cases: preview.cases,
    })
    const index = suites.value.findIndex((item) => item.id === result.suite.id)
    if (index >= 0) suites.value[index] = result.suite
    draftSuite.value = cloneSuite(result.suite)
    importNotice.value = `已导入 ${result.imported_count} 条，跳过 ${result.skipped_count} 条。`
    importPreview.value = null
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "测试案例导入失败。"
  } finally {
    confirmingImport.value = false
  }
}

function newSuite() {
  const now = new Date().toISOString()
  draftSuite.value = { id: "", name: "新测试集", description: "", cases: [], created_at: now, updated_at: now }
  selectedSuiteId.value = ""
  activeTab.value = "datasets"
}

function addCase() {
  if (!draftSuite.value) return
  const nextId = Math.max(0, ...draftSuite.value.cases.map((item) => item.id)) + 1
  draftSuite.value.cases.push({ id: nextId, question: "", category: "自定义", expected_status: "succeeded", expected_shape: null, expected_metric_codes: [], expected_metric_names: [], expected_orgs: [], expected_org_names: [], expected_missing: [], expected_row_count: null, expected_value: null, value_tolerance: 0.01 })
}

function removeCase(index: number) {
  draftSuite.value?.cases.splice(index, 1)
}

function parseList(value: string) {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
}

async function saveSuite() {
  if (!draftSuite.value || !draftSuite.value.name.trim() || draftSuite.value.cases.some((item) => !item.question.trim())) return
  saving.value = true
  error.value = ""
  const payload = {
    name: draftSuite.value.name.trim(),
    description: draftSuite.value.description.trim(),
    cases: draftSuite.value.cases.map((item) => ({
      ...item,
      expected_row_count: typeof item.expected_row_count === "number" && Number.isFinite(item.expected_row_count) ? item.expected_row_count : null,
      expected_value: typeof item.expected_value === "number" && Number.isFinite(item.expected_value) ? item.expected_value : null,
      value_tolerance: typeof item.value_tolerance === "number" && Number.isFinite(item.value_tolerance) ? item.value_tolerance : 0.01,
    })),
  }
  try {
    const saved = draftSuite.value.id
      ? await updateAccuracySuite(draftSuite.value.id, payload)
      : await createAccuracySuite(payload)
    const index = suites.value.findIndex((item) => item.id === saved.id)
    if (index >= 0) suites.value[index] = saved
    else suites.value.unshift(saved)
    selectSuite(saved.id)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "测试集保存失败。"
  } finally {
    saving.value = false
  }
}

async function removeSuite() {
  if (!draftSuite.value?.id || draftSuite.value.id === "phase-one-baseline") return
  if (!window.confirm(`确认删除测试集“${draftSuite.value.name}”？`)) return
  await deleteAccuracySuite(draftSuite.value.id)
  suites.value = suites.value.filter((item) => item.id !== draftSuite.value?.id)
  selectSuite(suites.value[0]?.id ?? "")
}

onMounted(() => void loadAll())
onBeforeUnmount(() => { if (pollTimer) window.clearTimeout(pollTimer) })
</script>

<template>
  <AppShell>
    <header class="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">Quality Center</p>
        <h1 class="mt-2 text-3xl font-semibold">自动化测试中心</h1>
        <p class="mt-2 text-sm text-muted-foreground">管理只读问数基线，执行准确率回归并定位语义和结果偏差。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="selectedSuiteId" class="form-control min-w-56" @change="selectSuite(selectedSuiteId)">
          <option v-for="suite in suites" :key="suite.id" :value="suite.id">{{ suite.name }}（{{ suite.cases.length }}条）</option>
        </select>
        <BaseButton :disabled="!queryReady || !selectedSuite || starting || Boolean(activeRun)" @click="runSuite"><LoaderCircle v-if="starting" class="animate-spin" /><Play v-else />开始测试</BaseButton>
      </div>
    </header>

    <p v-if="!queryReady" role="status" aria-live="polite" class="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle v-if="queryReadiness.status === 'initializing'" class="size-4 shrink-0 animate-spin" />
      {{ queryReadiness.message }}<span v-if="queryReadiness.total > 0">（{{ queryReadiness.completed }}/{{ queryReadiness.total }}）</span>
    </p>

    <nav class="flex flex-wrap gap-1 border-b" aria-label="测试中心导航">
      <button v-for="tab in tabs" :key="tab.id" type="button" class="border-b-2 px-4 py-2.5 text-sm transition-colors" :class="activeTab === tab.id ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'" @click="activeTab = tab.id">{{ tab.label }}</button>
    </nav>

    <BaseAlert v-if="error" title="操作未完成" variant="destructive">{{ error }}</BaseAlert>
    <LoadingSkeleton v-if="loading" :rows="4" row-class="h-20" />

    <template v-else>
      <section v-if="activeRun" class="border-l-2 border-[#7C9CDB] bg-muted/15 px-4 py-3">
        <div class="flex items-center justify-between gap-3 text-sm"><span class="font-medium">{{ activeRun.suite_name }}正在执行</span><span class="text-muted-foreground">{{ activeRun.completed }}/{{ activeRun.total }}</span></div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-[#7C9CDB] transition-[width]" :style="{ width: `${progress}%` }" /></div>
      </section>

      <section v-if="activeTab === 'overview'" class="space-y-6">
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article class="border-b p-4"><p class="text-xs text-muted-foreground">测试用例</p><p class="mt-2 text-3xl font-semibold tabular-nums">{{ suites.reduce((sum, item) => sum + item.cases.length, 0) }}</p><p class="mt-1 text-xs text-muted-foreground">{{ suites.length }} 个测试集</p></article>
          <article class="border-b p-4"><p class="text-xs text-muted-foreground">整体通过率</p><p class="mt-2 text-3xl font-semibold tabular-nums">{{ latestPassRate }}%</p><p class="mt-1 text-xs text-muted-foreground">仅统计已配置预期的用例</p></article>
          <article class="border-b p-4"><p class="text-xs text-muted-foreground">语义准确率</p><p class="mt-2 text-3xl font-semibold tabular-nums">{{ latestSemanticRate }}%</p><p class="mt-1 text-xs text-muted-foreground">查询类型、指标和机构</p></article>
          <article class="border-b p-4"><p class="text-xs text-muted-foreground">结果准确率</p><p class="mt-2 text-3xl font-semibold tabular-nums">{{ latestResultRate }}%</p><p class="mt-1 text-xs text-muted-foreground">执行状态和返回行数</p></article>
        </div>
        <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section><h2 class="font-semibold">最近运行</h2><div class="mt-3 overflow-x-auto border-y"><table class="w-full text-sm"><thead class="bg-muted/40"><tr><th class="table-head">测试集</th><th class="table-head">状态</th><th class="table-head">通过/失败/待复核</th><th class="table-head">开始时间</th></tr></thead><tbody><tr v-for="run in runs.slice(0, 5)" :key="run.id" class="border-b last:border-0"><td class="table-cell font-medium">{{ run.suite_name }}</td><td class="table-cell"><BaseBadge :variant="run.status === 'completed' ? 'success' : run.status === 'failed' ? 'destructive' : 'warning'">{{ runStatusLabel(run.status) }}</BaseBadge></td><td class="table-cell tabular-nums">{{ run.passed }} / {{ run.failed }} / {{ run.needs_review }}</td><td class="table-cell text-muted-foreground">{{ formatDate(run.started_at) }}</td></tr></tbody></table></div></section>
          <aside class="border-l pl-5"><h2 class="font-semibold">评分说明</h2><ul class="mt-3 space-y-3 text-sm text-muted-foreground"><li><strong class="text-foreground">语义准确率</strong><br>查询类型、指标编码和机构识别。</li><li><strong class="text-foreground">结果准确率</strong><br>执行状态和返回行数。</li><li><strong class="text-foreground">待补充预期</strong><br>用例可执行，但暂不计入准确率。</li></ul></aside>
        </div>
      </section>

      <section v-else-if="activeTab === 'accuracy'" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-semibold">准确率报告</h2><p class="mt-1 text-sm text-muted-foreground">{{ selectedRun ? `${selectedRun.suite_name} · ${formatDate(selectedRun.started_at)}` : '尚无运行记录' }}</p></div><select v-model="selectedRunId" class="form-control min-w-64"><option v-for="run in runs" :key="run.id" :value="run.id">{{ run.suite_name }} · {{ formatDate(run.started_at) }}</option></select></div>
        <BaseAlert v-if="selectedRun?.error" title="本次报告不可用" variant="destructive">{{ selectedRun.error }}</BaseAlert>
        <div v-if="selectedRun" class="grid gap-3 sm:grid-cols-4"><div class="border-b p-3"><p class="text-xs text-muted-foreground">已执行</p><p class="mt-1 text-2xl font-semibold">{{ selectedRun.completed }}/{{ selectedRun.total }}</p></div><div class="border-b p-3"><p class="text-xs text-muted-foreground">通过</p><p class="mt-1 text-2xl font-semibold">{{ selectedRun.passed }}</p></div><div class="border-b p-3"><p class="text-xs text-muted-foreground">未通过</p><p class="mt-1 text-2xl font-semibold">{{ selectedRun.failed }}</p></div><div class="border-b p-3"><p class="text-xs text-muted-foreground">待补充预期</p><p class="mt-1 text-2xl font-semibold">{{ selectedRun.needs_review }}</p></div></div>
        <div v-if="selectedRun" class="overflow-x-auto border-y"><table class="w-full text-sm"><thead class="bg-muted/40"><tr><th class="table-head">#</th><th class="table-head min-w-80">问题</th><th class="table-head">状态</th><th class="table-head">查询类型</th><th class="table-head">语义</th><th class="table-head">结果</th><th class="table-head">断言详情</th></tr></thead><tbody><tr v-for="result in selectedRun.results" :key="result.id" class="border-b align-top"><td class="table-cell">{{ result.id }}</td><td class="table-cell leading-6">{{ result.question }}</td><td class="table-cell"><BaseBadge :variant="result.verdict === 'passed' ? 'success' : result.verdict === 'failed' ? 'destructive' : 'secondary'">{{ verdictLabel(result.verdict) }}</BaseBadge></td><td class="table-cell font-mono text-xs">{{ result.shape ?? result.status }}</td><td class="table-cell"><CheckCircle2 v-if="result.semantic_passed" class="size-4 text-emerald-600" /><span v-else class="text-muted-foreground">—</span></td><td class="table-cell"><CheckCircle2 v-if="result.result_passed" class="size-4 text-emerald-600" /><span v-else class="text-muted-foreground">—</span></td><td class="table-cell"><details><summary class="cursor-pointer text-muted-foreground">查看</summary><ul class="mt-2 min-w-64 space-y-1 text-xs"><li v-for="assertion in result.assertions" :key="assertion.name" :class="assertion.passed ? 'text-emerald-700' : 'text-amber-700'">{{ assertion.name }}：{{ assertion.passed ? '符合预期' : `预期 ${JSON.stringify(assertion.expected)}，实际 ${JSON.stringify(assertion.actual)}` }}</li><li v-if="result.error" class="text-amber-700">{{ result.error }}</li></ul></details></td></tr></tbody></table></div>
      </section>

      <section v-else-if="activeTab === 'datasets'" class="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside class="border-r pr-4"><div class="flex items-center justify-between"><h2 class="font-semibold">测试集</h2><BaseButton size="icon" variant="ghost" title="新建测试集" @click="newSuite"><Plus /></BaseButton></div><div class="mt-3 space-y-1"><button v-for="suite in suites" :key="suite.id" type="button" class="w-full rounded-lg px-3 py-2 text-left text-sm" :class="draftSuite?.id === suite.id ? 'bg-muted font-medium' : 'hover:bg-muted/60'" @click="selectSuite(suite.id)"><span class="block truncate">{{ suite.name }}</span><span class="mt-0.5 block text-xs text-muted-foreground">{{ suite.cases.length }} 条用例</span></button></div></aside>
        <div v-if="draftSuite" class="min-w-0 space-y-5">
          <div class="grid gap-4 md:grid-cols-2">
            <label class="form-field">测试集名称<input v-model="draftSuite.name" class="form-control"></label>
            <label class="form-field">说明<input v-model="draftSuite.description" class="form-control"></label>
          </div>
          <BaseAlert v-if="importNotice" title="导入完成">{{ importNotice }}</BaseAlert>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div><h2 class="font-semibold">测试用例</h2><p class="mt-1 text-xs text-muted-foreground">空的预期字段不会参与评分，运行后标记为“待补充预期”。</p></div>
            <div class="flex flex-wrap items-center gap-2">
              <BaseButton variant="ghost" @click="downloadTemplate"><Download />下载模板</BaseButton>
              <select v-model="importMode" class="form-control w-28" :disabled="Boolean(importPreview)" title="导入方式">
                <option value="append">追加导入</option>
                <option value="replace">覆盖导入</option>
              </select>
              <input ref="importInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden" @change="selectImportFile">
              <BaseButton variant="outline" :disabled="!draftSuite.id || importing" title="请先保存新建测试集后再导入" @click="openImport"><LoaderCircle v-if="importing" class="animate-spin" /><Upload v-else />导入Excel</BaseButton>
              <BaseButton variant="outline" @click="addCase"><Plus />添加用例</BaseButton>
            </div>
          </div>
          <section v-if="importPreview" class="space-y-4 border-y py-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="font-medium">导入预览</h3>
                <p class="mt-1 text-xs text-muted-foreground">{{ importPreview.filename }} · {{ importPreview.mode === 'append' ? '追加导入' : '覆盖导入' }}</p>
              </div>
              <BaseButton size="icon" variant="ghost" title="取消导入" @click="resetImport"><X /></BaseButton>
            </div>
            <div class="grid gap-3 sm:grid-cols-4">
              <div class="border-b p-3"><p class="text-xs text-muted-foreground">文件行数</p><p class="mt-1 text-xl font-semibold">{{ importPreview.total_rows }}</p></div>
              <div class="border-b p-3"><p class="text-xs text-muted-foreground">可导入</p><p class="mt-1 text-xl font-semibold text-emerald-700">{{ importPreview.valid_count }}</p></div>
              <div class="border-b p-3"><p class="text-xs text-muted-foreground">重复跳过</p><p class="mt-1 text-xl font-semibold">{{ importPreview.duplicate_count }}</p></div>
              <div class="border-b p-3"><p class="text-xs text-muted-foreground">格式错误</p><p class="mt-1 text-xl font-semibold" :class="importPreview.error_count ? 'text-destructive' : ''">{{ importPreview.error_count }}</p></div>
            </div>
            <BaseAlert v-if="importPreview.error_count" title="请修正Excel后重新上传" variant="destructive">为避免导入不完整数据，存在格式错误时不能确认导入。</BaseAlert>
            <BaseAlert v-else-if="!importPreview.valid_count" title="没有可导入的案例">文件内容为空，或全部案例均与当前测试集重复。</BaseAlert>
            <div class="max-h-80 overflow-auto border-y">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-muted"><tr><th class="table-head">Excel行</th><th class="table-head min-w-80">用户问题</th><th class="table-head">校验结果</th><th class="table-head min-w-48">说明</th></tr></thead>
                <tbody><tr v-for="row in importPreview.rows" :key="row.row_number" class="border-b align-top"><td class="table-cell">{{ row.row_number }}</td><td class="table-cell leading-6">{{ row.question || '—' }}</td><td class="table-cell"><BaseBadge :variant="row.status === 'valid' ? 'success' : row.status === 'error' ? 'destructive' : 'secondary'">{{ row.status === 'valid' ? '可导入' : row.status === 'duplicate' ? '重复跳过' : '格式错误' }}</BaseBadge></td><td class="table-cell text-muted-foreground">{{ row.message || '—' }}</td></tr></tbody>
              </table>
            </div>
            <div class="flex justify-end gap-2">
              <BaseButton variant="ghost" @click="resetImport">取消</BaseButton>
              <BaseButton :disabled="!importPreview.can_import || confirmingImport" @click="confirmImport"><LoaderCircle v-if="confirmingImport" class="animate-spin" /><Upload v-else />确认导入{{ importPreview.valid_count }}条</BaseButton>
            </div>
          </section>
          <div class="space-y-4">
            <article v-for="(testCase, index) in draftSuite.cases" :key="testCase.id" class="border-l-2 border-border pl-4">
              <div class="flex gap-3">
                <span class="pt-2 text-xs text-muted-foreground">#{{ testCase.id }}</span>
                <div class="grid min-w-0 flex-1 gap-3 lg:grid-cols-6">
                  <label class="form-field lg:col-span-5">问题<input v-model="testCase.question" class="form-control"></label>
                  <label class="form-field">分类<input v-model="testCase.category" class="form-control"></label>
                  <label class="form-field">状态<input v-model="testCase.expected_status" class="form-control" placeholder="succeeded"></label>
                  <label class="form-field">查询类型<input v-model="testCase.expected_shape" class="form-control" placeholder="metric_trend"></label>
                  <label class="form-field lg:col-span-2">指标名称<input :value="testCase.expected_metric_names.join(', ')" class="form-control" placeholder="逗号分隔" @input="testCase.expected_metric_names = parseList(($event.target as HTMLInputElement).value)"></label>
                  <label class="form-field lg:col-span-2">机构名称<input :value="testCase.expected_org_names.join(', ')" class="form-control" placeholder="逗号分隔" @input="testCase.expected_org_names = parseList(($event.target as HTMLInputElement).value)"></label>
                  <label class="form-field lg:col-span-2">待澄清字段<input :value="testCase.expected_missing.join(', ')" class="form-control" placeholder="metrics, time, orgs" @input="testCase.expected_missing = parseList(($event.target as HTMLInputElement).value)"></label>
                  <label class="form-field">结果行数<input v-model.number="testCase.expected_row_count" type="number" min="0" class="form-control"></label>
                  <label class="form-field lg:col-span-2">预期数值<input v-model.number="testCase.expected_value" type="number" step="any" class="form-control"></label>
                  <label class="form-field">允许误差<input v-model.number="testCase.value_tolerance" type="number" min="0" step="any" class="form-control"></label>
                  <details class="lg:col-span-2"><summary class="cursor-pointer py-2 text-xs text-muted-foreground">高级：按编码断言</summary><div class="grid gap-3 sm:grid-cols-2"><label class="form-field">指标编码<input :value="testCase.expected_metric_codes.join(', ')" class="form-control" @input="testCase.expected_metric_codes = parseList(($event.target as HTMLInputElement).value)"></label><label class="form-field">机构编码<input :value="testCase.expected_orgs.join(', ')" class="form-control" @input="testCase.expected_orgs = parseList(($event.target as HTMLInputElement).value)"></label></div></details>
                </div>
                <BaseButton size="icon" variant="ghost" title="删除用例" @click="removeCase(index)"><Trash2 /></BaseButton>
              </div>
            </article>
          </div>
          <div class="sticky bottom-0 flex justify-end gap-2 border-t bg-background/95 py-3">
            <BaseButton v-if="draftSuite.id && draftSuite.id !== 'phase-one-baseline'" variant="ghost" @click="removeSuite"><Trash2 />删除测试集</BaseButton>
            <BaseButton :disabled="saving" @click="saveSuite"><LoaderCircle v-if="saving" class="animate-spin" /><Save v-else />保存测试集</BaseButton>
          </div>
        </div>
      </section>

      <section v-else class="space-y-4"><h2 class="font-semibold">运行记录</h2><div class="overflow-x-auto border-y"><table class="w-full text-sm"><thead class="bg-muted/40"><tr><th class="table-head">测试集</th><th class="table-head">状态</th><th class="table-head">进度</th><th class="table-head">通过</th><th class="table-head">未通过</th><th class="table-head">待复核</th><th class="table-head">开始时间</th><th class="table-head">完成时间</th></tr></thead><tbody><tr v-for="run in runs" :key="run.id" class="cursor-pointer border-b hover:bg-muted/30" @click="selectedRunId = run.id; activeTab = 'accuracy'"><td class="table-cell font-medium">{{ run.suite_name }}</td><td class="table-cell"><BaseBadge :variant="run.status === 'completed' ? 'success' : run.status === 'failed' ? 'destructive' : 'warning'">{{ runStatusLabel(run.status) }}</BaseBadge></td><td class="table-cell">{{ run.completed }}/{{ run.total }}</td><td class="table-cell">{{ run.passed }}</td><td class="table-cell">{{ run.failed }}</td><td class="table-cell">{{ run.needs_review }}</td><td class="table-cell text-muted-foreground">{{ formatDate(run.started_at) }}</td><td class="table-cell text-muted-foreground">{{ formatDate(run.finished_at) }}</td></tr></tbody></table></div></section>
    </template>
  </AppShell>
</template>
