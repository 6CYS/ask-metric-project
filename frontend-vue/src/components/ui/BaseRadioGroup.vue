<script setup lang="ts" generic="T extends string | number">
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from "reka-ui"

const props = defineProps<{
  modelValue: T
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>
  disabled?: boolean
  name?: string
  required?: boolean
}>()
const emit = defineEmits<{ "update:modelValue": [value: T] }>()

function updateValue(value: unknown) {
  const option = props.options.find((item) => item.value === value)
  if (option) emit("update:modelValue", option.value)
}
</script>

<template>
  <RadioGroupRoot
    :model-value="modelValue"
    :disabled="disabled"
    :name="name"
    :required="required"
    class="flex flex-wrap gap-5 text-sm"
    @update:model-value="updateValue"
  >
    <label
      v-for="option in options"
      :key="option.value"
      class="inline-flex items-center gap-2"
      :class="disabled || option.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
    >
      <RadioGroupItem
        :value="option.value"
        :disabled="option.disabled"
        :aria-label="option.label"
        class="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background text-primary outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:border-primary"
      >
        <RadioGroupIndicator class="size-2 rounded-full bg-current" />
      </RadioGroupItem>
      <span>{{ option.label }}</span>
    </label>
  </RadioGroupRoot>
</template>
