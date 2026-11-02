<script setup lang="ts">
import { LoaderCircle, Trash2 } from "@lucide/vue"

import BaseModal from "@/components/ui/BaseModal.vue"
import BaseButton from "@/components/ui/BaseButton.vue"

defineProps<{ open: boolean; title: string; busy?: boolean }>()
const emit = defineEmits<{ "update:open": [value: boolean]; confirm: [] }>()
</script>

<template>
  <BaseModal :open="open" :title="title" :busy="busy" size="sm" @update:open="emit('update:open', $event)">
    <div class="text-sm leading-6 text-muted-foreground"><slot /></div>
    <template #footer>
      <BaseButton variant="outline" :disabled="busy" @click="emit('update:open', false)">取消</BaseButton>
      <BaseButton variant="destructive" :disabled="busy" @click="emit('confirm')"><LoaderCircle v-if="busy" class="animate-spin" /><Trash2 v-else />{{ busy ? "删除中..." : "确认删除" }}</BaseButton>
    </template>
  </BaseModal>
</template>
