<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue"
import { LoaderCircle, RefreshCw } from "@lucide/vue"
import MetricPicker from "@/components/metrics/MetricPicker.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import BaseSwitch from "@/components/ui/BaseSwitch.vue"
import { ApiError, createMetricRelationship, updateMetricRelationship } from "@/lib/api"
import { relationPayload, type RelationForm } from "@/lib/metricRelationships"
import type { MetricItem } from "@/types/api"
import type { MetricRelation, MetricRelationWriteResult } from "@/types/metricRelationships"

const props = defineProps<{
  open: boolean
  relation: MetricRelation | null
  parent: string
  revision: string
  metrics: MetricItem[]
}>()
const emit = defineEmits<{
  "update:open": [open: boolean]
  saved: [result: MetricRelationWriteResult]
  refresh: []
  busy: [busy: boolean]
}>()
const blank = (): RelationForm => ({
  kind: "classification",
  parent: [],
  children: [],
  numerator: [],
  denominator: [],
  source: "",
  enabled: false,
})
const form = ref<RelationForm>(blank())
const busy = ref(false)
const error = ref("")
const errorId = useId()
const sourceInput = ref<HTMLTextAreaElement | null>(null)
const conflict = ref(false)
let editRevision = ""
let active = true
const parentCode = computed(() => form.value.parent[0] ?? "")
const parentMetric = computed(() =>
  props.metrics.find((metric) => metric.metric_code === parentCode.value),
)
const relatedMetrics = computed(() =>
  props.metrics.filter((metric) => metric.metric_code !== parentCode.value),
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const relation = props.relation
    form.value = relation
      ? {
          kind: relation.kind,
          parent: [relation.parent],
          children: [...relation.children],
          numerator: relation.kind === "ratio" ? relation.children.slice(0, 1) : [],
          denominator: relation.kind === "ratio" ? relation.children.slice(1, 2) : [],
          source: relation.source,
          enabled: relation.status === "approved",
        }
      : { ...blank(), parent: props.parent ? [props.parent] : [] }
    editRevision = props.revision
    error.value = ""
    conflict.value = false
  },
  { immediate: true },
)

watch(busy, (value) => emit("busy", value), { flush: "sync" })
onBeforeUnmount(() => {
  active = false
  emit("busy", false)
})

function refreshAfterConflict() {
  emit("update:open", false)
  emit("refresh")
}

async function save() {
  if (busy.value || conflict.value) return
  error.value = ""
  try {
    const payload = relationPayload(form.value, editRevision, props.relation?.status)
    busy.value = true
    const result = props.relation
      ? await updateMetricRelationship(props.relation.id, payload)
      : await createMetricRelationship(payload)
    if (!active) return
    emit("saved", result)
    emit("update:open", false)
  } catch (cause) {
    if (!active) return
    conflict.value = cause instanceof ApiError && cause.status === 409
    error.value = conflict.value
      ? "关系已被其他人修改。本次输入已保留，请关闭后刷新，再重新编辑。"
      : cause instanceof Error
        ? cause.message
        : "保存失败，请稍后重试。"
    if (!form.value.source.trim() || form.value.source.length > 2000) {
      await nextTick()
      sourceInput.value?.focus()
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :busy="busy"
    size="lg"
    :title="relation ? '编辑指标关系' : '添加指标关系'"
    description="选择已有指标，说明它们之间的业务关系。"
    @update:open="$emit('update:open', $event)"
  >
    <form id="metric-relation-form" class="grid gap-4" novalidate @submit.prevent="save">
      <label class="form-field"
        >关系类型
        <BaseSelect
          v-model="form.kind"
          :disabled="busy"
          :options="[
            { value: 'classification', label: '分类关系' },
            { value: 'composition', label: '组成关系' },
            { value: 'ratio', label: '占比依赖' },
          ]"
        />
        <span class="field-help">{{
          form.kind === "classification"
            ? "用于业务分类与下钻，不代表分项可以相加。"
            : form.kind === "composition"
              ? "仅在分项互不重复、完整覆盖总量时使用；请在关系说明中写明依据。"
              : "明确占比指标的分子与分母，不改变该指标原有统计口径。"
        }}</span>
      </label>
      <div class="rounded-md bg-muted/40 px-3 py-2">
        <p class="text-xs text-muted-foreground">
          {{ form.kind === "ratio" ? "占比指标" : "主指标" }}
        </p>
        <p class="mt-1 text-sm font-medium">{{ parentMetric?.metric_name || parentCode }}</p>
        <p class="mt-1 break-all text-xs text-muted-foreground">{{ parentCode }}</p>
      </div>
      <template v-if="form.kind === 'ratio'">
        <p class="text-sm text-muted-foreground">
          占比 = 分子指标 ÷ 分母指标 × 100%。请确认选择的是占比关系，不是增长率。
        </p>
        <MetricPicker
          v-model="form.numerator"
          :items="relatedMetrics"
          :max-selections="1"
          :disabled="busy"
          label="分子指标"
        />
        <MetricPicker
          v-model="form.denominator"
          :items="relatedMetrics"
          :max-selections="1"
          :disabled="busy"
          label="分母指标"
        />
      </template>
      <MetricPicker
        v-else
        v-model="form.children"
        :items="relatedMetrics"
        :max-selections="15"
        :disabled="busy"
        label="下级指标"
      />
      <label class="form-field"
        >关系说明<textarea
          ref="sourceInput"
          v-model="form.source"
          class="form-control min-h-24 resize-y"
          rows="3"
          required
          maxlength="2000"
          :aria-invalid="Boolean(error && (!form.source.trim() || form.source.length > 2000))"
          :aria-describedby="error ? errorId : undefined"
          :disabled="busy"
          placeholder="说明分类依据、组成口径或占比公式及使用限制。"
        />
      </label>
      <BaseSwitch v-model="form.enabled" :disabled="busy" label="启用这条关系" />
      <p class="text-xs text-muted-foreground">
        启用后可供问数发现关联指标；实际取数仍以机构、日期和指标口径为准。
      </p>
      <BaseAlert v-if="error" :id="errorId" title="保存未完成" variant="destructive"
        >{{ error
        }}<BaseButton v-if="conflict" variant="outline" class="mt-3" @click="refreshAfterConflict"
          ><RefreshCw />关闭并刷新关系</BaseButton
        ></BaseAlert
      >
    </form>
    <template #footer
      ><BaseButton variant="outline" :disabled="busy" @click="$emit('update:open', false)"
        >取消</BaseButton
      ><BaseButton type="submit" form="metric-relation-form" :disabled="busy || conflict"
        ><LoaderCircle v-if="busy" class="animate-spin" />{{
          busy ? "保存中…" : "保存关系"
        }}</BaseButton
      ></template
    >
  </BaseModal>
</template>
