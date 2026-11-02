<script setup lang="ts">
import ChatMarkdown from "./ChatMarkdown.vue"
defineProps<{text?: string}>()
</script>

<template>
  <div v-if="text" class="leading-7" data-provisional-answer>
    <ChatMarkdown :source="text" /><span class="inline-block h-4 w-0.5 animate-pulse rounded-full bg-[#52789C] align-middle" aria-hidden="true" />
  </div>
</template>
