import { buildClarificationSelection } from "@/lib/clarificationSelection"
import { clarificationDisplayField } from "@/lib/clarificationOptions"
import { clarificationTranscript } from "@/lib/conversationMessages"
import type { BackendNextClarification, SemanticPatch } from "@/types/api"

export type InlineClarificationPart = {
  text: string
  patch?: SemanticPatch & { catalog_selection_mode: "append" }
}

/** Only structured, uniquely named candidates can become inline confirmation controls. */
export function clarificationInlineParts(clarification: BackendNextClarification): InlineClarificationPart[] {
  const message = clarificationTranscript(clarification)
  const choices = new Map<string, InlineClarificationPart["patch"]>()
  for (const field of (clarification.fields ?? []).map(clarificationDisplayField)) {
    if (field.type !== "metric" && field.type !== "organization") continue
    for (const option of field.options) {
      if (typeof option === "string") continue
      const name = (option.display_label ?? (field.type === "metric" ? option.metric_name ?? option.name : option.org_name ?? option.name))?.trim()
      const patch = buildClarificationSelection(field, [option])
      if (!name || !patch) continue
      const next = { ...patch, catalog_selection_mode: "append" as const }
      const originalName = field.type === "metric" ? option.metric_name ?? option.name : option.org_name ?? option.name
      if (option.display_label && originalName && option.display_label !== originalName) choices.set(originalName, undefined)
      // Same displayed name with different identities must not silently select one.
      if (!choices.has(name)) choices.set(name, next)
      else if (JSON.stringify(choices.get(name)) !== JSON.stringify(next)) choices.set(name, undefined)
    }
  }
  const names = [...choices.keys()].sort((a, b) => b.length - a.length)
  const parts: InlineClarificationPart[] = []
  let cursor = 0, plainStart = 0
  while (cursor < message.length) {
    const name = names.find((candidate) => message.startsWith(candidate, cursor))
    if (!name) { cursor++; continue }
    if (cursor > plainStart) parts.push({ text: message.slice(plainStart, cursor) })
    parts.push({ text: name, patch: choices.get(name) })
    cursor += name.length
    plainStart = cursor
  }
  if (plainStart < message.length) parts.push({ text: message.slice(plainStart) })
  return parts
}
