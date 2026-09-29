import type {BusinessFrame, FieldCandidate, MentionResolution, ResolvedField} from "./types.js";

/**
 * 待确认候选的唯一清单：系统据此向用户展示编号，也据此把用户回复对应到候选。
 * 展示与对应共用本模块，编号、顺序和内容只有一份，模型不参与罗列或选择。
 */
export interface ClarificationOption {
  no: number;
  /** 稳定标识：字段 + 待确认项 + 候选键；同名不同编码的候选也可区分。 */
  id: string;
  field: string;
  /** 待确认项：同一字段中的第几个原值/片段，每项至多选一个候选。 */
  item: number;
  label: string;
  candidate: FieldCandidate;
}
export interface ClarificationGroup {field: string; item: number; title: string; options: ClarificationOption[]}
export interface ReplyEvidence {
  reply: string;
  /** 本轮原文经目录识别确定的指标编码。 */
  codes?: Iterable<string>;
  /** 前端点选的选项标识（仅限当前待确认 Frame）。 */
  optionIds?: Iterable<string>;
}

const PENDING = new Set(["needs_confirmation", "ambiguous"]);
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

function candidateKey(candidate: FieldCandidate): string {
  const kind = candidate.metadata?.kind;
  return kind === "base" || kind === "base_only" ? `base:${String(candidate.metadata?.source_metric_code)}`
    : `code:${candidate.code ?? String(candidate.value)}`;
}

/** 基础指标候选代表整组口径，展示基础名称；其余展示正式名称。 */
function candidateLabel(candidate: FieldCandidate): string {
  const kind = candidate.metadata?.kind;
  const base = candidate.metadata?.base_name;
  return kind === "base" && typeof base === "string" ? base : String(candidate.value);
}

function itemText(field: ResolvedField, item: number): string | undefined {
  const mentions = field.metadata?.mentionResolutions as MentionResolution[] | undefined;
  const extracted = field.metadata?.extractedRawValues;
  const raw = field.rawValue;
  const text = mentions?.[item]?.text ?? (Array.isArray(extracted) ? extracted[item] : undefined)
    ?? (Array.isArray(raw) ? raw[item] : raw);
  return typeof text === "string" && text ? text : undefined;
}

function groupTitle(fieldLabel: string, text: string | undefined, options: FieldCandidate[]): string {
  const subject = text ? `「${text}」` : fieldLabel;
  if (options.some(option => option.metadata?.kind === "base" || option.metadata?.kind === "base_only")) {
    return `您说的${subject}是指哪个指标？`;
  }
  if (options.length && options.every(option => typeof option.metadata?.value_basis === "string")) {
    return `请选择${subject}的口径：`;
  }
  return `${subject}对应多个${fieldLabel}，请选择：`;
}

/** 按能力字段顺序生成全局连续编号的清单；字段内按待确认项分组，保持候选保存顺序。 */
export function clarificationOptions(frame: BusinessFrame, fieldLabels: Record<string, string>): ClarificationGroup[] {
  const groups: ClarificationGroup[] = [];
  let no = 0;
  for (const [field, label] of Object.entries(fieldLabels)) {
    const resolved = frame.fields[field];
    if (!resolved?.candidates?.length || !PENDING.has(resolved.resolutionStatus)) continue;
    const byItem = new Map<number, FieldCandidate[]>();
    for (const candidate of resolved.candidates) {
      const item = Number(candidate.metadata?.rawValueIndex ?? 0);
      if (!byItem.has(item)) byItem.set(item, []);
      byItem.get(item)!.push(candidate);
    }
    for (const [item, candidates] of [...byItem.entries()].sort(([a], [b]) => a - b)) {
      const seen = new Set<string>();
      const options = candidates.flatMap(candidate => {
        const key = candidateKey(candidate);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{no: ++no, id: `${field}:${item}:${key}`, field, item, label: candidateLabel(candidate), candidate}];
      });
      groups.push({field, item, title: groupTitle(label, itemText(resolved, item), candidates), options});
    }
  }
  return groups;
}

