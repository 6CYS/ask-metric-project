<script setup lang="ts">
import { ChevronRight } from "@lucide/vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import type { HTMLAttributes } from "vue"

defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    open?: boolean
    defaultOpen?: boolean
    disabled?: boolean
    triggerClass?: HTMLAttributes["class"]
    contentClass?: HTMLAttributes["class"]
  }>(),
  { open: undefined, defaultOpen: false },
)
const emit = defineEmits<{ "update:open": [value: boolean] }>()
</script>

<template>
  <CollapsibleRoot
    v-slot="{ open: isOpen }"
    v-bind="$attrs"
    :open="open"
    :default-open="defaultOpen"
    :disabled="disabled"
    @update:open="emit('update:open', $event)"
  >
    <CollapsibleTrigger
      class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      :class="triggerClass"
    >
      <ChevronRight
        class="size-3.5 shrink-0 transition-transform"
        :class="{ 'rotate-90': isOpen }"
        aria-hidden="true"
      />
      <span class="min-w-0 [overflow-wrap:anywhere]"><slot name="trigger" /></span>
    </CollapsibleTrigger>
    <CollapsibleContent :class="contentClass"><slot /></CollapsibleContent>
  </CollapsibleRoot>
</template>
