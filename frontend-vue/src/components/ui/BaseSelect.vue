<script setup lang="ts" generic="T extends string | number">
import { computed } from "vue"
import { Check, ChevronDown, ChevronUp } from "@lucide/vue"
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui"

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  modelValue: T | null
  options: ReadonlyArray<{ value: T; label: string; description?: string; disabled?: boolean }>
  contentWidth?: string
  placeholder?: string
  disabled?: boolean
  name?: string
  required?: boolean
}>()
const emit = defineEmits<{ "update:modelValue": [value: T] }>()

const selectedOption = computed(() =>
  props.options.find((option) => option.value === props.modelValue),
)
// Reka 不接受空字符串选项；类型前缀同时保留数字和同形字符串的区别。
function optionKey(value: T): string {
  return `${typeof value}:${value}`
}

function updateValue(key: string) {
  const option = props.options.find((item) => optionKey(item.value) === key)
  if (option) emit("update:modelValue", option.value)
}
</script>

<template>
  <SelectRoot
    :model-value="selectedOption ? optionKey(selectedOption.value) : ''"
    :disabled="disabled"
    :name="name"
    :required="required"
    @update:model-value="updateValue"
  >
    <SelectTrigger
      v-bind="$attrs"
      class="form-control inline-flex min-w-0 items-center justify-between gap-2 text-left"
    >
      <SelectValue class="min-w-0 truncate" :placeholder="selectedOption ? undefined : placeholder">
        {{ selectedOption?.label ?? placeholder }}
      </SelectValue>
      <SelectIcon as-child
        ><ChevronDown class="size-4 shrink-0 text-muted-foreground"
      /></SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        :collision-padding="8"
        :style="contentWidth ? { width: contentWidth } : undefined"
        class="z-[70] flex max-h-[min(20rem,var(--reka-select-content-available-height))] w-[var(--reka-select-trigger-width)] min-w-32 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border bg-popover text-sm font-normal text-popover-foreground shadow-lg outline-none"
      >
        <SelectScrollUpButton class="flex h-6 shrink-0 items-center justify-center bg-popover">
          <ChevronUp class="size-4 text-muted-foreground" />
        </SelectScrollUpButton>
        <SelectViewport class="min-h-0 p-1">
          <SelectItem
            v-for="option in options"
            :key="optionKey(option.value)"
            :value="optionKey(option.value)"
            :disabled="option.disabled"
            :text-value="option.label"
            class="relative flex min-h-8 cursor-default items-center rounded-md py-1.5 pr-8 pl-2 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary"
          >
            <span class="min-w-0">
              <SelectItemText class="block whitespace-normal [overflow-wrap:anywhere]">
                {{ option.label }}
              </SelectItemText>
              <span
                v-if="option.description"
                class="mt-0.5 block text-xs leading-5 text-muted-foreground"
                >{{ option.description }}</span
              >
            </span>
            <SelectItemIndicator class="absolute right-2 inline-flex items-center">
              <Check class="size-4" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
        <SelectScrollDownButton class="flex h-6 shrink-0 items-center justify-center bg-popover">
          <ChevronDown class="size-4 text-muted-foreground" />
        </SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
