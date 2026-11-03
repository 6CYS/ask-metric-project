<script setup lang="ts">
import { Check } from "@lucide/vue"
import { CheckboxIndicator, CheckboxRoot } from "reka-ui"

defineProps<{ modelValue: boolean; disabled?: boolean; name?: string; required?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>()
</script>

<template>
  <CheckboxRoot
    :model-value="modelValue"
    :disabled="disabled"
    :name="name"
    :required="required"
    class="inline-flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background text-primary-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary"
    @update:model-value="emit('update:modelValue', $event === true)"
  >
    <CheckboxIndicator><Check class="size-3" aria-hidden="true" /></CheckboxIndicator>
  </CheckboxRoot>
</template>
