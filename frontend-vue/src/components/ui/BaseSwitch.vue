<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean; label: string }>()
defineEmits<{ "update:modelValue": [value: boolean] }>()
</script>

<template>
  <label class="inline-flex items-center gap-2 text-xs text-muted-foreground select-none" :class="disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
    <span>{{ label }}</span>
    <input
      type="checkbox"
      class="peer sr-only"
      :checked="modelValue"
      :disabled="disabled"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="relative h-5 w-9 rounded-full bg-input transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/60 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-background after:shadow-md after:transition-transform peer-checked:after:translate-x-4" />
  </label>
</template>
