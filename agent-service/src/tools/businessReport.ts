import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {numberTokens} from "../replyGuard.js";
import type {BusinessEvidence} from "../answerEvidence.js";
import {BackendApiError} from "../backendClient.js";
import {narrativeEvidenceRefs, narrativeParagraphEvidence, normalizeReportNarrative, verifiedNarrativeRefs} from "../analysis/narrative.js";
import {expandFindingRefs} from "../analysis/verifiedFindings.js";
import {overviewComparisonSign} from "../analysis/businessReportClaims.js";
import {publicTextProblem} from "../runtime/delivery.js";
import {currentTurnMessages} from "./turnContract.js";
import {buildOverviewPieChart} from "../analysis/overviewCharts.js";
import {buildReportChart, prefersReportText, reportChartSchema, type BusinessReportChart} from "../analysis/reportCharts.js";

interface EvidenceItem {ref: string; display: string; label: string; type?: string; value?: string; ranked_increases?: string[]; judgment_kind?: string; input_refs?: string[]}
export interface OverviewEvidence extends BusinessEvidence {
  frame_id?: string;
  topic?: "loan" | "deposit"; topic_version?: string; topic_name?: string; source_notice?: string; context_notice?: string;
  metric_sources?: Record<string, string>;
  analysis_date: string | null; requested_date: string; org_codes: string[]; org_name: string;
  basis: string; evidence_items: EvidenceItem[]; table_rows: Record<string, string>[];
  table_columns: string[]; tasks: Array<{task_id: string; status: string}>;
  gaps: Array<{label?: string; reason: string}>;
  plan?: {objective?: string; questions?: string[]; rationale?: string; metric_ids?: string[]; comparisons?: string[]};
  followup_candidates?: Array<{parent: string; metric_ids: string[]; comparisons: string[]; reason: string}>;
  date_selection?: "exact" | "latest_snapshot" | "available_in_range";
  data_freshness?: {checked_on: string; as_of: string | null; lag_days: number | null; notice: string};
  period?: {start: string; end: string; checked_on: string; snapshot_dates: string[];
    months: Array<{month: string; as_of: string | null; date_count: number}>};
}
export interface ReportInput {
  evidence_refs: string[]; summary: string;
  sections: Array<{title: string; text: string; evidence_refs: string[]}>;
  metric_ids: string[];
}

