import type { BusinessKnowledgePayload } from "@/types/api"

export type BusinessKnowledgeForm = Omit<BusinessKnowledgePayload, "revision" | "metric_codes"> & {
  metric_codes: string[]
}

export function knowledgePayload(
  form: Omit<BusinessKnowledgePayload, "revision">,
  revision: string,
): BusinessKnowledgePayload {
  const text = (value: string, label: string, max: number) => {
    const trimmed = value.trim()
    if (!trimmed) throw new Error(`请填写${label}。`)
    if ([...trimmed].length > max) throw new Error(`${label}不能超过 ${max} 字。`)
    return trimmed
  }
  const title = text(form.title, "标题", 200)
  const content = text(form.text, "知识内容", 8000)
  if (!revision) throw new Error("请先重新读取业务知识，再保存。")
  const codes = [...new Set((form.metric_codes ?? []).map((code) => code.trim()).filter(Boolean))]
  if (form.batch_query_enabled && (codes.length < 1 || codes.length > 24))
    throw new Error("支持批量取数时，请关联 1 至 24 个指标。")
  return {
    title,
    text: content,
    enabled: form.enabled,
    revision,
    ...(form.batch_query_enabled !== undefined
      ? { batch_query_enabled: form.batch_query_enabled }
      : {}),
    metric_codes: codes,
  }
}
