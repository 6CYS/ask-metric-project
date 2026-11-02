export const RESULT_PAGE_SIZE_OPTIONS = [10, 20, 50] as const

export function resultTotalPages(totalItems: number, pageSize: number) {
  return Math.max(1, Math.ceil(Math.max(0, totalItems) / normalizePageSize(pageSize)))
}

export function clampResultPage(page: number, totalItems: number, pageSize: number) {
  return Math.min(Math.max(1, Math.trunc(page) || 1), resultTotalPages(totalItems, pageSize))
}

export function paginateResultRows<T>(rows: T[], page: number, pageSize: number) {
  const normalizedSize = normalizePageSize(pageSize)
  const normalizedPage = clampResultPage(page, rows.length, normalizedSize)
  const start = (normalizedPage - 1) * normalizedSize
  return rows.slice(start, start + normalizedSize)
}

function normalizePageSize(pageSize: number) {
  return RESULT_PAGE_SIZE_OPTIONS.includes(pageSize as 10 | 20 | 50) ? pageSize : 10
}
