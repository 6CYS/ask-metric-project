<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, RotateCcw, Save } from "@lucide/vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import { listBusinessSkills, restoreBusinessSkill, updateBusinessSkill } from "@/lib/api"
import type { BusinessSkillItem } from "@/types/api"

const props = defineProps<{ canWrite: boolean; adminToken: string; refreshKey?: number }>()
const items = ref<BusinessSkillItem[]>([])
const selectedName = ref("")
const contentDraft = ref("")
const loading = ref(true)
const busy = ref(false)
const error = ref("")
const message = ref("")
const pendingAction = ref<
  { kind: "select"; name: string } | { kind: "refresh" | "restore" } | null
>(null)
let controller: AbortController | undefined
const selected = computed(() => items.value.find((item) => item.name === selectedName.value))
const dirty = computed(() =>
  Boolean(selected.value && contentDraft.value !== selected.value.content),
)
const writable = computed(() => props.canWrite && selected.value?.editable && !busy.value)
const connectedCount = computed(() => items.value.filter((item) => item.editable).length)

function clearStatus() {
  error.value = ""
  message.value = ""
}

function applySelection(name: string) {
  selectedName.value = name
  contentDraft.value = selected.value?.content ?? ""
  clearStatus()
}

function select(name: string) {
  if (busy.value || name === selectedName.value) return
  if (dirty.value) pendingAction.value = { kind: "select", name }
  else applySelection(name)
}

async function load() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  clearStatus()
  try {
    const response = await listBusinessSkills(request.signal)
    if (request.signal.aborted) return
    items.value = response.items
    applySelection(
      response.items.some((item) => item.name === selectedName.value)
        ? selectedName.value
        : (response.items[0]?.name ?? ""),
    )
  } catch (reason) {
    if (!request.signal.aborted)
      error.value = reason instanceof Error ? reason.message : "Skill 加载失败，请重试。"
  } finally {
    if (controller === request) loading.value = false
  }
}

async function requestRefresh() {
  if (busy.value) return
  if (dirty.value) pendingAction.value = { kind: "refresh" }
  else await load()
}

function acceptSaved(saved: BusinessSkillItem) {
  items.value = items.value.map((item) => (item.name === saved.name ? saved : item))
  contentDraft.value = saved.content
}

async function save() {
  const item = selected.value
  if (!item || !writable.value || !dirty.value) return
  if (!contentDraft.value.trim()) {
    error.value = "请填写方法正文。"
    return
  }
  busy.value = true
  clearStatus()
  try {
    acceptSaved(await updateBusinessSkill(item, contentDraft.value, props.adminToken))
    message.value = "已保存，将在下一轮问数中生效。"
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Skill 保存失败，请重试。"
  } finally {
    busy.value = false
  }
}

async function confirmAction() {
  const action = pendingAction.value
  if (!action || busy.value) return
  if (action.kind === "select") {
    pendingAction.value = null
    applySelection(action.name)
  } else if (action.kind === "refresh") {
    pendingAction.value = null
    await load()
  } else {
    const item = selected.value
    if (!item || !writable.value) return
    busy.value = true
    clearStatus()
    try {
      acceptSaved(await restoreBusinessSkill(item, props.adminToken))
      pendingAction.value = null
      message.value = "已恢复默认方法，将在下一轮问数中生效。"
    } catch (reason) {
      pendingAction.value = null
      error.value = reason instanceof Error ? reason.message : "恢复默认失败，请重试。"
    } finally {
      busy.value = false
    }
  }
}

