<script setup lang="ts">
import { computed, useId } from "vue"
import { LoaderCircle, RefreshCw } from "@lucide/vue"

import MetricPicker from "@/components/metrics/MetricPicker.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import { useKnowledgeEditorState } from "@/composables/useKnowledgeEditorState"
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
    resetKey?: number
  }>(),
  {
    editing: false,
    busy: false,
    conflict: false,
    error: "",
    metricsLoading: false,
    metricsError: "",
    resetKey: 0,
  },
)
const emit = defineEmits<{
  "update:open": [open: boolean]
  "update:modelValue": [form: BusinessKnowledgeForm]
  save: []
  reload: []
  loadMetrics: []
}>()
const isPlan = computed(() => props.modelValue.batch_query_enabled === true)
const { expanded, discardOpen, requestClose, discard, toggleMetrics } = useKnowledgeEditorState(
  props,
  () => emit("update:open", false),
  () => emit("loadMetrics"),
)
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

function updateField<K extends keyof BusinessKnowledgeForm>(
  field: K,
  value: BusinessKnowledgeForm[K],
) {
  emit("update:modelValue", { ...props.modelValue, [field]: value })
}
</script>

<template>
  <BaseModal
    :open="open"
    :busy="busy"
    size="lg"
    :title="
      isPlan
        ? editing
          ? '编辑查询方案'
          : '新建查询方案'
        : editing
          ? '编辑业务知识'
          : '新建业务知识'
    "
    :description="
      isPlan
        ? '说明方案适用的问题，并选择需要查询的正式指标。'
        : '填写业务含义、分析方法和需要注意的口径。'
    "
    @update:open="requestClose"
  >
    <form id="business-knowledge-form" class="grid gap-4" novalidate @submit.prevent="emit('save')">
      <div v-if="currentMetric" class="rounded-md bg-muted/40 px-3 py-2 text-sm">
        <span class="text-muted-foreground">当前指标</span>
        <p class="mt-1 break-words font-medium">{{ currentMetric.metric_name }}</p>
      </div>
      <label class="form-field">
        {{ isPlan ? "方案名称" : "知识标题" }} <span class="sr-only">必填</span>
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
        {{ isPlan ? "适用场景与查询说明" : "知识内容" }} <span class="sr-only">必填</span>
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
        :label="isPlan ? '启用这个方案' : '启用这条知识'"
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
          {{ isPlan ? "查询指标（必选，1～24 个）" : "相关指标（选填）"
          }}<span
            v-if="isPlan || modelValue.metric_codes.length"
            class="ml-2 text-muted-foreground"
            >{{
              isPlan
                ? `已选 ${modelValue.metric_codes.length}/24`
                : `${modelValue.metric_codes.length} 个`
            }}</span
          >
        </template>
        <template v-if="expanded">
          <p class="text-xs leading-5 text-muted-foreground">
            {{
              isPlan
                ? "选择方案需要查询的正式指标，机构和日期沿用用户的问题。"
                : "帮助匹配相关知识，并在指标详情中展示；不代表必须查询这些指标。"
            }}
          </p>
          <MetricPicker
            :model-value="modelValue.metric_codes"
            :items="metrics"
            :loading="metricsLoading"
            :error="metricsError"
            :disabled="busy"
            :max-selections="isPlan ? 24 : undefined"
            @update:model-value="updateField('metric_codes', $event)"
            @retry="emit('loadMetrics')"
          />
        </template>
      </BaseDisclosure>
      <p v-if="isPlan" class="text-xs leading-5 text-muted-foreground">
        <template v-if="!modelValue.metric_codes.length">请至少选择 1 个查询指标后保存。</template>
        <template v-else-if="modelValue.metric_codes.length > 24"
          >当前已选 {{ modelValue.metric_codes.length }} 个指标，请移除至 24
          个以内后保存。</template
        >
        <template v-else-if="modelValue.metric_codes.length === 24"
          >已选满 24 个指标，如需更换请先移除已选项。</template
        >
        <template v-else
          >已选 {{ modelValue.metric_codes.length }}/24 个指标，可继续添加或移除。</template
        >
      </p>
      <p
        v-if="modelValue.metric_codes.length"
        class="break-words text-xs leading-5 text-muted-foreground"
      >
        {{ isPlan ? "查询指标：" : "已关联：" }}{{ linkedNames
        }}<template v-if="modelValue.metric_codes.length > 3"
          >等 {{ modelValue.metric_codes.length }} 个指标</template
        >。
        <template v-if="editing">{{
          isPlan
            ? "修改内容会更新这些指标关联的查询方案。"
            : "修改内容会同时更新这些指标引用的知识。"
        }}</template>
        <template v-else-if="hasCurrentMetric">保存后即可在当前指标中查看。</template>
      </p>
      <p v-if="currentMetric && !hasCurrentMetric" class="text-sm leading-6 text-muted-foreground">
        当前未关联「{{ currentMetric.metric_name }}」。{{
          isPlan
            ? "保存后不会在当前指标的关联列表中显示此方案。"
            : "保存后不会在当前指标的知识列表中显示。"
        }}
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
      <BaseButton variant="outline" :disabled="busy" @click="requestClose(false)">取消</BaseButton>
      <BaseButton
        type="submit"
        form="business-knowledge-form"
        :disabled="
          busy ||
          conflict ||
          !modelValue.title.trim() ||
          !modelValue.text.trim() ||
          (isPlan && (modelValue.metric_codes.length < 1 || modelValue.metric_codes.length > 24))
        "
      >
        <LoaderCircle v-if="busy" class="animate-spin" />{{
          busy
            ? "保存中…"
            : isPlan
              ? "保存方案"
              : editing
                ? "保存修改"
                : hasCurrentMetric
                  ? "保存并关联"
                  : "保存知识"
        }}
      </BaseButton>
    </template>
  </BaseModal>
  <ConfirmDialog
    v-model:open="discardOpen"
    title="放弃未保存的修改？"
    confirm-label="放弃修改"
    cancel-label="继续编辑"
    :busy="busy"
    @confirm="discard"
  >
    本次修改尚未保存，放弃后将无法恢复。
  </ConfirmDialog>
</template>
