type ConversationDate = string | number | null | undefined

function parseDate(value: ConversationDate): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatConversationDate(value: ConversationDate): string {
  const date = parseDate(value)
  if (!date) return "创建时间未知"
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
