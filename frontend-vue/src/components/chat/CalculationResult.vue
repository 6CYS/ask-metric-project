<script setup lang="ts">
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import type { CalculationDetails } from "@/lib/agentApi"
defineProps<{ calculation: CalculationDetails }>()
</script>

<template>
  <div v-if="calculation.status === 'succeeded'" class="mt-1 text-sm" aria-label="计算口径和数据来源">
    <BaseDisclosure class="text-muted-foreground" trigger-class="text-xs leading-6 transition-colors hover:text-foreground">
      <template #trigger>查看计算口径和数据来源</template>
      <div class="mt-2 space-y-2 break-words">
        <p v-if="calculation.sources?.some(source => source.historical)">本次计算包含之前查询的数值快照，沿用当时的原值，未重新查库刷新。</p>
        <p v-for="result in calculation.results" :key="result.name">{{ result.label }}：{{ result.expression }}</p>
        <p v-for="(input, name) in calculation.inputs" :key="name">
          {{ name }}：{{ input.source_text || [input.org_name, input.metric_name, input.date].filter(Boolean).join(' · ') }}，{{ input.value }}{{ input.unit }}
        </p>
      </div>
    </BaseDisclosure>
  </div>
</template>
