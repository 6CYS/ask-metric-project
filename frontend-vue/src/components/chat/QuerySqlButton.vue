<script setup lang="ts">
import { CodeXml } from "@lucide/vue"
import { onDeactivated, ref } from "vue"
import QuerySqlPanel from "./QuerySqlPanel.vue"
import type { QuerySqlReference } from "@/types/querySql"

defineProps<{ references: QuerySqlReference[] }>()
const isOpen = ref(false)

onDeactivated(() => {
  isOpen.value = false
})
</script>

<template>
  <button
    v-if="references.length"
    type="button"
    class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/75 transition-colors hover:bg-muted/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    aria-haspopup="dialog"
    :aria-expanded="isOpen"
    @click="isOpen = true"
  >
    <CodeXml class="size-3.5" aria-hidden="true" />查看执行 SQL
    <span v-if="references.length > 1">· {{ references.length }} 项</span>
  </button>
  <QuerySqlPanel
    v-if="isOpen"
    :open="isOpen"
    :references="references"
    @update:open="isOpen = $event"
  />
</template>
