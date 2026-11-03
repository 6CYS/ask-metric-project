<script setup lang="ts" generic="Nullable extends boolean = false">
import { ChevronDown, ChevronUp } from "@lucide/vue"
import {
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
  NumberFieldRoot,
} from "reka-ui"

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    modelValue: Nullable extends true ? number | null : number
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Vue 宏需要布尔字面量生成运行时 Boolean，才能识别 nullable 简写。
    nullable?: Nullable | false
    min?: number
    max?: number
    step?: number
    disabled?: boolean
    readonly?: boolean
    id?: string
    name?: string
    required?: boolean
  }>(),
  { step: 1 },
)
const emit = defineEmits<{
  "update:modelValue": [value: Nullable extends true ? number | null : number]
}>()

function updateValue(value: number | undefined) {
  // Reka 以 undefined 表示清空；仅 nullable 配置允许输出 null。
  const nextValue =
    value !== undefined && Number.isFinite(value) ? value : props.nullable ? null : (props.min ?? 0)
  emit("update:modelValue", nextValue as Nullable extends true ? number | null : number)
}
</script>

<template>
  <NumberFieldRoot
    :id="id"
    :model-value="modelValue"
    :min="min"
    :max="max"
    :step="step"
    :step-snapping="false"
    :disabled="disabled"
    :readonly="readonly"
    :name="name"
    :required="required"
    :format-options="{ useGrouping: false, maximumFractionDigits: 20 }"
    locale="zh-CN"
    class="relative"
    @update:model-value="updateValue"
  >
    <NumberFieldInput
      v-bind="$attrs"
      class="form-control pr-10!"
      :aria-required="required"
      aria-roledescription="数值输入"
    />
    <div
      class="absolute inset-y-1 right-1 flex w-6 flex-col overflow-hidden rounded border border-input"
    >
      <NumberFieldIncrement
        aria-label="增加"
        class="flex min-h-0 flex-1 items-center justify-center bg-muted/40 text-muted-foreground outline-none hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        ><ChevronUp class="size-3" aria-hidden="true"
      /></NumberFieldIncrement>
      <NumberFieldDecrement
        aria-label="减少"
        class="flex min-h-0 flex-1 items-center justify-center border-t border-input bg-muted/40 text-muted-foreground outline-none hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        ><ChevronDown class="size-3" aria-hidden="true"
      /></NumberFieldDecrement>
    </div>
  </NumberFieldRoot>
</template>
