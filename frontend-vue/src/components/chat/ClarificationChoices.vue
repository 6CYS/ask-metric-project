<script setup lang="ts">
import type { ClarificationChoiceSet, ClarificationChoice } from "@/lib/agentApi"

/** 系统给出的待确认清单：编号与服务端保存的清单一致，点选按选项标识回传，不依赖文字匹配。 */
defineProps<{ choices: ClarificationChoiceSet; active: boolean }>()
const emit = defineEmits<{ choose: [choice: ClarificationChoice] }>()
</script>

<template>
  <div class="mt-3 space-y-3" role="group" aria-label="请选择确认项">
    <p v-if="choices.confirmation_unclear" class="text-sm text-muted-foreground">未能从回复中确定您选择的是哪一项，请点选或回复序号、名称。</p>
    <div v-for="group in choices.options" :key="group.title" class="space-y-2">
      <p class="text-sm text-muted-foreground">{{ group.title }}</p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="option in group.options"
          :key="option.id"
          type="button"
          class="rounded-full border px-3 py-1 text-sm transition-colors enabled:hover:bg-muted disabled:cursor-default disabled:opacity-60"
          :disabled="!active"
          :aria-label="`第${option.no}项：${option.label}`"
          @click="emit('choose', option)"
        >
          <span class="mr-1 text-muted-foreground">{{ option.no }}.</span>{{ option.label }}
        </button>
      </div>
    </div>
    <p v-if="active" class="text-xs text-muted-foreground">也可以直接回复序号或名称。</p>
  </div>
</template>
