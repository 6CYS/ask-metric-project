<script setup lang="ts">
withDefaults(defineProps<{ rows?: number; rowClass?: string }>(), { rows: 4, rowClass: "h-10" })
</script>

<template>
  <div class="grid gap-2" aria-label="加载中" aria-busy="true">
    <div v-for="index in rows" :key="index" class="animate-pulse rounded-lg bg-muted" :class="rowClass" />
  </div>
</template>
