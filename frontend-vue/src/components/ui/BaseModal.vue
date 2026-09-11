<script setup lang="ts">
import { X } from "@lucide/vue"
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui"

import BaseButton from "@/components/ui/BaseButton.vue"

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  busy?: boolean
  size?: "sm" | "md" | "lg"
}>(), { description: "", busy: false, size: "md" })

const emit = defineEmits<{ "update:open": [value: boolean] }>()
const widthClasses = { sm: "max-w-xs", md: "max-w-xl", lg: "max-w-2xl" }

/** 保存进行中禁止遮罩、Esc 和关闭按钮关窗，避免用户误以为请求已取消。 */
function updateOpen(nextOpen: boolean) {
  if (!nextOpen && props.busy) return
  emit("update:open", nextOpen)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="updateOpen">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/15 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_120ms_ease-out]" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-hidden rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl outline-none data-[state=open]:animate-[dialog-in_140ms_ease-out]"
        :class="widthClasses[size]"
      >
        <div class="space-y-1.5 pr-8">
          <DialogTitle class="text-base font-semibold">{{ title }}</DialogTitle>
          <DialogDescription v-if="description" class="text-sm leading-5 text-muted-foreground">{{ description }}</DialogDescription>
          <DialogDescription v-else class="sr-only">请查看并确认当前对话框中的内容。</DialogDescription>
        </div>
        <div class="min-h-0 overflow-y-auto pr-1"><slot /></div>
        <div v-if="$slots.footer" class="-mx-5 -mb-5 flex flex-col-reverse gap-2 border-t bg-muted/40 p-4 sm:flex-row sm:justify-end"><slot name="footer" /></div>
        <BaseButton variant="ghost" size="icon" class="absolute top-3 right-3 text-muted-foreground" :disabled="busy" aria-label="关闭弹窗" @click="updateOpen(false)"><X /></BaseButton>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
