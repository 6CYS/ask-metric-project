<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue"
import { Check, ChevronRight, Copy, X } from "@lucide/vue"
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"

import BaseButton from "@/components/ui/BaseButton.vue"
import { copyText } from "@/lib/clipboard"

const props = withDefaults(
  defineProps<{
    label: string
    text: string
    loadText?: () => Promise<string>
    actionLabel?: string
    actionPlacement?: "inline" | "footer"
  }>(),
  { actionLabel: "全文", actionPlacement: "inline" },
)
defineOptions({ inheritAttrs: false })

const container = ref<HTMLElement | null>(null)
const measure = ref<HTMLElement | null>(null)
const measureText = ref<HTMLElement | null>(null)
const measureAction = ref<HTMLElement | null>(null)
const previewText = ref(props.text)
const measured = ref(false)
const truncated = ref(false)
const open = ref(false)
const fullText = ref("")
const loading = ref(false)
const loadError = ref("")
const copyStatus = ref("")
const hasAction = computed(() => truncated.value || Boolean(props.loadText))
const detailText = computed(() => fullText.value || props.text)
let observer: ResizeObserver | undefined
let frame = 0
let requestVersion = 0

function measurePreview() {
  const box = measure.value
  const text = measureText.value
  const action = measureAction.value
  if (!box || !text || !action || !container.value?.getBoundingClientRect().width) return

  const maxHeight = Number.parseFloat(getComputedStyle(box).lineHeight) * 2 + 1
  text.textContent = props.text
  action.hidden = true
  const overflows = box.getBoundingClientRect().height > maxHeight
  if (!overflows && !props.loadText) {
    previewText.value = props.text
    truncated.value = false
    measured.value = true
    return
  }

  // 在相同字体和宽度下测量“正文 + 文尾入口”，只占最后一行的文字空间。
  action.hidden = props.actionPlacement !== "inline"
  if (box.getBoundingClientRect().height <= maxHeight) {
    previewText.value = props.text
    truncated.value = overflows
  } else {
    const characters = Array.from(props.text)
    let low = 0
    let high = characters.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      text.textContent = `${characters.slice(0, middle).join("")}…`
      if (box.getBoundingClientRect().height <= maxHeight) low = middle
      else high = middle - 1
    }
    previewText.value = `${characters.slice(0, low).join("")}…`
    truncated.value = true
  }
  measured.value = true
}

function scheduleMeasure() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measurePreview)
}

async function loadFullText() {
  if (!props.loadText) return
  const version = ++requestVersion
  loading.value = true
  loadError.value = ""
  try {
    const text = await props.loadText()
    // 关闭、切换数据或重新加载后，旧响应不能覆盖当前详情。
    if (version === requestVersion) fullText.value = text
  } catch {
    if (version === requestVersion) loadError.value = "完整信息加载失败，请重试。"
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function copyContent() {
  try {
    await copyText(detailText.value)
    copyStatus.value = "已复制"
  } catch {
    copyStatus.value = "复制失败，请选择文字复制。"
  }
}

watch(open, async (value) => {
  requestVersion += 1
  fullText.value = ""
  loading.value = false
  loadError.value = ""
  copyStatus.value = ""
  if (value) await loadFullText()
})
watch(
  () => [props.text, props.actionLabel, props.actionPlacement],
  async () => {
    scheduleMeasure()
    requestVersion += 1
    fullText.value = ""
    loading.value = false
    copyStatus.value = ""
    if (open.value) await loadFullText()
  },
  { flush: "post" },
)

onMounted(() => {
  measurePreview()
  let lastWidth = 0
  observer = new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width !== lastWidth) {
      lastWidth = entry.contentRect.width
      scheduleMeasure()
    }
  })
  if (container.value) observer.observe(container.value)
  document.fonts?.addEventListener("loadingdone", scheduleMeasure)
})
onDeactivated(() => {
  open.value = false
})
onBeforeUnmount(() => {
  requestVersion += 1
  observer?.disconnect()
  cancelAnimationFrame(frame)
  document.fonts?.removeEventListener("loadingdone", scheduleMeasure)
})
</script>

<template>
  <PopoverRoot v-model:open="open">
    <div ref="container" v-bind="$attrs" class="text-preview relative min-w-0">
      <div class="text-preview-body" :class="!measured && 'line-clamp-2'">
        <span class="whitespace-pre-wrap">{{ previewText }}</span
        ><PopoverTrigger v-if="hasAction && actionPlacement === 'inline'" as-child
          ><button
            type="button"
            class="text-preview-action rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            :aria-label="`查看完整${label}`"
          >
            {{ actionLabel }}
          </button></PopoverTrigger
        >
      </div>
      <div
        v-if="$slots.footer || (hasAction && actionPlacement === 'footer')"
        class="mt-1.5 flex flex-wrap items-center gap-2"
      >
        <slot name="footer" />
        <PopoverTrigger v-if="hasAction && actionPlacement === 'footer'" as-child
          ><button
            type="button"
            class="inline-flex items-center gap-0.5 rounded-sm text-xs font-normal text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            :aria-label="`查看完整${label}`"
          >
            {{ actionLabel }}<ChevronRight class="size-3" aria-hidden="true" /></button
        ></PopoverTrigger>
      </div>
      <div
        aria-hidden="true"
        class="pointer-events-none invisible absolute top-0 left-0 h-0 w-full overflow-hidden select-none"
      >
        <div ref="measure" class="text-preview-body">
          <span ref="measureText" class="whitespace-pre-wrap" /><span
            ref="measureAction"
            class="text-preview-action"
            hidden
            >{{ actionLabel }}</span
          >
        </div>
      </div>
    </div>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="start"
        :side-offset="8"
        :collision-padding="12"
        class="z-50 flex max-h-[min(32rem,var(--reka-popover-content-available-height))] w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-hidden rounded-lg border bg-popover p-4 text-sm font-normal text-popover-foreground shadow-lg"
      >
        <header class="flex shrink-0 items-center justify-between gap-3 border-b pb-3">
          <h3 class="font-semibold">{{ label }}</h3>
          <PopoverClose as-child
            ><BaseButton variant="ghost" size="icon" class="size-6" aria-label="关闭详情"
              ><X class="size-3.5" /></BaseButton
          ></PopoverClose>
        </header>
        <div class="min-h-0 overflow-y-auto overscroll-contain">
          <p v-if="loading" role="status" class="text-muted-foreground">正在加载完整信息…</p>
          <div v-else-if="loadError" role="alert" class="space-y-2">
            <p class="text-destructive">{{ loadError }}</p>
            <BaseButton variant="outline" size="sm" @click="loadFullText">重试</BaseButton>
          </div>
          <p v-else class="select-text whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">
            {{ detailText }}
          </p>
        </div>
        <footer class="flex shrink-0 items-center justify-between gap-3 border-t pt-2">
          <span class="text-xs text-muted-foreground">Esc 关闭</span>
          <BaseButton
            variant="ghost"
            size="sm"
            :disabled="loading || Boolean(loadError)"
            @click="copyContent"
            ><Check v-if="copyStatus === '已复制'" /><Copy v-else />复制内容</BaseButton
          >
        </footer>
        <p v-if="copyStatus" role="status" class="text-xs text-muted-foreground">
          {{ copyStatus }}
        </p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
.text-preview-body {
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: normal;
}

.text-preview-action {
  display: inline;
  margin-inline-start: 0.375rem;
  font-size: 0.75rem;
  font-weight: 400;
  line-height: inherit;
  vertical-align: baseline;
  white-space: nowrap;
}
</style>
