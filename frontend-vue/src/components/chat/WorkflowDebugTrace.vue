<script setup lang="ts">
import type { WorkflowTrace } from "@/lib/workflowTrace"

defineProps<{ trace: WorkflowTrace }>()
const statuses: Record<string, string> = {
  not_started: "尚未执行", not_recorded: "未记录步骤结果", completed: "已完成", partial: "部分取得数据",
  no_data: "无可比数据", skipped_no_data: "因排名无数据未补查", failed: "执行失败", blocked: "依赖未满足",
}
const phases: Record<string, string> = {planned: "已召回，待执行", awaiting_input: "已召回，待确认条件", blocked: "已召回，执行受阻", executed: "已执行"}
const outcomes: Record<string, string> = {answered: "已形成有依据的结果", no_data: "正常缺数", unavailable: "服务未完成"}
const methods: Record<string, string> = {ranking: "机构排名", compare: "历史比较", observe: "定向补查"}
const dateModes: Record<string, string> = {exact: "保留指定日期", latest_snapshot: "按实际覆盖选择最近可比日期", all_in_range: "区间已有记录", latest_in_range: "区间最新观测", available_in_range: "区间可用观测"}
const score = (value: number | undefined) => typeof value === "number" ? value.toFixed(3) : "未记录"
</script>

<template>
  <section class="space-y-3 rounded-md border border-blue-200 bg-blue-50/30 p-3 text-sm" aria-label="召回分析路线">
    <div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold">预设分析路线 · {{ trace.name }}</h3>
        <span class="rounded bg-muted px-2 py-0.5 text-xs">{{ trace.outcome ? outcomes[trace.outcome] ?? trace.outcome : phases[trace.phase] ?? trace.phase }}</span>
      </div>
      <p class="mt-1 break-all text-xs text-muted-foreground">{{ trace.workflow_id }}<template v-if="trace.version"> · {{ trace.version }}</template></p>
    </div>
    <div v-if="trace.retrieval" class="space-y-1">
      <h4 class="font-medium">召回依据</h4>
      <p v-if="trace.retrieval.matched_document?.text" class="leading-6">{{ trace.retrieval.matched_document.text }}</p>
      <p class="text-xs text-muted-foreground">向量检索：Milvus · {{ trace.retrieval.embedding_model ?? '模型未记录' }}；重排：{{ trace.retrieval.reranker_model ?? '模型未记录' }}</p>
      <p class="text-xs text-muted-foreground">重排得分 {{ score(trace.retrieval.rerank_score) }}（门槛 {{ score(trace.retrieval.min_score) }}）；与其他类别差值 {{ trace.retrieval.rerank_score !== undefined && trace.retrieval.other_class_score !== undefined ? score(trace.retrieval.rerank_score - trace.retrieval.other_class_score) : '未记录' }}（门槛 {{ score(trace.retrieval.min_margin) }}）</p>
    </div>
    <p v-if="trace.basis"><span class="font-medium">分析口径：</span>{{ trace.basis }}</p>
    <div v-if="trace.date_policy || trace.coverage" class="space-y-1 rounded bg-background/70 p-2 text-xs leading-5">
      <p v-if="trace.date_policy">日期处理：{{ dateModes[trace.date_policy.mode ?? ''] ?? trace.date_policy.mode ?? '未记录' }}<template v-if="trace.date_policy.requested_start">；请求 {{ trace.date_policy.requested_start }}<template v-if="trace.date_policy.requested_end !== trace.date_policy.requested_start"> 至 {{ trace.date_policy.requested_end }}</template></template>；实际观测 {{ trace.date_policy.actual_dates?.join('、') || '无有效记录' }}</p>
      <p v-if="trace.coverage">机构覆盖：目标 {{ trace.coverage.requested_org_count ?? '未记录' }} 家，同日有效 {{ trace.coverage.valid_org_count ?? '未记录' }} 家</p>
    </div>
    <div>
      <h4 class="mb-2 font-medium">分析步骤与执行结果</h4>
      <ol class="list-none space-y-2">
        <li v-for="(step, index) in trace.steps" :key="step.id" class="rounded border bg-background p-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-medium">{{ index + 1 }}. {{ methods[step.method] ?? step.method }}<template v-if="step.method === 'ranking'"> · {{ step.position === 'top' ? '从高到低' : '从低到高' }}取 {{ step.top_n }} 家</template></span>
            <span class="text-xs" :class="['failed', 'blocked'].includes(step.status) ? 'text-destructive' : 'text-muted-foreground'">{{ statuses[step.status] ?? '状态未记录' }}</span>
          </div>
          <p v-if="step.rationale" class="mt-1 leading-6">{{ step.rationale }}</p>
          <p v-if="step.metrics?.length" class="mt-1 text-xs leading-5 text-muted-foreground">指标：{{ step.metrics.map(metric => metric.name).join('、') }}</p>
          <p v-if="step.organization_from_step" class="mt-1 text-xs text-muted-foreground">机构与日期沿用排名入选结果，不扩大补查范围。</p>
          <p v-if="step.fact_count !== undefined" class="mt-1 text-xs text-muted-foreground">取得 {{ step.fact_count }} 条事实 · {{ step.org_count }} 家机构 · {{ step.task_count }} 个查询任务<template v-if="step.actual_dates?.length"> · {{ step.actual_dates.join('、') }}</template></p>
          <ul v-if="step.gaps?.length" class="mt-1 list-inside list-disc text-xs leading-5 text-muted-foreground"><li v-for="gap in step.gaps" :key="gap">{{ gap }}</li></ul>
          <p v-if="step.error_code" class="mt-1 text-xs text-destructive">诊断码：{{ step.error_code }}</p>
        </li>
      </ol>
    </div>
    <div v-if="trace.interpretation?.length" class="text-xs leading-5 text-muted-foreground">
      <h4 class="font-medium">判断依据与边界</h4>
      <p v-for="item in trace.interpretation" :key="item">{{ item }}</p>
    </div>
  </section>
</template>
