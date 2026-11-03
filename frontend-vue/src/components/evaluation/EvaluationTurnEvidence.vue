<script setup lang="ts">
import { computed, useId } from "vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import ChatMarkdown from "@/components/chat/ChatMarkdown.vue"
import ChatResultContent from "@/components/chat/ChatResultContent.vue"
import { evaluationEvidenceResponse, isRecord } from "@/lib/evaluation"
import type { EvaluationTurnDetail } from "@/types/evaluation"

const props = withDefaults(
  defineProps<{
    detail: EvaluationTurnDetail
    collapseEvidence?: boolean
  }>(),
  { collapseEvidence: false },
)
const evidenceId = useId()
const answers = computed(() =>
  (props.detail?.messages ?? []).flatMap((message) =>
    message.role === "assistant" && typeof message.text === "string" && message.text.trim()
      ? [message.text]
      : [],
  ),
)
const evidence = computed(() =>
  (props.detail?.messages ?? []).flatMap((message, index) => {
    if (message.role !== "tool" || !("details" in message)) return []
    const details = message.details
    const response = evaluationEvidenceResponse(details, `${evidenceId}-${index}`)
    return [
      {
        index,
        name: "tool" in message ? String(message.tool) : "查询依据",
        details,
        response,
        failed: "is_error" in message && Boolean(message.is_error),
        totalRows:
          isRecord(details) && typeof details.row_count === "number" ? details.row_count : null,
        partial: isRecord(details) && Boolean(details.truncated),
      },
    ]
  }),
)
</script>
<template>
  <div class="min-w-0 space-y-5">
    <section>
      <h3>实际回答</h3>
      <div v-if="answers.length" class="mt-3 space-y-4 text-sm">
        <ChatMarkdown v-for="(answer, index) in answers" :key="index" :source="answer" />
      </div>
      <p v-else class="evaluation-note mt-3">
        当前轮次没有可展示的最终正文。{{
          detail.turn.status === "running"
            ? "执行结束后可刷新查看。"
            : "请结合执行状态与查询依据核对。"
        }}
      </p>
    </section>
    <BaseDisclosure
      v-if="evidence.length"
      :default-open="!collapseEvidence"
      content-class="mt-3 space-y-3"
    >
      <template #trigger
        ><span class="font-semibold">查询依据 · {{ evidence.length }} 项</span></template
      >
      <article v-for="item in evidence" :key="item.index" class="rounded-lg border p-3">
        <p class="mb-2 text-xs text-muted-foreground">
          {{ item.failed ? "工具执行异常" : "已记录的工具回执" }} · {{ item.name }}
        </p>
        <p
          v-if="
            item.partial ||
            (item.totalRows !== null &&
              item.response &&
              item.totalRows > (item.response.result?.table?.rows.length ?? 0))
          "
          class="evaluation-note"
        >
          当前回执仅含部分数据<span v-if="item.totalRows !== null"
            >，共 {{ item.totalRows }} 条</span
          >；请结合原始结果核对。
        </p>
        <ChatResultContent
          v-if="item.response"
          :response="item.response"
          :question="detail.turn.question"
          :clarification-resolved="true"
        />
        <BaseDisclosure class="mt-2 text-xs" trigger-class="text-muted-foreground">
          <template #trigger>查看授权回执</template>
          <pre class="evaluation-json mt-2">{{ JSON.stringify(item.details, null, 2) }}</pre>
        </BaseDisclosure>
      </article>
    </BaseDisclosure>
  </div>
</template>
