<script setup lang="ts">
import { Check, LoaderCircle, X } from "@lucide/vue"
import { nextTick, onMounted, ref } from "vue"

import BaseButton from "@/components/ui/BaseButton.vue"

const props = defineProps<{ title: string; busy: boolean; error: string }>()
const emit = defineEmits<{ save: [title: string]; cancel: [] }>()
const draft = ref(props.title)
const input = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await nextTick()
  input.value?.focus()
  input.value?.select()
})

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || props.busy) return
  if (event.key === "Enter") {
    event.preventDefault()
    emit("save", draft.value)
  } else if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    emit("cancel")
  }
}
</script>

<template>
  <div class="min-w-0 flex-1 space-y-1" @keydown="onKeydown">
    <div class="flex min-w-0 items-center gap-1">
      <input
        ref="input"
        v-model="draft"
        aria-label="会话名称"
        :aria-invalid="Boolean(error)"
        :disabled="busy"
        maxlength="255"
        class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
      <BaseButton
        variant="ghost"
        size="icon"
        class="size-7"
        :disabled="busy"
        aria-label="保存会话名称"
        @click="emit('save', draft)"
        ><LoaderCircle v-if="busy" class="animate-spin" /><Check v-else
      /></BaseButton>
      <BaseButton
        variant="ghost"
        size="icon"
        class="size-7"
        :disabled="busy"
        aria-label="取消修改会话名称"
        @click="emit('cancel')"
        ><X
      /></BaseButton>
    </div>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <p v-else class="text-[11px] text-muted-foreground">Enter 保存 · Esc 取消</p>
  </div>
</template>
