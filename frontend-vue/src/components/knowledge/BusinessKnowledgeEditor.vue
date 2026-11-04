<script setup lang="ts">
import { computed, ref, useId, watch } from "vue"
import { LoaderCircle, RefreshCw } from "@lucide/vue"

import MetricPicker from "@/components/metrics/MetricPicker.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseCheckbox from "@/components/ui/BaseCheckbox.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSwitch from "@/components/ui/BaseSwitch.vue"
import type { BusinessKnowledgeForm } from "@/lib/businessKnowledge"
import type { MetricItem } from "@/types/api"

const props = withDefaults(
  defineProps<{
    open: boolean
    modelValue: BusinessKnowledgeForm
    metrics: MetricItem[]
    editing?: boolean
    busy?: boolean
    conflict?: boolean
    error?: string
    metricsLoading?: boolean
    metricsError?: string
    currentMetric?: MetricItem
  }>(),
  {
    editing: false,
    busy: false,
    conflict: false,
    error: "",
    metricsLoading: false,
    metricsError: "",
  },
)
const emit = defineEmits<{
  "update:open": [open: boolean]
  "update:modelValue": [form: BusinessKnowledgeForm]
  save: []
  reload: []
  loadMetrics: []
}>()
const expanded = ref(false)
const errorId = useId()
const hasCurrentMetric = computed(() =>
  Boolean(
    props.currentMetric && props.modelValue.metric_codes.includes(props.currentMetric.metric_code),
  ),
)
const metricByCode = computed(() => new Map(props.metrics.map((item) => [item.metric_code, item])))
const linkedNames = computed(() =>
  props.modelValue.metric_codes
    .slice(0, 3)
    .map((code) => metricByCode.value.get(code)?.metric_name || code)
    .join("、"),
)

watch(
  () => props.open,
  (open) => {
    if (open) expanded.value = false
  },
)

function updateField<K extends keyof BusinessKnowledgeForm>(
  field: K,
  value: BusinessKnowledgeForm[K],
) {
  emit("update:modelValue", { ...props.modelValue, [field]: value })
}

function toggleMetrics(open: boolean) {
  expanded.value = open
  if (expanded.value) emit("loadMetrics")
}
</script>

<template>
  <BaseModal
    :open="open"
    :busy="busy"
    size="lg"
    :title="editing ? '查看与编辑知识' : '新建业务知识'"
    description="填写业务含义、分析方法和需要注意的口径。"
    @update:open="emit('update:open', $event)"
  >
    <form id="business-knowledge-form" class="grid gap-4" novalidate @submit.prevent="emit('save')">
      <div v-if="currentMetric" class="rounded-md bg-muted/40 px-3 py-2 text-sm">
        <span class="text-muted-foreground">当前指标</span>
        <p class="mt-1 break-words font-medium">{{ currentMetric.metric_name }}</p>
      </div>
      <label class="form-field">
        知识标题 <span class="sr-only">必填</span>
        <input
          :value="modelValue.title"
          class="form-control"
          required
          maxlength="200"
          :aria-invalid="
            Boolean(
              error && (!modelValue.title.trim() || [...modelValue.title.trim()].length > 200),
            )
          "
          :aria-describedby="error ? errorId : undefined"
          :disabled="busy"
          @input="updateField('title', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="form-field">
        知识内容 <span class="sr-only">必填</span>
        <textarea
          :value="modelValue.text"
          class="form-control min-h-40 resize-y"
          rows="7"
          required
          maxlength="8000"
          :aria-invalid="
            Boolean(error && (!modelValue.text.trim() || [...modelValue.text.trim()].length > 8000))
          "
          :aria-describedby="error ? errorId : undefined"
          :disabled="busy"
          @input="updateField('text', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <BaseSwitch
        :model-value="modelValue.enabled"
        label="启用这条知识"
        :disabled="busy"
        @update:model-value="updateField('enabled', $event)"
      />
      <BaseDisclosure
        class="rounded-lg border p-3"
        :open="expanded"
        trigger-class="text-sm font-medium"
        content-class="mt-3 space-y-3"
        @update:open="toggleMetrics"
      >
        <template #trigger>
          相关指标（选填）<span
            v-if="modelValue.metric_codes.length"
            class="ml-2 text-muted-foreground"
            >{{ modelValue.metric_codes.length }} 个</span
          >
        </template>
        <template v-if="expanded">
          <p class="text-xs leading-5 text-muted-foreground">
            关联已有指标，便于在指标详情中查看和维护这条知识。
          </p>
          <MetricPicker
            :model-value="modelValue.metric_codes"
            :items="metrics"
            :loading="metricsLoading"
            :error="metricsError"
            :disabled="busy"
            @update:model-value="updateField('metric_codes', $event)"
            @retry="emit('loadMetrics')"
          />
        </template>
      </BaseDisclosure>
      <div class="space-y-1.5">
        <label class="inline-flex items-center gap-2 text-sm font-medium">
          <BaseCheckbox
            :model-value="modelValue.batch_query_enabled ?? false"
            :disabled="busy || (!modelValue.batch_query_enabled && !modelValue.metric_codes.length)"
            @update:model-value="updateField('batch_query_enabled', $event)"
          />
          支持批量取数
        </label>
        <p class="text-xs leading-5 text-muted-foreground">
          适用的分析问题可按关联指标统一取数，机构和日期沿用用户的问题。
          <span v-if="!modelValue.metric_codes.length">请先关联指标。</span>
          <span v-else>每个方案最多关联 24 个指标；未开启时仍按需自主查询。</span>
        </p>
      </div>
      <p
        v-if="modelValue.metric_codes.length"
        class="break-words text-xs leading-5 text-muted-foreground"
      >
        已关联：{{ linkedNames
        }}<template v-if="modelValue.metric_codes.length > 3"
          >等 {{ modelValue.metric_codes.length }} 个指标</template
        >。
        <template v-if="editing">修改内容会同时更新这些指标引用的知识。</template>
        <template v-else-if="hasCurrentMetric">保存后即可在当前指标中查看。</template>
      </p>
      <p v-if="currentMetric && !hasCurrentMetric" class="text-sm leading-6 text-muted-foreground">
        当前未关联「{{ currentMetric.metric_name }}」。保存后不会在当前指标的知识列表中显示。
      </p>
      <BaseAlert v-if="error" :id="errorId" title="保存未完成" variant="destructive">
        {{ error }}
        <BaseButton
          v-if="conflict"
          class="mt-3"
          variant="outline"
          :disabled="busy"
          @click="emit('reload')"
        >
          <RefreshCw />{{ editing ? "放弃本次修改并重新读取" : "重新读取版本并保留输入" }}
        </BaseButton>
      </BaseAlert>
    </form>
    <template #footer>
      <BaseButton variant="outline" :disabled="busy" @click="emit('update:open', false)"
        >取消</BaseButton
      >
      <BaseButton
        type="submit"
        form="business-knowledge-form"
        :disabled="busy || conflict || !modelValue.title.trim() || !modelValue.text.trim()"
      >
        <LoaderCircle v-if="busy" class="animate-spin" />{{
          busy ? "保存中…" : editing ? "保存修改" : hasCurrentMetric ? "保存并关联" : "保存知识"
        }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
