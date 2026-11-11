<script setup lang="ts">
import { computed } from "vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import { runStatusLabels, turnStatusLabels } from "@/lib/evaluation"
import type { RunStatus, TurnStatus } from "@/types/evaluation"
const props = defineProps<{ status: RunStatus | TurnStatus; batch?: boolean }>()
const label = computed(() =>
  props.batch
    ? runStatusLabels[props.status as RunStatus]
    : turnStatusLabels[props.status as TurnStatus],
)
const variant = computed(() =>
  ["running", "cancelling"].includes(props.status)
    ? "default"
    : props.status === "failed"
      ? "destructive"
      : ["interrupted", "skipped", "deleting"].includes(props.status)
        ? "warning"
        : "secondary",
)
</script>
<template>
  <BaseBadge :variant="variant">{{ label }}</BaseBadge>
</template>
