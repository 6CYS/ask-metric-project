import type {ResolvedField} from "./types.js";
import {BusinessInputError} from "./inputError.js";

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").replace(/月份/gu, "月").replace(/月末$/u, "月");

/** 列举的比较基期不改变观测期间，例如“和上个月、去年同期相比”。 */
function withoutComparisonPeriods(text: string): string {
  const period = "(?:上个?月|上月|上年同期|去年同期|年初|上季度|上季)";
  const periods = `${period}(?:\\s*[、，,和与及]\\s*${period})*`;
  return text.normalize("NFKC")
    .replace(new RegExp(`(?:和|与|跟)\\s*${periods}\\s*(?:相比|比较|对比|比(?=[呢吗呀啊？?，,。.!！\\s]|$))`, "gu"), "")
    .replace(new RegExp(`(?:较|相比于?|对比于?|比)\\s*${periods}`, "gu"), "")
    .replace(new RegExp(`${periods}\\s*(?:相比|比较|对比)`, "gu"), "");
}

export function comparisonPeriodsOnly(text: string): boolean {
  return withoutComparisonPeriods(text) !== text.normalize("NFKC") && !overviewTimeExpression(text);
}

/** 先抽取完整期间，再抽取单点，避免模型截取区间端点、补年份或遗漏日期。 */
export function overviewTimeExpression(text: string): string | undefined {
  const month = "(?:1[0-2]|0?[1-9]|[一二三四五六七八九十]{1,3})月份?(?:末|底)?";
  const year = "(?:\\d{4}年|今年|去年|前年|上年|本年)?";
  // 比较基期不是目标期间；“最近…和上个月相比”仍按最近实际覆盖取当前值。
  const value = withoutComparisonPeriods(text);
  return value.match(new RegExp(`${year}${month}\\s*(?:至|到|~|～|-)\\s*${year}${month}`, "u"))?.[0]
    ?? value.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*(?:至|到|~|～)\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/u)?.[0]
    ?? value.match(/(?:最近|过去|近)\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:个?月|天)/u)?.[0]
    ?? value.match(/\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|(?:\d{4}年|今年|去年|前年|上年|本年)?(?:1[0-2]|0?[1-9]|[一二三四五六七八九十]{1,3})月份?(?:\d{1,2}日|末|底)?|本月|这个月|当月|当前月|上个月(?:末|底)?|上月(?:末|底)?|今天|今日|昨天|(?:今年|去年|前年|本年)?(?:第?[一二三四1-4]季度|[上下]半年)|本季度|上季度|今年|去年/u)?.[0]
    ?? recentOverviewExpression(value);
}

/** 无界“最近”选最近记录；“最近三个月”等有界期间仍走原日期解析，不偷换成一个截至日。 */
export function recentOverviewExpression(text: string): string | undefined {
  return normalize(text).match(/(?:最近|近期|近来|最新)(?![\d一二三四五六七八九十两几])|这段时间|这阵子|这阵儿/u)?.[0];
}

/** 月份是用户条件；模型省略或 retain 旧月份时不能静默默认到当前月。 */
export function assertOverviewMonthSource(question: string, fields: Record<string, ResolvedField>): void {
  const requested = overviewTimeExpression(question);
  if (!requested) return;
  const actual = fields.time?.metadata?.sourceExpression ?? fields.time?.rawValue;
  if (typeof actual !== "string" || normalize(actual) !== normalize(requested)) {
    throw new BusinessInputError("OVERVIEW_DATE_SOURCE_MISMATCH", "time",
      `本轮时间表达为“${requested}”，请将 time 按此原文 set；不能省略、retain 旧日期或改用当前月。“最近/近期”由服务端检查覆盖并选择最新截至日，模型不得猜日期。此错误由模型修正，不向用户重复询问日期。`);
  }
}

/** 只校验明确业务主题；分析目标和指标选择仍由模型结合主题规划。 */
export function overviewTopicExpression(text: string): "loan" | "deposit" | undefined {
  const combined = /存\s*贷(?:款)?/u.test(text);
  const loan = combined || /贷款|信贷|不良/u.test(text);
  const deposit = combined || /存款|揽储|储蓄/u.test(text);
  return deposit && !loan ? "deposit" : loan && !deposit ? "loan" : undefined;
}

export function multipleOverviewTopics(text: string): boolean {
  return /存\s*贷(?:款)?/u.test(text)
    || /存款|揽储|储蓄/u.test(text) && /贷款|信贷|不良/u.test(text);
}

/** 明确的延续问法不能因模型误选独立问题而丢掉已确定的机构、日期。 */
export function overviewContinuesCurrent(text: string): boolean {
  return /呢[？?。！!\s]*$/u.test(text) && !/另(?:一个|一|起)|新(?:的)?(?:问题|话题)|重新开始|不沿用|不要沿用/u.test(text);
}
