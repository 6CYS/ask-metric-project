<script setup lang="ts">
import { computed } from "vue"
import { LoaderCircle, Send } from "@lucide/vue"

import BaseButton from "@/components/ui/BaseButton.vue"

const QUESTION_MAX_LENGTH = 1000
const QUESTION_LENGTH_WARNING_THRESHOLD = 900

const props = withDefaults(defineProps<{
  modelValue: string
  examples?: string[]
  placeholder?: string
  isSubmitting?: boolean
  variant?: "hero" | "chat"
}>(), {
  examples: () => [],
  placeholder: "输入自然语言问题",
  isSubmitting: false,
  variant: "hero",
})

const emit = defineEmits<{
  "update:modelValue": [value: string]
  submit: [value: string]
}>()

const trimmedValue = computed(() => props.modelValue.trim())
const questionLength = computed(() => props.modelValue.length)
const isTooLong = computed(() => questionLength.value > QUESTION_MAX_LENGTH)
const showLengthStatus = computed(() => questionLength.value >= QUESTION_LENGTH_WARNING_THRESHOLD)
const lengthStatus = computed(() => isTooLong.value
  ? `问题最多输入 ${QUESTION_MAX_LENGTH} 个字符，已超出 ${questionLength.value - QUESTION_MAX_LENGTH} 个字符。`
  : `${questionLength.value}/${QUESTION_MAX_LENGTH}`)

function submit() {
  if (trimmedValue.value && !isTooLong.value && !props.isSubmitting) emit("submit", trimmedValue.value)
}

/** 中文输入法确认候选词也会触发 Enter，组合输入期间不能误提交表单。 */
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}
</script>

<template>
  <form
    class="w-full"
    :class="variant === 'hero' && 'rounded-lg border bg-background shadow-[0_18px_60px_rgba(15,23,42,0.08)] transition-shadow focus-within:shadow-[0_22px_70px_rgba(15,23,42,0.12)]'"
    @submit.prevent="submit"
  >
    <div class="flex w-full items-end gap-2" :class="variant === 'hero' ? 'p-2.5 sm:p-3' : 'mx-auto max-w-4xl'">
      <textarea
        :value="modelValue"
        :placeholder="placeholder"
        :rows="variant === 'hero' ? 2 : 1"
        aria-label="指标问题"
        :aria-describedby="showLengthStatus ? 'question-length-status' : undefined"
        :aria-invalid="isTooLong"
        class="min-w-0 flex-1 resize-none rounded-lg border bg-background px-3 py-3 text-[15px] leading-6 outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30"
        :class="[
          variant === 'hero' ? 'max-h-48 min-h-24 border-transparent focus:border-transparent focus:ring-0' : 'max-h-36 min-h-12 border-border',
          isTooLong && 'border-destructive focus:border-destructive focus:ring-destructive/20',
        ]"
        :disabled="isSubmitting"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="handleKeydown"
      />
      <BaseButton type="submit" size="icon" class="size-12" :variant="variant === 'hero' ? 'default' : 'secondary'" :class="variant === 'hero' ? 'border-primary' : 'border-border bg-input'" :disabled="!trimmedValue || isTooLong || isSubmitting" title="发送">
        <LoaderCircle v-if="isSubmitting" class="size-5 animate-spin" />
        <Send v-else class="size-5" />
        <span class="sr-only">发送</span>
      </BaseButton>
    </div>
    <div
      v-if="showLengthStatus"
      id="question-length-status"
      class="px-3 pb-2 text-right text-xs"
      :class="isTooLong ? 'text-destructive' : 'text-muted-foreground'"
      role="status"
    >
      {{ lengthStatus }}
    </div>
    <div v-if="variant === 'hero' && examples.length" class="flex flex-wrap gap-2 border-t px-3 py-3 sm:px-4">
      <BaseButton
        v-for="example in examples"
        :key="example"
        variant="ghost"
        size="sm"
        class="h-auto min-h-7 rounded-md border border-transparent px-2.5 py-1 text-left text-xs whitespace-normal text-muted-foreground hover:border-border"
        @click="emit('update:modelValue', example)"
      >
        {{ example }}
      </BaseButton>
    </div>
  </form>
</template>
