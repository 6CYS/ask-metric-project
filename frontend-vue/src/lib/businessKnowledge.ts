import type { BusinessKnowledgePayload } from "@/types/api"

export type BusinessKnowledgeForm = Omit<BusinessKnowledgePayload, "revision">

export function knowledgePayload(form: BusinessKnowledgeForm, revision: string): BusinessKnowledgePayload {
  const text = (value: string, label: string, max: number) => {
    const trimmed = value.trim()
    if (!trimmed) throw new Error(`请填写${label}。`)
    if ([...trimmed].length > max) throw new Error(`${label}不能超过 ${max} 字。`)
    return trimmed
  }
  const title = text(form.title, "标题", 200)
  const content = text(form.text, "知识内容", 8000)
  if (!revision) throw new Error("请先重新读取业务知识，再保存。")
  return { title, text: content, enabled: form.enabled, revision }
}
