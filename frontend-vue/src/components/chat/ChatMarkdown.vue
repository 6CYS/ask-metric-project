<script setup lang="ts">
import { computed, h, type FunctionalComponent, type VNodeChild } from "vue"
import type { Token } from "markdown-it"

import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { parseAssistantMarkdown } from "@/lib/assistantMarkdown"

const props = defineProps<{ source?: string; tokens?: Token[] }>()
const tokens = computed(() => props.tokens ?? parseAssistantMarkdown(props.source ?? ""))

function renderElement(token: Token, children: VNodeChild[]): VNodeChild {
  if (token.hidden) return children
  const attrs = Object.fromEntries(token.attrs ?? [])
  if (token.tag === "a") {
    const { title, ...linkAttrs } = attrs
    const link = () =>
      h("a", { ...linkAttrs, target: "_blank", rel: "noopener noreferrer nofollow" }, children)
    return title ? h(BaseTooltip, { content: String(title) }, { default: link }) : link()
  }
  return h(token.tag, attrs, children)
}

// 复用 Markdown token 结构，让链接接入 Vue 提示组件，避免动态 HTML 绕过公共控件。
function renderTokens(source: readonly Token[]): VNodeChild[] {
  const root: VNodeChild[] = []
  const stack: Array<{ token: Token; children: VNodeChild[] }> = []
  let children = root
  for (const token of source) {
    if (token.nesting === 1) {
      stack.push({ token, children })
      children = []
    } else if (token.nesting === -1) {
      const parent = stack.pop()
      if (parent) {
        const element = renderElement(parent.token, children)
        children = parent.children
        children.push(element)
      }
    } else if (token.type === "inline") {
      children.push(...renderTokens(token.children ?? []))
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      children.push(h("br"), "\n")
    } else if (token.type === "code_inline") {
      children.push(h("code", token.content))
    } else if (token.type === "fence" || token.type === "code_block") {
      const language = token.info.trim().split(/\s+/)[0]
      children.push(
        h("pre", h("code", language ? { class: `language-${language}` } : {}, token.content)),
      )
    } else if (token.type === "image" || !token.tag) {
      children.push(token.content)
    } else {
      children.push(renderElement(token, token.content ? [token.content] : []))
    }
  }
  return root
}

const MarkdownContent: FunctionalComponent<{ tokens: Token[] }> = (input) =>
  renderTokens(input.tokens)
</script>

<template>
  <div class="chat-markdown min-w-0 break-words leading-7">
    <MarkdownContent :tokens="tokens" />
  </div>
</template>

<style scoped>
.chat-markdown {
  font-weight: 400;
}

.chat-markdown :deep(> * + *) {
  margin-top: 0.75rem;
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

.chat-markdown :deep(> h1:not(:first-child)),
.chat-markdown :deep(> h2:not(:first-child)),
.chat-markdown :deep(> h3:not(:first-child)),
.chat-markdown :deep(> h4:not(:first-child)),
.chat-markdown :deep(> h5:not(:first-child)),
.chat-markdown :deep(> h6:not(:first-child)) {
  margin-top: 1.125rem;
}

.chat-markdown :deep(strong) {
  font-weight: 600;
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
