<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue"
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router"
import { ClipboardCheck, Plus, RefreshCw } from "@lucide/vue"
import AppShell from "@/components/AppShell.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import EvaluationDatasetPanel from "@/components/evaluation/EvaluationDatasetPanel.vue"
import EvaluationRunDialog from "@/components/evaluation/EvaluationRunDialog.vue"
import EvaluationRunList from "@/components/evaluation/EvaluationRunList.vue"
import EvaluationRunPanel from "@/components/evaluation/EvaluationRunPanel.vue"
import EvaluationTurnDetail from "@/components/evaluation/EvaluationTurnDetail.vue"
import EvaluationComparison from "@/components/evaluation/EvaluationComparison.vue"
import { useEvaluation } from "@/composables/useEvaluation"
import type {
  DatasetInput,
  EvaluationDataset,
  EvaluationReview,
  EvaluationRun,
  RunInput,
} from "@/types/evaluation"
import "@/components/evaluation/evaluation.css"

const route = useRoute()
const router = useRouter()
const state = useEvaluation()
const {
  datasets,
  runs,
  selectedRun,
  detail,
  selectedRunId,
  selectedTurnId,
  loading,
  runLoading,
  detailLoading,
  busy,
  hasLoaded,
  loadError,
  runError,
  detailError,
  actionError,
  activeRun,
} = state
const tabs = [
  { id: "datasets", label: "问题集" },
  { id: "runs", label: "测评批次" },
  { id: "compare", label: "版本对比" },
]
const currentTab = computed(() =>
  tabs.some((tab) => tab.id === route.query.tab) ? String(route.query.tab) : "runs",
)
const runDialogOpen = ref(false)
type PendingLeave =
  { kind: "tab"; tab: string } | { kind: "route"; resolve: (allow: boolean) => void }
const pendingLeave = ref<PendingLeave | null>(null)
const leaving = ref(false)
const pendingCancelRun = ref<EvaluationRun | null>(null)
const stoppingRun = ref(false)
const activationKey = ref(0)
const initialDatasetId = ref("")
const datasetEditor = ref<{ saved(dataset: EvaluationDataset): void; isDirty(): boolean } | null>(
  null,
)
let active = false
let locationSequence = 0
let locationRequest: { key: string; promise: Promise<void> } | null = null

function reportError(reason: unknown) {
  actionError.value = reason instanceof Error ? reason.message : "操作未完成，请重试。"
}
async function navigate(query: Record<string, string | undefined>) {
  try {
    await router.replace({ name: "evaluations", query: { ...route.query, ...query } })
  } catch (reason) {
    reportError(reason)
  }
}
function changeTab(tab: string) {
  if (tab === currentTab.value || pendingLeave.value || leaving.value) return
  if (currentTab.value === "datasets" && datasetEditor.value?.isDirty()) {
    pendingLeave.value = { kind: "tab", tab }
    return
  }
  navigate({ tab }).catch(reportError)
}
function closeLeaveConfirmation() {
  if (leaving.value) return
  const pending = pendingLeave.value
  pendingLeave.value = null
  if (pending?.kind === "route") pending.resolve(false)
}
async function confirmLeave() {
  const pending = pendingLeave.value
  if (!pending || leaving.value) return
  if (pending.kind === "route") {
    pendingLeave.value = null
    pending.resolve(true)
    return
  }
  leaving.value = true
  try {
    await navigate({ tab: pending.tab })
    pendingLeave.value = null
  } finally {
    leaving.value = false
  }
}
async function applyLocation() {
  if (!active || route.name !== "evaluations") return
  const requested = typeof route.query.run === "string" ? route.query.run : selectedRunId.value
  const turn = typeof route.query.turn === "string" ? route.query.turn : ""
  const key = JSON.stringify([requested, turn])
  if (locationRequest?.key === key) return locationRequest.promise
  const sequence = ++locationSequence
  const promise = (async () => {
    if (requested && (selectedRunId.value !== requested || !selectedRun.value))
      await state.selectRun(requested)
    if (sequence !== locationSequence) return
    if (turn && selectedRun.value?.id === requested && selectedTurnId.value !== turn)
      await state.selectTurn(requested, turn)
    else if (!turn && selectedTurnId.value) state.clearDetail()
  })()
  locationRequest = { key, promise }
  try {
    await promise
  } finally {
    if (locationRequest?.promise === promise) locationRequest = null
  }
}
watch(
  () => [route.name, route.query.run, route.query.turn],
  () => {
    applyLocation().catch(reportError)
  },
)
onActivated(() => {
  active = true
  ++activationKey.value
  state.activate().then(applyLocation).catch(reportError)
})
onDeactivated(() => {
  active = false
  runDialogOpen.value = false
  closeLeaveConfirmation()
  pendingCancelRun.value = null
  ++locationSequence
  state.deactivate()
})
onBeforeUnmount(closeLeaveConfirmation)
onBeforeRouteLeave(() => {
  if (!datasetEditor.value?.isDirty()) return true
  closeLeaveConfirmation()
  // 路由守卫等待本次明确选择，取消时保留当前地址及草稿。
  return new Promise<boolean>((resolve) => {
    pendingLeave.value = { kind: "route", resolve }
  })
})

