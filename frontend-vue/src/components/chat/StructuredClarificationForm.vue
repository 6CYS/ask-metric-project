<script setup lang="ts">
import { computed } from "vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { formatClarificationOption, getClarificationOptionValue } from "@/lib/clarificationOptions"
import { buildClarificationSelection } from "@/lib/clarificationSelection"
import { clarificationInlineParts, type InlineClarificationPart } from "@/lib/clarificationInlineText"
import type { BackendNextClarification, ClarificationField, ClarificationOption, SemanticPatch } from "@/types/api"

const props = defineProps<{ clarification: BackendNextClarification; disabled?: boolean }>()
const emit = defineEmits<{ submit: [patch: SemanticPatch, label: string] }>()
const fields = computed(() => props.clarification.fields ?? [])
const catalogKinds = computed(() => [...new Set(fields.value.filter((field) => field.type === "metric" || field.type === "organization").map((field) => field.type === "metric" ? "指标" : "机构"))])
const messageParts = computed(() => clarificationInlineParts(props.clarification))
const hasInlineChoices = computed(() => messageParts.value.some((part) => part.patch))
function selectInline(part: InlineClarificationPart) {
  if (part.patch && !props.disabled) emit("submit", part.patch, part.text)
}
function selectResult(field: ClarificationField, option: ClarificationOption) {
  const patch = buildClarificationSelection(field, [option])
  if (patch && !props.disabled) emit("submit", patch, formatClarificationOption(option))
}
</script>

<template>
  <section class="space-y-1 text-sm leading-7">
    <p class="whitespace-pre-line"><template v-for="(part, index) in messageParts" :key="index"><button v-if="part.patch" type="button" class="inline cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left text-inherit transition-colors hover:bg-[#EEF4FA] hover:text-[#365F82] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#52789C] disabled:cursor-wait disabled:opacity-60" :disabled="disabled" :aria-label="`使用${part.text}澄清`" title="点击确认此候选项" @click="selectInline(part)">{{ part.text }}</button><template v-else>{{ part.text }}</template></template></p>
    <p class="text-muted-foreground"><template v-if="hasInlineChoices">可点击上方候选名称确认，也可在下方输入框补充。</template><template v-else>请在下方输入框直接补充。</template><template v-if="catalogKinds.length">可在输入框旁的选择面板添加多项，一起发送；也支持<template v-for="(kind, index) in catalogKinds" :key="kind">{{ index ? '、' : '' }}“/{{ kind }}”</template>快捷搜索。</template></p>
    <template v-for="field in fields.filter((item) => item.type === 'result')" :key="field.field">
      <div class="flex flex-wrap gap-2 py-1"><BaseButton v-for="option in field.options" :key="getClarificationOptionValue(option)" variant="ghost" class="h-auto whitespace-normal text-left" :disabled="disabled" @click="selectResult(field, option)">{{ formatClarificationOption(option) }}</BaseButton></div>
    </template>
  </section>
</template>