/** 规范清单的文字形式，追加在澄清消息后；用户可回复序号或名称。 */
export function renderClarificationOptions(groups: ClarificationGroup[], unclear = false): string {
  if (!groups.length) return "";
  const lines = unclear ? ["未能从回复中确定您选择的是哪一项，请回复下列序号或名称："] : ["请回复下列序号或名称："];
  for (const group of groups) {
    lines.push(group.title, ...group.options.map(option => `${option.no}. ${option.label}`));
  }
  return lines.join("\n");
}

const DIGITS: Record<string, number> = {零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
function parseNumber(token: string): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  if (!/^[零一二两三四五六七八九十]+$/.test(token)) return undefined;
  const [tens, ones] = token.includes("十") ? token.split("十") : ["", token];
  const value = (token.includes("十") ? (tens ? DIGITS[tens] ?? NaN : 1) * 10 : 0) + (ones ? DIGITS[ones] ?? NaN : 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 只认明确的序号表达：整句只有序号（“2”“2和5”“第二个”），或带“第…个/项/条/种”“选…”“…号”标记。
 * 日期等普通数字（如“2026年4月末”）不当作序号。
 */
export function replyOrdinals(reply: string): number[] {
  const text = reply.normalize("NFKC").replace(/\s+/g, "");
  const number = "(\\d+|[零一二两三四五六七八九十]+)";
  const found: string[] = [];
  const bare = text.replace(/^(就是|是|选|选择|要|我要|我选)/, "").replace(/(吧|呢|吗|。|！|!|\.)+$/, "");
  const list = new RegExp(`^(?:第?${number}(?:个|项|条|种|号)?)(?:(?:和|与|及|、|,|，|跟)第?${number}(?:个|项|条|种|号)?)*$`);
  if (list.test(bare)) {
    found.push(...(bare.match(new RegExp(number, "g")) ?? []));
  } else {
    for (const pattern of [`第${number}(?:个|项|条|种)?`, `(?:选|选择)${number}`, `${number}号`]) {
      for (const match of text.matchAll(new RegExp(pattern, "g"))) found.push(match[1]!);
    }
  }
  return [...new Set(found.map(parseNumber).filter((value): value is number => value !== undefined))];
}

/** 候选在原文中出现的最长依据：正式名称、展示名称、基础名称或口径。 */
function textMatchLength(option: ClarificationOption, reply: string): number {
  const metadata = option.candidate.metadata ?? {};
  const texts = [option.label, option.candidate.value, metadata.value_basis, metadata.base_name];
  return Math.max(0, ...texts.filter((text): text is string => typeof text === "string")
    .map(normalize).filter(text => text && reply.includes(text)).map(text => text.length));
}

/**
 * 把用户回复对应到候选：点选、原文目录识别编码、原文包含的名称（每项取最长且唯一）、明确序号。
 * 每个待确认项至多选一个候选；同一项的依据互相矛盾时视为未对应，不猜。
 */
export function selectOptions(groups: ClarificationGroup[], evidence: ReplyEvidence): ClarificationOption[] {
  const options = groups.flatMap(group => group.options);
  const votes = new Map<string, Set<string>>();
  const vote = (option: ClarificationOption) => {
    const key = `${option.field}:${option.item}`;
    if (!votes.has(key)) votes.set(key, new Set());
    votes.get(key)!.add(option.id);
  };
  const ids = new Set(evidence.optionIds ?? []);
  options.filter(option => ids.has(option.id)).forEach(vote);
  const codes = new Set(evidence.codes ?? []);
  options.filter(option => option.candidate.code && codes.has(option.candidate.code)).forEach(vote);
  const reply = normalize(evidence.reply);
  for (const group of groups) {
    const lengths = group.options.map(option => textMatchLength(option, reply));
    const longest = Math.max(0, ...lengths);
    if (longest) group.options.filter((_, index) => lengths[index] === longest).forEach(vote);
  }
  const numbers = new Set(replyOrdinals(evidence.reply));
  options.filter(option => numbers.has(option.no)).forEach(vote);
  const byId = new Map(options.map(option => [option.id, option]));
  return [...votes.values()].filter(chosen => chosen.size === 1).map(chosen => byId.get([...chosen][0]!)!);
}
