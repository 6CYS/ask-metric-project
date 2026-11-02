/** 比较精确十进制，不把大额金额转成浮点数；格式与指数范围在这里收敛。 */
function decimal(raw: string): { value: bigint; scale: number } {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(raw);
  if (!match || raw.length > 220) throw new Error("主题事实不是有效十进制数");
  const fraction = match[3] ?? "",
    exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 200 || fraction.length > 200) throw new Error("主题事实精度超出范围");
  const scale = fraction.length - exponent;
  if (Math.abs(scale) > 200) throw new Error("主题事实精度超出范围");
  const value = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`);
  return { value: scale < 0 ? value * 10n ** BigInt(-scale) : value, scale: Math.max(0, scale) };
}
export function compareDecimal(left: string, right: string): number {
  const a = decimal(left),
    b = decimal(right),
    scale = Math.max(a.scale, b.scale);
  const delta = a.value * 10n ** BigInt(scale - a.scale) - b.value * 10n ** BigInt(scale - b.scale);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function changeDirection(value: string): "decrease" | "increase" | "unchanged" {
  const sign = compareDecimal(value, "0");
  return sign < 0 ? "decrease" : sign > 0 ? "increase" : "unchanged";
}