watch(() => props.refreshKey, requestRefresh)
onMounted(load)
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <section aria-label="skill管理" class="min-w-0 space-y-5">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h2 class="font-semibold">分析方法与使用说明</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          维护模型开展查询与分析时参考的方法。共 {{ items.length }} 项，当前问数已接入
          {{ connectedCount }} 项。
        </p>
      </div>
      <BaseButton variant="outline" :disabled="loading || busy" @click="requestRefresh"
        ><RefreshCw :class="loading && 'animate-spin'" />刷新列表</BaseButton
      >
    </div>
    <BaseAlert v-if="error" title="操作失败" variant="destructive"
      ><template #icon><AlertTriangle /></template>{{ error }}</BaseAlert
    >
    <BaseAlert v-if="message" title="操作成功"
      ><template #icon><CheckCircle2 /></template>{{ message }}</BaseAlert
    >
    <LoadingSkeleton v-if="loading && !items.length" :rows="5" row-class="h-14" />
    <div
      v-else-if="!items.length"
      class="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
    >
      暂无可查看的 Skill。
    </div>
    <div v-else class="grid min-w-0 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <nav
        aria-label="Skill 列表"
        class="space-y-1 lg:max-h-[720px] lg:overflow-y-auto lg:border-r lg:pr-4"
      >
        <button
          v-for="item in items"
          :key="item.name"
          type="button"
          :disabled="busy || loading"
          :aria-pressed="selectedName === item.name"
          class="w-full rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          :class="
            selectedName === item.name
              ? 'border-primary/25 bg-muted'
              : 'border-transparent hover:bg-muted/60'
          "
          @click="select(item.name)"
        >
          <span class="flex items-start justify-between gap-2"
            ><span class="text-sm font-medium">{{ item.display_name }}</span
            ><BaseBadge :variant="item.editable ? 'success' : 'outline'" class="shrink-0">{{
              item.editable ? "已接入" : "未接入"
            }}</BaseBadge></span
          >
          <span class="mt-1 block break-all text-xs text-muted-foreground">{{ item.name }}</span>
        </button>
      </nav>
      <div v-if="selected" class="min-w-0 space-y-4" :aria-busy="busy || loading">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-semibold">{{ selected.display_name }}</h3>
            <BaseBadge variant="outline">{{
              selected.modified ? "人工维护" : "部署默认"
            }}</BaseBadge
            ><span v-if="dirty" class="text-xs text-muted-foreground">有未保存的修改</span>
          </div>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">{{ selected.description }}</p>
          <p v-if="!selected.editable" class="mt-2 text-sm text-muted-foreground">
            此 Skill 尚未接入当前问数，仅供查看。
          </p>
        </div>
        <label for="skill-content" class="block space-y-2 text-sm font-medium">
          <span class="flex items-center justify-between"
            ><span>方法正文</span
            ><span class="text-xs font-normal text-muted-foreground">Markdown</span></span
          >
          <textarea
            id="skill-content"
            v-model="contentDraft"
            :readonly="!writable || loading"
            :maxlength="100000"
            spellcheck="false"
            class="form-control h-[min(60vh,640px)] min-h-96 resize-y py-3 font-mono text-sm leading-6 font-normal"
          />
        </label>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div class="min-w-0 text-xs leading-5 text-muted-foreground">
            <p v-if="selected.updated_at">
              最近修改：{{ selected.updated_by }} ·
              {{ new Date(selected.updated_at).toLocaleString("zh-CN", { hour12: false }) }}
            </p>
            <p v-if="selected.editable">保存后下一轮问数生效，执行中的问数沿用本轮方法。</p>
          </div>
          <div v-if="selected.editable" class="flex flex-wrap gap-2">
            <BaseButton
              v-if="dirty"
              variant="ghost"
              :disabled="busy || loading"
              @click="contentDraft = selected.content"
              >取消修改</BaseButton
            >
            <BaseButton
              variant="outline"
              :disabled="!writable || loading || !selected.modified"
              @click="pendingAction = { kind: 'restore' }"
              ><RotateCcw />恢复默认</BaseButton
            >
            <BaseButton
              :disabled="!writable || loading || !dirty || !contentDraft.trim()"
              @click="save"
              ><LoaderCircle v-if="busy" class="animate-spin" /><Save
                v-else
              />保存并生效</BaseButton
            >
          </div>
        </div>
      </div>
    </div>
    <ConfirmDialog
      :open="pendingAction !== null"
      :title="pendingAction?.kind === 'restore' ? '恢复默认方法' : '放弃未保存的修改？'"
      :confirm-label="pendingAction?.kind === 'restore' ? '恢复默认' : '放弃修改并继续'"
      busy-label="正在恢复..."
      variant="default"
      :busy="busy"
      @update:open="
        (open) => {
          if (!open) pendingAction = null
        }
      "
      @confirm="confirmAction"
    >
      {{
        pendingAction?.kind === "restore"
          ? "将使用随当前版本部署的默认正文，下一轮问数起生效。"
          : "当前正文尚未保存，继续后将放弃这些修改。"
      }}
    </ConfirmDialog>
  </section>
</template>