function openRun(dataset?: EvaluationDataset) {
  initialDatasetId.value = dataset?.id ?? selectedRun.value?.dataset.id ?? ""
  actionError.value = ""
  runDialogOpen.value = true
}
async function saveDataset(input: DatasetInput, existing?: EvaluationDataset) {
  const saved = await state.saveDataset(input, existing)
  if (saved) datasetEditor.value?.saved(saved)
}
async function startRun(input: RunInput) {
  const created = await state.createRun(input)
  if (!created) return
  runDialogOpen.value = false
  await navigate({ tab: "runs", run: created.id, turn: undefined })
}
async function selectRun(id: string) {
  await navigate({ tab: "runs", run: id, turn: undefined })
  await applyLocation()
}
async function selectTurn(id: string) {
  if (!selectedRun.value) return
  await navigate({ run: selectedRun.value.id, turn: id })
  await applyLocation()
  await nextTick()
  document.querySelector<HTMLElement>('[aria-label="轮次详情"]')?.focus({ preventScroll: true })
  document
    .querySelector('[aria-label="轮次详情"]')
    ?.scrollIntoView({ block: "start", behavior: "smooth" })
}
async function comparisonDetail(runId: string, turnId: string) {
  await navigate({ tab: "runs", run: runId, turn: turnId })
  await applyLocation()
}
function cancelRun(run: EvaluationRun) {
  if (busy.value || stoppingRun.value || pendingCancelRun.value) return
  actionError.value = ""
  pendingCancelRun.value = run
}
function closeCancelRun() {
  if (!busy.value && !stoppingRun.value) pendingCancelRun.value = null
}
async function confirmCancelRun() {
  const run = pendingCancelRun.value
  if (!run || busy.value || stoppingRun.value) return
  stoppingRun.value = true
  try {
    const stopped = await state.cancelRun(run)
    if (stopped) pendingCancelRun.value = null
  } catch (reason) {
    reportError(reason)
  } finally {
    stoppingRun.value = false
  }
}
async function review(input: Pick<EvaluationReview, "verdict" | "note">) {
  if (selectedRun.value && detail.value)
    await state.saveReview(selectedRun.value.id, detail.value.turn.id, input)
}
function closeDetail() {
  state.clearDetail()
  navigate({ turn: undefined }).catch(reportError)
}
function retryDetail() {
  if (selectedRun.value && selectedTurnId.value)
    state.selectTurn(selectedRun.value.id, selectedTurnId.value).catch(reportError)
}
</script>

