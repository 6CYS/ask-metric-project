<script setup lang="ts">
import { computed } from "vue"
import { RouterLink } from "vue-router"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import type { BusinessKnowledgeItem, MetricItem } from "@/types/api"

const props = withDefaults(
  defineProps<{
    item: BusinessKnowledgeItem | null
    metrics: MetricItem[]
    busy?: boolean
  }>(),
  { busy: false },
)
const emit = defineEmits<{ close: []; edit: [item: BusinessKnowledgeItem] }>()
const isPlan = computed(() => props.item?.batch_query_enabled === true)
const metricByCode = computed(
  () => new Map(props.metrics.map((metric) => [metric.metric_code, metric])),
)
</script>

<template>
  <BaseModal
    v-if="item"
    :open="true"
    :busy="busy"
    size="lg"
    :title="isPlan ? '查询方案详情' : '业务知识详情'"
    :description="isPlan ? '查看方案适用范围与查询指标。' : '查看业务含义、分析方法和适用边界。'"
    @update:open="
      (value) => {
        if (!value) emit('close')
      }
    "
  >
    <div class="space-y-5">
      <div class="space-y-2">
        <h3 class="break-words font-medium">{{ item.title }}</h3>
        <BaseBadge :variant="item.enabled ? 'success' : 'secondary'">{{
          item.enabled ? "已启用" : "已停用"
        }}</BaseBadge>
      </div>
      <div v-if="isPlan && item.report_layout" class="space-y-2">
        <h4 class="text-sm font-medium">报告输出结构</h4>
        <p class="break-words text-sm leading-6">报告标题：{{ item.report_layout.title }}</p>
        <ol class="space-y-1 text-sm leading-6">
          <li>经营摘要</li>
          <li v-for="section in item.report_layout.sections" :key="section.id" class="break-words">
            {{ section.title }}（{{ section.table ? "包含事实对照表" : "不含事实对照表" }}）
          </li>
        </ol>
        <p class="text-xs leading-5 text-muted-foreground">
          章节顺序与数据表由输出配置生成；说明文字提供分析指导。数据表只展示本次已取得的可用数据。
        </p>
      </div>
      <div class="space-y-2">
        <h4 class="text-sm font-medium">{{ isPlan ? "适用场景与查询说明" : "知识内容" }}</h4>
        <p class="whitespace-pre-wrap break-words text-sm leading-6">{{ item.text }}</p>
      </div>
      <div class="space-y-2">
        <h4 class="text-sm font-medium">{{ isPlan ? "查询指标" : "相关指标（选填）" }}</h4>
        <p class="text-xs leading-5 text-muted-foreground">
          {{
            isPlan
              ? "这些指标组成方案的取数范围，机构与期间以用户的问题为准。"
              : "关联用于帮助检索并在指标详情中展示，不代表必须查询；通用分析方法无需关联指标。"
          }}
        </p>
        <ul v-if="item.metric_codes?.length" class="divide-y">
          <li v-for="code in item.metric_codes" :key="code" class="py-2 text-sm">
            <RouterLink
              :to="{ path: '/metrics', query: { metric: code } }"
              class="block break-words rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              @click="emit('close')"
            >
              <span>{{ metricByCode.get(code)?.metric_name || "指标名称暂不可用" }}</span>
              <span class="mt-1 block break-all text-xs text-muted-foreground">{{ code }}</span>
            </RouterLink>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">
          {{ isPlan ? "尚未配置查询指标。" : "未关联指标。" }}
        </p>
      </div>
    </div>
    <template #footer>
      <BaseButton variant="outline" :disabled="busy" @click="emit('close')">关闭</BaseButton>
      <BaseButton :disabled="busy" @click="emit('edit', item)">{{
        isPlan ? "编辑方案" : "编辑知识"
      }}</BaseButton>
    </template>
  </BaseModal>
</template>
