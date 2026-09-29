<script setup lang="ts">
import { computed } from "vue"

import { renderAssistantHtml } from "@/lib/assistantMarkdown"

const props = defineProps<{ source: string }>()
const html = computed(() => renderAssistantHtml(props.source))
</script>

<template>
  <!-- 渲染输出经 markdown-it html:false 转义，不含原始 HTML；样式只收敛排版，不改写内容 -->
  <div class="chat-markdown min-w-0 break-words leading-7" v-html="html" />
</template>

<style scoped>
.chat-markdown :deep(> * + *) {
  margin-top: 0.375rem;
}

.chat-markdown :deep(h1),
.chat-markdown :deep(h2),
.chat-markdown :deep(h3),
.chat-markdown :deep(h4),
.chat-markdown :deep(h5),
.chat-markdown :deep(h6) {
  font-weight: 600;
  line-height: 1.5;
}

.chat-markdown :deep(h1),
.chat-markdown :deep(h2) {
  font-size: 1.05rem;
}

.chat-markdown :deep(ul) {
  list-style: disc;
  padding-inline-start: 1.5rem;
}

.chat-markdown :deep(ol) {
  list-style: decimal;
  padding-inline-start: 1.5rem;
}

.chat-markdown :deep(li + li) {
  margin-top: 0.25rem;
}

.chat-markdown :deep(li > ul),
.chat-markdown :deep(li > ol) {
  margin-top: 0.25rem;
}

.chat-markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.chat-markdown :deep(th),
.chat-markdown :deep(td) {
  border: 1px solid var(--border);
  padding: 0.375rem 0.75rem;
  text-align: left;
  white-space: nowrap;
}

.chat-markdown :deep(thead th) {
  background-color: color-mix(in oklab, var(--muted) 60%, transparent);
  font-weight: 500;
}

.chat-markdown :deep(tbody tr:hover) {
  background-color: color-mix(in oklab, var(--muted) 40%, transparent);
}

.chat-markdown :deep(code) {
  border-radius: 0.25rem;
  background-color: var(--muted);
  padding: 0.125rem 0.375rem;
  font-size: 0.875em;
}

.chat-markdown :deep(pre) {
  overflow-x: auto;
  border-radius: 0.375rem;
  background-color: var(--muted);
  padding: 0.75rem;
  font-size: 0.875rem;
  line-height: 1.6;
}

.chat-markdown :deep(pre code) {
  background-color: transparent;
  padding: 0;
}

.chat-markdown :deep(a) {
  color: #52789c;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.chat-markdown :deep(blockquote) {
  border-inline-start: 3px solid var(--border);
  padding-inline-start: 0.75rem;
  color: var(--muted-foreground);
}

.chat-markdown :deep(hr) {
  border-top: 1px solid var(--border);
  margin: 0.75rem 0;
}
</style>
