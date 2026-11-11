<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import {
  compareEvaluationRuns,
  evaluationSummary,
  reviewLabel,
  turnDuration,
} from "@/lib/evaluation"
import EvaluationStatusBadge from "./EvaluationStatusBadge.vue"
import EvaluationEvidenceComparison from "./EvaluationEvidenceComparison.vue"
import { useEvaluationComparisonDetails } from "@/composables/useEvaluationComparisonDetails"
import type { EvaluationComparisonRow } from "@/lib/evaluation"
import type { EvaluationRun } from "@/types/evaluation"
const props = defineProps<{ runs: EvaluationRun[] }>()
const emit = defineEmits<{ detail: [runId: string, turnId: string] }>()
const availableRuns = computed(() => props.runs.filter((run) => run.status !== "deleting"))
const runOptions = computed(() =>
  availableRuns.value.map((run) => ({
    value: run.id,
    label: `${run.name} · ${run.version_label || "未登记版本"}`,
  })),
)
const beforeId = ref("")
const afterId = ref("")
const expandedId = ref("")
const comparisonDetails = useEvaluationComparisonDetails()
const { before: beforeDetail, after: afterDetail } = comparisonDetails
watch(availableRuns, comparisonDetails.syncRuns)
watch([beforeId, afterId], () => {
  expandedId.value = ""
  comparisonDetails.clear()
})
watch(
  () => availableRuns.value.map((run) => run.id),
  (ids) => {
    if (!ids.includes(beforeId.value)) beforeId.value = ids[1] ?? ids[0] ?? ""
    if (!ids.includes(afterId.value)) afterId.value = ids[0] ?? ""
  },
  { immediate: true },
)
const before = computed(() => availableRuns.value.find((run) => run.id === beforeId.value))
const after = computed(() => availableRuns.value.find((run) => run.id === afterId.value))
const comparison = computed(() =>
  before.value && after.value && before.value.id !== after.value.id
    ? compareEvaluationRuns(before.value, after.value)
    : null,
)
async function closeComparison() {
  const previousId = expandedId.value
  expandedId.value = ""
  comparisonDetails.clear()
  await nextTick()
  document.getElementById(`compare-evidence-trigger-${previousId}`)?.focus({ preventScroll: true })
}
async function openComparison(row: EvaluationComparisonRow) {
  if (!before.value || !after.value) return
  if (expandedId.value === row.id) return closeComparison()
  expandedId.value = row.id
  const loaded = comparisonDetails.load(
    row.before ? { runId: before.value.id, turn: row.before } : null,
    row.after ? { runId: after.value.id, turn: row.after } : null,
  )
  await nextTick()
  if (expandedId.value === row.id) {
    const panel = document.getElementById(`compare-evidence-${row.id}`)
    panel?.focus({ preventScroll: true })
    panel?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
  await loaded
}
</script>
<template>
  <section class="evaluation-panel">
    <header class="evaluation-panel-header">
      <div>
        <h2>版本逐题对比</h2>
        <p>按冻结题目身份和会话前文对齐。执行结果与人工业务结论分开比较。</p>
      </div>
    </header>
    <div class="grid gap-5 border-b p-5 lg:grid-cols-2">
      <label class="form-field"
        >基准批次<BaseSelect
          v-model="beforeId"
          :options="runOptions"
          placeholder="选择基准批次"
          aria-label="基准批次" /></label
      ><label class="form-field"
        >对比批次<BaseSelect
          v-model="afterId"
          :options="runOptions"
          placeholder="选择对比批次"
          aria-label="对比批次"
      /></label>
    </div>
    <div v-if="!comparison" class="evaluation-empty">
      <h3>选择两个不同批次</h3>
      <p>至少完成两次测评后，可核对逐题结果和配置差异。</p>
    </div>
    <template v-else-if="before && after">
      <div class="space-y-4 p-5">
        <BaseAlert v-if="comparison.contextDifferences.length" title="比较条件存在差异"
          >{{
            comparison.contextDifferences.join("；")
          }}。请结合差异分析，不将分数变化直接归因于代码版本。</BaseAlert
        >
        <p class="evaluation-note">
          数据条件由人工登记，即使文字相同，也不代表底层数据快照相同。待复核不计入业务通过。
        </p>
        <div class="grid gap-4 lg:grid-cols-2">
          <article
            v-for="run in [before, after]"
            :key="run.id"
            class="rounded-lg border bg-muted/20 p-4"
          >
            <h3>{{ run.name }}</h3>
            <dl class="evaluation-metadata mt-3">
              <div>
                <dt>问题集</dt>
                <dd>{{ run.dataset.name }} · v{{ run.dataset.version }}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{{ run.model }}</dd>
              </div>
              <div>
                <dt>配置摘要</dt>
                <dd>{{ run.config_hash }}</dd>
              </div>
              <div>
                <dt>题集摘要</dt>
                <dd>{{ run.dataset_hash }}</dd>
              </div>
              <div>
                <dt>数据条件</dt>
                <dd>{{ run.data_label || "未登记" }}</dd>
              </div>
              <div>
                <dt>业务复核</dt>
                <dd>
                  {{ evaluationSummary(run).passed }} 通过 /
                  {{ evaluationSummary(run).failed }} 未通过 /
                  {{ evaluationSummary(run).pendingReview }} 待复核
                </dd>
              </div>
            </dl>
          </article>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="evaluation-table evaluation-comparison-table min-w-[800px]">
          <colgroup>
            <col style="width: 34%" />
            <col span="4" style="width: 13%" />
            <col style="width: 14%" />
          </colgroup>
          <thead>
            <tr>
              <th>题目 / 可比性</th>
              <th>基准执行</th>
              <th>基准业务复核</th>
              <th>对比执行</th>
              <th>对比业务复核</th>
              <th>依据对比</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in comparison.rows" :key="row.id">
              <tr :class="{ selected: expandedId === row.id }">
                <td class="max-w-xs">
                  <p class="whitespace-pre-wrap break-words">
                    {{ row.after?.question || row.before?.question }}
                  </p>
                  <p class="evaluation-note" :class="{ 'text-amber-700': !row.comparable }">
                    {{
                      row.comparable
                        ? "题目及前文一致"
                        : row.changes.join("、") + "；不能直接判断改进"
                    }}
                  </p>
                </td>
                <td>
                  <template v-if="row.before"
                    ><EvaluationStatusBadge :status="row.before.status" />
                    <p class="evaluation-note">{{ turnDuration(row.before) }}</p></template
                  ><span v-else>—</span>
                </td>
                <td>
                  {{ reviewLabel(row.before)
                  }}<BaseButton
                    v-if="row.before"
                    variant="link"
                    size="sm"
                    class="block"
                    @click="emit('detail', before.id, row.id)"
                    >查看依据</BaseButton
                  >
                </td>
                <td>
                  <template v-if="row.after"
                    ><EvaluationStatusBadge :status="row.after.status" />
                    <p class="evaluation-note">{{ turnDuration(row.after) }}</p></template
                  ><span v-else>—</span>
                </td>
                <td>
                  {{ reviewLabel(row.after)
                  }}<BaseButton
                    v-if="row.after"
                    variant="link"
                    size="sm"
                    class="block"
                    @click="emit('detail', after.id, row.id)"
                    >查看依据</BaseButton
                  >
                </td>
                <td>
                  <BaseButton
                    :id="`compare-evidence-trigger-${row.id}`"
                    variant="outline"
                    size="sm"
                    :aria-label="`对比依据：${row.after?.question || row.before?.question}`"
                    :aria-expanded="expandedId === row.id"
                    :aria-controls="
                      expandedId === row.id ? `compare-evidence-${row.id}` : undefined
                    "
                    @click="openComparison(row)"
                    >对比依据</BaseButton
                  >
                </td>
              </tr>
              <tr v-if="expandedId === row.id">
                <td colspan="6" class="evaluation-comparison-expanded">
                  <EvaluationEvidenceComparison
                    :id="`compare-evidence-${row.id}`"
                    :before="before"
                    :after="after"
                    :row="row"
                    :before-detail="beforeDetail"
                    :after-detail="afterDetail"
                    @close="closeComparison"
                    @retry="comparisonDetails.retry"
                  />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.evaluation-comparison-table {
  table-layout: fixed;
}
.evaluation-comparison-table > tbody > tr > .evaluation-comparison-expanded {
  padding: 12px;
  background: var(--muted);
}
</style>
