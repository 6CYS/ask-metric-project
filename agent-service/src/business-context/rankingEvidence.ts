import {BusinessInputError} from "./inputError.js";
import {normalizeInputEvidence} from "./inputEvidence.js";
import {withFieldClarification} from "./fieldClarification.js";
import type {FieldResolution, FieldSchema, QueryOperation, ResolverContext} from "./types.js";

type Position = "top" | "bottom";
interface VerifiedRanking {position?: Position; top_n?: number}
const NUMBER = "(?:[0-9]+|[零〇一二两三四五六七八九十百]+)";

/** “哪家/哪个最高或最差”明确寻找单个极值对象；不把“哪些/哪几家”默认为一名。 */
function singleExtremum(text: string): {position?: Position} | undefined {
  const matches = text.split(/[，。；！？,;!?]/u).flatMap(clause => {
    const subjects = [...clause.matchAll(/哪(?:一)?(?:家|个|所)|谁/gu)];
    const extrema = [...clause.matchAll(/最高|最低|最多|最少|最大|最小|最好|最差|最强|最弱/gu)];
    if (subjects.length !== 1 || extrema.length !== 1 || /哪些|哪几|几家|多个|多家|并列/u.test(clause)
      || negated(clause, subjects[0]!.index!, subjects[0]!.index! + subjects[0]![0].length)
      || negated(clause, extrema[0]!.index!, extrema[0]!.index! + extrema[0]![0].length)) return [];
    const word = extrema[0]![0];
    // 好坏强弱的排序方向仍由模型按指标含义提出；这里只证明对象数量。
    return [{...(/最高|最多|最大/u.test(word) ? {position: "top" as const}
      : /最低|最少|最小/u.test(word) ? {position: "bottom" as const} : {})}];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** 只识别榜单条数的数值表达；日期和机构集合数量不在这里推断为TopN。 */
function integer(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^(?:[零〇一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?|一?百)$/u.test(text)) return undefined;
  const digits: Record<string, number> = {零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
  let total = 0, digit = 0;
  for (const char of text) {
    if (char === "十" || char === "百") {total += (digit || 1) * (char === "十" ? 10 : 100); digit = 0;}
    else if (digits[char] !== undefined) digit = digits[char]!;
    else return undefined;
  }
  return total + digit;
}

function negated(text: string, start: number, end: number): boolean {
  const prefix = text.slice(0, start).split(/[，。；！？,;!?]/).at(-1) ?? "";
  return /(?:不要|不用|不是|不看|不查|不取|不再|别|无需|取消)/u.test(prefix)
    || /^(?:不要|取消|不查|不看|不是)/u.test(text.slice(end));
}

function anchors(original: string) {
  const normalized = normalizeInputEvidence(original);
  // 明确替换只消费最终目标；并列目标仍保留为竞争证据，不能任选其中一组。
  const changes = [...normalized.matchAll(/改(?:成|为)|换(?:成|为)|而是/g)];
  const change = changes.at(-1);
  const tail = change ? normalized.slice(change.index! + change[0].length) : "";
  const list = new RegExp(`(top|bottom|前|后|最高|最低|最多|最少)(?:的)?(${NUMBER})(名|家|位|条|个|项)?`, "giu");
  const bounded = (match: RegExpMatchArray, value: string): boolean => {
    const rest = value.slice(match.index! + match[0].length);
    return !/^(?:个)?(?:月|年|日|季度|星期|周|小时|分钟)/u.test(rest)
      && (!!match[3] || /^(?:$|[，。；！？、,;!?.]|和|及)/u.test(rest));
  };
  const first = [...tail.matchAll(list)][0];
  const replacesRanking = !!change && (!!first && first.index === 0 && bounded(first, tail)
    || new RegExp(`^${NUMBER}(?:名|家|位|条|项)(?:$|[，。；！？、,;!?.])|^(?:位次|排第几)`, "u").test(tail));
  const unclearReplacement = !!change && new RegExp(`^${NUMBER}(?:$|[，。；！？,;!?])`, "u").test(tail);
  const text = replacesRanking ? normalized.slice(change!.index!) : normalized;
  const positions = new Set<Position>(), counts = new Set<number>();
  let invalidCount = false, excludedRanking = false;
  const direction = (word: string): Position => /^(?:后|最低|最少|bottom)/i.test(word) ? "bottom" : "top";
  for (const match of text.matchAll(list)) {
    const end = match.index! + match[0].length;
    if (!bounded(match, text)) continue;
    if (negated(text, match.index!, end)) {excludedRanking = true; continue;}
    positions.add(direction(match[1]!));
    const count = integer(match[2]!);
    if (count !== undefined && count >= 1 && count <= 100) counts.add(count);
    else invalidCount = true;
  }
  for (const match of text.matchAll(/前面|后面|从高到低|从低到高|降序|升序/gu)) {
    if (!negated(text, match.index!, match.index! + match[0].length)) {
      positions.add(/后面|从低到高|升序/u.test(match[0]) ? "bottom" : "top");
    } else excludedRanking = true;
  }
  const countOnly = new RegExp(`(?:只取|取|显示|展示|列出|返回|选出|榜单取|排名取|改成|改为|换成|换为)(${NUMBER})(名|家|位|条|项)`, "gu");
  for (const match of text.matchAll(countOnly)) {
    const prefix = text.slice(0, match.index!).split(/[，。；！？,;!?]/).at(-1) ?? "";
    const rest = text.slice(match.index! + match[0].length);
    // 非榜单语境的“返回三家机构”是集合数量；不能据它改变 TopN。
    if (!/排名|排序|榜单/u.test(prefix) && !(match[2] === "名" && /^(?:$|[，。；！？,;!?])/u.test(rest))) continue;
    const count = integer(match[1]!);
    if (negated(text, match.index!, match.index! + match[0].length)) {excludedRanking = true; continue;}
    if (count !== undefined && count >= 1 && count <= 100) counts.add(count);
    else invalidCount = true;
  }
  const single = singleExtremum(text);
  if (single && !counts.size && !invalidCount) {
    counts.add(1);
    if (single.position) positions.add(single.position);
  }
  const cancel = /取消(?:排名|排序|榜单)|(?:不要|不用|无需|不再|不)(?:排名|排序|榜单)|只(?:查|看|要)(?:数值|取值)|改(?:为|成)(?:普通)?取值/u.test(text);
  const positionRequest = /(?:排(?:在)?第?几|第几名|位次|名次(?:是|为|多少)|排名(?:是|为)?(?:多少|第?几))/u.test(text);
  const rankingRequest = positions.size > 0 || counts.size > 0 || invalidCount || excludedRanking || /排名|排序|榜单|名次|位次|排第几/u.test(text);
  return {positions, counts, cancel, positionRequest, rankingRequest, unclearReplacement, invalidCount, excludedRanking};
}

/** 结构化空槽可由同一份原文证据补齐；不覆盖模型已给值，不以集合家数填榜单条数。 */
export async function completeRankingOperation(operation: {kind: "ranking"; position: Position | null; top_n: number | null}, context: ResolverContext) {
  const proof = anchors(await operationText(context, []));
  if (proof.positions.size > 1 || proof.counts.size > 1 || proof.invalidCount || proof.excludedRanking
    || proof.unclearReplacement || proof.cancel || proof.positionRequest) return operation;
  return {...operation,
    position: operation.position ?? (proof.positions.size === 1 ? [...proof.positions][0]! : null),
    top_n: operation.top_n ?? (proof.counts.size === 1 ? [...proof.counts][0]! : null)};
}

async function operationText(context: ResolverContext, metricTerms: string[]): Promise<string> {
  let text = context.originalMessage;
  if (context.resolveMetricMentions && anchors(text).rankingRequest) {
    const matched = await context.resolveMetricMentions(text);
    const chars = Array.from(text);
    // 正式指标名称及其待确认口径可以含排名/数字；不能再解释成独立操作。
    for (const mention of matched.mentions) if (mention.resolution.status === "resolved"
      || mention.resolution.candidates?.some(candidate => typeof candidate.code === "string")) {
      for (let index = mention.start; index < mention.end; index += 1) chars[index] = " ";
    }
    text = chars.join("");
  }
  // 本轮确认选中的正式名称/口径来自已保存候选，短回复也无需再次当成排序目标。
  text = normalizeInputEvidence(text);
  for (const term of [...metricTerms].sort((a, b) => b.length - a.length)) {
    const value = normalizeInputEvidence(term);
    if (value) text = text.replaceAll(value, " ");
  }
  return text;
}

/** 本轮证据或宿主选定历史决定业务值；模型给出的合法枚举、数字本身不构成依据。 */
export async function resolveRankingEvidence(operation: QueryOperation, schema: FieldSchema, context: ResolverContext, metricTerms: string[] = []): Promise<FieldResolution> {
  const proof = anchors(await operationText(context, metricTerms));
  const prior = context.previous?.resolvedValue as Partial<QueryOperation> | undefined;
  const saved = context.previous?.metadata?.rankingEvidence as (VerifiedRanking & {verified?: boolean}) | undefined;
  const source = context.previous?.resolutionStatus === "resolved" && prior?.kind === "ranking"
    ? prior as VerifiedRanking : saved?.verified === true ? saved : {};
  const historical: VerifiedRanking = {...(source.position === "top" || source.position === "bottom" ? {position: source.position} : {}),
    ...(Number.isInteger(source.top_n) && source.top_n! >= 1 && source.top_n! <= 100 ? {top_n: source.top_n!} : {})};
  const partial = (verified: VerifiedRanking = {}): FieldResolution => ({status: "ambiguous", value: {
    ...(verified.position !== undefined || verified.top_n !== undefined ? {kind: "ranking"} : {}), ...verified},
    metadata: {userInputIssue: true, userClarificationQuestion: schema.userClarification?.question,
      rankingEvidence: {verified: true, ...verified}}});
  const competing = proof.positions.size > 1 || proof.counts.size > 1 || proof.unclearReplacement
    || proof.cancel && (proof.positions.size > 0 || proof.counts.size > 0 || proof.positionRequest);
  if (competing) return partial();
  const current: VerifiedRanking = {...(proof.positions.size ? {position: [...proof.positions][0]!} : {}),
    ...(proof.counts.size ? {top_n: [...proof.counts][0]!} : {})};
  if (proof.invalidCount) return partial(current.position ? {position: current.position} : {});
  if (proof.excludedRanking) return partial();
  const verified: VerifiedRanking = {...historical, ...current};
  const mismatch = (expected: string): never => {
    const message = `本轮明确依据或所选历史要求${expected}。请据此修正 operation；参数枚举合法并不授权修改业务目标，不从日期或机构数量推断榜单条件。原焦点未改变。`;
    throw new BusinessInputError("QUERY_OPERATION_EVIDENCE_MISMATCH", "operation", message, undefined, undefined,
      [withFieldClarification(schema, {field: "operation", reason: "invalid", message, ...(schema.inputSchema ? {inputSchema: schema.inputSchema} : {})})]);
  };
  if (operation.kind === "value") {
    if (proof.cancel && !proof.positions.size && !proof.counts.size || !proof.rankingRequest && (!prior?.kind || prior.kind === "value")) {
      return {status: "resolved", value: operation};
    }
    if (proof.positionRequest) return mismatch("查询关注对象在比较总体中的位次（rank_position）");
    if (verified.position && verified.top_n) return mismatch(`查看${verified.position === "top" ? "前" : "后"} ${verified.top_n} 名榜单`);
    return partial(verified);
  }
  if (operation.kind === "rank_position") {
    return proof.positionRequest && !proof.positions.size && !proof.counts.size
      || !proof.rankingRequest && context.previous?.resolutionStatus === "resolved" && prior?.kind === "rank_position"
      ? {status: "resolved", value: operation} : verified.position && verified.top_n
        ? mismatch(`查看${verified.position === "top" ? "前" : "后"} ${verified.top_n} 名榜单`) : partial(verified);
  }
  if (proof.positionRequest || proof.cancel && !proof.positions.size && !proof.counts.size) return partial();
  const position = [...proof.positions][0] ?? historical.position;
  const top_n = [...proof.counts][0] ?? historical.top_n;
  if (position === undefined || top_n === undefined) return partial({...(position ? {position} : {}), ...(top_n ? {top_n} : {})});
  if (operation.position !== position || operation.top_n !== top_n) return mismatch(`查看${position === "top" ? "前" : "后"} ${top_n} 名榜单`);
  return {status: "resolved", value: operation, metadata: {rankingEvidence: {verified: true, position, top_n}}};
}

/** 把已可核验的业务排序事实规范成操作；不要求模型填写后端kind或重复条数证明。 */
export async function normalizeQueryOperation(context: ResolverContext, allMembers?: {count: number; direction?: "ascending" | "descending"}): Promise<FieldResolution> {
  const proof = anchors(await operationText(context, []));
  if (proof.positions.size > 1 || proof.counts.size > 1 || proof.invalidCount || proof.excludedRanking || proof.unclearReplacement) return {status: "ambiguous"};
  if (proof.positionRequest && !proof.positions.size && !proof.counts.size) return {status: "resolved", value: {kind: "rank_position"}};
  if (proof.positions.size === 1 && proof.counts.size === 1) {
    const count = [...proof.counts][0]!;
    return count >= 1 && count <= 100 ? {status: "resolved", value: {kind: "ranking", position: [...proof.positions][0]!, top_n: count}} : {status: "ambiguous"};
  }
  if (allMembers && proof.positions.size === 1 && proof.counts.size === 0 && allMembers.count >= 1 && allMembers.count <= 100) {
    const position = [...proof.positions][0]!;
    if (!allMembers.direction || position === (allMembers.direction === "descending" ? "top" : "bottom")) return {status: "resolved", value: {kind: "ranking", position, top_n: allMembers.count}};
  }
  return proof.rankingRequest ? {status: "ambiguous"} : {status: "resolved", value: {kind: "value"}};
}
