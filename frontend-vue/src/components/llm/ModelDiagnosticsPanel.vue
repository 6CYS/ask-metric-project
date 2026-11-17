<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from "vue"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  RefreshCw,
} from "@lucide/vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import ModelDiagnosticResponse from "@/components/llm/ModelDiagnosticResponse.vue"
import {
  getDiagnosticTarget,
  ModelDiagnosticError,
  runModelDiagnostic,
} from "@/lib/modelDiagnosticsApi"
import type {
  DiagnosticResult,
  DiagnosticStarted,
  DiagnosticTarget,
} from "@/types/modelDiagnostics"

const target = ref<DiagnosticTarget | null>(null)
const loading = ref(false)
const loadError = ref("")
const running = ref(false)
const started = ref<DiagnosticStarted | null>(null)
const result = ref<DiagnosticResult | null>(null)
const localOutcome = ref<{
  status: "failed" | "cancelled"
  message: string
  duration_ms: number
  finished_at: string
} | null>(null)
const firstOutput = ref<number | null>(null)
const beganAt = ref(0)
const now = ref(Date.now())
const cooldownUntil = ref(0)
let active = true
let metadataController: AbortController | null = null
let controller: AbortController | null = null
let clock: ReturnType<typeof setInterval> | undefined

const outcome = computed(() => result.value ?? localOutcome.value)
const displayedTarget = computed(() => started.value?.target ?? target.value)
const cooldownSeconds = computed(() =>
  Math.max(0, Math.ceil((cooldownUntil.value - now.value) / 1000)),
)
const elapsed = computed(() =>
  running.value ? Math.max(0, now.value - beganAt.value) : (outcome.value?.duration_ms ?? null),
)
const phase = computed(() =>
  firstOutput.value !== null
    ? "已收到模型输出，等待完成"
    : started.value
      ? "等待模型首次输出"
      : "正在准备检测",
)
const outcomeLabel = computed(() =>
  outcome.value?.status === "succeeded"
    ? "本次检测成功"
    : outcome.value?.status === "cancelled"
      ? "本次检测已停止"
      : "本次检测未完成",
)

