import type { LogRound, LogStatus } from "@/types/queryLogs"

export const logStatusText: Record<LogStatus, string> = {
  success: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  waiting_user: "待确认",
  running: "执行中",
  unknown: "状态未记录",
}
export function logDuration(value: number | null): string {
  return value === null ? "耗时未记录" : `${(value / 1000).toFixed(1)} 秒`
}
export function logDate(value: number | null, timeOnly = false): string {
  if (value === null) return "时间未记录"
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(timeOnly ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    ...(timeOnly ? { second: "2-digit" } : {}),
  }).format(value)
}
export function nextFailedRound(
  rounds: LogRound[],
  currentId: string | null,
): LogRound | undefined {
  const failed = rounds.filter((round) => round.status === "failed")
  const index = failed.findIndex((round) => round.id === currentId)
  return failed[(index + 1) % failed.length]
}
