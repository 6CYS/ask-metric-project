<script setup lang="ts">
import { ref } from "vue"
import { Maximize2 } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"

const props = defineProps<{ label: string; text: string; loadText?: () => Promise<string> }>()
const open = ref(false)
const fullText = ref("")
const loading = ref(false)
const error = ref("")

async function loadFullText() {
  if (!props.loadText || fullText.value || loading.value) return
  loading.value = true
  error.value = ""
  try {
    fullText.value = await props.loadText()
  } catch {
    error.value = "完整信息加载失败，请点击展开按钮重试。"
  } finally {
    loading.value = false
  }
}

function expand() {
  open.value = true
  void loadFullText()
}
</script>

<template>
  <div class="flex items-start gap-1" @mouseenter="loadFullText" @focusin="loadFullText">
    <span class="min-w-0 flex-1 line-clamp-2 whitespace-pre-line [overflow-wrap:anywhere]" :title="fullText || (loadText ? (error || '悬停加载完整信息，也可点击展开查看') : text)">{{ text }}</span>
    <BaseButton variant="ghost" size="icon" class="size-6 shrink-0 text-muted-foreground" :title="`查看完整${label}`" :aria-label="`查看完整${label}`" @click="expand">
      <Maximize2 class="size-3.5" />
    </BaseButton>
    <BaseModal v-model:open="open" :title="label" size="lg">
      <p v-if="loading" class="text-sm text-muted-foreground">正在加载完整信息…</p>
      <p v-else-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-else class="select-text whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">{{ fullText || text }}</p>
    </BaseModal>
  </div>
</template>
