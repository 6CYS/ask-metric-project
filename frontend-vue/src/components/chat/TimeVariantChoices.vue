<script setup lang="ts">
import type { TimeVariant } from "@/types/api"

/** 备选时间口径 chips：仅展示后端下发的 label 与区间，点选回传显式 time_override，不做前端日期换算。 */
defineProps<{ variants: TimeVariant[]; active: boolean }>()
const emit = defineEmits<{ choose: [variant: TimeVariant] }>()
</script>

<template>
  <div class="mt-3 space-y-2" role="group" aria-label="切换时间口径">
    <p class="text-sm text-muted-foreground">切换为：</p>
    <div class="flex flex-wrap gap-2">
      <button
        v-for="variant in variants"
        :key="`${variant.start}_${variant.end}_${variant.label}`"
        type="button"
        class="rounded-full border px-3 py-1 text-sm transition-colors enabled:hover:bg-muted disabled:cursor-default disabled:opacity-60"
        :disabled="!active"
        :aria-label="`切换口径：${variant.label}`"
        @click="emit('choose', variant)"
      >
        {{ variant.label }}
      </button>
    </div>
  </div>
</template>