<template>
  <AppShell>
    <div class="evaluation-center space-y-5">
      <PageHeader
        title="测评中心"
        description="用真实问数链路验证问题集，保留执行结果、人工复核和版本差异。"
      >
        <template #actions
          ><BaseButton variant="outline" :disabled="loading || busy" @click="state.refresh()"
            ><RefreshCw :class="{ 'animate-spin': loading }" />刷新</BaseButton
          ><BaseButton
            :disabled="!hasLoaded || !datasets.length || busy || Boolean(activeRun)"
            @click="openRun()"
            ><Plus />发起测评</BaseButton
          ></template
        >
      </PageHeader>
      <BaseAlert
        v-if="loadError"
        :title="hasLoaded ? '刷新未完成，保留上次读取结果' : '测评中心加载失败'"
        variant="destructive"
        >{{ loadError
        }}<BaseButton variant="outline" size="sm" class="ml-3" @click="state.refresh()"
          >重试</BaseButton
        ></BaseAlert
      >
      <BaseAlert
        v-if="actionError && !runDialogOpen && !pendingCancelRun"
        title="操作未完成"
        variant="destructive"
        >{{ actionError }}</BaseAlert
      >
      <div v-if="activeRun" class="evaluation-active-notice" role="status">
        <ClipboardCheck class="size-4 shrink-0" /><span
          >“{{ activeRun.name }}”{{
            activeRun.status === "cancelling" ? "正在停止" : "正在执行"
          }}，当前页面自动刷新进度。</span
        ><BaseButton variant="link" size="sm" @click="selectRun(activeRun.id)">查看批次</BaseButton>
      </div>
      <nav class="evaluation-tabs" aria-label="测评中心分区">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          :aria-current="currentTab === tab.id ? 'page' : undefined"
          :class="{ active: currentTab === tab.id }"
          @click="changeTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div v-if="loading && !hasLoaded" class="evaluation-panel evaluation-empty" role="status">
        <h2>正在加载测评中心…</h2>
      </div>
      <EvaluationDatasetPanel
        v-else-if="currentTab === 'datasets'"
        ref="datasetEditor"
        :key="activationKey"
        :datasets="datasets"
        :busy="busy"
        @save="saveDataset"
        @run="openRun"
      />
      <template v-else-if="currentTab === 'runs'">
        <EvaluationRunList
          :runs="runs"
          :selected-id="selectedRunId"
          :busy="busy"
          @select="selectRun"
          @cancel="cancelRun"
        />
        <p v-if="runLoading" role="status" class="evaluation-note p-4">正在加载批次…</p>
        <BaseAlert v-else-if="runError" title="批次读取失败" variant="destructive"
          >{{ runError
          }}<BaseButton
            variant="outline"
            size="sm"
            class="ml-3"
            @click="state.selectRun(selectedRunId)"
            >重新读取</BaseButton
          ></BaseAlert
        >
        <EvaluationRunPanel
          v-else-if="selectedRun"
          :run="selectedRun"
          :selected-turn-id="selectedTurnId"
          :busy="busy"
          @select="selectTurn"
          @cancel="cancelRun(selectedRun)"
          @rerun="openRun()"
        />
        <EvaluationTurnDetail
          v-if="selectedTurnId"
          :detail="detail"
          :loading="detailLoading"
          :error="detailError"
          :busy="busy"
          @close="closeDetail"
          @retry="retryDetail"
          @review="review"
        />
      </template>
      <EvaluationComparison
        v-else-if="currentTab === 'compare'"
        :runs="runs"
        @detail="comparisonDetail"
      />
      <ConfirmDialog
        :open="Boolean(pendingLeave)"
        title="放弃未保存修改"
        confirm-label="放弃修改并离开"
        busy-label="正在离开…"
        variant="default"
        :busy="leaving"
        @update:open="closeLeaveConfirmation"
        @confirm="confirmLeave"
      >
        {{
          pendingLeave?.kind === "route"
            ? "问题集尚未保存，确认离开测评中心？"
            : "问题集尚未保存，确认离开编辑区？"
        }}
      </ConfirmDialog>
      <ConfirmDialog
        :open="Boolean(pendingCancelRun)"
        title="停止测评批次"
        confirm-label="确认停止"
        busy-label="正在停止…"
        :busy="busy || stoppingRun"
        @update:open="closeCancelRun"
        @confirm="confirmCancelRun"
      >
        <p>停止“{{ pendingCancelRun?.name }}”？已保存结果会保留；停止后不会自动重跑剩余问题。</p>
        <BaseAlert v-if="actionError" title="停止未完成" variant="destructive" class="mt-3">{{
          actionError
        }}</BaseAlert>
      </ConfirmDialog>
      <EvaluationRunDialog
        v-model:open="runDialogOpen"
        :datasets="datasets"
        :initial-dataset-id="initialDatasetId"
        :busy="busy"
        :error="actionError"
        :blocked="Boolean(activeRun)"
        @start="startRun"
      />
    </div>
  </AppShell>
</template>
