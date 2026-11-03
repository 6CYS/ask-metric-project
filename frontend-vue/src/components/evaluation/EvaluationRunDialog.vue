<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { datasetTurnCount } from "@/lib/evaluation"
import type { EvaluationDataset, RunInput } from "@/types/evaluation"
const props = defineProps<{
  open: boolean
  datasets: EvaluationDataset[]
  initialDatasetId: string
  busy: boolean
  error: string
  blocked: boolean
}>()
const emit = defineEmits<{ "update:open": [value: boolean]; start: [input: RunInput] }>()
const datasetOptions = computed(() =>
  props.datasets.map((item) => ({
    value: item.id,
    label: `${item.name} · v${item.version}`,
  })),
)
const datasetId = ref("")
const name = ref("")
const versionLabel = ref("")
const dataLabel = ref("")
const validationError = ref("")
const errorId = useId()
const runForm = ref<HTMLFormElement | null>(null)
const dataset = computed(() => props.datasets.find((item) => item.id === datasetId.value))
watch(
  () => props.open,
  (open) => {
    if (!open) return
    datasetId.value = props.initialDatasetId || props.datasets[0]?.id || ""
    name.value = ""
    versionLabel.value = ""
    dataLabel.value = ""
    validationError.value = ""
  },
)
async function start() {
  if (props.busy || props.blocked) return
  validationError.value = !dataset.value
    ? "请选择问题集。"
    : !name.value.trim()
      ? "请填写批次名称。"
      : name.value.length > 120
        ? "批次名称不能超过 120 字。"
        : versionLabel.value.length > 200
          ? "待测版本说明不能超过 200 字。"
          : dataLabel.value.length > 1000
            ? "数据条件说明不能超过 1000 字。"
            : ""
  if (validationError.value) {
    await nextTick()
    runForm.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }
  if (!dataset.value) return
  emit("start", {
    dataset_id: dataset.value.id,
    dataset_version: dataset.value.version,
    name: name.value.trim(),
    version_label: versionLabel.value.trim(),
    data_label: dataLabel.value.trim(),
  })
}
</script>
<template>
  <BaseModal
    :open="open"
    :busy="busy"
    title="发起测评"
    description="组内串行追问，组间创建新会话。每次发起都会生成新批次和新会话。"
    @update:open="emit('update:open', $event)"
  >
    <form
      id="evaluation-run-form"
      ref="runForm"
      class="space-y-4"
      novalidate
      @submit.prevent="start"
    >
      <BaseAlert
        v-if="validationError || error"
        :id="errorId"
        title="批次未能发起"
        variant="destructive"
        >{{ validationError || error }}</BaseAlert
      >
      <BaseAlert v-if="blocked" title="已有执行中的批次"
        >请等待当前批次结束，或先停止当前批次。</BaseAlert
      >
      <label class="form-field"
        >问题集<BaseSelect
          name="datasetId"
          v-model="datasetId"
          :options="datasetOptions"
          :disabled="busy"
          placeholder="选择问题集"
          aria-label="问题集"
          :aria-invalid="Boolean(validationError && !dataset)"
          :aria-describedby="validationError ? errorId : undefined"
          required
      /></label>
      <p v-if="dataset" class="evaluation-note">
        冻结 v{{ dataset.version }} · {{ dataset.groups.length }} 组 ·
        {{ datasetTurnCount(dataset) }} 轮；当前编辑中的未保存修改不会进入本次测评。
      </p>
      <label class="form-field"
        >批次名称<input
          v-model="name"
          class="form-control"
          maxlength="120"
          :aria-invalid="Boolean(validationError && (!name.trim() || name.length > 120))"
          :aria-describedby="validationError ? errorId : undefined"
          required
          :disabled="busy"
      /></label>
      <label class="form-field"
        >待测版本说明<input
          v-model="versionLabel"
          class="form-control"
          maxlength="200"
          :aria-invalid="Boolean(validationError && versionLabel.length > 200)"
          :aria-describedby="validationError ? errorId : undefined"
          :disabled="busy"
          placeholder="人工登记当前待测版本或改动说明（选填）"
      /></label>
      <label class="form-field"
        >数据条件说明<textarea
          v-model="dataLabel"
          class="form-control resize-y py-2 leading-6"
          rows="2"
          maxlength="1000"
          :aria-invalid="Boolean(validationError && dataLabel.length > 1000)"
          :aria-describedby="validationError ? errorId : undefined"
          :disabled="busy"
          placeholder="人工登记测试期间、数据环境等条件（选填）"
        />
      </label>
      <p class="evaluation-note">
        数据条件是人工说明，不是数据库快照。使用当前登录账号及服务当前模型配置，批次会记录实际模型和配置摘要。
      </p>
      <p class="evaluation-note">
        本次将访问真实问数链路并消耗模型资源。执行结束后仍需逐题人工复核。
      </p>
    </form>
    <template #footer
      ><BaseButton variant="outline" :disabled="busy" @click="emit('update:open', false)"
        >取消</BaseButton
      ><BaseButton
        type="submit"
        form="evaluation-run-form"
        :disabled="busy || blocked || !dataset || !name.trim()"
        >{{ busy ? "正在发起…" : "开始测评" }}</BaseButton
      ></template
    >
  </BaseModal>
</template>
