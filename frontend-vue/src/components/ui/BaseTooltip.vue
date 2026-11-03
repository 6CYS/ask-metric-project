<script setup lang="ts">
import { ref, watch } from "vue"
import {
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  useForwardExpose,
} from "reka-ui"

const props = withDefaults(
  defineProps<{
    content: string | undefined
    side?: "top" | "right" | "bottom" | "left"
  }>(),
  { side: "top" },
)

defineOptions({ inheritAttrs: false })

const { forwardRef } = useForwardExpose()
const open = ref(false)
watch(
  () => props.content,
  (content) => {
    if (!content) open.value = false
  },
)

// 禁用按钮的提示由外层容器承载；子按钮通过键盘获得焦点时仍能显示说明。
function handleFocusIn(event: FocusEvent) {
  if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) {
    open.value = Boolean(props.content)
  }
}
</script>

<template>
  <TooltipProvider :delay-duration="350" :skip-delay-duration="150">
    <TooltipRoot v-model:open="open" :disabled="!content" ignore-non-keyboard-focus>
      <TooltipTrigger
        :ref="forwardRef"
        as-child
        v-bind="$attrs"
        @focusin="handleFocusIn"
        @focusout="open = false"
        ><slot
      /></TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="side"
          :side-offset="6"
          :collision-padding="8"
          class="z-[100] max-h-[var(--reka-tooltip-content-available-height)] max-w-[min(28rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs leading-5 whitespace-pre-line text-popover-foreground shadow-md [overflow-wrap:anywhere]"
          >{{ content }}</TooltipContent
        >
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
