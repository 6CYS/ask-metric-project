<script setup lang="ts">
import type { CalculationDetails } from "@/lib/agentApi"
defineProps<{ calculation: CalculationDetails }>()
</script>

<template>
  <div class="mt-1 text-sm" aria-label="计算口径和数据来源">
    <p v-if="calculation.status !== 'succeeded'" class="text-muted-foreground">计算未完成：{{ calculation.message || '请检查计算条件后重试。' }}</p>
    <template v-else>
      <details class="text-muted-foreground">
        <summary class="cursor-pointer text-xs leading-6 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">查看计算口径和数据来源</summary>
        <div class="mt-2 space-y-2 break-words">
          <p v-for="result in calculation.results" :key="result.name">{{ result.label }}：{{ result.expression }}</p>
          <p v-for="(input, name) in calculation.inputs" :key="name">
            {{ name }}：{{ input.source_text || [input.org_name, input.metric_name, input.date].filter(Boolean).join(' · ') }}，{{ input.value }}{{ input.unit }}
          </p>
        </div>
      </details>
    </template>
  </div>
</template>
