<script setup lang="ts">
import { X } from "@lucide/vue"
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "reka-ui"

import BaseButton from "@/components/ui/BaseButton.vue"

defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <DialogRoot>
    <DialogTrigger as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/15 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_120ms_ease-out]" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl outline-none data-[state=open]:animate-[dialog-in_140ms_ease-out]"
      >
        <div class="space-y-1.5 pr-8">
          <DialogTitle class="text-base font-semibold">{{ title }}</DialogTitle>
          <DialogDescription v-if="description" class="text-sm leading-5 text-muted-foreground">
            {{ description }}
          </DialogDescription>
        </div>

        <slot />

        <div v-if="$slots.confirm" class="-mx-5 -mb-5 flex justify-end gap-2 rounded-b-lg border-t bg-muted/40 p-4">
          <DialogClose as-child>
            <BaseButton variant="outline">取消</BaseButton>
          </DialogClose>
          <DialogClose as-child>
            <slot name="confirm" />
          </DialogClose>
        </div>

        <DialogClose as-child>
          <BaseButton
            variant="ghost"
            size="icon"
            class="absolute top-3 right-3 text-muted-foreground"
            aria-label="关闭弹窗"
          >
            <X />
          </BaseButton>
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
