export const businessChartColors = [
  "#263F59",
  "#365B58",
  "#244A73",
  "#365A70",
  "#365C4D",
  "#3A6068",
  "#2A665F",
  "#4B6175",
  "#496C66",
] as const

export const businessChartTextColor = "#64748B"
export const businessChartGridColor = "#E2E8F0"
export const businessChartTextStyle = {
  fontFamily: '"Microsoft YaHei", sans-serif',
  color: businessChartTextColor,
}

/** 沿用正式展示名称的映射，图形切换和机构重排不改变颜色。 */
export function organizationColor(name: string): string {
  let hash = 2166136261
  for (const character of name)
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619) >>> 0
  return businessChartColors[hash % businessChartColors.length] ?? businessChartColors[0]
}
