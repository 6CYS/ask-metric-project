<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue"

import BaseButton from "@/components/ui/BaseButton.vue"

defineProps<{
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
}>()

defineEmits<{ change: [page: number] }>()
</script>

<template>
  <div class="flex flex-col gap-3 border-t px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
    <p class="text-muted-foreground">
      <template v-if="totalItems">第 {{ (page - 1) * pageSize + 1 }}-{{ Math.min(page * pageSize, totalItems) }} 条，共 {{ totalItems }} 条</template>
      <template v-else>共 0 条</template>
    </p>
    <div class="flex items-center gap-2">
      <span class="text-xs text-muted-foreground">第 {{ page }} / {{ totalPages }} 页</span>
      <BaseButton variant="outline" size="icon" :disabled="page <= 1" aria-label="上一页" @click="$emit('change', page - 1)">
        <ChevronLeft />
      </BaseButton>
      <BaseButton variant="outline" size="icon" :disabled="page >= totalPages" aria-label="下一页" @click="$emit('change', page + 1)">
        <ChevronRight />
      </BaseButton>
    </div>
  </div>
</template>
