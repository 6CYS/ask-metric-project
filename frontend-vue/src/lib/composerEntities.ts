import type { BackendNextClarification, SemanticPatch } from "@/types/api"

export type ComposerEntity = { kind: "metric" | "organization"; code: string; name: string; searchText?: string }
export type ComposerAnswer = SemanticPatch & { text?: string; catalog_selection_mode?: "append" }
export type ComposerMention = { entity: ComposerEntity; start: number; end: number }

export function clarificationCatalogKinds(clarification?: BackendNextClarification): ComposerEntity["kind"][] {
  if (!clarification) return []
  const kinds: string[] = (clarification.fields ?? []).map((field) => field.type)
  if (!kinds.length) {
    kinds.push(clarification.type)
    if (clarification.missing?.includes("metrics")) kinds.push("metric")
    if (clarification.missing?.includes("orgs")) kinds.push("organization")
  }
  return [...new Set(kinds.filter((kind): kind is ComposerEntity["kind"] => kind === "metric" || kind === "organization"))]
}

export function consumeCatalogCommand(value: string, cursor: number) {
  const before = value.slice(0, cursor)
  const match = /(?<![/:])\/(指标|机构)$/.exec(before)
  if (!match) return null
  const start = cursor - match[1]!.length - 1
  return { kind: match[1] === "指标" ? "metric" as const : "organization" as const, value: value.slice(0, start) + value.slice(cursor), cursor: start }
}

export function entityKey(entity: ComposerEntity) { return `${entity.kind}:${entity.code}` }

export function composeQuestion(text: string, entities: ComposerEntity[]) {
  return [...entities.filter((entity) => !text.includes(entity.name)).map((entity) => entity.name), text.trim()].filter(Boolean).join("，")
}

// Keep catalog identities only while the inserted text itself remains unedited.
export function updateComposerMentions(previous: string, next: string, mentions: ComposerMention[]) {
  if (previous === next) return mentions
  let start = 0
  while (start < Math.min(previous.length, next.length) && previous[start] === next[start]) start++
  let oldEnd = previous.length, newEnd = next.length
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd-- }
  const delta = next.length - previous.length
  return mentions.flatMap((mention) => {
    if (mention.end <= start) return [mention]
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    return []
  }).filter((mention) => next.slice(mention.start, mention.end) === mention.entity.name)
}

export function insertComposerEntity(text: string, cursor: number, entity: ComposerEntity, mentions: ComposerMention[]) {
  const existing = mentions.find((mention) => entityKey(mention.entity) === entityKey(entity))
  if (existing) return { text, cursor: existing.end, mentions }
  const position = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, position), after = text.slice(position)
  const prefix = before && !/[\s，、。！？：；]$/.test(before) ? " " : ""
  const suffix = after && !/^[\s，、。！？：；]/.test(after) ? " " : ""
  const start = position + prefix.length, end = start + entity.name.length
  const next = before + prefix + entity.name + suffix + after
  return { text: next, cursor: end + suffix.length, mentions: [...updateComposerMentions(text, next, mentions), { entity, start, end }] }
}

export function composeClarification(text: string, entities: ComposerEntity[], clarification: BackendNextClarification): ComposerAnswer | string {
  if (!entities.length) return text.trim()
  if (clarification.type !== "semantic_slots") return composeQuestion(text, entities)
  const set: Record<string, unknown> = {}
  const metrics = entities.filter((entity) => entity.kind === "metric").map(({ code, name }) => ({ code, name }))
  const orgs = entities.filter((entity) => entity.kind === "organization").map(({ name }) => name)
  for (const field of clarification.fields ?? []) {
    for (const option of field.preserved_options ?? []) {
      if (typeof option === "string") continue
      if (field.type === "metric" && metrics.length) {
        const code = option.metric_code ?? option.code
        const name = option.metric_name ?? option.name
        if (code && name) metrics.push({ code, name })
      }
      if (field.type === "organization" && orgs.length && (option.org_name ?? option.name)) orgs.push((option.org_name ?? option.name)!)
    }
  }
  if (metrics.length) set.metrics = [...new Map(metrics.map((metric) => [metric.code, metric])).values()]
  if (orgs.length) set.orgs = [...new Set(orgs)]
  const remainder = entities.reduce((value, entity) => value.split(entity.name).join(" "), text).replace(/\s+/g, " ").trim()
  return { set, add_ops: [], remove_ops: [], text: remainder, catalog_selection_mode: "append" }
}