const isProseError = (error: unknown): error is Error => error instanceof Error && /^(?:summary |sections\[)/u.test(error.message);

/** 合并同一快照的段首和标题日期；跨期比较、正文基期和代码保持原样。 */
function overviewDisplayText(text: string, sources: OverviewEvidence[]) {
  const date = sources[0]?.analysis_date;
  if (!date || sources.some(source => source.analysis_date !== date
    || source.period?.snapshot_dates.some(snapshot => snapshot !== date)
    || source.table_rows.some(row => row.data_date && row.data_date !== date))) return text;
  const sameDate = (year: string, month: string, day: string) =>
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` === date;
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/u).map((part, index) => {
    if (index % 2) return part;
    const paragraphs = part.replace(/(^|\n[ \t]*\n)([ \t]*)(?:截至|截止)\s*(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?[,，][ \t]*/gu,
      (matched, paragraph: string, indent: string, year: string, month: string, day: string) =>
        sameDate(year, month, day) ? paragraph + indent : matched);
    return paragraphs.split("\n").map(line => /^\s*(?:#{1,6}\s+.+|\*\*[^*]+\*\*)\s*$/u.test(line)
      ? line.replace(/[（(](?:截至|截止)\s*(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?\s*[）)]/gu,
        (matched, year: string, month: string, day: string) => sameDate(year, month, day) ? "" : matched)
      : line).join("\n");
  }).join("");
}

function overviewGaps(sources: OverviewEvidence[]) {
  const missing = sources[0]?.period?.months.filter(month => month.date_count === 0).map(month => month.month) ?? [];
  const periodGaps: OverviewEvidence["gaps"] = missing.length
    ? [{reason: `以下月份无可用记录：${missing.join("、")}，不能判断这些月份的变化`}] : [];
  return [...sources.flatMap(source => source.gaps), ...periodGaps];
}

/** 校验细节保存在 gaps；正文只说明受影响的业务比较，合并同一种缺项。 */
function overviewBusinessGaps(sources: OverviewEvidence[]) {
  const groups = new Map<string, Set<string>>();
  for (const gap of overviewGaps(sources)) {
    const comparison = /^(较上月|较同期|较年初)正式比较指标的当前值、增量与增幅不一致或比较分母为零/u.exec(gap.reason);
    const reason = comparison ? `的${comparison[1]}数据暂不可用，相关比较未纳入本次分析。` : gap.reason;
    const labels = groups.get(reason) ?? new Set<string>();
    labels.add(gap.label ?? "");
    groups.set(reason, labels);
  }
  return [...groups].map(([reason, labels]) => [...labels].filter(Boolean).join("、") + reason);
}

/** 表格和文字降级共用同一合并规则，未查询的比较格不能覆盖已经取得的值。 */
function mergedOverviewRows(sources: OverviewEvidence[]) {
  const rows = new Map<string, Record<string, string>>();
  for (const source of sources) for (const row of source.table_rows) {
    const key = row.data_date ? `${row.metric_id}@${row.data_date}` : row.metric_id!;
    const previous = rows.get(key) ?? {};
    rows.set(key, {...previous, ...Object.fromEntries(Object.entries(row)
      .filter(([field, value]) => value !== "—" && value !== "" || previous[field] === undefined))});
  }
  return rows;
}

/** 只选择已取数指标的正式引用，正文仍须经过统一校验与插值，不计算新数值或推断经营因果。 */
function overviewFactBody(sources: OverviewEvidence[], metricIds: string[]) {
  const atoms = new Map(sources.flatMap(source => source.evidence_items).map(atom => [atom.ref, atom]));
  const periods = [{label: "较上月", id: "mom"}, {label: "较同期", id: "yoy"}, {label: "较年初", id: "ytd"}];
  const requestedComparisons = sources.flatMap(source => source.plan?.comparisons ?? []);
  const hasComparisonPlan = sources.every(source => source.plan?.comparisons?.length)
    && requestedComparisons.every(id => periods.some(period => period.id === id));
  const rows = [...mergedOverviewRows(sources).values()].filter(row => metricIds.includes(row.metric_id!))
    .sort((left, right) => (left.data_date ?? "").localeCompare(right.data_date ?? "")
      || Number(right.metric_id === "total") - Number(left.metric_id === "total"));
  const selectedPeriods = periods.filter(period => !hasComparisonPlan || requestedComparisons.includes(period.id));
  const paragraphs: string[] = [];
  for (const row of rows) {
    if (!row["当前值"] || row["当前值"] === "—") continue;
    const prefix = `${row.data_date ? `d${row.data_date.replaceAll("-", "")}.` : ""}${row.metric_id}`;
    const date = row.data_date ?? sources[0]!.analysis_date;
    // 恢复正文保留计划要求的全部比较；旧回执缺少可靠计划时保留已有事实。
    const changes = selectedPeriods
      .flatMap(period => {
        const difference = atoms.get(`${prefix}.${period.id}.difference`), rate = atoms.get(`${prefix}.${period.id}.rate`);
        if (!difference && !rate) return [];
        const sign = overviewComparisonSign(difference);
        const direction = sign === 1 ? "增加" : sign === -1 ? "减少" : "变化";
        return [`${period.label}${difference ? `${direction}{{${difference.ref}}}` : "增幅"}${rate ? `${difference ? "（" : ""}{{${rate.ref}}}${difference ? "）" : ""}` : ""}`];
      });
    const share = atoms.get(`${prefix}.share.share`);
    if (share) changes.push(`占比{{${share.ref}}}`);
    paragraphs.push(`${date ? `截至${date}，` : ""}${row["指标"] ?? row.metric_id}为{{${prefix}.current}}${changes.length ? `；${changes.join("；")}` : ""}。`);
  }
  return paragraphs.join("\n\n");
}

/** 先核对完整来源与引用，再恢复正文，不能通过删段绕过授权和证据检查。 */
export function composePartialBusinessReport(sources: OverviewEvidence[], input: ReportInput) {
  // 使用原请求先过来源和引用校验；不能清空错误引用后走恢复。
  try {composeBusinessReport(sources, input);} catch (error) {if (!isProseError(error)) throw error;}
  const summary = overviewFactBody(sources, input.metric_ids)
    || "已检查请求范围，未取得可用指标记录，暂不能形成经营判断。";
  const report = composeBusinessReport(sources, {...input, summary, sections: []});
  return {...report, partial_analysis: true};
}

function overviewPublicAnswer(scope: string, summary: string, sections: ReportInput["sections"]) {
  return [scope, summary,
    ...sections.map(section => `${section.title ? `**${section.title}**\n\n` : ""}${section.text}`)].join("\n\n");
}

/** 已尝试但缺数也算完成补查；三轮后以缺口交付，不形成无界查询。 */
export function pendingOverviewFollowup(sources: OverviewEvidence[]) {
  if (sources.length >= 3 || !sources.at(-1)?.analysis_date) return [];
  const attempted = new Set(sources.flatMap(source => source.plan?.metric_ids ?? []));
  return sources.flatMap(source => source.followup_candidates ?? [])
    .map(candidate => ({...candidate, metric_ids: candidate.metric_ids.filter(id => !attempted.has(id))}))
    .filter(candidate => candidate.metric_ids.length);
}

/** 模型撰写文本，数字通过证据占位符引用；表格由回执构造，历史保留原任务授权边界。 */
export function composeBusinessReport(sources: OverviewEvidence[], input: ReportInput, incompleteNotice?: string) {
  const first = sources[0];
  if (!first || sources.some(source => source.status !== "succeeded"
    || JSON.stringify(source.org_codes) !== JSON.stringify(first.org_codes)
    || source.analysis_date !== first.analysis_date || source.requested_date !== first.requested_date
    || source.date_selection !== first.date_selection
    || JSON.stringify(source.period) !== JSON.stringify(first.period)
    || (source.topic ?? "loan") !== (first.topic ?? "loan") || source.topic_version !== first.topic_version
    || source.basis !== first.basis)) throw new Error("报告必须引用同一机构、日期和口径且主题版本相同的本轮概览证据。");
  const pending = pendingOverviewFollowup(sources);
  const evidence = new Map<string, EvidenceItem>();
  for (const source of sources) {
    if (!Array.isArray(source.evidence_items) || !Array.isArray(source.table_rows)) throw new Error("概览证据格式不完整，请重新查询。");
    for (const item of source.evidence_items) {
      // 日期选择线索会随补查变化；仅比较结构化新鲜度，不能把说明文字当作业务值冲突。
      if (item.ref === "scope.freshness" && evidence.has(item.ref) && first.data_freshness && source.data_freshness) {
        const sameFreshness = (["checked_on", "as_of", "lag_days"] as const)
          .every(field => first.data_freshness![field] === source.data_freshness![field]);
        if (!sameFreshness || source.data_freshness.as_of !== source.analysis_date) throw new Error("两轮日期覆盖证据发生变化，请确认一致的数据快照。");
        continue;
      }
      const previous = evidence.get(item.ref);
      if (previous && ((["display", "value", "type", "judgment_kind"] as const).some(field => previous[field] !== item[field])
        || JSON.stringify(previous.input_refs ?? []) !== JSON.stringify(item.input_refs ?? [])))
        throw new Error("两轮证据值或依赖发生变化，请确认一致的数据快照。");
      evidence.set(item.ref, item);
    }
  }
  const rows = mergedOverviewRows(sources);
  if (new Set(input.metric_ids).size !== input.metric_ids.length || input.metric_ids.some(id => ![...rows.values()].some(row => row.metric_id === id))) throw new Error("表格只能选择本轮实际取得数据的指标ID，缺数时使用空数组。");
  const refs = [...narrativeEvidenceRefs(input.summary), ...input.sections.flatMap(section =>
    [...section.evidence_refs, ...narrativeEvidenceRefs(section.title), ...narrativeEvidenceRefs(section.text)])];
  for (const ref of refs) if (!evidence.has(ref)) throw new Error(`不存在证据 ${ref}，请使用回执中的 ref。`);
  expandFindingRefs([...evidence.keys()], evidence);
  for (const text of [input.summary, ...input.sections.flatMap(section => [section.title, section.text])]) {
    const problem = publicTextProblem(text);
    if (problem) throw new Error(`summary ${problem}；请仅保留对用户有用的业务判断及证据。`);
  }
  const gaps = [...new Set([...overviewGaps(sources).map(gap => `${gap.label ?? ""}${gap.reason}`),
    ...(incompleteNotice ? [incompleteNotice, ...pending.map(item => `尚未完成补查：${item.reason}`)] : [])])];
  const normalizeDate = (year: string, month: string, day: string) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const allowedDates = new Set([first.analysis_date, first.requested_date, first.period?.start, first.period?.end,
    ...first.period?.snapshot_dates ?? [], ...sources.flatMap(source => source.evidence_items
    .flatMap(item => [...item.display.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/gu)].map(match => normalizeDate(match[1]!, match[2]!, match[3]!))))]);
  const allowedMonths = new Set([...allowedDates].filter((date): date is string => !!date).map(date => date.slice(0, 7)));
  first.period?.months.forEach(month => allowedMonths.add(month.month));
  const issues: string[] = [];
  const prepareProse = (value: string) => {
    let text = value.replace(/[+-](?=\{\{[^{}]+\}\})/gu, "");
    // 完全相同且唯一的数值展示可自动关联回执；不接纳近似值、换算值或歧义数值。
    const displays = new Map<string, string[]>();
    for (const item of evidence.values()) {
      if (!/^-?\d[\d.]*?(?:亿元|万元|元|%|个百分点)$/u.test(item.display)) continue;
      displays.set(item.display, [...displays.get(item.display) ?? [], item.ref]);
    }
    for (const [display, refs] of [...displays].sort((a, b) => b[0].length - a[0].length)) {
      if (refs.length !== 1) continue;
      const [, numeric, unit] = /^(-?[\d.]+)(亿元|万元|元|%|个百分点)$/u.exec(display)!;
      // 整体加粗必须整体匹配，不能从强调符内部起匹配而漏掉外侧负号。
      const pattern = (value: string) => {
        const parts = [value, unit!].map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const plain = parts.join("[ \\t\\u00a0]*");
        const emphasized = parts.map(part => `(?:\\*\\*${part}\\*\\*|__${part}__|${part})`).join("[ \\t\\u00a0]*");
        return `(?:\\*\\*${plain}\\*\\*|__${plain}__|${emphasized})`;
      };
      // 正号只是已核验正值的展示形式；其他数值仍要求完整符号和唯一匹配。
      text = text.replace(new RegExp(`(?<![\\d.+*_\\-][ \\t\\u00a0]*)${display.startsWith("-") ? "" : "\\+?"}${pattern(numeric!)}(?![\\d.])`, "gu"), `{{${refs[0]}}}`);
      // “减少2元”可引用唯一的正式负差额；不能把负余额或其他符号相反的数值当成减少量。
      if (display.startsWith("-") && overviewComparisonSign(evidence.get(refs[0]!)) === -1) {
        text = text.replace(new RegExp(`(减少|下降|下跌|降低|回落|下行)(\\s*(?:了|约为|约|为)?\\s*)${pattern(numeric!.slice(1))}(?![\\d.])`, "gu"),
          (_matched, verb: string, space: string) => `${verb}${space}{{${refs[0]}}}`);
      }
    }
    const residual = evidence.get("reconciliation.0.value");
    if (residual) text = text.replace(/残差(?:为|是)?(-?\d+(?:\.\d+)?)(?![\d.])/gu,
      (matched, numeric: string) => residual.display.match(/^-?\d+(?:\.\d+)?/u)?.[0] === numeric
        ? "残差为{{reconciliation.0.value}}" : matched);
    return text.replace(/\{\{([^{}]+)\}\}(亿元|万元|元|%|个百分点)/gu, (matched, ref: string, unit: string) =>
      evidence.get(ref)?.display.match(/(亿元|万元|元|%|个百分点)$/u)?.[0] === unit ? `{{${ref}}}` : matched);
  };
  const interpolate = (text: string, path: string): string => {
    if (text.includes("{{scope.freshness}}")) issues.push(`${path} 数据新鲜度由程序在报告开头统一披露，正文删除 {{scope.freshness}}，不要把完整说明作为天数嵌入句子或重复披露。`);
    for (const sentence of text.split(/[。！？；]/u)) {
      for (const match of sentence.matchAll(/(?:\d{4}年)?(\d{1,2})月(?:末|底)/gu)) {
        const before = sentence.slice(Math.max(0, match.index - 18), match.index);
        const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + 16);
        if (/(?:没有|未取得|缺少|缺失|不代表)[^，,。！？；]{0,12}$/u.test(before)
          || /^(?:的)?(?:数据|记录|余额)?(?:暂无|没有|缺失|未|尚未|无|缺)/u.test(after)) continue;
        const month = match[1]!.padStart(2, "0");
        const actualDates = first.period?.snapshot_dates ?? [first.analysis_date];
        const hasMonthEnd = actualDates.some(day => day && day.slice(5, 7) === month
          && Number(day.slice(8)) === new Date(Date.UTC(Number(day.slice(0, 4)), Number(month), 0)).getUTCDate());
        if (!hasMonthEnd) issues.push(`${path} 实际快照没有${match[0]}记录，月中截至日不能写成月末或月底数据；沿用实际日期。`);
      }
    }
    const withoutReferences = text.replace(/\{\{([^{}]+?)(\|cite)?\}\}/g, (_match, ref: string) => {
      if (!evidence.has(ref)) issues.push(`${path} 不存在证据 ${ref}，请使用回执中的 ref。`);
      return "";
    });
    for (const match of text.matchAll(/(?:增幅|增速)\s*[（(:：]?\s*(?:为|是|约)?\s*\{\{([^{}]+)\}\}/gu)) {
      const item = evidence.get(match[1]!);
      const prefix = text.slice(Math.max(0, match.index - 20), match.index);
      if (item && /(?:亿元|万元|元)$/u.test(item.display) && !/不能|无法|不等于|不代表|是否/u.test(prefix))
        issues.push(`${path} 金额证据不能称为增幅或增速，请称增量或差额；增幅须引用正式比率或已核验计算。`);
    }
    if (/\{\{|\}\}/.test(withoutReferences)) issues.push(`${path} 证据占位符格式应为 {{ref}}。`);
    // 日期按完整日期比较，兼容中文不补零的月份；不能用日期中的数字放行业务数值。
    const prose = withoutReferences.replace(/(?<!\d)(\d{1,2})\s*[-~～至到]\s*(\d{1,2})月/gu, (matched, start: string, end: string) =>
      first.period && Number(start) <= Number(end)
        && Array.from({length: Number(end) - Number(start) + 1}, (_, index) => Number(start) + index)
          .every(month => first.period!.months.some(item => Number(item.month.slice(5, 7)) === month)) ? "" : matched)
      .replace(/(\d{1,2}(?:[、,，和及]\d{1,2})+)月/gu, (matched, months: string) =>
      months.split(/[、,，和及]/u).every(month => [...allowedMonths].some(date => date.endsWith(`-${month.padStart(2, "0")}`))) ? "" : matched)
      .replace(/(\d+)(?:个|条|份)?(?:月(?:度)?(?:快照)?|(?:可用|有效|实际)?(?:快照|记录|数据点))/gu,
        (matched, count: string) => first.period?.snapshot_dates.length === Number(count) ? "" : matched)
      .replace(/(?:相隔|间隔|滞后)(?:大约|约)?\s*(\d+)\s*天/gu, (matched, days: string) =>
      first.data_freshness?.lag_days === Number(days) ? "" : matched)
      .replace(/(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?/gu,
      (matched, year: string, month: string, day: string) => allowedDates.has(normalizeDate(year, month, day)) ? "" : matched)
      .replace(/(\d{4})(?:年|[-/])(\d{1,2})月?/gu, (matched, year: string, month: string) => allowedMonths.has(`${year}-${month.padStart(2, "0")}`) ? "" : matched)
      .replace(/(?<!\d)(\d{1,2})月(?:(\d{1,2})日)?/gu, (matched, month: string, day?: string) => {
        const suffix = `-${month.padStart(2, "0")}${day ? `-${day.padStart(2, "0")}` : ""}`;
        return [...(day ? allowedDates : allowedMonths)].some(date => date?.endsWith(suffix)) ? "" : matched;
      });
    const numbers = [...numberTokens(prose)];
    if (numbers.length) issues.push(`${path} 业务数字只能使用 {{ref}} 引用，需替换的直接数值：${numbers.join("、")}。`);
    const chineseNumbers = [...prose.matchAll(/百分之[零一二三四五六七八九十百两]+|[零一二三四五六七八九十百两]+分之[零一二三四五六七八九十百两]+|[零一二三四五六七八九十百千万两]+(?:成|倍|个百分点|亿元|万元)/gu)].map(match => match[0]);
    if (chineseNumbers.length) issues.push(`${path} 业务数字只能使用 {{ref}} 引用，中文数量“${chineseNumbers.join("、")}”也不能自行计算或估算。`);
    for (const match of text.matchAll(/\{\{([^{}]+)\}\}(亿元|万元|元|%|个百分点)/g)) {
      issues.push(`${path} 的 {{${match[1]}}} 已包含单位，移除紧随其后的“${match[2]}”。`);
    }
    return text.replace(/(下降|减少|下跌|降低|回落|下行|收缩|降|减|跌)([\s*_]*(?:了|约为|约|为)?[\s*_]*)(\{\{[^{}]+\}\}(?:[、和及]\{\{[^{}]+\}\})*)/gu,
      (_matched, verb: string, space: string, refs: string) => {
        return `${verb}${space}${refs.replace(/\{\{([^{}]+)\}\}/gu, (matched, ref: string) => {
          const display = evidence.get(ref)?.display;
          return display?.startsWith("-") && overviewComparisonSign(evidence.get(ref)) === -1
            ? display.slice(1) : matched;
        })}`;
      }).replace(/\{\{([^{}]+?)(\|cite)?\}\}/g,
        (matched, ref: string, citation?: string) => evidence.has(ref) ? citation ? "" : evidence.get(ref)!.display : matched);
  };
  const preparedSummary = prepareProse(input.summary);
  let summary = overviewDisplayText(interpolate(preparedSummary, "summary"), sources);
  const sections = input.sections.map((section, index) => {
    const path = `sections[${index}]`;
    const text = prepareProse(section.text);
    const placeholders = narrativeEvidenceRefs(text);
    const refs = [...new Set([...section.evidence_refs, ...placeholders])];
    if (!refs.length || refs.some(ref => !evidence.has(ref))) issues.push(`${path} 需要有效的分析证据引用；段落 evidence_refs 使用 total.current 等原子 ref，不能使用 e1/e2 回执编号。`);
    return {...section, evidence_refs: refs, title: interpolate(prepareProse(section.title), `${path}.title`),
      text: overviewDisplayText(interpolate(text, `${path}.text`), sources)};
  });
  if (issues.length) throw new Error([...new Set(issues)].join("\n"));
  const tableRows = [...rows.values()].filter(row => input.metric_ids.includes(row.metric_id!))
    .sort((a, b) => (a.data_date ?? "").localeCompare(b.data_date ?? "") || input.metric_ids.indexOf(a.metric_id!) - input.metric_ids.indexOf(b.metric_id!))
    .map(cells => {
    return {metric_name: cells["指标"], ...(cells.data_date ? {stat_date: cells.data_date} : {}), current_value: cells["当前值"],
      mom_change: cells["较上月"], yoy_change: cells["较同期"], ytd_change: cells["较年初"], share: cells["占比"]};
  });
  const tasks = [...new Map(sources.flatMap(source => source.tasks).map(task => [task.task_id, task])).values()];
  const metricSources = new Map(sources.flatMap(source => source.table_rows.map(row =>
    [row["指标"] ?? row.metric_id!, source.metric_sources?.[row.metric_id!] ?? "正式指标目录"] as const)));
  const sourceDetail = first.topic === "deposit" && metricSources.size
    ? `本次有值指标的映射来源：${[...metricSources].map(([label, source]) => `${label}（${source}）`).join("；")}。`
    : "";
  const notices = [first.context_notice, first.source_notice, sourceDetail, first.data_freshness?.notice].filter(Boolean);
  // 数据覆盖属于交付事实，不能只藏在明细或依赖模型主动复述。
  const periodDates = first.period?.snapshot_dates;
  const coverage = periodDates ? periodDates.length
    ? `本次取得的数据日期为${periodDates.join("、")}。`
    : "查询期间暂无可用数据。" : "";
  const visibleBody = [summary, ...sections.map(section => section.text)].join("\n");
  const missingGaps = [...overviewBusinessGaps(sources),
    ...(incompleteNotice ? [incompleteNotice, ...pending.map(item => `尚未完成补查：${item.reason}`)] : [])]
    .filter(gap => !visibleBody.includes(gap));
  const prependCoverage = !!coverage && !visibleBody.includes(coverage);
  summary = [prependCoverage ? coverage : "", summary,
    ...missingGaps].filter(Boolean).join("\n\n");
  const scopeDate = first.period
    ? `查询期间：${first.period.start}至${first.period.end} · 实际数据：${first.period.snapshot_dates.join("、") || "暂无数据"}`
    : first.date_selection === "latest_snapshot"
      ? `最新可用数据：${first.analysis_date ?? "暂无数据"}`
      : first.analysis_date && first.analysis_date !== first.requested_date
        ? `查询日期：${first.requested_date} · 实际数据日期：${first.analysis_date}`
        : first.analysis_date ?? first.requested_date;
  const scope = `${first.org_name} · ${scopeDate}`;
  // 内部口径与来源保留在回执中；公共正文只合并业务内容和实际数据范围。
  const publicAnswer = overviewPublicAnswer(scope, summary, sections);
  return {kind: "business_report", status: "succeeded", delivery: "business_evidence_v1",
    answer_policy: "verified_report_v1", public_answer: publicAnswer,
    topic: first.topic ?? "loan", topic_version: first.topic_version, topic_name: first.topic_name, source_notice: first.source_notice, context_notice: first.context_notice,
    org_codes: first.org_codes, org_name: first.org_name, analysis_date: first.analysis_date,
    requested_date: first.requested_date, basis: first.basis, tasks,
    date_selection: first.date_selection, period: first.period, data_freshness: first.data_freshness,
    columns: ["metric_name", ...(first.period ? ["stat_date"] : []), "current_value", "mom_change", "yoy_change", "ytd_change", "share"], rows: tableRows, row_count: tableRows.length,
    partial_analysis: tableRows.length === 0 || gaps.length > 0,
    report: {summary, sections, presentation: {version: 1, body_mode: "narrative", layout: ["summary", "analysis", "data"],
      scope,
      source_notices: notices,
      limitations: [first.basis,
        first.topic === "deposit" ? "余额与比较指标用于观察规模及结构变化；客户和资金变动原因仍需流水等证据。" : "余额与比较指标用于观察规模及组成变化；投放、还款、核销等原因仍需相应证据。"]},
      plans: sources.map(source => source.plan), evidence_refs: input.evidence_refs,
      body_evidence: narrativeParagraphEvidence(preparedSummary).map(paragraph => ({...paragraph,
        paragraph: paragraph.paragraph + (prependCoverage ? 1 : 0),
        evidence_refs: expandFindingRefs(paragraph.evidence_refs, evidence)}))},
    gaps, evidence_items: [...evidence.values()]};
}

const parameters = Type.Object({
  evidence_refs: Type.Array(Type.String(), {minItems: 1, maxItems: 3, description: "本轮概览回执的 e1/e2 等引用；包含初查和补查，不引用历史数值。"}),
  body: Type.Optional(Type.String({minLength: 1, maxLength: 6000, description: "完整自然正文；仅把已有结果改为图表时可省略。先回答问题，再按需说明关键分项，无固定栏目。只引用影响判断的关键数字，完整数据留表格，不逐行复述所有比较。展示数值用{{实际原子ref}}，明确比较基期。已核验判断用于理解依据，自然组织正文，无需照搬固定句子；{{实际原子ref|cite}}可关联所依据的事实。不能推断未证实因果、资金迁移或连续趋势；不自行换算，日期沿用实际截至日。"})),
  chart: Type.Optional(Type.Union([reportChartSchema, Type.Object({type: Type.Literal("pie"), relationship_id: Type.Optional(Type.String({minLength: 1,
    description: "可选主题关系ID。省略时使用已确认且数据完整的结构分组，不把父项和子项混在同一饼图。"}))}, {additionalProperties: false})])),
  metric_ids: Type.Array(Type.String(), {maxItems: 16, description: "表格展示的主题指标ID，按用户重点排序；无数值时为空。"}),
}, {additionalProperties: false, anyOf: [{required: ["body"]}, {required: ["chart"]}]});

export function createBusinessReportTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "business_report_present", label: "生成经营分析报告", parameters,
    description: "观察初查及补查证据后，交付自然body并主动配一张有助理解结论的chart：比较变化选bar及同基期差额引用，完整结构选pie，连续真实时点选line；单值、无可比数据或用户只要文字时不强画。正文与图一起交付，不为画图重新取数；仅绘图时可只提交chart。数字用{{total.current}}等实际证据占位符，表格与图表由程序生成。围绕问题重点写发现、分化、反例或边界，无固定栏目，不把专家假设当成本机构原因。",
    execute: async (_id, rawInput, _update, request, _invocation, context) => {
      let errorCode = "ANALYSIS_REPORT_INPUT";
      try {
        const chartOnly = !!rawInput.chart && rawInput.body === undefined;
        const caption = prefersReportText(request.originalMessage) ? "本次仅展示文字和数据明细。"
          : rawInput.chart?.type === "pie" ? "结构分布见下方饼图。" : "数据比较见下方图表。";
        const input = {...rawInput, ...normalizeReportNarrative(chartOnly ? {...rawInput, body: caption} : rawInput)};
        errorCode = "ANALYSIS_REPORT_EVIDENCE";
        const references = await request.answerEvidence?.() ?? [];
        const selected = input.evidence_refs.map(ref => references.find(item => item.ref === ref));
        if (new Set(input.evidence_refs).size !== input.evidence_refs.length
          || selected.some(item => item?.evidence.kind !== "business_overview")) {
          const available = references.filter(item => item.evidence.kind === "business_overview").map(item => item.ref);
          const state = await request.frames?.state();
          throw new Error(available.length
            ? `本轮可用概览引用为 ${available.join("、")}，请用这些 evidence_refs 重新提交报告，不能沿用上一轮编号。`
            : `本轮还未读取概览证据。先调用 read_business_result，frameId=${state?.focusFrameId ?? "请用 business_context_read 定位"}；按读取回执中的本轮 evidence_refs 再提交报告，不让用户重复条件。`);
        }
        const sources = selected.map(item => item!.evidence as OverviewEvidence);
        for (const source of sources) {
          const scope = await request.backend.resolveBusinessField("organization", source.org_codes, {signal: context.abortSignal});
          if (scope.status !== "resolved" || JSON.stringify((scope.value as {codes?: string[]})?.codes) !== JSON.stringify(source.org_codes)) throw new Error("报告机构权限已变化。");
          for (const task of source.tasks) await request.backend.getTask(task.task_id, {signal: context.abortSignal});
        }
        let details;
        try { details = composeBusinessReport(sources, input); }
        catch (error) {
          if (!isProseError(error)) throw error;
          // 复用当前轮工具回执限定一次修正机会，避免覆盖可修正的业务正文或无界重写。
          const revised = currentTurnMessages(await request.turnMessages?.() ?? []).some(message =>
            message.role === "toolResult" && message.toolName === "business_report_present"
            && (message.details as {error_code?: string} | undefined)?.error_code === "ANALYSIS_REPORT_PROSE");
          if (!revised) return {content: [{type: "text", text: `${error.message}\n请基于本轮已有证据完整重写正文，保证前后指代、比较对象与基期一致，不逐句删除后拼接。先直接回答用户问题，再列关键事实和必要缺口；不逐行复述明细，不推断没有证据的经营好坏或原因。用完整 body 重新提交 business_report_present，只修正文，不重新取数。`}],
            details: {kind: "business_report", status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_PROSE", retryable: true}};
          // 整篇修正仍失败时只重建已核验事实，不裁句保留失去前提的判断。
          const summary = overviewFactBody(sources, input.metric_ids);
          if (!summary.trim() && sources.some(source => source.table_rows.length)) throw error;
          const report = summary.trim() ? composeBusinessReport(sources, {...input, summary, sections: []})
            : composePartialBusinessReport(sources, input);
          details = {...report, narrative_repaired: true,
          narrative_repair: {reason_code: "REPORT_PROSE_VALIDATION"}};
        }
        let generated: {charts: BusinessReportChart[]; notice?: string} = {charts: []};
        if (!prefersReportText(request.originalMessage)) {
          if (rawInput.chart?.type === "pie") {
            const topic = await request.backend.businessTopic(sources[0]!.topic ?? "loan", false, {signal: context.abortSignal});
            generated = buildOverviewPieChart(sources, topic, rawInput.chart.relationship_id);
          } else {
            generated = buildReportChart(sources.map((evidence, index) => ({ref: input.evidence_refs[index]!, evidence})),
              "narrative_repaired" in details && details.narrative_repaired ? undefined : rawInput.chart,
              request.originalMessage, verifiedNarrativeRefs(details.report));
          }
        }
        if (generated.charts.length || generated.notice) {
          const {charts, notice} = generated;
          if (chartOnly && notice) details = composeBusinessReport(sources, {...input, summary: notice, sections: []});
          details = {...details, partial_analysis: details.partial_analysis || !!notice,
            gaps: notice ? [...details.gaps, notice] : details.gaps,
            public_answer: notice && !chartOnly ? `${details.public_answer}\n\n${notice}` : details.public_answer,
            report: {...details.report, charts,
              summary: notice && !chartOnly ? `${details.report.summary}\n\n${notice}` : details.report.summary}};
        }
        // 补查是用户目标的内部步骤；交付后焦点回到本轮初查，追问不继承最后一个分项。
        if (sources.length > 1 && request.frames && sources[0]?.frame_id) {
          const state = await request.frames.state();
          const root = await request.frames.get(sources[0].frame_id);
          const current = state.focusFrameId ? await request.frames.get(state.focusFrameId) : undefined;
          if (root?.turnId === request.operationId && current?.turnId === request.operationId
            && root.status === "success" && current.capability === "business_overview"
            && state.focusFrameId !== root.frameId) await request.frames.setFocus(root.frameId, state.version);
        }
        return {content: [{type: "text", text: details.public_answer}], details, terminate: true};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {content: [{type: "text", text: error instanceof Error ? error.message : "报告证据校验失败"}],
          details: {kind: "business_report", status: "ARGUMENT_ERROR", retryable: true,
            error_code: isProseError(error) ? "ANALYSIS_REPORT_PROSE" : errorCode}};
      }
    }};
}
