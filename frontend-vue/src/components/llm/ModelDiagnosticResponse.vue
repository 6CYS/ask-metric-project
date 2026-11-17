<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { Copy } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { copyText } from "@/lib/clipboard"
import type { DiagnosticModelResponse } from "@/types/modelDiagnostics"

const props = defineProps<{ response: DiagnosticModelResponse; incomplete: boolean }>()
const copyStatus = ref("")
const errorLabel = computed(() =>
  props.response.error_source === "http" ? "网关错误返回（脱敏）" : "调用错误（脱敏）",
)
const contentLabel = computed(() => (props.incomplete ? "模型回复（未完整返回）" : "模型回复"))
const responseText = computed(() =>
  [
    props.response.http_status === null
      ? "未收到 HTTP 响应状态"
      : `HTTP ${props.response.http_status}`,
    props.response.content
      ? `${contentLabel.value}\n${props.response.content}`
      : "未收到模型回复正文。",
    props.response.error ? `${errorLabel.value}\n${props.response.error}` : "",
    props.response.truncated ? "内容过长，已截取显示。" : "",
  ]
    .filter(Boolean)
    .join("\n\n"),
)

watch(
  () => props.response,
  () => {
    copyStatus.value = ""
  },
)
async function copyResponse() {
  const text = responseText.value
  try {
    await copyText(text)
    if (responseText.value === text) copyStatus.value = "已复制"
  } catch {
    if (responseText.value === text) copyStatus.value = "复制失败，请选择文字复制。"
  }
}
</script>

<template>
  <section class="mt-4 min-w-0 border-t pt-3" aria-label="模型返回内容">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="font-medium text-foreground">
        {{
          response.http_status === null ? "未收到 HTTP 响应状态" : `HTTP ${response.http_status}`
        }}
      </p>
      <BaseButton variant="ghost" size="sm" @click="copyResponse"><Copy />复制返回内容</BaseButton>
    </div>
    <p v-if="copyStatus" role="status" class="mt-1">{{ copyStatus }}</p>
    <template v-if="response.content">
      <h3 class="mt-3 mb-2 font-medium text-foreground">{{ contentLabel }}</h3>
      <pre
        class="max-h-64 overflow-auto rounded-md border bg-background p-3 text-sm leading-6 text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
        >{{ response.content }}</pre>
    </template>
    <p v-else class="mt-3">未收到模型回复正文。</p>
    <template v-if="response.error">
      <h3 class="mt-3 mb-2 font-medium text-foreground">{{ errorLabel }}</h3>
      <pre
        class="max-h-64 overflow-auto rounded-md border bg-background p-3 text-sm leading-6 text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
        >{{ response.error }}</pre>
    </template>
    <p v-if="response.truncated" class="mt-2">内容过长，已截取显示。</p>
  </section>
</template>
