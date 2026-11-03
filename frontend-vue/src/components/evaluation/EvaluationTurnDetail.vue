<script setup lang="ts">
import { ref, watch } from "vue"
import { X } from "@lucide/vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseRadioGroup from "@/components/ui/BaseRadioGroup.vue"
import EvaluationStatusBadge from "./EvaluationStatusBadge.vue"
import EvaluationTurnEvidence from "./EvaluationTurnEvidence.vue"
import { evaluationDate, reviewLabel, turnDuration } from "@/lib/evaluation"
import type { EvaluationReview, EvaluationTurnDetail } from "@/types/evaluation"
const props = defineProps<{
  detail: EvaluationTurnDetail | null
  loading: boolean
  error: string
  busy: boolean
}>()
const emit = defineEmits<{
  close: []
  retry: []
  review: [input: Pick<EvaluationReview, "verdict" | "note">]
}>()
const verdict = ref<EvaluationReview["verdict"]>("needs_review")
const verdictOptions: ReadonlyArray<{ value: EvaluationReview["verdict"]; label: string }> = [
  { value: "passed", label: "业务通过" },
  { value: "failed", label: "业务未通过" },
  { value: "needs_review", label: "待复核" },
]
const note = ref("")
const saved = ref(false)
watch(
  () => props.detail,
  (value) => {
    verdict.value = value?.turn.review?.verdict ?? "needs_review"
    note.value = value?.turn.review?.note ?? ""
    saved.value = Boolean(value?.turn.review)
  },
  { immediate: true },
)
function save() {
  saved.value = false
  emit("review", { verdict: verdict.value, note: note.value.trim() })
}
</script>
<template>
  <section class="evaluation-panel" aria-label="轮次详情" tabindex="-1">
    <header class="evaluation-panel-header">
      <div>
        <h2>轮次详情与人工复核</h2>
        <p>对照冻结期望、真实正文和查询依据后登记结论。</p>
      </div>
      <BaseButton variant="ghost" size="icon" aria-label="关闭轮次详情" @click="emit('close')"
        ><X
      /></BaseButton>
    </header>
    <p v-if="loading" role="status" class="p-6 text-sm text-muted-foreground">
      正在读取当前授权范围内的会话结果…
    </p>
    <div v-else-if="error" class="p-5">
      <BaseAlert title="详情读取失败" variant="destructive"
        >{{ error
        }}<BaseButton variant="outline" size="sm" class="mt-3" @click="emit('retry')"
          >重新读取</BaseButton
        ></BaseAlert
      >
    </div>
    <template v-else-if="detail">
      <div class="flex flex-wrap gap-3 border-b px-5 py-3 text-xs">
        <EvaluationStatusBadge :status="detail.turn.status" /><span>{{
          reviewLabel(detail.turn)
        }}</span
        ><span>实际耗时 {{ turnDuration(detail.turn) }}</span>
      </div>
      <div class="evaluation-detail-grid">
        <div class="space-y-5 border-r p-5">
          <section>
            <h3>原始问题</h3>
            <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-7">
              {{ detail.turn.question }}
            </p>
          </section>
          <section>
            <h3>人工期望</h3>
            <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-7">
              {{ detail.turn.expected || "未填写人工期望，请依据业务目标和真实来源复核。" }}
            </p>
          </section>
          <section v-if="detail.turn.result?.error_message">
            <h3>执行说明</h3>
            <p class="mt-2 text-sm leading-6 text-destructive">
              {{ detail.turn.result.error_message }}
            </p>
          </section>
          <p v-if="detail.turn.status === 'skipped'" class="evaluation-note">
            前序轮次未成功，当前追问未执行，不能视作独立问答通过。
          </p>
          <BaseDisclosure class="text-xs" trigger-class="text-muted-foreground">
            <template #trigger>执行身份与实际时序</template>
            <dl class="evaluation-metadata mt-3">
              <div>
                <dt>会话</dt>
                <dd>{{ detail.turn.session_id || "未创建" }}</dd>
              </div>
              <div>
                <dt>请求</dt>
                <dd>{{ detail.turn.request_id || "未发出" }}</dd>
              </div>
              <div>
                <dt>用户条目</dt>
                <dd>{{ detail.turn.result?.user_entry_id || "—" }}</dd>
              </div>
              <div>
                <dt>开始 / 结束</dt>
                <dd>
                  {{ evaluationDate(detail.turn.started_at) }} /
                  {{ evaluationDate(detail.turn.finished_at) }}
                </dd>
              </div>
              <div>
                <dt>运行 / 回答状态</dt>
                <dd>
                  {{ detail.turn.result?.run_status || "—" }} /
                  {{ detail.turn.result?.answer_status || "—" }}
                </dd>
              </div>
              <div v-for="(value, key) in detail.turn.result?.timings_ms || {}" :key="key">
                <dt>{{ key }}（毫秒）</dt>
                <dd>{{ Array.isArray(value) ? value.join("、") : (value ?? "未记录") }}</dd>
              </div>
            </dl>
          </BaseDisclosure>
        </div>
        <div class="min-w-0 space-y-5 p-5">
          <EvaluationTurnEvidence :detail="detail" />
        </div>
      </div>
      <form class="space-y-4 border-t bg-muted/15 p-5" @submit.prevent="save">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3>人工复核</h3>
            <p class="evaluation-note">查询成功不代表业务正确。未复核和待复核均不计入通过。</p>
          </div>
          <span v-if="detail.turn.review" class="text-xs text-muted-foreground"
            >{{ detail.turn.review.reviewer }} ·
            {{ evaluationDate(detail.turn.review.updated_at) }}</span
          >
        </div>
        <p v-if="detail.turn.status !== 'completed'" class="evaluation-note">
          本轮尚未形成执行完成的结果，不能登记业务通过。
        </p>
        <BaseRadioGroup
          v-model="verdict"
          :options="verdictOptions"
          :disabled="busy || detail.turn.status !== 'completed'"
          name="evaluation-verdict"
          aria-label="人工复核结论"
        />
        <label class="form-field"
          >复核说明<textarea
            v-model="note"
            class="form-control resize-y py-2 leading-6"
            rows="3"
            maxlength="5000"
            :disabled="busy || detail.turn.status !== 'completed'"
            placeholder="记录核对依据、问题与待确认事项"
          />
        </label>
        <div class="flex items-center gap-3">
          <BaseButton type="submit" :disabled="busy || detail.turn.status !== 'completed'">{{
            busy ? "保存中…" : "保存复核"
          }}</BaseButton
          ><span v-if="saved" role="status" class="text-xs text-muted-foreground"
            >已记录当前复核</span
          >
        </div>
      </form>
    </template>
  </section>
</template>
