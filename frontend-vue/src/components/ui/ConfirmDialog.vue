<script setup lang="ts">
import { Check, LoaderCircle, Trash2 } from "@lucide/vue"

import BaseModal from "@/components/ui/BaseModal.vue"
import BaseButton from "@/components/ui/BaseButton.vue"

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    busy?: boolean
    confirmLabel?: string
    cancelLabel?: string
    busyLabel?: string
    variant?: "default" | "destructive"
  }>(),
  {
    busy: false,
    confirmLabel: "确认删除",
    cancelLabel: "取消",
    busyLabel: "删除中...",
    variant: "destructive",
  },
)
const emit = defineEmits<{ "update:open": [value: boolean]; confirm: [] }>()
function updateOpen(open: boolean) {
  if (!props.busy) emit("update:open", open)
}
function confirm() {
  if (props.open && !props.busy) emit("confirm")
}
</script>

<template>
  <BaseModal :open="open" :title="title" :busy="busy" size="sm" @update:open="updateOpen">
    <div class="text-sm leading-6 text-muted-foreground"><slot /></div>
    <template #footer>
      <BaseButton variant="outline" :disabled="busy" @click="updateOpen(false)">{{
        cancelLabel
      }}</BaseButton>
      <BaseButton :variant="variant" :disabled="busy" @click="confirm"
        ><LoaderCircle v-if="busy" class="animate-spin" /><Trash2
          v-else-if="confirmLabel === '确认删除'"
        /><Check v-else />{{ busy ? busyLabel : confirmLabel }}</BaseButton
      >
    </template>
  </BaseModal>
</template>
