<script setup lang="ts">
import { X } from "@lucide/vue"
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui"

import BaseButton from "@/components/ui/BaseButton.vue"

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    busy?: boolean
    size?: "sm" | "md" | "lg" | "xl"
  }>(),
  { description: "", busy: false, size: "md" },
)

const emit = defineEmits<{
  "update:open": [value: boolean]
  "close-auto-focus": [event: Event]
}>()
const widthClasses = { sm: "max-w-xs", md: "max-w-xl", lg: "max-w-2xl", xl: "max-w-6xl" }

/** 保存进行中禁止遮罩、Esc 和关闭按钮关窗，避免用户误以为请求已取消。 */
function updateOpen(nextOpen: boolean) {
  if (!nextOpen && props.busy) return
  emit("update:open", nextOpen)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="updateOpen">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/15 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_120ms_ease-out]"
      />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl outline-none data-[state=open]:animate-[dialog-in_140ms_ease-out]"
        :class="widthClasses[size]"
        @close-auto-focus="emit('close-auto-focus', $event)"
      >
        <div class="shrink-0 space-y-1.5 pr-8">
          <DialogTitle class="text-base font-semibold">{{ title }}</DialogTitle>
          <DialogDescription v-if="description" class="text-sm leading-5 text-muted-foreground">{{
            description
          }}</DialogDescription>
          <DialogDescription v-else class="sr-only"
            >请查看并确认当前对话框中的内容。</DialogDescription
          >
        </div>
        <!-- 为焦点外框保留滚动区内边距，同时保持内容与标题对齐。 -->
        <div class="-my-1 -ml-1 min-h-0 flex-1 overflow-y-auto p-1"><slot /></div>
        <div
          v-if="$slots.footer"
          class="-mx-5 -mb-5 flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/40 p-4 sm:flex-row sm:justify-end"
        >
          <slot name="footer" />
        </div>
        <BaseButton
          variant="ghost"
          size="icon"
          class="absolute top-3 right-3 text-muted-foreground"
          :disabled="busy"
          aria-label="关闭弹窗"
          @click="updateOpen(false)"
          ><X
        /></BaseButton>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