function duration(value: number | null) {
  if (value === null) return "—"
  return value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(1)} 秒`
}
function dateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false })
}
function clearClock() {
  clearInterval(clock)
  clock = undefined
}
function updateClock() {
  now.value = Date.now()
  if (!active || (!running.value && !cooldownSeconds.value)) return clearClock()
  if (!clock) clock = setInterval(updateClock, 250)
}

async function loadTarget() {
  if (loading.value || running.value) return
  const request = new AbortController()
  metadataController = request
  loading.value = true
  loadError.value = ""
  try {
    const value = await getDiagnosticTarget(request.signal)
    if (!request.signal.aborted) target.value = value
  } catch (error) {
    if (!request.signal.aborted)
      loadError.value =
        error instanceof ModelDiagnosticError
          ? error.message
          : "无法读取当前模型信息，请刷新后重试。"
  } finally {
    if (metadataController === request) {
      metadataController = null
      loading.value = false
    }
  }
}

async function start() {
  if (running.value || loading.value || cooldownSeconds.value || !target.value) return
  const request = new AbortController()
  controller = request
  running.value = true
  result.value = null
  localOutcome.value = null
  started.value = null
  firstOutput.value = null
  loadError.value = ""
  beganAt.value = Date.now()
  cooldownUntil.value = beganAt.value + target.value.cooldown_ms
  updateClock()
  try {
    const completed = await runModelDiagnostic(request.signal, (event) => {
      if (controller !== request || request.signal.aborted || !active) return
      if (event.type === "started") {
        started.value = event
        target.value = event.target
        cooldownUntil.value = Date.now() + event.target.cooldown_ms
      } else {
        firstOutput.value = event.first_output_ms
      }
    })
    if (!request.signal.aborted) {
      result.value = completed
      firstOutput.value = completed.first_output_ms
    }
  } catch (error) {
    if (error instanceof ModelDiagnosticError && error.retryAfterMs)
      cooldownUntil.value = Date.now() + error.retryAfterMs
    localOutcome.value = {
      status: request.signal.aborted ? "cancelled" : "failed",
      message: request.signal.aborted
        ? "已停止等待，并向模型服务发送取消信号。"
        : error instanceof ModelDiagnosticError
          ? error.message
          : "检测连接超时或中断，请稍后重新检测。",
      duration_ms: Date.now() - beganAt.value,
      finished_at: new Date().toISOString(),
    }
  } finally {
    if (controller === request) {
      controller = null
      running.value = false
      updateClock()
    }
  }
}

function stop() {
  controller?.abort()
}
function deactivate() {
  active = false
  stop()
  metadataController?.abort()
  clearClock()
}
onMounted(loadTarget)
onActivated(() => {
  active = true
  updateClock()
  return loadTarget()
})
onDeactivated(deactivate)
onUnmounted(deactivate)
</script>

<template>
  <section
    class="max-w-5xl rounded-lg border bg-card p-5"
    aria-labelledby="model-diagnostics-heading"
  >
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="model-diagnostics-heading" class="font-semibold">检测当前问数模型</h2>
        <p class="mt-1 text-sm leading-6 text-muted-foreground">
          发送一次简短请求，检查模型是否能正常开始并完成输出。
        </p>
      </div>
      <BaseButton variant="outline" :disabled="loading || running" @click="loadTarget"
        ><RefreshCw :class="loading && 'animate-spin'" />刷新模型信息</BaseButton
      >
    </div>

    <BaseAlert v-if="loadError" class="mt-4" title="模型信息读取失败" variant="destructive"
      ><template #icon><AlertTriangle /></template>{{ loadError }}</BaseAlert
    >
    <dl class="mt-5 grid gap-4 border-y py-4 text-sm sm:grid-cols-2">
      <div>
        <dt class="text-muted-foreground">{{ started ? "本次检测模型" : "当前生效模型" }}</dt>
        <dd class="mt-1 break-all font-medium">
          {{ displayedTarget?.model ?? (loading ? "正在读取…" : "暂未获取") }}
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground">配置来源</dt>
        <dd class="mt-1 break-all">
          {{
            displayedTarget
              ? displayedTarget.configuration_source === "database"
                ? "配置中心"
                : "当前服务配置"
              : "—"
          }}<span
            v-if="displayedTarget?.configuration_version"
            class="ml-2 text-muted-foreground"
            >{{ displayedTarget.configuration_version }}</span
          >
        </dd>
      </div>
    </dl>

    <div class="mt-5 flex flex-wrap items-center gap-3">
      <BaseButton
        :variant="running ? 'outline' : 'default'"
        :disabled="!running && (loading || !target || cooldownSeconds > 0)"
        @click="running ? stop() : start()"
        ><CircleStop v-if="running" /><Activity v-else />{{
          running
            ? "停止检测"
            : cooldownSeconds > 0
              ? `${cooldownSeconds} 秒后可再次检测`
              : outcome
                ? "再次检测"
                : "开始检测"
        }}</BaseButton
      >
      <span class="text-xs leading-5 text-muted-foreground"
        >{{
          displayedTarget
            ? `最长等待 ${displayedTarget.max_duration_ms / 1000} 秒`
            : "最长等待 60 秒"
        }}，不自动重试。</span
      >
    </div>

    <div v-if="running || outcome" class="mt-5 rounded-md bg-muted/40 p-4">
      <div
        role="status"
        aria-live="polite"
        class="flex flex-wrap items-center gap-2 text-sm font-medium"
      >
        <template v-if="running"
          ><LoaderCircle class="size-4 animate-spin text-primary" />{{ phase }}</template
        >
        <template v-else>
          <CheckCircle2 v-if="outcome?.status === 'succeeded'" class="size-4 text-emerald-600" />
          <CircleStop
            v-else-if="outcome?.status === 'cancelled'"
            class="size-4 text-muted-foreground"
          />
          <AlertTriangle v-else class="size-4 text-amber-600" />
          {{ outcomeLabel }}
          <BaseBadge v-if="result?.error_code === 'MODEL_RATE_LIMITED'" variant="warning"
            >请求限流</BaseBadge
          >
        </template>
      </div>
      <p v-if="outcome" class="mt-2 text-sm leading-6">{{ outcome.message }}</p>
      <dl class="mt-4 flex flex-wrap gap-x-12 gap-y-3 text-sm">
        <div>
          <dt class="text-muted-foreground">首次输出耗时</dt>
          <dd class="mt-1 font-medium tabular-nums">
            {{ firstOutput === null && running ? "等待中" : duration(firstOutput) }}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{{ running ? "已用时" : "总耗时" }}</dt>
          <dd class="mt-1 font-medium tabular-nums">{{ duration(elapsed) }}</dd>
        </div>
        <div v-if="outcome">
          <dt class="text-muted-foreground">检测结束时间</dt>
          <dd class="mt-1 tabular-nums">{{ dateTime(outcome.finished_at) }}</dd>
        </div>
      </dl>
      <details v-if="started" class="mt-4 border-t pt-3 text-xs text-muted-foreground">
        <summary
          class="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring"
        >
          查看检测详情
        </summary>
        <dl class="mt-3 grid gap-2 break-all">
          <div>
            <dt class="inline">检测编号：</dt>
            <dd class="inline font-mono">{{ started.diagnostic_id }}</dd>
          </div>
          <div>
            <dt class="inline">开始时间：</dt>
            <dd class="inline">{{ dateTime(started.started_at) }}</dd>
          </div>
          <div v-if="result?.error_code">
            <dt class="inline">原因代码：</dt>
            <dd class="inline font-mono">{{ result.error_code }}</dd>
          </div>
        </dl>
        <ModelDiagnosticResponse
          v-if="result?.model_response"
          :response="result.model_response"
          :incomplete="result.status !== 'succeeded'"
        />
      </details>
    </div>
    <p class="mt-4 text-xs leading-6 text-muted-foreground">
      检测使用已生效配置，不使用未保存的修改，也不执行指标查询。首次输出包含模型思考或正文；结果仅代表本次检测，不能保证后续问数速度或回答准确性。
    </p>
  </section>
</template>
