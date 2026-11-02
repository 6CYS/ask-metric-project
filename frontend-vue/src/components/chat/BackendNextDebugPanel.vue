<script setup lang="ts">
import { Bug, X } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"

const props = defineProps<{ question: string; taskId?: string; taskVersion?: number; status?: string; stage?: string; timings?: Record<string, number>; debug?: Record<string, unknown> }>()
const emit = defineEmits<{ close: [] }>()

const labels: Record<string, string> = {
  question: "问题输入",
  execution_route: "本次正式执行链路",
  multiturn_understanding: "历史多轮模型输入（已退出）",
  multiturn_context_merge: "历史多轮条件合并（已退出）",
  multiturn_candidate_dsl: "历史多轮候选 DSL（已退出）",
  task_create: "QueryTask 创建",
  intent_routing: "大模型意图识别",
  semantic: "语义分析",
  chat_model: "Chat 模型",
  embedding: "Embedding",
  rerank: "Rerank",
  slot_frame: "有效查询上下文",
  clarification: "澄清过程",
  clarification_answers: "用户澄清选择",
  logical_dsl: "最终采用的 Logical DSL",
  query: "SQL 查询",
  result: "SQL 查询原始结果（未换算）",
  error: "错误详情",
  model_raw_output: "单轮语义模型原始输出（仅诊断）",
  model_adapted_output: "单轮兼容转换结果（仅诊断）",
  field_validation_errors: "字段校验与容错",
  trace: "节点流转轨迹",
}

function pretty(value: unknown) {
  if (value === undefined) return "未记录"
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function displayValue(key: string, value: unknown) {
  if (key === "query" && value && typeof value === "object") {
    const query = value as Record<string, unknown>
    const sql = query.rendered_sql ?? query.sql
    if (typeof sql === "string") return sql.trim()
  }
  return pretty(value)
}

function duration(key: string) {
  const value = props.timings?.[key]
  return typeof value === "number" ? `${value >= 1000 ? (value / 1000).toFixed(2) + " s" : value + " ms"}` : ""
}

function entries() {
  const data = props.debug ?? {}
  const semantic = data.semantic && typeof data.semantic === "object" ? data.semantic as Record<string, unknown> : {}
  const chatModel = semantic.chat_model && typeof semantic.chat_model === "object" ? semantic.chat_model as Record<string, unknown> : {}
  const multiturn = data.multiturn_shadow && typeof data.multiturn_shadow === "object" ? data.multiturn_shadow as Record<string, unknown> : {}
  const validation = multiturn.candidate_dsl_validation && typeof multiturn.candidate_dsl_validation === "object" ? multiturn.candidate_dsl_validation as Record<string, unknown> : {}
  const expanded: Record<string, unknown> = {
    ...data,
    multiturn_understanding: multiturn.understanding,
    multiturn_context_merge: multiturn.context_merge,
    multiturn_candidate_dsl: validation.candidate_dsl,
    model_raw_output: chatModel.output,
    model_adapted_output: chatModel.adapted_output,
    field_validation_errors: chatModel.field_validation_errors,
  }
  return ["question", "execution_route", "task_create", "trace", "multiturn_understanding", "multiturn_context_merge", "multiturn_candidate_dsl", "intent_routing", "model_raw_output", "model_adapted_output", "field_validation_errors", "semantic", "slot_frame", "clarification", "clarification_answers", "logical_dsl", "query", "result", "error"]
    .filter((key) => key === "question" || expanded[key] !== undefined)
    .map((key) => ({ key, label: labels[key] ?? key, value: key === "question" ? props.question : expanded[key], time: key === "semantic" ? duration("analyze_total_ms") : key === "query" ? duration("query_planning_ms") : key === "result" ? duration("sql_execution_ms") : "" }))
}

function routeNotice() {
  const route = props.debug?.execution_route
  if (!route || typeof route !== "object") return null
  const value = route as Record<string, unknown>
  if (value.selected_pipeline === "MULTITURN_CONTEXT") {
    return "此为旧版多轮执行记录，仅供历史查看；当前版本不再执行这条链路。"
  }
  if (value.selected_pipeline === "SINGLE_TURN_QUERY") {
    return "本次采用独立指标查询链路，不继承其他任务的条件。"
  }
  if (value.selected_pipeline === "MULTITURN_CLARIFICATION") {
    return "此为旧版跨任务澄清，已退出运行链。请重新提问并补齐指标、机构和日期。"
  }
  if (value.selected_pipeline === "SINGLE_TURN_FALLBACK") {
    return "此为旧版多轮回退记录，仅供历史查看，当前已无该路由。"
  }
  if (value.selected_pipeline === "LEGACY_GRAY_MULTITURN_OVERRIDE") {
    return "此为旧版灰度执行记录，仅供历史查看；当前已移除灰度执行和恢复开关。"
  }
  return null
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-black/30" @click.self="emit('close')">
    <aside class="ml-auto flex h-full w-[min(94vw,680px)] flex-col border-l bg-background shadow-xl">
      <header class="flex items-center justify-between border-b px-4 py-3">
        <div class="flex items-center gap-2"><Bug class="size-4" /><div><h2 class="text-sm font-semibold">调试流程</h2><p class="text-xs text-muted-foreground">{{ taskId ? `Task ${taskId}${taskVersion !== undefined ? ` · v${taskVersion}` : ''}` : "尚未创建 QueryTask" }} · {{ status }} / {{ stage }}</p></div></div>
        <BaseButton variant="ghost" size="icon" title="关闭调试面板" @click="emit('close')"><X /></BaseButton>
      </header>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <slot name="status" />
        <section v-if="routeNotice()" class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm leading-5 text-blue-900">
          {{ routeNotice() }}
        </section>
        <section v-for="item in entries()" :key="item.key" class="overflow-hidden rounded-md border bg-muted/20">
          <div class="flex items-center justify-between border-b bg-background px-3 py-2"><span class="text-sm font-medium">{{ item.label }}</span><span v-if="item.time" class="font-mono text-xs text-muted-foreground">{{ item.time }}</span></div>
          <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">{{ displayValue(item.key, item.value) }}</pre>
        </section>
        <section v-if="!entries().length" class="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">暂时没有调试数据</section>
      </div>
    </aside>
  </div>
</template>
