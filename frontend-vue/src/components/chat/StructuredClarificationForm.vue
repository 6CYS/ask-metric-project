<script setup lang="ts">
import { computed } from "vue"
import { clarificationTranscript } from "@/lib/conversationMessages"
import type { BackendNextClarification } from "@/types/api"

const props = defineProps<{ clarification: BackendNextClarification }>()
const message = computed(() => clarificationTranscript(props.clarification))
</script>

<template>
  <p class="whitespace-pre-line text-sm leading-7">{{ message }}</p>
</template>
