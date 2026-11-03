<script setup lang="ts">
import { computed } from "vue"
import { X } from "@lucide/vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import { evaluationDate, reviewLabel, turnDuration } from "@/lib/evaluation"
import type { EvaluationComparisonRow } from "@/lib/evaluation"
import type {
  ComparisonDetailState,
  ComparisonSide,
} from "@/composables/useEvaluationComparisonDetails"
import type { EvaluationRun } from "@/types/evaluation"
import EvaluationStatusBadge from "./EvaluationStatusBadge.vue"
import EvaluationTurnEvidence from "./EvaluationTurnEvidence.vue"

const props = defineProps<{
  before: EvaluationRun
  after: EvaluationRun
  row: EvaluationComparisonRow
  beforeDetail: ComparisonDetailState
  afterDetail: ComparisonDetailState
}>()
const emit = defineEmits<{ close: []; retry: [side: ComparisonSide] }>()
const sides = computed(() => [
  {
    key: "before" as const,
    label: "基准结果",
    run: props.before,
    turn: props.beforeDetail.detail?.turn ?? props.row.before,
    state: props.beforeDetail,
  },
  {
    key: "after" as const,
    label: "对比结果",
    run: props.after,
    turn: props.afterDetail.detail?.turn ?? props.row.after,
    state: props.afterDetail,
  },
])
</script>

<template>
  <section
    class="evaluation-evidence-comparison"
    tabindex="-1"
    aria-label="依据对比"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <header class="flex items-start justify-between gap-4 border-b p-4">
      <div class="min-w-0">
        <h2>依据对比</h2>
        <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
          {{ row.after?.question || row.before?.question }}
        </p>
      </div>
      <BaseButton variant="ghost" size="sm" aria-label="收起依据对比" @click="emit('close')">
        <X />收起
      </BaseButton>
    </header>
    <BaseAlert v-if="!row.comparable" title="比较条件存在差异" class="m-4">
      {{ row.changes.join("、") }}，请结合各自问题及人工期望核对。
    </BaseAlert>
    <div class="grid grid-cols-2 divide-x">
      <article v-for="side in sides" :key="side.key" class="min-w-0" :aria-label="side.label">
        <header class="space-y-2 border-b bg-muted/20 p-4">
          <h3>{{ side.label }}</h3>
          <p class="break-words text-sm">
            {{ side.run.name }} · {{ side.run.version_label || "未登记版本" }}
          </p>
          <div v-if="side.turn" class="flex flex-wrap items-center gap-2 text-xs">
            <EvaluationStatusBadge :status="side.turn.status" />
            <span>{{ turnDuration(side.turn) }}</span>
            <span>{{ reviewLabel(side.turn) }}</span>
          </div>
        </header>
        <div class="max-h-[70vh] min-w-0 space-y-5 overflow-y-auto overscroll-contain p-4">
          <p v-if="!side.turn" class="evaluation-note">该批次没有此题，暂无可对比依据。</p>
          <template v-else>
            <BaseDisclosure content-class="mt-2 space-y-3" trigger-class="text-xs">
              <template #trigger>问题与人工期望</template>
              <div>
                <h3>原始问题</h3>
                <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-6">
                  {{ side.turn.question }}
                </p>
              </div>
              <div>
                <h3>人工期望</h3>
                <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-6">
                  {{ side.turn.expected || "未填写人工期望" }}
                </p>
              </div>
            </BaseDisclosure>
            <div v-if="side.turn.review" class="rounded-md bg-muted/30 p-3 text-xs leading-6">
              <p class="text-muted-foreground">
                {{ side.turn.review.reviewer }} · {{ evaluationDate(side.turn.review.updated_at) }}
              </p>
              <p class="whitespace-pre-wrap break-words">
                {{ side.turn.review.note || "未填写复核说明" }}
              </p>
            </div>
            <BaseAlert v-if="side.turn.result?.error_message" title="执行说明">
              {{ side.turn.result.error_message }}
            </BaseAlert>
            <p v-if="side.state.loading" role="status" class="evaluation-note">
              正在读取已保存的依据…
            </p>
            <BaseAlert v-else-if="side.state.error" title="依据读取失败" variant="destructive">
              {{ side.state.error }}
              <BaseButton
                variant="outline"
                size="sm"
                class="mt-3"
                :aria-label="`重新读取${side.label}依据`"
                @click="emit('retry', side.key)"
                >重新读取</BaseButton
              >
            </BaseAlert>
            <EvaluationTurnEvidence
              v-else-if="side.state.detail"
              :key="`${side.run.id}:${side.turn.id}`"
              :detail="side.state.detail"
              collapse-evidence
            />
          </template>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.evaluation-evidence-comparison {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  text-align: left;
  outline: none;
}
</style>
