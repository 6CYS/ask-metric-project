<script setup lang="ts">
import type { AssistantParagraph } from "@/lib/assistantText"

defineProps<{ segments: AssistantParagraph }>()
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index"><strong v-if="segment.bold" class="font-semibold">{{ segment.text }}</strong><template v-else>{{ segment.text }}</template></template>
</template>
