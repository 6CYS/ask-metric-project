import type {FieldCandidate} from "../business-context/types.js";

/**
 * 待确认候选的唯一编号清单与发布收敛规则（唯一首推置顶、相似度降序、最多 DISPLAYED_CANDIDATE_LIMIT 项）只在这里定义。
 * 既有文字回复链按此编号取候选，新题发布复用顺序但另签不透明公共 option_id。
 */
export interface CandidateOption {
  /** 展示编号，从 1 开始，与展示顺序一致。 */
  no: number;
  /** 既有链路内部键；可含编码，不得直接作为新题公共 option_id。 */
  optionId: string;
  /** 业务名称，不含编码。 */
  label: string;
  candidate: FieldCandidate;
}

export function candidateOptions(candidates: readonly FieldCandidate[] | undefined, scope = ""): CandidateOption[] {
  const list = [...(candidates ?? [])];
  const preferred = list.filter(candidate => candidate.preferred === true);
  const ordered = preferred.length === 1 ? [preferred[0]!, ...list.filter(candidate => candidate !== preferred[0])] : list;
  return ordered.map((candidate, index) => {
    const baseName = candidate.metadata?.kind === "base" && typeof candidate.metadata.base_name === "string" ? candidate.metadata.base_name : undefined;
    return {no: index + 1, label: baseName ?? String(candidate.value), candidate,
      optionId: `${scope}:${candidate.code ?? String(candidate.value)}`};
  });
}

/** 发布清单展示上限：只约束对外发布的候选条数，完整目录保留在字段候选中供名称解析。 */
export const DISPLAYED_CANDIDATE_LIMIT = 4;

/**
 * 发布/展示用候选收敛：按候选身份去重，唯一首推置顶，其余按相似度降序（同分保持目录原序），最多 4 项。
 * 不按编码截断，也不替用户选择歧义项；不同口径或日历身份不合并（见 candidateIdentity）。
 */
export function displayedCandidates(candidates: readonly FieldCandidate[] | undefined): FieldCandidate[] {
  const unique = uniqueCandidates(candidates);
  const ranked = unique.map((candidate, index) => ({candidate, index}))
    .sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0) || a.index - b.index)
    .map(item => item.candidate);
  const preferred = ranked.filter(candidate => candidate.preferred === true);
  const ordered = preferred.length === 1 ? [preferred[0]!, ...ranked.filter(candidate => candidate !== preferred[0])] : ranked;
  return ordered.slice(0, DISPLAYED_CANDIDATE_LIMIT);
}

/** 唯一首推选项；没有或不唯一时不返回，确认式话术与“是”的确认均以此为准。 */
export function preferredOption(options: readonly CandidateOption[]): CandidateOption | undefined {
  const preferred = options.filter(option => option.candidate.preferred === true);
  return preferred.length === 1 ? preferred[0] : undefined;
}

export interface CandidateOptionGroup {
  /** 仅用于本次待确认项映射，不作为跨轮 item_ref 或公共选项 ID。 */
  key: string;
  rawValueIndex: number;
  semanticSpan?: string;
  options: CandidateOption[];
}

function identityJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(identityJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${identityJson(item)}`).join(",")}}`;
}

/** 候选身份沿用基础指标归组规则；日历是同一代码下仍需保留的真实身份。 */
export function candidateIdentity(candidate: FieldCandidate): string {
  const kind = candidate.metadata?.kind;
  const key = kind === "base" || kind === "base_only" ? `base:${String(candidate.metadata?.source_metric_code)}`
    : `code:${candidate.code ?? (typeof candidate.value === "string" ? candidate.value : identityJson(candidate.value))}`;
  return candidate.metadata?.calendar === undefined ? key : `${key}:calendar:${identityJson(candidate.metadata.calendar)}`;
}

/** 只在同一待确认项内去重，保留首个候选及其首推、目录快照。 */
export function uniqueCandidates(candidates: readonly FieldCandidate[] | undefined): FieldCandidate[] {
  const seen = new Set<string>();
  return (candidates ?? []).filter(candidate => {
    const key = candidateIdentity(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 按真实待确认项分组；每组独立收敛（去重、首推置顶、相似度降序、最多 4 项）并从 1 编号，不带入旧全局编号。 */
export function candidateOptionGroups(candidates: readonly FieldCandidate[] | undefined, scope = ""): CandidateOptionGroup[] {
  const groups = new Map<string, Omit<CandidateOptionGroup, "options"> & {candidates: FieldCandidate[]}>();
  for (const candidate of candidates ?? []) {
    const parsedIndex = Number(candidate.metadata?.rawValueIndex ?? 0);
    const rawValueIndex = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0;
    const span = typeof candidate.metadata?.semanticSpan === "string" && candidate.metadata.semanticSpan ? candidate.metadata.semanticSpan : undefined;
    const key = span ? `span:${span}` : `raw:${rawValueIndex}`;
    const group = groups.get(key);
    if (group) group.candidates.push(candidate);
    else groups.set(key, {key, rawValueIndex, ...(span ? {semanticSpan: span} : {}), candidates: [candidate]});
  }
  return [...groups.values()].sort((a, b) => a.rawValueIndex - b.rawValueIndex).map(group => {
    const {candidates: grouped, ...identity} = group;
    return {...identity, options: candidateOptions(displayedCandidates(grouped), scope ? `${scope}:${group.key}` : group.key)};
  });
}
