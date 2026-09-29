import type { ClarificationChoiceSet } from "@/lib/agentApi"

/** 解析待确认回执中的规范清单；只认服务端给出的结构，不从正文猜测。 */
export function asChoiceSet(details: unknown): ClarificationChoiceSet | undefined {
  const value = details as (Partial<ClarificationChoiceSet> & { kind?: string; status?: string }) | null | undefined
  if (value?.kind !== "business_context" || value.status !== "NEEDS_CLARIFICATION") return undefined
  if (typeof value.frame_id !== "string" || !Array.isArray(value.options) || !value.options.length
    || typeof value.listing !== "string") return undefined
  return { frame_id: value.frame_id, options: value.options, listing: value.listing,
    confirmation_unclear: value.confirmation_unclear === true }
}

/** 正文末尾与回执逐字一致的清单改为可点选展示，避免同一份清单显示两遍。 */
export function withoutListing(content: string, choices: ClarificationChoiceSet | undefined): string {
  const listing = choices?.listing
  if (!listing || !content.endsWith(listing)) return content
  return content.slice(0, -listing.length).trimEnd()
}
