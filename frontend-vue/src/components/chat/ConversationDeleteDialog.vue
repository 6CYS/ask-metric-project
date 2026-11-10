<script setup lang="ts">
import { ChevronLeft, ChevronRight, LoaderCircle, MessageSquare, Trash2 } from "@lucide/vue"
import { computed, ref, watch } from "vue"

import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import type {
  ConversationDeleteFailure,
  ManagedConversation,
} from "@/composables/useConversationManagement"

const props = defineProps<{
  open: boolean
  targets: ManagedConversation[]
  busy: boolean
  finished: boolean
  processed: number
  failures: ConversationDeleteFailure[]
}>()
const emit = defineEmits<{ close: []; confirm: []; retry: [] }>()
const expanded = ref(false)
const page = ref(0)
const pageSize = 10
watch(
  () => props.open,
  () => {
    expanded.value = false
    page.value = 0
  },
)
watch(
  () => props.targets,
  () => {
    expanded.value = false
    page.value = 0
  },
)
watch(
  () => props.finished,
  () => {
    page.value = 0
  },
)
const total = computed(() => props.targets.length)
const shown = computed(() =>
  expanded.value
    ? props.targets.slice(page.value * pageSize, (page.value + 1) * pageSize)
    : props.targets.slice(0, 3),
)
const percentage = computed(() =>
  total.value ? Math.round((props.processed / total.value) * 100) : 0,
)
const title = computed(() =>
  props.busy
    ? `正在删除 ${total.value} 个会话`
    : props.finished
      ? `已删除 ${total.value - props.failures.length} 个会话`
      : total.value === 1
        ? "删除这个会话？"
        : `确认删除已选的 ${total.value} 个会话？`,
)
const failedPage = computed(() =>
  props.failures.slice(page.value * pageSize, (page.value + 1) * pageSize),
)
const pageCount = computed(() => (props.finished ? props.failures.length : total.value))

function close() {
  if (!props.busy) emit("close")
}
function toggleExpanded() {
  expanded.value = !expanded.value
  page.value = 0
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="title"
    :busy="busy"
    size="md"
    description="仅删除本次选中的会话及聊天内容，无法恢复。"
    @update:open="!$event && close()"
  >
    <div v-if="!busy && !finished" class="min-w-0 space-y-3">
      <div
        class="min-w-0 space-y-3 overflow-y-auto rounded-lg border bg-muted/30 p-3"
        :class="expanded ? 'h-60' : 'max-h-52'"
      >
        <div v-for="item in shown" :key="item.id" class="flex min-w-0 items-start gap-2">
          <MessageSquare class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <BaseTooltip :content="item.title"
              ><p class="truncate text-sm">{{ item.title }}</p></BaseTooltip
            >
            <p class="mt-1 text-xs text-muted-foreground">
              {{ item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "本地草稿" }}
            </p>
          </div>
        </div>
      </div>
      <div v-if="total > 3" class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{{ expanded ? `已选 ${total} 个会话` : `另有 ${total - 3} 个会话` }}</span
        ><BaseButton variant="link" size="sm" :aria-expanded="expanded" @click="toggleExpanded">{{
          expanded ? "收起明细" : `查看全部 ${total} 个`
        }}</BaseButton>
      </div>
    </div>
    <div v-else class="space-y-3">
      <div class="flex justify-between gap-2 text-sm" role="status" aria-live="polite">
        <span>{{
          busy
            ? "删除进度"
            : failures.length
              ? `${failures.length} 个会话未删除，可重试失败项。`
              : "已完成，其他未选中的会话已保留。"
        }}</span
        ><span class="shrink-0 tabular-nums">{{ processed }} / {{ total }}</span>
      </div>
      <div
        class="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="会话删除进度"
        :aria-valuenow="percentage"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="h-full bg-primary" :style="{ width: `${percentage}%` }" />
      </div>
      <div
        v-if="finished && failures.length"
        class="max-h-60 space-y-3 overflow-y-auto rounded-md border p-3"
      >
        <div v-for="item in failedPage" :key="item.id">
          <p class="break-words text-sm">{{ item.title }}</p>
          <p class="mt-1 break-words text-xs text-destructive">{{ item.message }}</p>
        </div>
      </div>
    </div>
    <div
      v-if="(expanded || finished) && pageCount > pageSize && !busy"
      class="mt-3 flex items-center justify-between gap-2"
    >
      <span class="text-xs text-muted-foreground"
        >{{ page * pageSize + 1 }}–{{ Math.min((page + 1) * pageSize, pageCount) }} /
        {{ pageCount }} 个</span
      >
      <div class="flex gap-1">
        <BaseButton
          variant="ghost"
          size="icon"
          :disabled="page === 0"
          aria-label="上一页会话"
          @click="page--"
          ><ChevronLeft /></BaseButton
        ><BaseButton
          variant="ghost"
          size="icon"
          :disabled="(page + 1) * pageSize >= pageCount"
          aria-label="下一页会话"
          @click="page++"
          ><ChevronRight
        /></BaseButton>
      </div>
    </div>
    <template #footer>
      <template v-if="!finished">
        <BaseButton variant="outline" :disabled="busy" @click="close">取消</BaseButton>
        <BaseButton variant="destructive" :disabled="busy" @click="emit('confirm')"
          ><LoaderCircle v-if="busy" class="animate-spin" /><Trash2 v-else />{{
            busy ? "正在删除…" : total === 1 ? "删除这个会话" : `删除这 ${total} 个会话`
          }}</BaseButton
        >
      </template>
      <template v-else
        ><BaseButton v-if="failures.length" variant="outline" @click="emit('retry')"
          >重试失败项（{{ failures.length }}）</BaseButton
        ><BaseButton @click="close">完成</BaseButton></template
      >
    </template>
  </BaseModal>
</template>
